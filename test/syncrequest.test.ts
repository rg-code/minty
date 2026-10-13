import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { fernetEncrypt } from "../src/fernet";
import { CATCH_UP_CRON } from "../src/sync";
import { nextCatchUp } from "../src/routes/syncrequest";
import type { Env } from "../src/env";
import { call, getJson } from "./helpers";
import { FakePlaid, page } from "./fake-plaid";

// Clicking the logo asks for a sync. The request only records it; the next cron run (the
// 10-minute catch-up at the latest) sweeps every bank. No request path calls Plaid's sync.
const E = env as unknown as Env;
let plaid: FakePlaid;

async function reset() {
  await env.DB.batch(["app_state", "transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}
async function addItem(cursor: string, start: string | null = null) {
  const enc = await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!);
  return (await env.DB.prepare(
    `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, txn_cursor, sync_start_cursor, updated_at)
     VALUES ('me', 'me_primary', ?, ?, ?, ?, '2026-10-01T00:00:00.000Z') RETURNING id`).bind(`i-${crypto.randomUUID()}`, enc, cursor, start).first<{ id: number }>())!.id;
}
const cron = async (c: string) => { const ctx = createExecutionContext(); await worker.scheduled(createScheduledController({ cron: c }), E, ctx); await waitOnExecutionContext(ctx); };
const post = () => call("/sync-request", { method: "POST" });

beforeEach(async () => { await reset(); plaid = new FakePlaid().install(); });
afterEach(() => vi.restoreAllMocks());

describe("POST /sync-request", () => {
  it("records one pending request, however many clicks, and never calls Plaid", async () => {
    const r = await post();
    expect(r.status).toBe(200);
    const first = await r.json() as any;
    expect(first).toMatchObject({ pending: true, requested_at: expect.any(String), runs_by: expect.any(String) });
    const again = await (await post()).json() as any;
    expect(again.requested_at).toBe(first.requested_at);
    expect(plaid.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT value FROM app_state WHERE key = 'sync_requested_by'").first()).toEqual({ value: "me@example.com" });
  });

  it("is refused from another site", async () => {
    expect((await call("/sync-request", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("reports the last time any bank synced", async () => {
    await addItem("c1");
    const { body } = await getJson("/sync-request");
    expect(body).toMatchObject({ pending: false, runs_by: null, last_synced_at: "2026-10-01T00:00:00.000Z" });
  });
});

describe("the cron and a requested sync", () => {
  it("the catch-up run sweeps every bank when a sync was requested, then the request is done", async () => {
    await addItem("caught-up");                        // not downloading: the catch-up alone would skip it
    await post();
    plaid.syncPages.push(page("c2", false));
    await cron(CATCH_UP_CRON);
    expect(plaid.calls.filter((c) => c.path === "/transactions/sync").map((c) => c.body.cursor)).toEqual(["caught-up"]);
    expect(plaid.paths()).not.toContain("/item/get");  // the daily connection check stays with the hourly run
    expect((await getJson("/sync-request")).body.pending).toBe(false);
    plaid.calls = [];
    await cron(CATCH_UP_CRON);                         // nothing pending: back to downloads only
    expect(plaid.calls).toEqual([]);
  });

  it("the hourly run also counts as the requested sync", async () => {
    await addItem("k1");
    await post();
    plaid.syncPages.push(page("k2", false));
    await cron("17 * * * *");
    expect((await getJson("/sync-request")).body.pending).toBe(false);
  });
});

describe("nextCatchUp", () => {
  it("is the next 10-minute mark", () => {
    expect(nextCatchUp(new Date("2026-10-13T10:07:30Z"))).toBe("2026-10-13T10:10:00.000Z");
    expect(nextCatchUp(new Date("2026-10-13T10:10:00Z"))).toBe("2026-10-13T10:20:00.000Z");
    expect(nextCatchUp(new Date("2026-10-13T23:55:00Z"))).toBe("2026-10-14T00:00:00.000Z");
  });
});
