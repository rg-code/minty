import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { fernetEncrypt } from "../src/fernet";
import { SESSION_MINUTES, pruneLinkSessions } from "../src/routes/link";
import { limitersFor } from "../src/limits";
import { accessToken, call, getJson } from "./helpers";
import { FakePlaid, page, plaidError } from "./fake-plaid";

// Step 3 of docs/security-plan.md: Link sessions. /link/token reserves a slot under the Trial cap
// for one login; /link/exchange claims it once, before Plaid's exchange, and takes owner and
// plaid_account from it; /link/cancel gives it back.

const E = env as unknown as Env;
let plaid: FakePlaid;

const wipe = () => E.DB.batch(["transaction_tags", "transactions", "accounts", "items", "link_sessions"].map((t) => E.DB.prepare(`DELETE FROM ${t}`)));
const post = (path: string, body: unknown, init: Parameters<typeof call>[1] = {}) =>
  call(path, { method: "POST", body: JSON.stringify(body), ...init });
const postJson = async (path: string, body: unknown, init: Parameters<typeof call>[1] = {}) => {
  const r = await post(path, body, init);
  return { status: r.status, body: (await r.json()) as any };
};
const OTHER = async () => ({ token: await accessToken({ email: "other@example.com" }) });

async function addItems(plaidAccount: string, owner: string, n: number) {
  await E.DB.batch(Array.from({ length: n }, (_, i) => E.DB.prepare(
    "INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES (?, ?, ?, 'x')",
  ).bind(owner, plaidAccount, `${plaidAccount}-item-${i}-${crypto.randomUUID()}`)));
}
const session = (id: string) => E.DB.prepare("SELECT * FROM link_sessions WHERE id = ?").bind(id).first<any>();
const reserved = async (account: string) => {
  const body = (await getJson("/capacity")).body;
  return Object.values(body).flat().find((s: any) => s.account === account) as any;
};
const linkToken = (owner = "me", init: Parameters<typeof call>[1] = {}) => postJson("/link/token", { owner }, init);
const exchange = (session_id: string, extra: Record<string, unknown> = {}, init: Parameters<typeof call>[1] = {}) =>
  postJson("/link/exchange", { session_id, public_token: "public-sandbox-1", ...extra }, init);

beforeEach(async () => { await wipe(); plaid = new FakePlaid().install(); });
afterEach(() => vi.restoreAllMocks());

