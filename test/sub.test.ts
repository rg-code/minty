/// <reference types="vite/client" />
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getJson } from "./helpers";
import { accountHolding, addDays, addMonths, holding, payoutCandidates, requirementState } from "../src/sub/rules";

// SUB, sign-up bonuses (docs/sub.md), against a real local D1.
const db = env.DB;
const send = (method: string, path: string, body?: unknown) =>
  getJson<any>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const rows = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<any>()).results;

describe("the rules", () => {
  it("months end on the last day of a shorter month; days are plain days", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addDays("2026-03-07", 180)).toBe("2026-09-03");
  });

  const rule = (o: Record<string, unknown> = {}) => ({ rule_trigger: null, rule_trigger_date: null, rule_length: null, rule_unit: null,
    keep_open_until: null, keep_open_reason: null, opened_date: "2026-01-10", ...o }) as any;
  it("a holding date only from an explicit rule; keep open on the day itself, reached the day after", () => {
    expect(holding(rule(), [], "2026-03-01")).toEqual({ state: "unknown", why: "No holding rule recorded", calculated: null });
    const six = rule({ rule_trigger: "opened", rule_length: 6, rule_unit: "months" });
    expect(holding(six, [], "2026-07-10")).toMatchObject({ state: "until", date: "2026-07-10", basis: "6 months after opening" });
    expect(holding(six, [], "2026-07-11")).toMatchObject({ state: "reached", date: "2026-07-10" });
  });

  it("after a payout: waits for one, and an unknown payout date keeps it unknown", () => {
    const paid = rule({ rule_trigger: "last_payout", rule_length: 90, rule_unit: "days" });
    expect(holding(paid, [], "2026-05-01")).toMatchObject({ state: "unknown", why: "Waiting for the payout's date" });
    expect(holding(paid, [{ date: "2026-04-01", amount_cents: 10000, points: null }, { date: null, amount_cents: 5000, points: null }], "2026-05-01"))
      .toMatchObject({ state: "unknown", why: "A payout's date isn't known" });
    expect(holding(paid, [{ date: "2026-04-01", amount_cents: 10000, points: null }, { date: "2026-02-01", amount_cents: 5000, points: null }], "2026-05-01"))
      .toMatchObject({ state: "until", date: "2026-06-30" });
  });

  it("a date you give wins, with its reason, and the rule's date stays for comparison", () => {
    const o = rule({ rule_trigger: "opened", rule_length: 6, rule_unit: "months", keep_open_until: "2026-12-31", keep_open_reason: "Annual fee posts in January" });
    expect(holding(o, [], "2026-08-01")).toEqual({ state: "until", date: "2026-12-31", basis: "Annual fee posts in January", calculated: "2026-07-10" });
  });

  it("an account: the latest known date governs; an unknown offer never lets it read as reached", () => {
    const until = { state: "until", date: "2026-09-01", basis: "", calculated: null } as const;
    const reached = { state: "reached", date: "2026-03-01", basis: "", calculated: null } as const;
    const unknown = { state: "unknown", why: "", calculated: null } as const;
    expect(accountHolding([until, reached])).toEqual({ state: "until", date: "2026-09-01", unknown: 0 });
    expect(accountHolding([reached, unknown])).toEqual({ state: "unknown", date: "2026-03-01", unknown: 1 });
    expect(accountHolding([until, unknown])).toEqual({ state: "until", date: "2026-09-01", unknown: 1 });
    expect(accountHolding([reached])).toEqual({ state: "reached", date: "2026-03-01", unknown: 0 });
  });

  it("requirements: met by hand wins; overdue only the day after; a stale feed is can't-tell, never not-met", () => {
    const p = { done: 300000, target: 400000, count: 12, target_count: null, pending: 0 };
    expect(requirementState({ done_at: "2026-02-01", deadline: "2026-04-10" }, p, "2026-05-01", true)).toBe("met");
    expect(requirementState({ done_at: null, deadline: "2026-04-10" }, { ...p, done: 400000 }, "2026-04-01", true)).toBe("met_estimate");
    expect(requirementState({ done_at: null, deadline: "2026-04-10" }, p, "2026-04-10", true)).toBe("open");
    expect(requirementState({ done_at: null, deadline: "2026-04-10" }, p, "2026-04-11", true)).toBe("overdue");
    expect(requirementState({ done_at: null, deadline: "2026-04-10" }, p, "2026-04-11", false)).toBe("cant_tell");
  });

  it("payout candidates: credits near the expected amount", () => {
    expect(payoutCandidates([{ amount_cents: -30000 }, { amount_cents: -1200 }, { amount_cents: 500 }], 30000)).toEqual([{ amount_cents: -30000 }]);
    expect(payoutCandidates([{ amount_cents: -1200 }], null)).toEqual([{ amount_cents: -1200 }]);
  });
});

