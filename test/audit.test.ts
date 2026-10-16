import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { CLASSIFIED, accountMaps, markAuditDirty, refreshTotals, snapshotBalances } from "../src/audit/totals";
import type { Env } from "../src/env";

// CFA, phase C1 (docs/cfa.md): each transaction's bucket, the monthly totals the audit reads, and
// daily balance snapshots. Plaid's sign: positive = money out.
const E = env as unknown as Env;
const db = env.DB;
let acct: Record<string, number>;

async function setup() {
  await db.batch(["monthly_totals", "balance_snapshots", "bucket_overrides", "transaction_tags", "transactions", "accounts", "items"]
    .map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.prepare("DELETE FROM app_state WHERE key LIKE 'audit_%'").run();
  const item = (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, status)
    VALUES ('me', 'me_primary', 'item-audit', 'x', 'Bank', 'good') RETURNING id`).first<{ id: number }>())!.id;
  acct = {};
  for (const [key, type, subtype, owner] of [["checking", "depository", "checking", "me"], ["savings", "depository", "savings", "me"],
    ["card", "credit", "credit card", "me"], ["brokerage", "investment", "brokerage", "me"], ["spouse", "depository", "checking", "spouse"]]) {
    acct[key] = (await db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype, balance_current_cents)
      VALUES (?, ?, ?, ?, ?, ?, 100000) RETURNING id`).bind(owner, item, key, key, type, subtype).first<{ id: number }>())!.id;
  }
}
async function txn(account: string, date: string, cents: number, category: string | null, name: string, o: { merchant?: string; pending?: number } = {}) {
  const owner = account === "spouse" ? "spouse" : "me";
  return (await db.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, name, merchant_name, category, pending)
    VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?) RETURNING id`)
    .bind(owner, acct[account], crypto.randomUUID(), cents, date, name, o.merchant ?? null, category, o.pending ?? 0).first<{ id: number }>())!.id;
}
const buckets = async () => Object.fromEntries((await db.prepare(CLASSIFIED).bind("0000-01-01", ...await accountMaps(E)).all<{ id: number; bucket: string }>()).results.map((r) => [r.id, r.bucket]));
const totals = async () => (await db.prepare("SELECT month, owner, bucket, category, amount_cents, n FROM monthly_totals ORDER BY month, owner, bucket, category").all()).results;

beforeEach(setup);

describe("buckets", () => {
  it("spending, a refund, a paycheck, money in from outside", async () => {
    const coffee = await txn("card", "2026-09-03", 550, "FOOD_AND_DRINK", "Blue Bottle");
    const refund = await txn("card", "2026-09-05", -2000, "GENERAL_MERCHANDISE", "Store refund");
    const pay = await txn("checking", "2026-09-15", -400000, "INCOME", "Payroll");
    const venmo = await txn("checking", "2026-09-16", -2500, "TRANSFER_IN", "Venmo from a friend");
    const b = await buckets();
    expect([b[coffee], b[refund], b[pay], b[venmo]]).toEqual(["spend", "spend", "income", "income"]);
  });

  it("a card payment counts once: the purchases are spending, both sides of the payment are transfers", async () => {
    const out = await txn("checking", "2026-09-20", 120000, "LOAN_PAYMENTS", "Card autopay");
    const inn = await txn("card", "2026-09-21", -120000, "LOAN_PAYMENTS", "Payment thank you");
    const b = await buckets();
    expect([b[out], b[inn]]).toEqual(["transfer", "transfer"]);
  });

  it("a payment arriving on a card with no matching side is still a transfer; a loan payment out is debt", async () => {
    const received = await txn("card", "2026-09-21", -5000, "TRANSFER_IN", "Payment received");
    const mortgage = await txn("checking", "2026-09-01", 310000, "LOAN_PAYMENTS", "Home loan");
    const b = await buckets();
    expect([b[received], b[mortgage]]).toEqual(["transfer", "debt"]);
  });

  it("money into savings or investments is saving, and coming back out is negative saving", async () => {
    const toSavings = await txn("checking", "2026-09-02", 50000, "TRANSFER_OUT", "To savings");
    const arrives = await txn("savings", "2026-09-03", -50000, "TRANSFER_IN", "From checking");
    const toBrokerage = await txn("checking", "2026-09-10", 30000, "TRANSFER_OUT", "To brokerage");
    const atBrokerage = await txn("brokerage", "2026-09-10", -30000, "TRANSFER_IN", "Deposit");
    const out = await txn("savings", "2026-09-25", 20000, "TRANSFER_OUT", "To checking");
    const back = await txn("checking", "2026-09-27", -20000, "TRANSFER_IN", "From savings");
    const b = await buckets();
    expect([b[toSavings], b[arrives], b[toBrokerage], b[atBrokerage], b[out], b[back]])
      .toEqual(["saving", "transfer", "saving", "transfer", "transfer", "saving"]);
  });

  it("a move between two people's checking accounts is a transfer", async () => {
    const a = await txn("checking", "2026-09-05", 10000, "TRANSFER_OUT", "To spouse");
    const b2 = await txn("spouse", "2026-09-06", -10000, "TRANSFER_IN", "From me");
    const b = await buckets();
    expect([b[a], b[b2]]).toEqual(["transfer", "transfer"]);
  });

  it("the same amount the other way isn't a pair unless one side is a transfer, or it's more than 3 days apart", async () => {
    const purchase = await txn("card", "2026-09-05", 10000, "GENERAL_MERCHANDISE", "Store");
    const deposit = await txn("checking", "2026-09-06", -10000, "INCOME", "Side gig");
    const late = await txn("checking", "2026-09-01", 7000, "TRANSFER_OUT", "To savings, early");
    await txn("savings", "2026-09-08", -7000, "TRANSFER_IN", "Arrives a week later");
    const b = await buckets();
    expect([b[purchase], b[deposit]]).toEqual(["spend", "income"]);
    expect(b[late]).toBe("spend");                                       // unpaired TRANSFER_OUT: spending until corrected
  });

  it("a correction for a merchant wins, and pending transactions don't count", async () => {
    const betterment = await txn("checking", "2026-09-04", 25000, "TRANSFER_OUT", "BETTERMENT DEPOSIT", { merchant: "Betterment" });
    const pending = await txn("card", "2026-09-29", 999, "FOOD_AND_DRINK", "Pending lunch", { pending: 1 });
    await db.prepare("INSERT INTO bucket_overrides (merchant, bucket) VALUES ('BETTERMENT', 'saving')").run();
    const b = await buckets();
    expect(b[betterment]).toBe("saving");
    expect(b[pending]).toBeUndefined();
  });
});

describe("monthly totals", () => {
  it("sums per month, person, bucket and category", async () => {
    await txn("card", "2026-08-30", 1000, "FOOD_AND_DRINK", "A");
    await txn("card", "2026-09-01", 2000, "FOOD_AND_DRINK", "B");
    await txn("card", "2026-09-02", 3000, "FOOD_AND_DRINK", "C");
    await txn("spouse", "2026-09-02", 4000, "FOOD_AND_DRINK", "D");
    await txn("checking", "2026-09-15", -500000, "INCOME", "Payroll");
    expect(await refreshTotals(E)).toEqual({ from: "0000-01-01", full: true });     // the first run rebuilds everything
    expect(await totals()).toEqual([
      { month: "2026-08", owner: "me", bucket: "spend", category: "FOOD_AND_DRINK", amount_cents: 1000, n: 1 },
      { month: "2026-09", owner: "me", bucket: "income", category: "INCOME", amount_cents: -500000, n: 1 },
      { month: "2026-09", owner: "me", bucket: "spend", category: "FOOD_AND_DRINK", amount_cents: 5000, n: 2 },
      { month: "2026-09", owner: "spouse", bucket: "spend", category: "FOOD_AND_DRINK", amount_cents: 4000, n: 1 },
    ]);
  });

  it("after that, only from the month of what's new (3 days earlier, for a transfer's other side); nothing new, nothing done", async () => {
    await txn("card", "2026-06-10", 1000, "FOOD_AND_DRINK", "June");
    await refreshTotals(E);
    expect(await refreshTotals(E)).toEqual({ from: null, full: false });
    await txn("card", "2026-09-02", 2000, "FOOD_AND_DRINK", "September");
    expect(await refreshTotals(E)).toEqual({ from: "2026-08-30", full: false });   // August and on
    expect((await totals()).map((r: any) => r.month)).toEqual(["2026-06", "2026-09"]);
  });

  it("rebuilds every month after a correction, and once a week", async () => {
    await txn("checking", "2026-03-04", 25000, "TRANSFER_OUT", "BETTERMENT", { merchant: "Betterment" });
    await refreshTotals(E);
    expect((await totals())[0]).toMatchObject({ month: "2026-03", bucket: "spend" });
    await db.prepare("INSERT INTO bucket_overrides (merchant, bucket) VALUES ('BETTERMENT', 'saving')").run();
    await markAuditDirty(E);
    expect(await refreshTotals(E)).toEqual({ from: "0000-01-01", full: true });
    expect((await totals())[0]).toMatchObject({ month: "2026-03", bucket: "saving", amount_cents: 25000 });
    expect(await refreshTotals(E)).toEqual({ from: null, full: false });
    expect(await refreshTotals(E, new Date(Date.now() + 8 * 864e5))).toEqual({ from: "0000-01-01", full: true });
  });

  it("a removed transaction drops out at the weekly rebuild", async () => {
    const gone = await txn("card", "2026-09-02", 2000, "FOOD_AND_DRINK", "Removed by the bank");
    await refreshTotals(E);
    await db.prepare("DELETE FROM transactions WHERE id = ?").bind(gone).run();
    await refreshTotals(E, new Date(Date.now() + 8 * 864e5));
    expect(await totals()).toEqual([]);
  });
});

describe("balance snapshots", () => {
  it("one per account a day, written only when the balance changed", async () => {
    expect(await snapshotBalances(E)).toBe(5);
    expect(await snapshotBalances(E)).toBe(0);
    await db.prepare("UPDATE accounts SET balance_current_cents = 99000 WHERE id = ?").bind(acct.checking).run();
    expect(await snapshotBalances(E)).toBe(1);
    const rows = (await db.prepare("SELECT account_id, current_cents FROM balance_snapshots WHERE account_id = ?").bind(acct.checking).all()).results;
    expect(rows).toEqual([{ account_id: acct.checking, current_cents: 99000 }]);
  });

  it("older than a year, only Sundays are kept (thinned in the first run after midnight UTC)", async () => {
    const ins = db.prepare("INSERT INTO balance_snapshots (account_id, date, current_cents) VALUES (?, ?, 1)");
    await db.batch(["2025-01-05", "2025-01-06", "2025-01-07"].map((d) => ins.bind(acct.checking, d)));   // a Sunday, then Monday and Tuesday
    await snapshotBalances(E, new Date("2026-10-16T00:17:00Z"));
    const kept = (await db.prepare("SELECT date FROM balance_snapshots WHERE account_id = ? AND date < '2026-01-01'").bind(acct.checking).all()).results;
    expect(kept).toEqual([{ date: "2025-01-05" }]);
  });
});

describe("the hourly cron", () => {
  it("snapshots balances and refreshes the totals after sync; the catch-up run doesn't", async () => {
    await txn("card", "2026-09-02", 2000, "FOOD_AND_DRINK", "Lunch");
    await db.prepare("UPDATE items SET status = 'error'").run();          // nothing to sync or check with Plaid
    const run = async (cron: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ cron }), E, ctx);
      await waitOnExecutionContext(ctx);
    };
    await run("*/10 * * * *");
    expect(await totals()).toEqual([]);
    await run("17 * * * *");
    expect((await totals()).length).toBe(1);
    expect((await db.prepare("SELECT count(*) AS n FROM balance_snapshots").first<{ n: number }>())!.n).toBe(5);
  });
});