describe("POST /link/token reserves a slot", () => {
  it("records a session for this login, owner and slot, for 30 minutes", async () => {
    const { status, body } = await linkToken();
    expect(status).toBe(200);
    expect(body).toMatchObject({ link_token: "link-sandbox-abc", plaid_account: "me_primary" });
    expect(body.session_id).toMatch(/^[A-Za-z0-9_-]{22}$/);                     // 128 bits, base64url
    const s = await session(body.session_id);
    expect(s).toMatchObject({ email: "me@example.com", operation: "link", owner: "me", plaid_account: "me_primary",
      item_id: null, used_at: null, finished_at: null, released_at: null, expires_at: body.expires_at });
    const minutes = (Date.parse(body.expires_at) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(SESSION_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(SESSION_MINUTES);
    expect(await reserved("me_primary")).toMatchObject({ used: 0, reserved: 1 });
  });

  it("the cap counts open reservations: the last free slot, once reserved, sends the next link to the next slot", async () => {
    await addItems("me_primary", "me", 9);
    expect((await linkToken()).body.plaid_account).toBe("me_primary");
    expect((await linkToken()).body.plaid_account).toBe("me_backup");
  });

  it("concurrent links can't overshoot a slot's cap", async () => {
    await addItems("me_primary", "me", 9);
    await addItems("me_backup", "me", 10);
    const results = await Promise.all([linkToken(), linkToken(), linkToken()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const n = await E.DB.prepare("SELECT count(*) AS n FROM link_sessions WHERE plaid_account = 'me_primary' AND released_at IS NULL").first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(plaid.paths()).toEqual(["/link/token/create"]);                        // only the one that got the slot
  });

  it("an expired or released reservation stops counting", async () => {
    await addItems("me_primary", "me", 9);
    const a = (await linkToken()).body.session_id;
    await E.DB.prepare("UPDATE link_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(a).run();
    const b = (await linkToken()).body;
    expect(b.plaid_account).toBe("me_primary");
    await post("/link/cancel", { session_id: b.session_id });
    expect((await linkToken()).body.plaid_account).toBe("me_primary");
  });

  it("a Plaid failure gives the reservation back", async () => {
    plaid.replies["/link/token/create"] = plaidError("INVALID_API_KEYS", 400, "INVALID_INPUT");
    expect((await linkToken()).status).toBe(502);
    const s = await E.DB.prepare("SELECT * FROM link_sessions").first<any>();
    expect(s.released_at).not.toBeNull();
    expect(await reserved("me_primary")).toMatchObject({ reserved: 0 });
  });

  it("when nothing is free, the errors are the same as before (no keys / every slot full)", async () => {
    await addItems("spouse_primary", "spouse", 10);
    const noKeys = await linkToken("spouse");
    expect(noKeys.status).toBe(400);
    expect(noKeys.body.detail).toContain("PLAID_CLIENT_ID_SPOUSE_BACKUP");
    await addItems("me_primary", "me", 10);
    await addItems("me_backup", "me", 10);
    const full = await linkToken("me");
    expect(full.status).toBe(409);
    expect(full.body.detail).toMatch(/at the 10-item cap/);
    expect(plaid.calls).toEqual([]);
  });
});

describe("POST /link/exchange claims the session", () => {
  it("once, takes owner and slot from the session (whatever the body says), and turns the reservation into the bank", async () => {
    plaid.syncPages.push(page("c1", false));
    await addItems("me_primary", "me", 10);
    const { session_id } = (await linkToken()).body;                              // me_backup
    const r = await exchange(session_id, { owner: "spouse", plaid_account: "spouse_primary" });
    expect(r.status).toBe(200);
    expect(r.body.plaid_account).toBe("me_backup");
    const item = await E.DB.prepare("SELECT * FROM items WHERE plaid_item_id = 'plaid-item-1'").first<any>();
    expect(item).toMatchObject({ owner: "me", plaid_account: "me_backup" });
    expect(plaid.calls.filter((c) => c.path === "/item/public_token/exchange").map((c) => c.clientId)).toEqual(["cid_me_backup"]);
    const s = await session(session_id);
    expect(s.used_at).not.toBeNull();
    expect(s.finished_at).not.toBeNull();
    expect(s.item_id).toBe(item.id);
    expect(await reserved("me_backup")).toMatchObject({ used: 1, reserved: 0 });

    const again = await exchange(session_id);
    expect(again.status).toBe(409);
    expect(again.body.detail).toBe("This connection was already completed. Reload the page to see it.");
    expect(plaid.calls.filter((c) => c.path === "/item/public_token/exchange")).toHaveLength(1);
  });

  it("another login's session is refused before Plaid, and stays usable by its own login", async () => {
    const { session_id } = (await linkToken()).body;
    plaid.calls = [];
    const r = await exchange(session_id, {}, await OTHER());
    expect(r.status).toBe(409);
    expect(r.body.detail).toBe("Unknown Link session: reload the page and start the connection again.");
    expect(plaid.calls).toEqual([]);
    expect((await session(session_id)).used_at).toBeNull();
  });

  it("an expired, cancelled or made-up session is refused before Plaid", async () => {
    const a = (await linkToken()).body.session_id;
    await E.DB.prepare("UPDATE link_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(a).run();
    const b = (await linkToken()).body.session_id;
    await post("/link/cancel", { session_id: b });
    plaid.calls = [];
    expect((await exchange(a)).body.detail).toBe(`This connection expired (after ${SESSION_MINUTES} minutes). Start it again.`);
    expect((await exchange(b)).body.detail).toBe("This connection was cancelled. Start it again.");
    expect((await exchange("made-up")).status).toBe(409);
    expect(plaid.calls).toEqual([]);
  });

  it("a missing session (an old page) is a clear 422", async () => {
    const r = await postJson("/link/exchange", { owner: "me", plaid_account: "me_primary", public_token: "p" });
    expect(r.status).toBe(422);
    expect(r.body.detail).toBe("Link session missing: reload the page and start the connection again.");
    expect(plaid.calls).toEqual([]);
  });

  it("if Plaid refuses the exchange, nothing was spent: the reservation is released", async () => {
    const { session_id } = (await linkToken()).body;
    plaid.replies["/item/public_token/exchange"] = plaidError("INVALID_PUBLIC_TOKEN", 400, "INVALID_INPUT");
    expect((await exchange(session_id)).status).toBe(502);
    expect((await session(session_id)).released_at).not.toBeNull();
    expect(await reserved("me_primary")).toMatchObject({ reserved: 0 });
  });

  it("if the exchange may have reached Plaid (no answer), the claimed session keeps counting, and Setup checks say so", async () => {
    const { session_id } = (await linkToken()).body;
    delete (plaid.replies as Record<string, unknown>)["/item/public_token/exchange"];   // the fake throws: like a network failure
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await exchange(session_id)).status).toBe(500);
    const s = await session(session_id);
    expect([s.used_at !== null, s.finished_at, s.released_at]).toEqual([true, null, null]);
    expect(await reserved("me_primary")).toMatchObject({ used: 0, reserved: 1 });
    await E.DB.prepare("UPDATE link_sessions SET used_at = '2020-01-01T00:00:00.000Z', expires_at = '2020-01-01T00:30:00.000Z' WHERE id = ?").bind(session_id).run();
    expect(await reserved("me_primary")).toMatchObject({ reserved: 1 });           // still, after its expiry
    const checks = Object.fromEntries((await getJson("/status")).body.checks.map((c: any) => [c.id, c]));
    expect(checks.link_interrupted_me_primary).toMatchObject({ ok: false, level: "warn",
      message: "1 bank link on me_primary stopped after Plaid may have created the connection, so it counts against its 10-bank cap." });
  });
});

describe("POST /link/cancel", () => {
  it("releases this login's unused session; not another login's, not a used one", async () => {
    plaid.syncPages.push(page("c1", false));
    const a = (await linkToken()).body.session_id;
    expect((await postJson("/link/cancel", { session_id: a }, await OTHER())).body).toEqual({ session_id: a, released: false });
    expect((await postJson("/link/cancel", { session_id: a })).body).toEqual({ session_id: a, released: true });
    expect((await postJson("/link/cancel", { session_id: a })).body.released).toBe(false);             // once
    const b = (await linkToken()).body.session_id;
    await exchange(b);
    expect((await postJson("/link/cancel", { session_id: b })).body.released).toBe(false);
    expect((await session(b)).released_at).toBeNull();
  });

  it("counts against the link rate limit like every /link/* call", () => {
    expect(limitersFor("POST", new URL("https://x/link/cancel"))).toEqual(["RL_GENERAL", "RL_LINK"]);
  });
});

describe("POST /link/token/update", () => {
  const item = async () => {
    const enc = await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!);
    return (await E.DB.prepare(
      "INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES ('me', 'me_primary', 'upd-1', ?) RETURNING id",
    ).bind(enc).first<{ id: number }>())!.id;
  };

  it("opens an update session, and one reconnect per bank a minute", async () => {
    const id = await item();
    const first = await postJson("/link/token/update", { item_id: id });
    expect(first.status).toBe(200);
    expect(await session(first.body.session_id)).toMatchObject({ operation: "update", item_id: id, plaid_account: "me_primary" });
    const second = await postJson("/link/token/update", { item_id: id });
    expect(second.status).toBe(429);
    expect(second.body.detail).toBe("Reconnecting this bank was started less than a minute ago. Finish or close that one, or wait a minute.");
    expect(plaid.paths()).toEqual(["/link/token/create"]);
    await post("/link/cancel", { session_id: first.body.session_id });             // closing Link ends the cooldown
    expect((await postJson("/link/token/update", { item_id: id })).status).toBe(200);
  });

  it("the cooldown ends after a minute, and a Plaid failure doesn't start it", async () => {
    const id = await item();
    plaid.replies["/link/token/create"] = plaidError("INTERNAL_SERVER_ERROR", 500, "API_ERROR");
    expect((await postJson("/link/token/update", { item_id: id })).status).toBe(502);
    plaid.replies["/link/token/create"] = { body: { link_token: "link-sandbox-abc" } };
    const ok = await postJson("/link/token/update", { item_id: id });
    expect(ok.status).toBe(200);
    await E.DB.prepare("UPDATE link_sessions SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(ok.body.session_id).run();
    expect((await postJson("/link/token/update", { item_id: id })).status).toBe(200);
  });

  it("update sessions never count against the cap", async () => {
    const id = await item();
    await postJson("/link/token/update", { item_id: id });
    expect(await reserved("me_primary")).toMatchObject({ used: 1, reserved: 0 });
  });
});

describe("cleaning up", () => {
  const add = (id: string, f: Record<string, string | null>) => E.DB.prepare(
    `INSERT INTO link_sessions (id, email, operation, owner, plaid_account, expires_at, used_at, finished_at, released_at)
     VALUES (?, 'me@example.com', 'link', 'me', 'me_primary', ?, ?, ?, ?)`).bind(id, f.expires, f.used ?? null, f.finished ?? null, f.released ?? null).run();
  const OLD = "2020-01-01T00:00:00.000Z";
  const ids = async () => (await E.DB.prepare("SELECT id FROM link_sessions ORDER BY id").all<{ id: string }>()).results.map((r) => r.id);

  it("drops sessions a week past expiry, but never a claimed one that didn't finish", async () => {
    await add("finished", { expires: OLD, used: OLD, finished: OLD });
    await add("released", { expires: OLD, released: OLD });
    await add("expired-unused", { expires: OLD });
    await add("interrupted", { expires: OLD, used: OLD });
    await add("recent", { expires: new Date(Date.now() - 86_400_000).toISOString() });
    await pruneLinkSessions(E.DB);
    expect(await ids()).toEqual(["interrupted", "recent"]);
  });

  it("the hourly cron does it", async () => {
    await add("finished", { expires: OLD, used: OLD, finished: OLD });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect(await ids()).toEqual([]);
  });
});
