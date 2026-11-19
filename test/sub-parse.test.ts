import { describe, expect, it } from "vitest";
import { keepTerms, parseOffer, sentences, tidy } from "../public/sub-parse.js";

// Reading an offer's fields from its terms (public/sub-parse.js). Texts are made up, shaped like
// real offer pages and terms, in pasted, PDF-like and OCR-like (broken lines) forms.

describe("parseOffer", () => {
  it("a card: points, spend in a window, the program, the fee", () => {
    const t = `Earn 60,000 bonus points after you spend $4,000 on purchases in the first 3 months from account opening. That's $750 toward travel when you redeem through Chase Ultimate Rewards®. $95 annual fee.`;
    const { fields, requirements, quotes } = parseOffer(t);
    expect(fields).toMatchObject({ reward_points: 60000, reward_program: "chase_ur", institution: "Chase", kind: "card", annual_fee_cents: 9500 });
    expect(requirements).toEqual([{ kind: "spend", target_cents: 400000, length: 3, unit: "months" }]);
    expect((quotes as Record<string, string>).spend).toMatch(/^Earn 60,000 bonus points/);
  });

  it("a bank bonus: cash, direct deposits with a count, a window, and a keep-open rule", () => {
    const t = `Get a $300 bonus when you open a new checking account. To qualify, receive two qualifying direct deposits totaling $1,000 or more within 90 days of account opening.
      The account must remain open for at least 6 months, or the bonus may be deducted at closing.`;
    const { fields, requirements } = parseOffer(t);
    expect(fields).toMatchObject({ reward_cents: 30000, kind: "bank", rule_trigger: "opened", rule_length: 6, rule_unit: "months" });
    expect(fields.reward_points).toBeUndefined();
    expect(requirements).toEqual([{ kind: "direct_deposits", target_count: 2, target_cents: 100000, length: 90, unit: "days" }]);
  });

  it("forfeit wording, and a rule that starts at the payout", () => {
    const t = `Earn a $200 cash bonus. If you close the account within 180 days after the bonus is paid, we will deduct the bonus amount.`;
    expect(parseOffer(t).fields).toMatchObject({ reward_cents: 20000, rule_trigger: "first_payout", rule_length: 180, rule_unit: "days" });
  });

  it("OCR-like text: broken lines, a word for the number, 75k miles", () => {
    const t = `Earn 75k bonus\nmiles after you spend $4,000 on\npurchases within the first three months. Capital One Venture Rewards.\n$0 intro annual fee for the first year, then $95.`;
    const { fields, requirements } = parseOffer(t);
    expect(fields).toMatchObject({ reward_points: 75000, reward_program: "capital_one", institution: "Capital One", fee_waived_first_year: true });
    expect(requirements[0]).toMatchObject({ kind: "spend", target_cents: 400000, length: 3, unit: "months" });
  });

  it("a PDF's text: a split ligature (fi rst), a ligature character, runs of spaces", () => {
    const t = "Earn a $250 cash bonus. Spend $1,500 on purchases within the   fi rst 90 days. If you close the\naccount within 12 months, we may reclaim the bonus.";
    expect(tidy("the ﬁrst  ﬂight")).toBe("the first flight");
    const { fields, requirements } = parseOffer(t);
    expect(requirements).toEqual([{ kind: "spend", target_cents: 150000, length: 90, unit: "days" }]);
    expect(fields).toMatchObject({ reward_cents: 25000, rule_trigger: "opened", rule_length: 12, rule_unit: "months" });
    expect(tidy("if you fill it in")).toBe("if you fill it in");                    // no join where there's no split
  });

  it("finds nothing it can't read, and never guesses", () => {
    const { fields, requirements, used } = parseOffer("A great card for everyday purchases. Terms apply.");
    expect(fields).toEqual({});
    expect(requirements).toEqual([]);
    expect(used).toEqual([]);
  });
});

describe("keepTerms", () => {
  it("keeps short terms as they are, and long ones with the used sentences first and a note", () => {
    expect(keepTerms("Short terms.")).toBe("Short terms.");
    const filler = "Lorem ipsum dolor sit amet. ".repeat(400);
    const key = "Earn 60,000 bonus points after you spend $4,000 in the first 3 months.";
    const kept = keepTerms(`${filler}${key}`, [key], 8000);
    expect(kept.length).toBeLessThanOrEqual(8000);
    expect(kept.startsWith(key)).toBe(true);
    expect(kept).toMatch(/\[Cut to fit: the rest is in the full terms\.\]$/);
  });
  it("splits into sentences across broken lines", () => {
    expect(sentences("One line\nbroken here. Two.")).toEqual(["One line broken here.", "Two."]);
  });
});
