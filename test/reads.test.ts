import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { call } from "./helpers";
import { FakePlaid, account, page, txn } from "./fake-plaid";
import { fernetEncrypt } from "../src/fernet";
import { runSyncAll } from "../src/sync";
import { vi } from "vitest";
import { pruneReadCounts, readsToday } from "../src/limits";

// D1 bills rows read: the free plan allows 5,000,000 a day, and one slow query used them up
// (ABC's first version read hundreds of thousands of rows per request). Every page-facing route
// gets a budget here, measured on a large made-up household.

const TXNS = 7000;

/** A D1 that adds up meta.rows_read for every statement a request runs. */
function counting(db: D1Database) {
  const tally = { rows: 0, statements: 0 };
  const note = (r: any) => { tally.rows += r?.meta?.rows_read ?? 0; tally.statements++; return r; };
  const wrap = (s: D1PreparedStatement): any => ({
    __inner: s,
    bind: (...a: unknown[]) => wrap(s.bind(...a)),
    all: async () => note(await s.all()),
    run: async () => note(await s.run()),
    raw: async (o?: any) => { note(await s.all()); return s.raw(o); },
    first: async (col?: string) => { const r = note(await s.all()); const row = r.results[0] ?? null; return col && row ? row[col] : row; },
  });
  const proxy = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (stmts: any[]) => (await db.batch(stmts.map((x) => x.__inner))).map(note),
    exec: (sql: string) => db.exec(sql),
    dump: () => (db as any).dump(),
  };
  return { db: proxy as unknown as D1Database, tally };
}

async function readsOf(path: string, init: RequestInit = {}) {
  const { db, tally } = counting(env.DB);
  const r = await call(path, { ...init, envOverrides: { DB: db } as Partial<Env> });
  expect(r.status, path).toBe(200);
  return tally.rows;
}

