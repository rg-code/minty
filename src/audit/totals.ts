import type { Env } from "../env";

/** CFA, the Complete financial audit (docs/cfa.md), phase C1: what the audit's charts read, kept
 * by the hourly cron, never on a request.
 *
 * Each posted transaction gets one bucket (all in SQL, so the Worker does no per-row work):
 *  - a correction in bucket_overrides for its merchant, if there is one; else
 *  - a transfer pair (the same amount the other way in another of the household's accounts,
 *    within 3 days, one side of it a Plaid transfer or loan payment): saving when money moves between a spending account and a savings,
 *    investment or HSA account (negative when it comes back out), otherwise transfer (ignored);
 *  - income: INCOME, or TRANSFER_IN from outside into a bank account;
 *  - transfer: a payment arriving on a credit card (the purchases on it already count);
 *  - debt: a loan payment going out (a mortgage, a car loan, a card that isn't linked);
 *  - transfer: anything else inside a savings or investment account;
 *  - spend: everything else (a refund is negative spending).
 *
 * monthly_totals is refreshed from the month of the earliest transaction added since the last
 * run (3 days earlier, for a transfer's other side), and rebuilt whole once a week, or when a
 * correction changed (app_state audit_dirty), which also catches edits and removals. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const REBUILD_DAYS = 7;

// A pair needs one side Plaid calls a transfer, so a $100 purchase and an unrelated $100 deposit
// in the same week stay what they are.
const TRANSFERS = "('TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS')";

// Each account's type, and whether it's a savings, investment or HSA account, are passed in as two
// small JSON objects keyed by account id (?2, ?3; see accountMaps): joining accounts instead would
// read an account row for every transaction, which D1 counts.
const TYPE = (id: string) => `json_extract(?2, '$."' || ${id} || '"')`;
const SAVING = (id: string) => `coalesce(json_extract(?3, '$."' || ${id} || '"'), 0)`;

/** ?2 and ?3 for CLASSIFIED: { account id: type } and { account id: 1 } for savings-like accounts. */
export async function accountMaps(env: Env): Promise<[string, string]> {
  const { results } = await env.DB.prepare("SELECT id, type, subtype FROM accounts").all<{ id: number; type: string | null; subtype: string | null }>();
  const types: Record<string, string | null> = {}, saving: Record<string, number> = {};
  for (const a of results) {
    types[a.id] = a.type;
    if (a.type === "investment" || (a.type === "depository" && ["savings", "cd", "money market", "hsa"].includes(a.subtype ?? ""))) saving[a.id] = 1;
  }
  return [JSON.stringify(types), JSON.stringify(saving)];
}

/** The bucket of each posted transaction from ?1 (a date) on: id, owner, month, bucket, category,
 * amount_cents. ?2 and ?3 come from accountMaps. */
export const CLASSIFIED = `
  WITH t AS (
    SELECT t.id, t.owner, t.date, t.amount_cents AS amt, coalesce(nullif(t.category, ''), 'OTHER') AS category,
           ${TYPE("t.account_id")} AS atype, ${SAVING("t.account_id")} AS self_saving,
           upper(coalesce(nullif(t.merchant_name, ''), t.name, '')) AS merchant,
           (SELECT p.account_id FROM transactions p
             WHERE p.amount_cents = -t.amount_cents AND p.date BETWEEN date(t.date, '-3 days') AND date(t.date, '+3 days')
               AND p.account_id <> t.account_id AND p.pending = 0
               AND (t.category IN ${TRANSFERS} OR p.category IN ${TRANSFERS}) LIMIT 1) AS pair_account
    FROM transactions t
    WHERE t.pending = 0 AND t.amount_cents <> 0 AND t.date >= ?1
  )
  SELECT t.id, t.owner, substr(t.date, 1, 7) AS month, t.category, t.amt AS amount_cents,
    CASE
      WHEN o.bucket IS NOT NULL THEN o.bucket
      WHEN t.pair_account IS NOT NULL THEN
        CASE WHEN ${SAVING("t.pair_account")} AND NOT t.self_saving THEN 'saving' ELSE 'transfer' END
      WHEN t.amt < 0 AND t.category = 'INCOME' THEN 'income'
      WHEN t.amt < 0 AND t.category = 'TRANSFER_IN' AND t.atype = 'depository' AND NOT t.self_saving THEN 'income'
      WHEN t.amt < 0 AND t.atype = 'credit' AND t.category IN ('LOAN_PAYMENTS', 'TRANSFER_IN') THEN 'transfer'
      WHEN t.amt > 0 AND t.category = 'LOAN_PAYMENTS' THEN 'debt'
      WHEN t.self_saving THEN 'transfer'
      ELSE 'spend'
    END AS bucket
  FROM t
  LEFT JOIN bucket_overrides o ON o.merchant = t.merchant`;

