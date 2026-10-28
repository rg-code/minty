import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { refreshTotals, snapshotBalances } from "../src/audit/totals";
import type { Env } from "../src/env";
import { getJson } from "./helpers";

// Left out of the numbers (analytics_exclusions, docs/cfa.md): a tag, a bank or an account kept out
// of CFA, the dashboard's cards and EGG; the transactions themselves still show.
const E = env as unknown as Env;
const db = env.DB;
let bank: number, other: number, acct: Record<string, number>;
const send = (body: unknown) => getJson<any>("/audit/exclusions", { method: "PUT", body: JSON.stringify(body) });
const spend = async () => Object.fromEntries((await db.prepare("SELECT category, sum(amount_cents) AS c FROM monthly_totals WHERE bucket = 'spend' GROUP BY category").all<{ category: string; c: number }>()).results.map((r) => [r.category, r.c]));

async function txn(account: string, date: string, cents: number, category: string, name: string, tags: string[] = []) {
  const id = (await db.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, name, category, pending)
    VALUES ('me', ?, ?, ?, 'USD', ?, ?, ?, 0) RETURNING id`).bind(acct[account], crypto.randomUUID(), cents, date, name, category).first<{ id: number }>())!.id;
  for (const [i, t] of tags.entries()) await db.prepare("INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, ?, ?)").bind(id, t, i).run();
  return id;
}

beforeEach(async () => {
  await db.batch(["analytics_exclusions", "recurring_charges", "net_worth", "monthly_totals", "balance_snapshots", "bucket_overrides", "transaction_tags", "transactions", "accounts", "items"]
    .map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.prepare("DELETE FROM app_state WHERE key LIKE 'audit_%' OR key = 'networth_dirty'").run();
  const item = (name: string) => db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, status)
    VALUES ('me', 'me_primary', ?, 'x', ?, 'good') RETURNING id`).bind(`item-${name}`, name).first<{ id: number }>().then((r) => r!.id);
  bank = await item("Chase"); other = await item("Amex");
  acct = {};
  for (const [key, it, type] of [["checking", bank, "depository"], ["card", bank, "credit"], ["amex", other, "credit"]] as const) {
    acct[key] = (await db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype, balance_current_cents)
      VALUES ('me', ?, ?, ?, ?, ?, ?) RETURNING id`).bind(it, key, key, type, type === "credit" ? "credit card" : "checking", type === "credit" ? 20000 : 500000).first<{ id: number }>())!.id;
  }
  await txn("card", "2026-09-03", 5000, "FOOD_AND_DRINK", "Cafe");
  await txn("card", "2026-09-04", 70000, "GENERAL_MERCHANDISE", "Laptop for the office", ["sync"]);
  await txn("amex", "2026-09-05", 12000, "TRAVEL", "Hotel");
  await refreshTotals(E);
});

describe("leaving things out of the numbers", () => {
  it("a tag: its transactions drop out of the monthly totals at the next run, and come back", async () => {
    expect(await spend()).toEqual({ FOOD_AND_DRINK: 5000, GENERAL_MERCHANDISE: 70000, TRAVEL: 12000 });
    expect((await send({ kind: "tag", value: "sync", left_out: true })).body.left_out).toEqual([expect.objectContaining({ kind: "tag", value: "sync", name: "sync" })]);
    expect((await refreshTotals(E)).full).toBe(true);
    expect(await spend()).toEqual({ FOOD_AND_DRINK: 5000, TRAVEL: 12000 });
    await send({ kind: "tag", value: "sync", left_out: false });
    await refreshTotals(E);
    expect(await spend()).toEqual({ FOOD_AND_DRINK: 5000, GENERAL_MERCHANDISE: 70000, TRAVEL: 12000 });
  });

  it("a bank takes all its accounts out; an account only itself", async () => {
    await send({ kind: "bank", value: bank, left_out: true });
    await refreshTotals(E);
    expect(await spend()).toEqual({ TRAVEL: 12000 });
    await send({ kind: "bank", value: bank, left_out: false });
    await send({ kind: "account", value: acct.amex, left_out: true });
    await refreshTotals(E);
    expect(await spend()).toEqual({ FOOD_AND_DRINK: 5000, GENERAL_MERCHANDISE: 70000 });
  });

  it("net worth: a left-out account isn't counted today, and its history is rebuilt without it", async () => {
    await db.prepare("INSERT INTO balance_snapshots (account_id, date, current_cents) VALUES (?, '2026-09-01', 400000), (?, '2026-09-01', 10000), (?, '2026-09-01', 30000), (?, '2026-09-10', 450000)")
      .bind(acct.checking, acct.card, acct.amex, acct.checking).run();
    await send({ kind: "account", value: acct.amex, left_out: true });
    await refreshTotals(E);
    const rows = (await db.prepare("SELECT date, assets_cents AS a, debts_cents AS d FROM net_worth ORDER BY date").all()).results;
    expect(rows).toEqual([{ date: "2026-09-01", a: 400000, d: 10000 }, { date: "2026-09-10", a: 450000, d: 10000 }]);   // the card carried forward, Amex left out
    await snapshotBalances(E);
    const today = await db.prepare("SELECT assets_cents AS a, debts_cents AS d FROM net_worth WHERE date = date('now')").first();
    expect(today).toEqual({ a: 500000, d: 20000 });
  });

  it("EGG lists a left-out retirement account, and counts none of it", async () => {
    const ira = (await db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype, balance_current_cents)
      VALUES ('me', ?, 'ira', 'IRA', 'investment', 'ira', 900000) RETURNING id`).bind(other).first<{ id: number }>())!.id;
    await db.prepare("INSERT INTO balance_snapshots (account_id, date, current_cents) VALUES (?, '2026-09-01', 880000)").bind(ira).run();
    expect((await getJson<any>("/retirement")).body.snapshots).toHaveLength(1);
    await send({ kind: "bank", value: other, left_out: true });
    const { body } = await getJson<any>("/retirement");
    expect(body.accounts.find((a: any) => a.id === ira)).toMatchObject({ in_retirement: true, left_out: true });
    expect(body.snapshots).toEqual([]);
  });

  it("the transactions still show on the dashboard", async () => {
    await send({ kind: "bank", value: bank, left_out: true });
    expect((await getJson<any[]>("/transactions")).body).toHaveLength(3);
  });

  it("GET lists what's left out by name, with the banks and accounts to choose from; the summary carries the list", async () => {
    await send({ kind: "account", value: acct.amex, left_out: true });
    const { body } = await getJson<any>("/audit/exclusions");
    expect(body.left_out).toEqual([expect.objectContaining({ kind: "account", value: String(acct.amex), name: "amex", bank: "Amex" })]);
    expect(body.banks.map((b: any) => b.name).sort()).toEqual(["Amex", "Chase"]);
    expect(body.accounts).toHaveLength(3);
    expect((await getJson<any>("/audit/summary")).body.left_out).toHaveLength(1);
  });

  it("refuses a kind it doesn't know, a missing switch, a bank or account that doesn't exist", async () => {
    expect((await send({ kind: "merchant", value: "x", left_out: true })).status).toBe(422);
    expect((await send({ kind: "tag", value: "sync" })).status).toBe(422);
    expect((await send({ kind: "tag", value: "x".repeat(65), left_out: true })).status).toBe(422);
    expect((await send({ kind: "bank", value: 999999, left_out: true })).status).toBe(404);
    expect((await send({ kind: "account", value: "1", left_out: true })).status).toBe(422);
  });
});
