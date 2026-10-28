import { describe, expect, it } from "vitest";
import "../public/reconcile.js";

// The Select bar's Summary (public/reconcile.js): pure matching on the rows the page has.
const R = (globalThis as any).MintyReconcile;
let n = 0;
const tx = (amount: number, date: string, name: string, more: Record<string, unknown> = {}) =>
  ({ id: ++n, owner: "me", account_id: 1, account_name: "Visa", institution_name: "Bank", date, name, merchant_name: name, amount, category: "GENERAL_MERCHANDISE", tags: [], ...more });

describe("summarize", () => {
  it("totals: out and in with counts, net, range, largest and average charge", () => {
    const s = R.summarize([tx(30, "2026-10-02", "Cafe"), tx(70, "2026-10-05", "Shop"), tx(-25, "2026-10-09", "Payroll", { category: "INCOME" })]);
    expect(s.totals).toMatchObject({ n: 3, out: 10000, outN: 2, in: 2500, inN: 1, net: -7500, from: "2026-10-02", to: "2026-10-09", average: 5000 });
    expect(s.totals.largest.name).toBe("Shop");
  });

  it("pairs a charge with its exact refund from the same merchant, the closest one, within 120 days", () => {
    const old = tx(45.99, "2026-06-01", "Amazon"), charge = tx(45.99, "2026-10-03", "AMAZON MKTPL*AB12"), refund = tx(-45.99, "2026-10-12", "Amazon.com");
    const late = tx(20, "2026-01-01", "Target"), lateRefund = tx(-20, "2026-06-01", "Target");          // 151 days: not paired
    const early = tx(-15, "2026-10-01", "Gap"), after = tx(15, "2026-10-04", "Gap");                     // the refund came first: not paired
    const s = R.summarize([old, charge, refund, late, lateRefund, early, after]);
    expect(s.refunds).toHaveLength(1);
    expect(s.refunds[0]).toMatchObject({ charge: { id: charge.id }, refund: { id: refund.id }, cents: 4599, days: 9 });
    expect(s.openCharges.map((t: any) => t.id)).toContain(old.id);
  });

  it("a card payment out of checking and its credit on the card balance as a move; pay never does", () => {
    const pay = tx(500, "2026-10-10", "CHASE CREDIT CRD AUTOPAY", { account_id: 2, category: "LOAN_PAYMENTS" });
    const credit = tx(-500, "2026-10-11", "AUTOMATIC PAYMENT - THANK YOU", { account_id: 1, category: "LOAN_PAYMENTS" });
    const lunch = tx(50, "2026-10-10", "Deli", { account_id: 1, category: "FOOD_AND_DRINK" });
    const salary = tx(-50, "2026-10-11", "PAYROLL DEPOSIT", { account_id: 2, category: "INCOME" });
    const s = R.summarize([pay, credit, lunch, salary]);
    expect(s.transfers).toEqual([expect.objectContaining({ from: pay, to: credit, cents: 50000, days: 1 })]);
    expect(s.openCharges).toEqual([lunch]);
    expect(s.openCredits).toEqual([salary]);
  });

  it("a merchant refunded in part, and what's still open", () => {
    const s = R.summarize([tx(100, "2026-10-01", "Best Buy"), tx(200, "2026-10-02", "Best Buy"), tx(-120, "2026-10-08", "BEST BUY #123")]);
    expect(s.refunds).toEqual([]);
    expect(s.partial).toEqual([expect.objectContaining({ charged: 30000, refunded: 12000, open: 18000 })]);
    expect(s.openCharges).toEqual([]);
    expect(s.openOut).toBe(0);
  });

  it("by person and by account", () => {
    const s = R.summarize([tx(10, "2026-10-01", "A"), tx(5, "2026-10-01", "B", { owner: "sam", account_id: 9, account_name: "Amex" })]);
    expect(s.people.map((g: any) => [g.key, g.out])).toEqual([["me", 1000], ["sam", 500]]);
    expect(s.accounts.map((g: any) => g.name)).toEqual(["Bank · Visa", "Bank · Amex"]);
  });
});

describe("merchantKey and csv", () => {
  it("a merchant's first telling word", () => {
    expect(R.merchantKey({ name: "SQ *BLUE BOTTLE COFFEE" })).toBe("blue");
    expect(R.merchantKey({ merchant_name: "Amazon", name: "AMZN" })).toBe("amazon");
  });

  it("CSV signed as the dashboard shows it, quoted where needed", () => {
    const out = R.csv([tx(12.5, "2026-10-02", 'Joe "the" Cafe, Inc', { tags: ["a", "b"] }), tx(-3, "2026-10-01", "Refund")]);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("date,merchant,description,person,account,category,amount,pending,tags");
    expect(lines[1]).toContain(",3.00,");                       // money in, positive, oldest first
    expect(lines[2]).toContain('"Joe ""the"" Cafe, Inc"');
    expect(lines[2]).toContain(",-12.50,,a; b");
  });
});