const REFRESH = [
  "DELETE FROM monthly_totals WHERE month >= substr(?1, 1, 7)",
  `INSERT INTO monthly_totals (month, owner, bucket, category, amount_cents, n)
   SELECT month, owner, bucket, category, sum(amount_cents), count(*) FROM (${CLASSIFIED.replace("t.date >= ?1", "t.date >= substr(?1, 1, 7) || '-01'")})
   GROUP BY month, owner, bucket, category`,
];

const state = async (env: Env) => Object.fromEntries((await env.DB.prepare(
  "SELECT key, value FROM app_state WHERE key IN ('audit_watermark', 'audit_rebuilt_at', 'audit_dirty')").all<{ key: string; value: string | null }>()).results
  .map((r) => [r.key, r.value]));
const setState = (env: Env, key: string, value: string | null) => env.DB.prepare(
  `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ${NOW}) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
  .bind(key, value);

/** A correction changed: the next hourly run rebuilds every month. */
export const markAuditDirty = (env: Env) => setState(env, "audit_dirty", "1").run();

/** The hourly cron's step: refreshes monthly_totals where something changed. Returns what it did. */
export async function refreshTotals(env: Env, now = new Date()): Promise<{ from: string | null; full: boolean }> {
  const s = await state(env);
  const top = (await env.DB.prepare("SELECT max(id) AS id FROM transactions").first<{ id: number | null }>())?.id ?? 0;
  const mark = Number(s.audit_watermark ?? 0);
  const stale = !s.audit_rebuilt_at || Date.parse(s.audit_rebuilt_at) < now.getTime() - REBUILD_DAYS * 864e5;
  let from: string | null = null, full = false;
  if (stale || s.audit_dirty || top < mark) {
    from = "0000-01-01"; full = true;               // weekly, after a correction, or the transactions were reset
  } else if (top > mark) {
    // The earliest new transaction, 3 days earlier for its other side: only rows added since the last run.
    from = (await env.DB.prepare("SELECT date(min(date), '-3 days') AS d FROM transactions WHERE id > ?").bind(mark).first<{ d: string | null }>())?.d ?? null;
  }
  const writes = [setState(env, "audit_watermark", String(top))];
  if (from) {
    const [types, saving] = await accountMaps(env);
    writes.unshift(env.DB.prepare(REFRESH[0]).bind(from), env.DB.prepare(REFRESH[1]).bind(from, types, saving));
  }
  if (full) writes.push(setState(env, "audit_rebuilt_at", now.toISOString()), setState(env, "audit_dirty", null));
  await env.DB.batch(writes);
  return { from, full };
}

// Each account's balance today, written only when it's new or changed (a handful of rows an hour).
const SNAPSHOT = `
  INSERT INTO balance_snapshots (account_id, date, current_cents, available_cents)
  SELECT id, date('now'), balance_current_cents, balance_available_cents FROM accounts
  WHERE balance_current_cents IS NOT NULL OR balance_available_cents IS NOT NULL
  ON CONFLICT (account_id, date) DO UPDATE SET current_cents = excluded.current_cents, available_cents = excluded.available_cents
  WHERE balance_snapshots.current_cents IS NOT excluded.current_cents OR balance_snapshots.available_cents IS NOT excluded.available_cents`;

// Older than a year, a snapshot a week (Sundays) is enough for a trend.
const THIN = "DELETE FROM balance_snapshots WHERE date < date('now', '-365 days') AND strftime('%w', date) <> '0'";

/** The hourly cron's step: today's balances; once a day (the first run after midnight UTC), thins old ones. */
export async function snapshotBalances(env: Env, now = new Date()): Promise<number> {
  const r = await env.DB.prepare(SNAPSHOT).run();
  if (now.getUTCHours() === 0) await env.DB.prepare(THIN).run();
  return r.meta.changes ?? 0;
}