beforeAll(async () => {
  const db = env.DB;
  await db.batch(["card_statements", "statement_sync", "benefit_marks", "card_products", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  // The first three are banks ABC's catalog recognises (src/benefits/catalog.ts); the rest are made up.
  const banks = ["American Express", "Citibank Online", "U.S. Bank", "Example Bank A", "Example Bank B", "Example Bank C", "Example Bank D", "Example Bank E"];
  await db.batch(banks.map((b, i) => db.prepare(
    `INSERT INTO items (id, owner, plaid_account, plaid_item_id, access_token_enc, institution_name, txn_cursor, status, updated_at)
     VALUES (?, 'me', 'me_primary', ?, 'x', ?, 'c', 'good', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).bind(i + 1, `item-${i}`, b)));
  const names = ["Business Platinum Card®", "Business Platinum Card®", "Charles Schwab Platinum Card®", "Business Gold Card", "Business Gold Card",
    "Blue Business Plus Card", "Credit Card - 1234", ...Array.from({ length: 21 }, (_, k) => `Card ${k}`)];
  await db.batch(names.map((n, i) => db.prepare(
    `INSERT INTO accounts (id, owner, item_id, plaid_account_id, name, mask, type, subtype) VALUES (?, 'me', ?, ?, ?, ?, 'credit', 'credit card')`)
    .bind(i + 1, i < 6 ? 1 : i === 6 ? 3 : 2 + (i % 6), `acct-${i}`, n, String(9000 + i))));
  const merchants = ["WHOLE FOODS", "Uber", "GRUBHUB*ORDER", "Staples", "DELL INC", "Platinum Resy Credit", "FLEXIBLE BUSINESS CREDIT",
    "AMEX Wireless Credit", "T-Mobile", "Hilton", "Walmart", "Shell", "Amazon", "Target", "Annual Travel/dining Credit (p To $325)"];
  const rows = Array.from({ length: TXNS }, (_, n) => {
    const name = merchants[n % merchants.length];
    const date = new Date(Date.UTC(2024, 9, 1) + n * 9 * 3.6e6).toISOString().slice(0, 10);
    return [1 + (n % names.length), `t${n}`, name.includes("Credit") ? -2000 : 1000 + (n % 7000), date, name, n % 3 ? name : null,
            // card members only on the Amex accounts, as Plaid sends them
            (n % names.length) < 6 && n % 3 === 0 ? `MEMBER ${n % 4}` : null];
  });
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    await db.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name, merchant_name, account_owner)
      SELECT 'me', j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3, j.value ->> 4, j.value ->> 5, j.value ->> 6 FROM json_each(?) j`)
      .bind(JSON.stringify(chunk)).run();
  }
  expect((await db.prepare("SELECT count(*) AS n FROM transactions").first<{ n: number }>())!.n).toBe(TXNS);
  // A year of monthly statements on every card, for /bills (docs/bills.md).
  await db.prepare(`INSERT INTO card_statements (account_id, issue_date, balance_cents, minimum_payment_cents, due_date, first_seen_at, last_seen_at)
    SELECT a.id, date('2025-01-05', '+' || m.value || ' months'), 50000 + a.id, 3500, date('2025-01-30', '+' || m.value || ' months'), 'x', 'x'
    FROM accounts a, json_each('[0,1,2,3,4,5,6,7,8,9,10,11]') m WHERE a.type = 'credit'`).run();
  await db.prepare("INSERT INTO statement_sync (item_id, status) SELECT id, 'ready' FROM items").run();
});

describe("D1 rows read per request (budgets)", () => {
  it.each([
    ["/benefits", 3000],                 // only the tracked cards' rows, once each (the first version read every row once per pattern)
    ["/statements", 100],                // one row per bank
    ["/bills", 7000],                    // 28 cards x 12 statements: each window an index range (an OR there read 85,000)
    ["/health", 100],
    ["/items", 100],
    ["/transactions", 2500],             // newest 500, via the date index
    ["/transactions?before=2025-06-01:3000", 2500],   // the next page, via the same index
    ["/accounts", 3500],                 // card members: only accounts that have some
    ["/status", 3500],
    ["/tags", 100],
    ["/users", 10],
    ["/capacity", 100],
    ["/sync-request", 40],
  ])("%s reads at most %i rows", async (path, budget) => {
    const rows = await readsOf(path);
    console.warn(`${path}: ${rows} rows read`);
    expect(rows, `${path} read ${rows} rows`).toBeLessThanOrEqual(budget);
  });
});

describe("D1 rows read by the cron", () => {
  it("a full sync page (100 transactions) and the catch-up check stay small", async () => {
    const plaid = new FakePlaid().install();
    try {
      const enc = await fernetEncrypt("access-sandbox-secret", (env as unknown as Env).TOKEN_ENC_KEY!);
      await env.DB.prepare("UPDATE items SET access_token_enc = ?, plaid_account = 'me_primary', updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 1").bind(enc).run();
      await env.DB.prepare("UPDATE items SET status = 'demo' WHERE id <> 1").run();
      plaid.syncPages.push(page("c2", false, { accounts: [account("acct-0")], added: Array.from({ length: 100 }, (_, i) => txn(`new-${i}`, "acct-0")),
        modified: [txn("t0", "acct-0", { amount: 1 })], removed: ["t28"] }));
      const { db, tally } = counting(env.DB);
      await runSyncAll({ ...(env as unknown as Env), DB: db }, { pages: 1 });
      console.warn(`sync page: ${tally.rows} rows read`);   // 332 when written
      expect(tally.rows).toBeLessThanOrEqual(600);
      const quiet = counting(env.DB);
      await runSyncAll({ ...(env as unknown as Env), DB: quiet.db }, { pages: 1 }, { updatesOnly: true });
      expect(quiet.tally.rows).toBeLessThanOrEqual(20);           // the 10-minute trigger, nothing downloading
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("D1 rows read by the read budget (src/limits.ts)", () => {
  it("the day's counter is one primary-key read, and pruning old ones stays small", async () => {
    const lookup = counting(env.DB);
    await readsToday(lookup.db);
    expect(lookup.tally.rows).toBeLessThanOrEqual(1);
    const prune = counting(env.DB);
    await pruneReadCounts(prune.db);
    expect(prune.tally.rows).toBeLessThanOrEqual(20);
  });
});

describe("D1 rows read by Link sessions (src/routes/link.ts)", () => {
  it("reserving a slot and cancelling stay small", async () => {
    const plaid = new FakePlaid().install();
    try {
      const reserve = counting(env.DB);
      const r = await call("/link/token", { method: "POST", body: JSON.stringify({ owner: "me" }), envOverrides: { DB: reserve.db } as Partial<Env> });
      expect(r.status).toBe(200);
      expect(reserve.tally.rows).toBeLessThanOrEqual(100);
      const { session_id } = await r.json() as { session_id: string };
      const cancel = counting(env.DB);
      await call("/link/cancel", { method: "POST", body: JSON.stringify({ session_id }), envOverrides: { DB: cancel.db } as Partial<Env> });
      expect(cancel.tally.rows).toBeLessThanOrEqual(20);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

