import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { loadConfig } from "../src/config";
import { fernetEncrypt } from "../src/fernet";
import { CATCH_UP_CRON, runSyncAll, syncItem, type ItemRow } from "../src/sync";
import type { Env } from "../src/env";
import { FakePlaid, account, page, plaidError, txn } from "./fake-plaid";

// Cursor-based sync, against a real local D1.
const E = env as unknown as Env;
const config = loadConfig(E);
let plaid: FakePlaid;

async function wipe() {
  await env.DB.batch(["transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

async function addItem(o: { owner?: string; plaid_account?: string; cursor?: string | null; start?: string | null; status?: string;
                              token?: string; updated_at?: string; attempted_at?: string } = {}): Promise<ItemRow> {
  const enc = o.token ?? await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!);
  return (await env.DB.prepare(
    `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, txn_cursor, sync_start_cursor, status, updated_at, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(o.owner ?? "me", o.plaid_account ?? "me_backup", `item-${crypto.randomUUID()}`, enc, o.cursor ?? null, o.start ?? null,
    o.status ?? "good", o.updated_at ?? "2026-09-01T00:00:00.000Z", o.attempted_at ?? null).first<ItemRow>())!;
}

const mutation = () => plaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", 400, "TRANSACTIONS_ERROR");

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
    expect(plaid.calls[0].body).toMatchObject({ access_token: "access-sandbox-secret", count: 100 });
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

  it("stores Plaid's account_owner (the card member on multi-card accounts), and updates it on modify", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")], added: [
      txn("main", "a1", { account_owner: "ALEX MORGAN" }),
      txn("au", "a1", { account_owner: "SAM MORGAN -1013" }),
      txn("none", "a1"),                                         // most banks leave it out
      txn("nul", "a1", { account_owner: null }),
    ] }));
    await syncItem(E, config, item, { pages: 1 });
    expect(await rows("SELECT plaid_txn_id, account_owner FROM transactions ORDER BY plaid_txn_id")).toEqual([
      { plaid_txn_id: "au", account_owner: "SAM MORGAN -1013" },
      { plaid_txn_id: "main", account_owner: "ALEX MORGAN" },
      { plaid_txn_id: "none", account_owner: null },
      { plaid_txn_id: "nul", account_owner: null },
    ]);
    plaid.syncPages.push(page("c2", false, { accounts: [account("a1")], modified: [txn("none", "a1", { account_owner: "SAM MORGAN -1013" })] }));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect((await rows("SELECT account_owner FROM transactions WHERE plaid_txn_id = 'none'"))[0].account_owner).toBe("SAM MORGAN -1013");
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
    ["INTERNAL_SERVER_ERROR", "retry", "good"],         // transient: retried, not marked 'error'
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
    plaid.syncPages.push(page("c1", true), mutation(), page("c1b", true), page("c2", false));
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["c0", "c1", "c0", "c1b"]);
  });

  it("stops when the run's byte budget is spent, then resumes next run", async () => {
    const item = await addItem();
    const big = Array.from({ length: 50 }, (_, i) => txn(`b-${i}`, "a1"));
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: big }), page("c2", true), page("c3", false));
    const budget = { pages: 10, bytes: 1_000 };                     // smaller than one page
    expect(await syncItem(E, config, item, budget)).toBe("partial");
    expect(plaid.calls).toHaveLength(1);                             // always at least one page
    expect(budget.bytes).toBeLessThanOrEqual(0);
    expect((await itemById(item.id)).txn_cursor).toBe("c1");
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 10, bytes: 1_000_000 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual([undefined, "c1", "c2"]);
  });

  it("uses SYNC_MAX_BYTES_PER_RUN / SYNC_MAX_PAGES_PER_RUN for the cron budget", async () => {
    await addItem();
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: [txn("t1", "a1")] }), page("c2", true), page("c3", false));
    await runSyncAll({ ...E, SYNC_MAX_BYTES_PER_RUN: "1", SYNC_MAX_PAGES_PER_RUN: "10" });
    expect(plaid.calls).toHaveLength(1);
    plaid.calls = [];
    await wipe(); await addItem();
    plaid.syncPages = [page("c1", true), page("c2", true), page("c3", false)];
    await runSyncAll({ ...E, SYNC_MAX_PAGES_PER_RUN: "2" });
    expect(plaid.calls).toHaveLength(2);
  });

  it("leaves no scratch rows behind (full sync and budget cut-off)", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: [txn("t1", "a1")] }), page("c2", true));
    expect(await syncItem(E, config, item, { pages: 2 })).toBe("partial");
    expect(await rows("SELECT * FROM sync_pages")).toEqual([]);
  });

  it.each([
    ["not JSON at all", "<html>oops</html>"],
    ["JSON without a next_cursor", { added: [], has_more: false }],
    ["a JSON string", "just text"],
  ])("never moves the cursor or writes anything for a malformed page (%s)", async (_, body) => {
    const item = await addItem({ cursor: "c5" });
    plaid.syncPages.push(page("c6", true, { accounts: [account("a1")], added: [txn("t1", "a1")] }));
    plaid.syncPages[0] = { body };
    expect(await syncItem(E, config, item, { pages: 3 })).toBe("retry");
    expect((await itemById(item.id))).toMatchObject({ txn_cursor: "c5", status: "good" });
    expect(await rows("SELECT * FROM transactions")).toEqual([]);
    expect(await rows("SELECT * FROM sync_pages")).toEqual([]);
    expect(plaid.calls).toHaveLength(1);                             // stops; the next run retries
  });

  it("persists a large page (500 transactions) exactly", async () => {
    const item = await addItem();
    const added = Array.from({ length: 500 }, (_, i) => txn(`big-${i}`, i % 2 ? "a1" : "a2", { amount: i + 0.01 }));
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1"), account("a2")], added }));
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("good");
    const [{ n, total }] = await rows("SELECT count(*) AS n, sum(amount_cents) AS total FROM transactions");
    expect(n).toBe(500);
    expect(total).toBe(Array.from({ length: 500 }, (_, i) => i * 100 + 1).reduce((a, b) => a + b, 0));
    expect((await itemById(item.id)).txn_cursor).toBe("c1");
  });

  it("marks an item whose token doesn't decrypt as error, without calling Plaid", async () => {
    const item = await addItem({ token: await fernetEncrypt("x", "dGhpcy1pcy1hbm90aGVyLXRlc3Qta2V5LTMyYnl0ZXM=") });
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("error");
    expect(plaid.calls).toEqual([]);
  });
});

describe("updates spread over several runs (TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION)", () => {
  it("keeps the cursor an update began from until it's caught up", async () => {
    const item = await addItem({ cursor: "c5" });
    plaid.syncPages.push(page("c6", true), page("c7", true), page("c8", false));
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("partial");
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c6", sync_start_cursor: "c5" });
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 1 })).toBe("partial");
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c7", sync_start_cursor: "c5" });
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 1 })).toBe("good");
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c8", sync_start_cursor: null });
  });

  it("records the first history download as starting from the beginning ('')", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true));
    await syncItem(E, config, item, { pages: 1 });
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c1", sync_start_cursor: "" });
  });

  it("restarts a history download from the beginning when Plaid's data changed between runs", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: [txn("old", "a1")] }));
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("partial");          // run 1, e.g. at link time
    plaid.syncPages.push(mutation(), page("r1", true, { accounts: [account("a1")], added: [txn("old", "a1")] }),
      page("r2", false, { accounts: [account("a1")], added: [txn("new", "a1")] }));
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 10 })).toBe("good");   // run 2
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual([undefined, "c1", undefined, "r1"]);
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "r2", sync_start_cursor: null, last_error: null, status: "good" });
    expect(await rows("SELECT plaid_txn_id FROM transactions ORDER BY plaid_txn_id")).toEqual([{ plaid_txn_id: "new" }, { plaid_txn_id: "old" }]);
  });

  it("restarts a later update from its own start, not from the beginning", async () => {
    const item = await addItem({ cursor: "c6", start: "c5" });
    plaid.syncPages.push(mutation(), page("c6b", false));
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["c6", "c5"]);
  });

  it("restarts from the beginning when the start isn't on record (downloads from before migration 0004)", async () => {
    const item = await addItem({ cursor: "stuck-mid-download" });
    plaid.syncPages.push(mutation(), page("r1", false));
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["stuck-mid-download", undefined]);
  });

  it("saves the restart point when the run's budget ends at the error", async () => {
    const item = await addItem({ cursor: "c1", start: "" });
    plaid.syncPages.push(mutation());
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("partial");
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: null, sync_start_cursor: "",
      last_error: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", status: "good" });
    plaid.syncPages.push(page("r1", false));
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 1 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["c1", undefined]);
  });

  it("restarts at most once per run, then records the error and leaves the last successful sync alone", async () => {
    const item = await addItem({ cursor: "c1", start: "" });
    plaid.syncPages.push(mutation(), mutation());
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("retry");
    expect(plaid.calls).toHaveLength(2);
    const after = await itemById(item.id);
    expect(after).toMatchObject({ status: "good", updated_at: "2026-09-01T00:00:00.000Z",
      last_error: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", txn_cursor: null, sync_start_cursor: "" });
    expect(after.attempted_at).toBeTruthy();
    expect(after.last_error_at).toBeTruthy();
  });

  it("records other failures without retrying them in the same run", async () => {
    const item = await addItem({ cursor: "c1" });
    plaid.syncPages.push(plaidError("INTERNAL_SERVER_ERROR", 500, "API_ERROR"));
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("retry");
    expect(plaid.calls).toHaveLength(1);
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c1", last_error: "INTERNAL_SERVER_ERROR",
      updated_at: "2026-09-01T00:00:00.000Z" });
  });
});

describe("syncItem with more slots", () => {
  it("syncs an item on a third slot with that slot's keys, and skips it once the slot is removed", async () => {
    const e = { ...E, PLAID_SLOTS: "primary,backup,extra1", PLAID_CLIENT_ID_ME_EXTRA1: "cid_me_extra1", PLAID_SECRET_ME_EXTRA1: "s" };
    const item = await addItem({ plaid_account: "me_extra1" });
    plaid.syncPages.push(page("c1", false));
    expect(await syncItem(e, loadConfig(e), item, { pages: 1 })).toBe("good");
    expect(plaid.calls[0].clientId).toBe("cid_me_extra1");
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 1 })).toBe("skipped");   // default slots only
    expect((await itemById(item.id)).status).toBe("good");                                          // untouched, not errored
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

  it("puts a bank that failed behind the others, so it can't hold them up", async () => {
    const stuck = await addItem({ cursor: "mid", updated_at: "2026-09-01T00:00:00.000Z" });
    const ok = await addItem({ cursor: "k1", updated_at: "2026-09-02T00:00:00.000Z" });
    plaid.syncPages.push(plaidError("INTERNAL_SERVER_ERROR", 500, "API_ERROR"));
    expect(await runSyncAll(E, { pages: 1 })).toEqual({ [stuck.id]: "retry" });
    plaid.syncPages.push(page("k2", false));
    expect(await runSyncAll(E, { pages: 1 })).toEqual({ [ok.id]: "good" });           // ok goes first now
  });

  it("syncs caught-up banks before unfinished downloads in the hourly sweep", async () => {
    const downloading = await addItem({ cursor: "d1", start: "", attempted_at: "2026-09-01T00:00:00.000Z" });
    const caughtUp = await addItem({ cursor: "k1", attempted_at: "2026-09-05T00:00:00.000Z" });
    plaid.syncPages.push(page("k2", false), page("d2", false));
    expect(await runSyncAll(E, { pages: 10 })).toEqual({ [caughtUp.id]: "good", [downloading.id]: "good" });
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["k1", "d1"]);   // caught-up first, though attempted later
  });

  it("catch-up runs only continue unfinished downloads", async () => {
    await addItem({ cursor: "k1" });
    const downloading = await addItem({ cursor: "d1", start: "" });
    plaid.syncPages.push(page("d2", false));
    expect(await runSyncAll(E, { pages: 10 }, { updatesOnly: true })).toEqual({ [downloading.id]: "good" });
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["d1"]);
    plaid.calls = [];
    expect(await runSyncAll(E, { pages: 10 }, { updatesOnly: true })).toEqual({});   // caught up: no Plaid calls
    expect(plaid.calls).toEqual([]);
  });

  it("the catch-up trigger syncs only downloads; the hourly one syncs every bank", async () => {
    const caughtUp = await addItem({ cursor: "k1" });
    const downloading = await addItem({ cursor: "d1", start: "" });
    const run = async (cron: string, e: Env = E) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ cron }), e, ctx);
      await waitOnExecutionContext(ctx);
    };
    plaid.syncPages.push(page("d2", true));
    await run(CATCH_UP_CRON, { ...E, SYNC_MAX_PAGES_PER_RUN: "1" });
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["d1"]);
    plaid.syncPages.push(page("k2", false), page("d3", false));
    await run("17 * * * *");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["d1", "k1", "d2"]);
    expect((await itemById(caughtUp.id)).txn_cursor).toBe("k2");
    expect((await itemById(downloading.id))).toMatchObject({ txn_cursor: "d3", sync_start_cursor: null });
  });
});
