import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getJson } from "./helpers";

// The dashboard's "Left out" view (GET /audit/left-out) and the 1M range's days (GET /audit/daily).
const db = env.DB;
let acct: Record<string, number>, bank: number;

async function txn(account: string, date: string, cents: number, category: string, name: string, tags: string[] = [], owner = "me") {
  const id = (await db.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, name, category, pending)
    VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, 0) RETURNING id`).bind(owner, acct[account], crypto.randomUUID(), cents, date, name, category).first<{ id: number }>())!.id;
  for (const [i, t] of tags.entries()) await db.prepare("INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, ?, ?)").bind(id, t, i).run();
  return id;
}

beforeEach(async () => {
  await db.batch(["analytics_exclusions", "bucket_overrides", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  const item = (n: string) => db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, status)
    VALUES ('me', 'me_primary', ?, 'x', ?, 'good') RETURNING id`).bind(`item-${n}`, n).first<{ id: number }>().then((r) => r!.id);
  bank = await item("Capital One");
  const other = await item("Chase");
  acct = {};
  for (const [k, it, type] of [["cap1", bank, "credit"], ["card", other, "credit"], ["checking", other, "depository"]] as const) {
    acct[k] = (await db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype) VALUES ('me', ?, ?, ?, ?, ?) RETURNING id`)
      .bind(it, k, k, type, type === "credit" ? "credit card" : "checking").first<{ id: number }>())!.id;
  }
  await txn("card", "2026-09-03", 5000, "ENTERTAINMENT", "Concert", ["sync"]);
  await txn("card", "2026-10-04", 2500, "ENTERTAINMENT", "Movie", ["SYNC"]);
  await txn("cap1", "2026-09-10", 40000, "TRAVEL", "Hotel", ["sync"]);                       // a left-out bank and a left-out tag: counted once, under the bank
  await txn("cap1", "2026-09-11", 9000, "TRAVEL", "Flight");
  await txn("checking", "2026-09-12", -300000, "INCOME", "Payroll", ["sync"]);
  await txn("card", "2026-09-13", 1200, "FOOD_AND_DRINK", "Lunch");                           // counted: not in the view
  await db.prepare("INSERT INTO analytics_exclusions (kind, value) VALUES ('tag', 'sync'), ('bank', ?)").bind(String(bank)).run();
});

describe("GET /audit/left-out", () => {
  it("left-out spending by month and by what left it out, each transaction once; the rest by bucket", async () => {
    const { status, body } = await getJson<any>("/audit/left-out?from=2026-09-01&to=2026-10-31");
    expect(status).toBe(200);
    expect(body.spend).toEqual({ "2026-09": { "tag:sync": 5000, [`bank:${bank}`]: 49000 }, "2026-10": { "tag:sync": 2500 } });
    expect(body.other).toEqual({ "2026-09": { income: -300000 } });
    expect(body.left_out.sort()).toEqual([`bank:${bank}`, "tag:sync"].sort());
  });

  it("by day, for the 1M range; and one item's transactions, listed", async () => {
    expect((await getJson<any>("/audit/left-out?from=2026-09-01&to=2026-09-30&by=day")).body.spend["2026-09-10"]).toEqual({ [`bank:${bank}`]: 40000 });
    const { body } = await getJson<any>(`/audit/left-out?from=2026-09-01&to=2026-10-31&item=${encodeURIComponent(`bank:${bank}`)}`);
    expect(body).toMatchObject({ count: 2, total_cents: 49000 });
    expect(body.transactions.map((t: any) => [t.name, t.institution_name])).toEqual([["Flight", "Capital One"], ["Hotel", "Capital One"]]);
    expect((await getJson<any>("/audit/left-out?from=2026-09-01&to=2026-10-31&item=tag:other")).status).toBe(422);
  });

  it("nothing left out: nothing to show", async () => {
    await db.prepare("DELETE FROM analytics_exclusions").run();
    expect((await getJson<any>("/audit/left-out?from=2026-09-01&to=2026-10-31")).body).toMatchObject({ spend: {}, other: {}, left_out: [] });
  });
});

describe("GET /audit/daily", () => {
  it("counted spending by day and category, without what's left out", async () => {
    const { body } = await getJson<any>("/audit/daily?from=2026-09-01&to=2026-09-30");
    expect(body.days).toEqual({ "2026-09-13": { FOOD_AND_DRINK: 1200 } });
    expect((await getJson<any>("/audit/daily?from=2026-01-01&to=2026-09-30")).status).toBe(422);     // at most about two months
  });
});
