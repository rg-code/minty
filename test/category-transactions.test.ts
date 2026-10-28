import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { refreshTotals } from "../src/audit/totals";
import type { Env } from "../src/env";
import { getJson } from "./helpers";

// GET /audit/transactions (docs/cfa.md): the transactions behind a figure, so CFA's categories and
// the dashboard's donut can list them, and they add up to what's shown.
const E = env as unknown as Env;
const db = env.DB;
let acct: Record<string, number>;
const list = (q: string) => getJson<any>(`/audit/transactions?${q}`);

async function txn(account: string, date: string, cents: number, category: string | null, name: string, o: { owner?: string; tags?: string[] } = {}) {
  const id = (await db.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, name, category, pending)
    VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, 0) RETURNING id`).bind(o.owner ?? "me", acct[account], crypto.randomUUID(), cents, date, name, category).first<{ id: number }>())!.id;
  for (const [i, t] of (o.tags ?? []).entries()) await db.prepare("INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, ?, ?)").bind(id, t, i).run();
  return id;
}

beforeEach(async () => {
  await db.batch(["analytics_exclusions", "recurring_charges", "net_worth", "monthly_totals", "balance_snapshots", "bucket_overrides", "transaction_tags", "transactions", "accounts", "items"]
    .map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.prepare("DELETE FROM app_state WHERE key LIKE 'audit_%' OR key = 'networth_dirty'").run();
  const item = (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, status)
    VALUES ('me', 'me_primary', 'item-c', 'x', 'Chase', 'good') RETURNING id`).first<{ id: number }>())!.id;
  acct = {};
  for (const [key, type, subtype] of [["checking", "depository", "checking"], ["card", "credit", "credit card"]]) {
    acct[key] = (await db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype) VALUES ('me', ?, ?, ?, ?, ?) RETURNING id`)
      .bind(item, key, key === "card" ? "Sapphire" : "Checking", type, subtype).first<{ id: number }>())!.id;
  }
});

describe("GET /audit/transactions", () => {
  it("a category's spending in a date range, newest first, adding up to the monthly total", async () => {
    await txn("card", "2026-09-03", 1500, "ENTERTAINMENT", "Cinema");
    await txn("card", "2026-09-20", 4000, "ENTERTAINMENT", "Concert");
    await txn("card", "2026-09-21", -1000, "ENTERTAINMENT", "Concert refund");                   // a refund: negative spending
    await txn("card", "2026-10-02", 2500, "ENTERTAINMENT", "Next month");
    await txn("card", "2026-09-05", 9000, "FOOD_AND_DRINK", "Dinner");
    await refreshTotals(E);
    const { status, body } = await list("category=ENTERTAINMENT&from=2026-09-01&to=2026-09-30");
    expect(status).toBe(200);
    expect(body.transactions.map((t: any) => [t.date, t.name, t.amount_cents])).toEqual([["2026-09-21", "Concert refund", -1000], ["2026-09-20", "Concert", 4000], ["2026-09-03", "Cinema", 1500]]);
    expect(body.transactions[0]).toMatchObject({ account_name: "Sapphire", institution_name: "Chase", owner: "me" });
    const month = await db.prepare("SELECT sum(amount_cents) AS c FROM monthly_totals WHERE month = '2026-09' AND bucket = 'spend' AND category = 'ENTERTAINMENT'").first<{ c: number }>();
    expect(body.total_cents).toBe(month!.c);
  });

  it("follows the audit: a corrected merchant, a card payment and what's left out aren't spending", async () => {
    await txn("card", "2026-09-03", 3000, "ENTERTAINMENT", "Netflix");
    await txn("card", "2026-09-04", 2000, "ENTERTAINMENT", "Sync thing", { tags: ["Sync"] });
    await txn("card", "2026-09-05", 1200, "ENTERTAINMENT", "Kept");
    await db.prepare("INSERT INTO bucket_overrides (merchant, bucket) VALUES ('NETFLIX', 'transfer')").run();
    await db.prepare("INSERT INTO analytics_exclusions (kind, value) VALUES ('tag', 'sync')").run();
    const { body } = await list("category=ENTERTAINMENT&from=2026-09-01&to=2026-09-30");
    expect(body.transactions.map((t: any) => t.name)).toEqual(["Kept"]);
    expect((await list("category=ENTERTAINMENT&from=2026-09-01&to=2026-09-30&bucket=transfer")).body.transactions.map((t: any) => t.name)).toEqual(["Netflix"]);
  });

  it("statement credits and interest are found under BANK_FEES; OTHER is what has no category; several at once; one person", async () => {
    await txn("card", "2026-09-03", -1500, "BANK_FEES", "Uber credit");
    await txn("card", "2026-09-04", 2300, "BANK_FEES", "INTEREST CHARGE");
    await txn("card", "2026-09-05", 9500, "BANK_FEES", "Annual fee");
    await txn("card", "2026-09-06", 700, null, "Mystery");
    await txn("checking", "2026-09-07", 400, null, "Spouse's mystery", { owner: "spouse" });
    const names = async (q: string) => (await list(q)).body.transactions.map((t: any) => t.name).sort();
    expect(await names("category=CREDITS&from=2026-09-01&to=2026-09-30")).toEqual(["Uber credit"]);
    expect(await names("category=INTEREST,BANK_FEES&from=2026-09-01&to=2026-09-30")).toEqual(["Annual fee", "INTEREST CHARGE"]);
    expect(await names("category=OTHER&from=2026-09-01&to=2026-09-30")).toEqual(["Mystery", "Spouse's mystery"]);
    expect(await names("category=OTHER&from=2026-09-01&to=2026-09-30&owner=me")).toEqual(["Mystery"]);
  });

  it("refuses what it can't answer", async () => {
    for (const q of ["from=2026-09-01&to=2026-09-30", "category=food&from=2026-09-01&to=2026-09-30", "category=FOOD_AND_DRINK&from=2026-09-30&to=2026-09-01",
      "category=FOOD_AND_DRINK&from=2020-01-01&to=2026-09-01", "category=FOOD_AND_DRINK&from=2026-09-01&to=2026-09-30&owner=nobody", "category=FOOD_AND_DRINK&from=2026-09-01&to=2026-09-30&bucket=fun"]) {
      expect((await list(q)).status, q).toBe(422);
    }
  });
});
