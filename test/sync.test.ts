import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { loadConfig } from "../src/config";
import { fernetEncrypt } from "../src/fernet";
import { runSyncAll, syncItem, type ItemRow } from "../src/sync";
import type { Env } from "../src/env";
import { FakePlaid, account, page, plaidError, txn } from "./fake-plaid";

// Port of tests/test_sync_engine.py, against a real local D1.
const E = env as unknown as Env;
const config = loadConfig(E);
let plaid: FakePlaid;

async function wipe() {
  await env.DB.batch(["transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

async function addItem(o: { owner?: string; plaid_account?: string; cursor?: string | null; status?: string; token?: string; updated_at?: string } = {}): Promise<ItemRow> {
  const enc = o.token ?? await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!);
  return (await env.DB.prepare(
    `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, txn_cursor, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(o.owner ?? "me", o.plaid_account ?? "me_backup", `item-${crypto.randomUUID()}`, enc, o.cursor ?? null,
    o.status ?? "good", o.updated_at ?? "2026-09-01T00:00:00.000Z").first<ItemRow>())!;
}

const rows = async (sql: string) => (await env.DB.prepare(sql).all<any>()).results;
const itemById = async (id: number) => env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<any>();

beforeEach(async () => { await wipe(); plaid = new FakePlaid().install(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("syncItem", () => {
  it("syncs every page, persisting each (cursor last) with the item's own credentials", async () => {
    const item = await addItem({ owner: "me", plaid_account: "me_backup" });
    plaid.syncPages.push(
      page("c1", true, { accounts: [account("a1")], added: [txn("t0", "a1"), txn("t1", "a1", { amount: 84.12, pending: true }), txn("orphan", "unknown-acct")] }),
      page("c2", false, { accounts: [account("a1", { balances: { current: 5, available: null, iso_currency_code: "USD" } })],
        modified: [txn("t1", "a1", { amount: 80, name: "Edited" })], removed: ["t0"] }),
    );
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("good");

    expect(plaid.calls.map((c) => [c.clientId, c.body.cursor])).toEqual([["cid_me_backup", undefined], ["cid_me_backup", "c1"]]);
    expect(plaid.calls[0].body).toMatchObject({ access_token: "access-sandbox-secret", count: 250 });
    expect((await itemById(item.id)).txn_cursor).toBe("c2");

    const txns = await rows("SELECT * FROM transactions");
    expect(txns).toHaveLength(1);                                   // t0 removed, orphan skipped
    expect(txns[0]).toMatchObject({ plaid_txn_id: "t1", owner: "me", amount_cents: 8000, name: "Edited",
      category: "FOOD_AND_DRINK", pending: 0, currency: "USD", date: "2026-09-20" });
    const [acct] = await rows("SELECT * FROM accounts");
    expect(acct).toMatchObject({ plaid_account_id: "a1", owner: "me", item_id: item.id, balance_current_cents: 500,
      balance_available_cents: null, type: "depository", subtype: "checking" });
  });

  it("stores amounts as exact cents and pending as 0/1", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")],
      added: [txn("x", "a1", { amount: 0.1 + 0.2 }), txn("y", "a1", { amount: -2450.005, pending: true })] }));
    await syncItem(E, config, item, { pages: 1 });
    expect(await rows("SELECT plaid_txn_id, amount_cents, pending FROM transactions ORDER BY plaid_txn_id"))
      .toEqual([{ plaid_txn_id: "x", amount_cents: 30, pending: 0 }, { plaid_txn_id: "y", amount_cents: -245001, pending: 1 }]);
  });

  it("never touches user tags when Plaid modifies a transaction", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")], added: [txn("t1", "a1")] }));
    await syncItem(E, config, item, { pages: 1 });
    const [{ id }] = await rows("SELECT id FROM transactions");
    await env.DB.prepare("INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, 'travel', 0)").bind(id).run();
    plaid.syncPages.push(page("c2", false, { accounts: [account("a1")], modified: [txn("t1", "a1", { amount: 99 })] }));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect(await rows("SELECT tag FROM transaction_tags")).toEqual([{ tag: "travel" }]);
    expect((await rows("SELECT amount_cents FROM transactions"))[0].amount_cents).toBe(9900);
  });

  it("resumes from the stored cursor", async () => {
    const item = await addItem({ cursor: "c8" });
    plaid.syncPages.push(page("c9", false));
    await syncItem(E, config, item, { pages: 5 });
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["c8"]);
  });

  it("stops at the page budget and resumes next run", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true), page("c2", true), page("c3", false));
    const budget = { pages: 2 };
    expect(await syncItem(E, config, item, budget)).toBe("partial");
    expect(budget.pages).toBe(0);
    expect((await itemById(item.id)).txn_cursor).toBe("c2");
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 2 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual([undefined, "c1", "c2"]);
  });

  it("keeps pages already saved when a later page fails transiently", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: [txn("t1", "a1")] }), plaidError("INTERNAL_SERVER_ERROR", 500, "API_ERROR"));
    expect(await syncItem(E, config, item, { pages: 5 })).toBe("retry");
    const after = await itemById(item.id);
    expect([after.txn_cursor, after.status]).toEqual(["c1", "good"]);
    expect(await rows("SELECT plaid_txn_id FROM transactions")).toEqual([{ plaid_txn_id: "t1" }]);
  });

  it.each([
    ["ITEM_LOGIN_REQUIRED", "login_required", "login_required"],
    ["ITEM_NOT_FOUND", "error", "error"],
    ["INTERNAL_SERVER_ERROR", "retry", "good"],         // Python marked this 'error' (and stopped syncing it)
    ["PRODUCT_NOT_READY", "retry", "good"],             // normal right after linking
    ["RATE_LIMIT_EXCEEDED", "retry", "good"],
  ])("maps %s to result %s and status %s", async (code, result, status) => {
    const item = await addItem();
    plaid.syncPages.push(plaidError(code));
    expect(await syncItem(E, config, item, { pages: 1 })).toBe(result);
    expect((await itemById(item.id)).status).toBe(status);
  });

  it("restarts pagination from the loop's first cursor on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", async () => {
    const item = await addItem({ cursor: "c0" });
    plaid.syncPages.push(page("c1", true), plaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", 400, "TRANSACTIONS_ERROR"),
      page("c1b", true), page("c2", false));
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["c0", "c1", "c0", "c1b"]);
  });

  it("marks an item whose token doesn't decrypt as error, without calling Plaid", async () => {
    const item = await addItem({ token: await fernetEncrypt("x", "dGhpcy1pcy1hbm90aGVyLXRlc3Qta2V5LTMyYnl0ZXM=") });
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("error");
    expect(plaid.calls).toEqual([]);
  });
});

describe("runSyncAll / cron", () => {
  it("sweeps syncable items least-recently-updated first, skipping errored, demo and removed users' items", async () => {
    const newer = await addItem({ updated_at: "2026-09-20T00:00:00.000Z" });
    const older = await addItem({ updated_at: "2026-09-10T00:00:00.000Z", plaid_account: "me_primary" });
    const relogin = await addItem({ status: "login_required", updated_at: "2026-09-15T00:00:00.000Z" });
    await addItem({ status: "error" });
    await addItem({ status: "demo" });
    const gone = await addItem({ owner: "alex", plaid_account: "alex_primary", updated_at: "2026-09-01T00:00:00.000Z" });
    plaid.syncPages.push(page("a", false), page("b", false), page("c", false));
    expect(await runSyncAll(E)).toEqual({ [gone.id]: "skipped", [older.id]: "good", [relogin.id]: "good", [newer.id]: "good" });
    expect(plaid.calls.map((c) => c.clientId)).toEqual(["cid_me_primary", "cid_me_backup", "cid_me_backup"]);
    expect((await itemById(relogin.id)).status).toBe("good");          // reconnected -> healthy again
  });

  it("shares one page budget across items", async () => {
    const a = await addItem({ updated_at: "2026-09-01T00:00:00.000Z" });
    const b = await addItem({ updated_at: "2026-09-02T00:00:00.000Z" });
    plaid.syncPages.push(page("a1", true), page("a2", true), page("b1", false));
    expect(await runSyncAll(E, { pages: 2 })).toEqual({ [a.id]: "partial" });
    expect((await itemById(b.id)).txn_cursor).toBeNull();
  });

  it("runs from the scheduled handler", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")], added: [txn("t1", "a1")] }));
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect((await itemById(item.id)).txn_cursor).toBe("c1");
  });
});