describe("the routes", () => {
  let card = 0, checking = 0;
  beforeEach(async () => {
    await db.batch(["sub_payouts", "sub_requirements", "sub_offers", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
    const item = (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, status, updated_at)
                                    VALUES ('me', 'me_primary', 'i-sub', 'x', 'Chase', 'good', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING id`).first<{ id: number }>())!.id;
    const acct = (pid: string, name: string, type: string) => db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype) VALUES ('me', ?, ?, ?, ?, ?) RETURNING id`)
      .bind(item, pid, name, type, type === "credit" ? "credit card" : "checking").first<{ id: number }>();
    card = (await acct("p-card", "Sapphire", "credit"))!.id;
    checking = (await acct("p-chk", "Checking", "depository"))!.id;
    const t = db.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name, category, pending) VALUES ('me', ?, ?, ?, ?, ?, ?, ?)`);
    await db.batch([
      t.bind(card, "t1", 150000, "2026-01-12", "Airline", "TRAVEL", 0),
      t.bind(card, "t2", 90000, "2026-02-03", "Store", "GENERAL_MERCHANDISE", 0),
      t.bind(card, "t3", -20000, "2026-02-10", "Store refund", "GENERAL_MERCHANDISE", 0),     // takes spend back
      t.bind(card, "t4", -100000, "2026-02-15", "Payment, thank you", "LOAN_PAYMENTS", 0),   // not spend
      t.bind(card, "t5", 9500, "2026-02-20", "Annual fee", "BANK_FEES", 0),                  // not spend
      t.bind(card, "t6", 4000, "2026-02-25", "Cafe", "FOOD_AND_DRINK", 1),                   // pending, apart
      t.bind(card, "t7", 300000, "2026-06-01", "After the window", "TRAVEL", 0),             // outside
      t.bind(checking, "d1", -60000, "2026-01-20", "ACME PAYROLL", "INCOME", 0),
      t.bind(checking, "d2", -60000, "2026-02-20", "ACME PAYROLL", "INCOME", 0),
      t.bind(checking, "d3", -5000, "2026-02-21", "Zelle from a friend", "TRANSFER_IN", 0),
      t.bind(checking, "b1", -30000, "2026-04-02", "NEW ACCOUNT BONUS", "INCOME", 0),
    ]);
  });

  it("an offer with its requirements: spend and direct deposits from the account's own transactions", async () => {
    const o = (await send("POST", "/sub/offers", { owner: "me", account_id: card, institution: "Chase", product: "Sapphire Preferred", reward_points: 60000,
      reward_program: "chase_ur", opened_date: "2026-01-10", rule_trigger: "opened", rule_length: 12, rule_unit: "months" }));
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await send("POST", "/sub/requirements", { offer_id: o.body.id, kind: "spend", target_cents: 400000, deadline: "2026-04-10" });
    const b = (await send("POST", "/sub/offers", { owner: "me", account_id: checking, kind: "bank", reward_cents: 30000, opened_date: "2026-01-15" })).body;
    await send("POST", "/sub/requirements", { offer_id: b.id, kind: "direct_deposits", target_cents: 100000, target_count: 2, deadline: "2026-04-15" });
    const r = (await send("GET", "/sub?today=2026-03-01")).body;
    const sp = r.offers.find((x: any) => x.id === o.body.id);
    expect(sp.requirements[0].progress).toEqual({ done: 220000, target: 400000, count: 2, target_count: null, pending: 4000 });
    expect(sp.requirements[0].state).toBe("open");
    expect(sp.holding).toMatchObject({ state: "until", date: "2027-01-10" });
    expect(sp.account_name).toBe("Sapphire");
    const bank = r.offers.find((x: any) => x.id === b.id);
    expect(bank.requirements[0].progress).toMatchObject({ done: 120000, count: 2 });
    expect(bank.requirements[0].state).toBe("met_estimate");
    // the bonus credit is offered as the payout, once it's in the window
    const later = (await send("GET", "/sub?today=2026-05-01")).body.offers.find((x: any) => x.id === b.id);
    expect(later.payout_candidates.map((c: any) => c.name)).toEqual(["NEW ACCOUNT BONUS"]);
    await send("POST", "/sub/payouts", { offer_id: b.id, date: "2026-04-02", amount_cents: 30000, transaction_id: later.payout_candidates[0].id });
    expect((await send("GET", "/sub?today=2026-05-01")).body.offers.find((x: any) => x.id === b.id).payout_candidates).toEqual([]);
  });

  it("a bank whose feed is behind says can't tell yet", async () => {
    await db.prepare("UPDATE items SET updated_at = '2026-01-01T00:00:00.000Z'").run();
    const o = (await send("POST", "/sub/offers", { owner: "me", account_id: card, opened_date: "2026-01-10" })).body;
    await send("POST", "/sub/requirements", { offer_id: o.id, kind: "spend", target_cents: 400000, deadline: "2026-04-10" });
    const r = (await send("GET", "/sub?today=2026-05-01")).body.offers[0];
    expect(r.feed_current).toBe(false);
    expect(r.requirements[0].state).toBe("cant_tell");
  });

  it("validates, and a planned offer needs no account", async () => {
    const bad = async (b: Record<string, unknown>) => (await send("POST", "/sub/offers", { owner: "me", ...b })).status;
    expect(await bad({ owner: "nobody" })).toBe(422);
    expect(await bad({ status: "great" })).toBe(422);
    expect(await bad({ reward_program: "nope" })).toBe(422);
    expect(await bad({ keep_open_until: "2027-01-01" })).toBe(422);                       // needs its reason
    expect(await bad({ rule_trigger: "opened" })).toBe(422);                                // needs length and unit
    expect(await bad({ terms_text: "x".repeat(8001) })).toBe(422);
    expect(await bad({ terms_url: "javascript:alert(1)" })).toBe(422);
    expect(await bad({ status: "planned", institution: "Citi", product: "Strata Premier" })).toBe(201);
    expect((await send("POST", "/sub/payouts", { offer_id: 99999, amount_cents: 1 })).status).toBe(422);
  });

  it("a payout needs one known field; removing an offer removes its requirements and payouts", async () => {
    const o = (await send("POST", "/sub/offers", { owner: "me" })).body;
    expect((await send("POST", "/sub/payouts", { offer_id: o.id })).status).toBe(422);
    expect((await send("POST", "/sub/payouts", { offer_id: o.id, points: 60000 })).status).toBe(201);
    await send("POST", "/sub/requirements", { offer_id: o.id, kind: "other", note: "Add an authorized user" });
    expect((await send("DELETE", `/sub/offers/${o.id}`)).body).toEqual({ id: o.id, removed: true });
    expect(await rows("SELECT count(*) AS n FROM sub_requirements")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*) AS n FROM sub_payouts")).toEqual([{ n: 0 }]);
  });
});

describe("sync never writes SUB", () => {
  it("no sync, statement or investment code names a sub_ table", () => {
    const src = import.meta.glob(["../src/sync.ts", "../src/statements.ts", "../src/investments.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(src)).toHaveLength(3);
    for (const [f, text] of Object.entries(src)) expect(text, f).not.toMatch(/\bsub_(offers|requirements|payouts)\b/);
  });
});
