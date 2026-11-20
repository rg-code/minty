/** SUB's rules (docs/sub.md §3), pure so they're tested on their own. Dates are plain days
 * (YYYY-MM-DD, UTC arithmetic, no time of day). Nothing here guesses: a holding date needs an
 * explicit rule, and an account is never called safe to close. */

/** When the spend rule (§1) was last checked against issuers' usual terms. */
export const CHECKED = "2026-11-19";

/** Categories that aren't spend toward a card's minimum: payments, transfers, fees and interest,
 * and money in. Everything else counts, refunds (negative amounts) taking spend back. */
export const NOT_SPEND = ["LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT", "BANK_FEES", "INTEREST", "INCOME"] as const;

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (t: Date) => t.toISOString().slice(0, 10);

export function addDays(d: string, n: number): string {
  const t = day(d);
  t.setUTCDate(t.getUTCDate() + n);
  return iso(t);
}

/** Calendar months, clamped to the last day of a shorter month: 31 Jan + 1 month = 28 (or 29) Feb. */
export function addMonths(d: string, n: number): string {
  const t = day(d);
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + n, want = t.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m, Math.min(want, last))));
}

export interface Rule {
  rule_trigger: "opened" | "first_payout" | "last_payout" | "date" | null;
  rule_trigger_date: string | null;
  rule_length: number | null;
  rule_unit: "days" | "months" | null;
  keep_open_until: string | null;
  keep_open_reason: string | null;
  opened_date: string | null;
}
export interface Payout { date: string | null; amount_cents: number | null; points: number | null }

export type Holding =
  | { state: "until"; date: string; basis: string; calculated: string | null }
  | { state: "reached"; date: string; basis: string; calculated: string | null }
  | { state: "unknown"; why: string; calculated: string | null };

/** The date a rule gives, or why there isn't one. */
export function calculated(o: Rule, payouts: Payout[]): { date: string } | { why: string } {
  if (!o.rule_trigger || !o.rule_length || !o.rule_unit) return { why: "No holding rule recorded" };
  let from: string | null = null;
  if (o.rule_trigger === "opened") from = o.opened_date;
  else if (o.rule_trigger === "date") from = o.rule_trigger_date;
  else {
    if (!payouts.length) return { why: "Waiting for the payout's date" };
    // an unknown date on any payout means first / last can't be known
    if (payouts.some((p) => !p.date)) return { why: "A payout's date isn't known" };
    const dates = payouts.map((p) => p.date!).sort();
    from = o.rule_trigger === "first_payout" ? dates[0] : dates.at(-1)!;
  }
  if (!from) return { why: o.rule_trigger === "opened" ? "The opening date isn't recorded" : "The rule's start date isn't recorded" };
  return { date: o.rule_unit === "months" ? addMonths(from, o.rule_length) : addDays(from, o.rule_length) };
}

const TRIGGER: Record<string, string> = { opened: "opening", first_payout: "the first payout", last_payout: "the last payout", date: "the date given" };

/** One offer's holding state on `today`. A manual date (with its reason) wins over the rule, and
 * the rule's own date stays visible for comparison. The date itself is still "keep open": it's
 * "reached" only the day after. */
export function holding(o: Rule, payouts: Payout[], today: string): Holding {
  const c = calculated(o, payouts);
  const calc = "date" in c ? c.date : null;
  let date: string, basis: string;
  if (o.keep_open_until) { date = o.keep_open_until; basis = o.keep_open_reason || "a date you gave"; }
  else if ("date" in c) { date = c.date; basis = `${o.rule_length} ${o.rule_unit} after ${TRIGGER[o.rule_trigger!]}`; }
  else return { state: "unknown", why: c.why, calculated: null };
  return today > date ? { state: "reached", date, basis, calculated: calc } : { state: "until", date, basis, calculated: calc };
}

/** Across every offer on one account: the latest known date governs; any unknown keeps the account
 * from "reached" (a known future date still shows). Never "safe to close". */
export function accountHolding(states: Holding[]): { state: "until" | "reached" | "unknown"; date: string | null; unknown: number } {
  const known = states.filter((s): s is Exclude<Holding, { state: "unknown" }> => s.state !== "unknown");
  const unknown = states.length - known.length;
  const latest = known.map((s) => s.date).sort().at(-1) ?? null;
  if (latest && known.some((s) => s.state === "until")) return { state: "until", date: latest, unknown };
  if (unknown) return { state: "unknown", date: latest, unknown };
  return { state: latest ? "reached" : "unknown", date: latest, unknown };
}

export interface Progress { done: number; target: number | null; count: number; target_count: number | null; pending: number }
/** A requirement's state on `today`: met (by hand, or the estimate reached the target), overdue
 * (the day after the deadline, not on it), or open. The feed being behind says "can't tell yet",
 * never "not met". */
export function requirementState(r: { done_at: string | null; deadline: string | null }, p: Progress | null, today: string, feedCurrent: boolean):
  "met" | "met_estimate" | "overdue" | "cant_tell" | "open" {
  if (r.done_at) return "met";
  const reached = p && (p.target === null || p.done >= p.target) && (p.target_count === null || p.count >= p.target_count) && (p.target !== null || p.target_count !== null);
  if (reached) return "met_estimate";
  if (p && !feedCurrent) return "cant_tell";
  if (r.deadline && today > r.deadline) return "overdue";
  return "open";
}

/** Credits that look like the bonus: money in whose name says bonus or reward, near the expected
 * amount when there is one (within a quarter). Offered for confirmation, never recorded alone. */
export function payoutCandidates<T extends { amount_cents: number }>(rows: T[], expected: number | null): T[] {
  return rows.filter((r) => r.amount_cents < 0 && (expected === null || Math.abs(-r.amount_cents - expected) <= expected * 0.25)).slice(0, 3);
}
