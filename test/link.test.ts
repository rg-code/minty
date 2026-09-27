import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { loadConfig } from "../src/config";
import { fernetDecrypt, fernetEncrypt } from "../src/fernet";
import { chooseAccountFor } from "../src/routes/link";
import type { Env } from "../src/env";
import { call, getJson } from "./helpers";
import { FakePlaid, account, page, plaidError, txn } from "./fake-plaid";

// Plaid Link routes: token, exchange, update mode, trial-cap overflow.
const E = env as unknown as Env;
const KEY = E.TOKEN_ENC_KEY!;
let plaid: FakePlaid;

async function wipe() {
  await env.DB.batch(["transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

/** n Items on a credential set (to fill it up to the cap). */
async function addItems(plaidAccount: string, owner: string, n: number) {
  const tok = await fernetEncrypt("access-sandbox-other", KEY);
  await env.DB.batch(Array.from({ length: n }, (_, i) => env.DB.prepare(
    "INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES (?, ?, ?, ?)",
  ).bind(owner, plaidAccount, `${plaidAccount}-item-${i}`, tok)));
}

const post = (path: string, body: unknown, envOverrides?: Partial<Env>) =>
  call(path, { method: "POST", body: JSON.stringify(body), envOverrides });

beforeEach(async () => { await wipe(); plaid = new FakePlaid().install(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("choose_account_for", () => {
  const config = loadConfig(E);

  it("routes to primary while under the cap", async () => {
    await addItems("me_primary", "me", 9);
    expect(await chooseAccountFor(E, config, "me")).toBe("me_primary");
  });

  it("overflows to backup at the cap", async () => {
    await addItems("me_primary", "me", 10);
    expect(await chooseAccountFor(E, config, "me")).toBe("me_backup");
  });

  it("never routes to the other person's accounts, and 409s when all are full", async () => {
    await addItems("spouse_primary", "spouse", 10);
    expect(await chooseAccountFor(E, config, "spouse")).toBe("spouse_backup");
    await addItems("spouse_backup", "spouse", 10);
    await expect(chooseAccountFor(E, config, "spouse")).rejects.toMatchObject({ status: 409 });
  });
});

describe("POST /link/token", () => {
  it("rejects an unknown owner without calling Plaid", async () => {
    expect((await post("/link/token", { owner: "neighbour" })).status).toBe(400);
    expect(plaid.calls).toEqual([]);
  });

  it("uses the chosen account's credentials and reports it", async () => {
    await addItems("me_primary", "me", 10);
    const r = await post("/link/token", { owner: "me" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ link_token: "link-sandbox-abc", plaid_account: "me_backup" });
    const [c] = plaid.calls;
    expect(c.path).toBe("/link/token/create");
    expect([c.clientId, c.secret]).toEqual(["cid_me_backup", "secret_me_backup"]);
    expect(c.body).toMatchObject({ client_name: "Minty", products: ["transactions"], country_codes: ["US"],
      user: { client_user_id: "me" }, transactions: { days_requested: 730 } });
    expect(c.body).not.toHaveProperty("redirect_uri");                 // blank setting -> field omitted
  });

  it("passes the redirect URI when configured", async () => {
    await post("/link/token", { owner: "spouse" }, { PLAID_REDIRECT_URI: "https://minty.example.workers.dev/connect" });
    expect(plaid.calls[0].body.redirect_uri).toBe("https://minty.example.workers.dev/connect");
  });

  it("refuses a slot without keys, naming the secrets to set, without calling Plaid", async () => {
    await addItems("spouse_primary", "spouse", 10);                    // spouse_backup has no keys in tests
    const { status, body } = await getJson("/link/token", { method: "POST", body: JSON.stringify({ owner: "spouse" }) });
    expect(status).toBe(400);
    expect(body.detail).toContain("PLAID_CLIENT_ID_SPOUSE_BACKUP");
    expect(plaid.calls).toEqual([]);
  });

  it("maps a Plaid failure to 502 with the error code only", async () => {
    plaid.replies["/link/token/create"] = plaidError("INVALID_API_KEYS", 400, "INVALID_INPUT");
    const { status, body } = await getJson("/link/token", { method: "POST", body: JSON.stringify({ owner: "me" }) });
    expect(status).toBe(502);
    expect(body).toEqual({ detail: "Plaid error: INVALID_API_KEYS" });
  });
});

describe("POST /link/exchange", () => {
  it.each([
    { owner: "me", plaid_account: "me_overflow2", public_token: "p" },      // unknown account
    { owner: "me", plaid_account: "spouse_primary", public_token: "p" },    // owner mismatch
  ])("rejects bad owner/account pairs without calling Plaid: %j", async (b) => {
    expect((await post("/link/exchange", b)).status).toBe(400);
    expect(plaid.calls).toEqual([]);
  });

  it("422s a missing public_token", async () => {
    expect((await post("/link/exchange", { owner: "me", plaid_account: "me_primary" })).status).toBe(422);
  });

  it("stores the token encrypted, then backfills in the background", async () => {
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")], added: [txn("t1", "a1")] }));
    const r = await post("/link/exchange", { owner: "me", plaid_account: "me_backup", public_token: "public-sandbox-1", institution_name: "Chase" });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ plaid_account: "me_backup", status: "good" });
    expect(text).not.toContain("access-sandbox-secret");

    const item = await env.DB.prepare("SELECT * FROM items").first<any>();
    expect(item).toMatchObject({ owner: "me", plaid_account: "me_backup", plaid_item_id: "plaid-item-1", institution_name: "Chase", txn_cursor: "c1" });
    expect(item.access_token_enc).not.toContain("access-sandbox-secret");
    expect(await fernetDecrypt(item.access_token_enc, KEY)).toBe("access-sandbox-secret");

    expect(plaid.paths()).toEqual(["/item/public_token/exchange", "/transactions/sync"]);
    expect(plaid.calls.every((c) => c.clientId === "cid_me_backup")).toBe(true);
    expect(plaid.calls[1].body.access_token).toBe("access-sandbox-secret");
    expect((await getJson("/transactions")).body.map((t: any) => t.plaid_txn_id)).toEqual(["t1"]);
  });

  it("re-linking the same Item refreshes its token instead of duplicating it", async () => {
    plaid.syncPages.push(page("c1", false), page("c2", false));
    await post("/link/exchange", { owner: "me", plaid_account: "me_primary", public_token: "p1", institution_name: "Chase" });
    plaid.replies["/item/public_token/exchange"] = { body: { access_token: "access-sandbox-new", item_id: "plaid-item-1" } };
    await post("/link/exchange", { owner: "me", plaid_account: "me_primary", public_token: "p2" });
    const { results } = await env.DB.prepare("SELECT * FROM items").all<any>();
    expect(results).toHaveLength(1);
    expect(results[0].institution_name).toBe("Chase");                          // kept when not re-sent
    expect(await fernetDecrypt(results[0].access_token_enc, KEY)).toBe("access-sandbox-new");
  });

  it("explains a missing TOKEN_ENC_KEY before calling Plaid", async () => {
    const { status, body } = await getJson("/link/exchange", {
      method: "POST", body: JSON.stringify({ owner: "me", plaid_account: "me_primary", public_token: "p" }),
      envOverrides: { TOKEN_ENC_KEY: "" },
    });
    expect(status).toBe(500);
    expect(body.detail).toMatch(/TOKEN_ENC_KEY is not set/);
    expect(plaid.calls).toEqual([]);
  });
});

describe("POST /link/token/update", () => {
  it("404s an unknown item", async () => {
    expect((await post("/link/token/update", { item_id: 42 })).status).toBe(404);
  });

  it("explains an undecryptable stored token instead of a bare 500", async () => {
    const { id } = (await env.DB.prepare(
      "INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES ('me', 'me_primary', 'bad', 'seed-placeholder') RETURNING id",
    ).first<{ id: number }>())!;
    const { status, body } = await getJson("/link/token/update", { method: "POST", body: JSON.stringify({ item_id: id }) });
    expect(status).toBe(409);
    expect(body.detail).toMatch(/can't be decrypted/);
    expect(plaid.calls).toEqual([]);
  });

  it("uses the item's own account and decrypted token, with no products", async () => {
    const enc = await fernetEncrypt("access-sandbox-secret", KEY);
    const { id } = (await env.DB.prepare(
      "INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES ('me', 'me_backup', 'i1', ?) RETURNING id",
    ).bind(enc).first<{ id: number }>())!;
    const r = await post("/link/token/update", { item_id: id });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ link_token: "link-sandbox-abc", plaid_account: "me_backup" });
    const [c] = plaid.calls;
    expect(c.clientId).toBe("cid_me_backup");
    expect(c.body.access_token).toBe("access-sandbox-secret");
    expect(c.body).not.toHaveProperty("products");
    expect(text).not.toContain("access-sandbox-secret");
  });
});
