import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { call } from "./helpers";
import { FakePlaid, account, page, txn } from "./fake-plaid";
import { fernetEncrypt } from "../src/fernet";
import { runSyncAll } from "../src/sync";
import { vi } from "vitest";

// D1 bills rows read: the free plan allows 5,000,000 a day, and one slow query used them up
// (ABC's first version read ~463,000 rows per request). Every page-facing route gets a budget
// here, measured on a made-up household the size of a real one (~7,000 transactions).

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
  await db.batch(["benefit_marks", "card_products", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  const banks = ["American Express", "Citibank Online", "U.S. Bank", "Bank of America", "Wells Fargo", "Barclays - Cards", "Navy Federal Credit Union", "Taekus"];
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
            // card members only on the Amex accounts, as in real data
            (n % names.length) < 6 && n % 3 === 0 ? `MEMBER ${n % 4}` : null];
  });
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    await db.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name, merchant_name, account_owner)
      SELECT 'me', j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3, j.value ->> 4, j.value ->> 5, j.value ->> 6 FROM json_each(?) j`)
      .bind(JSON.stringify(chunk)).run();
  }
  expect((await db.prepare("SELECT count(*) AS n FROM transactions").first<{ n: number }>())!.n).toBe(TXNS);
});

describe("D1 rows read per request (budgets)", () => {
  it.each([
    ["/benefits", 3000],                 // only the tracked cards' rows, once each (was ~463,000 on a real household)
    ["/health", 100],
    ["/items", 100],
    ["/transactions", 2500],             // newest 500, via the date index
    ["/accounts", 3500],                 // card members: only accounts that have some
    ["/status", 3500],
    ["/tags", 100],
    ["/users", 10],
    ["/capacity", 100],
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
