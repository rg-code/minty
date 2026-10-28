import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { markAuditDirty, markLeftOutChanged } from "../audit/totals";
import { ACCOUNT_NAME } from "../accounts";

/** CFA, the Complete financial audit (docs/cfa.md), phase C2: what the audit's charts show. Reads
 * only what the cron prepared (monthly_totals, net_worth, recurring_charges), never the
 * transactions, so it costs the same however long the history is. The browser draws the charts
 * and works out the findings. */

const BUCKETS = ["income", "spend", "saving", "transfer", "debt"] as const;
const MAX_MERCHANT = 80;

const monthsBack = (n: number, now = new Date()) => {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
};

/** GET /audit?months=12|24&owner=: monthly totals by bucket and category, net worth by day, the
 * recurring charges, card balances and the household's corrections. */
export async function audit(env: Env, config: Config, url: URL): Promise<Response> {
  const n = url.searchParams.get("months") === "24" ? 24 : 12;
  const owner = url.searchParams.get("owner");
  if (owner !== null && !config.users.has(owner)) throw unprocessable("owner must be one of the people in MINTY_USERS");
  const months = monthsBack(n);
  const since = `${months[0]}-01`;
  const by = (col: string) => (owner === null ? "" : ` AND ${col} = ?`);     // the person filter, when there is one
  const who = owner === null ? [] : [owner];
  const [totals, worth, recurring, cards, corrections, state] = await env.DB.batch([
    env.DB.prepare(`SELECT month, bucket, category, sum(amount_cents) AS cents, sum(n) AS n FROM monthly_totals
                    WHERE month >= ?${by("owner")} GROUP BY month, bucket, category`).bind(months[0], ...who),
    env.DB.prepare(`SELECT date, sum(assets_cents) AS assets, sum(debts_cents) AS debts FROM net_worth
                    WHERE date >= ?${by("owner")} GROUP BY date`).bind(since, ...who),
    env.DB.prepare(`SELECT r.owner, r.merchant, r.name, r.category, r.cadence, r.n, r.avg_cents, r.last_cents, r.prev_cents,
                           r.distinct_amounts, r.first_date, r.last_date, o.bucket AS corrected
                    FROM recurring_charges r LEFT JOIN bucket_overrides o ON o.merchant = r.merchant
                    WHERE 1${by("r.owner")}`).bind(...who),
    env.DB.prepare(`SELECT ${ACCOUNT_NAME("accounts")} AS name, mask, owner, balance_current_cents AS balance FROM accounts
                    WHERE type = 'credit'${by("owner")}`).bind(...who),
    env.DB.prepare("SELECT merchant, bucket FROM bucket_overrides"),
    env.DB.prepare("SELECT key, value, updated_at FROM app_state WHERE key IN ('audit_watermark', 'audit_rebuilt_at', 'audit_dirty', 'audit_error')"),
  ]);
  const st = Object.fromEntries((state.results as { key: string; value: string | null; updated_at: string }[]).map((r) => [r.key, r]));
  return json({
    today: new Date().toISOString().slice(0, 10),
    months, owner,
    totals: totals.results,
    net_worth: worth.results,
    recurring: recurring.results,
    cards: cards.results,
    corrections: corrections.results,
    refreshed_at: st.audit_watermark?.updated_at ?? null,       // the last cron run that looked
    rebuilt_at: st.audit_rebuilt_at?.value ?? null,
    pending_rebuild: Boolean(st.audit_dirty?.value),           // a correction waiting for the next run
    rebuild_error: st.audit_error?.value ?? null,              // the last run's failure, kept until one succeeds
  });
}

/** GET /audit/summary: the dashboard's cards, chart and donut. Each person's money in and spending
 * by month and category for 24 months, from monthly_totals (what the cron prepared, never the
 * transactions): a range on the table's key, no sort, so it reads each row once. */
export async function summary(env: Env): Promise<Response> {
  const months = monthsBack(24);
  const [rows, state, left] = await env.DB.batch([
    env.DB.prepare(`SELECT month, owner, bucket, category, amount_cents AS cents, n FROM monthly_totals
                    WHERE month >= ? AND bucket IN ('income', 'spend')`).bind(months[0]),
    env.DB.prepare("SELECT key, value, updated_at FROM app_state WHERE key IN ('audit_watermark', 'audit_dirty', 'audit_error')"),
    env.DB.prepare(LEFT_OUT_LIST),
  ]);
  const st = Object.fromEntries((state.results as { key: string; value: string | null; updated_at: string }[]).map((r) => [r.key, r]));
  return json({
    today: new Date().toISOString().slice(0, 10),
    months,
    totals: rows.results,
    left_out: left.results,                                 // the cards' "shown" totals leave these out too
    refreshed_at: st.audit_watermark?.updated_at ?? null,
    pending_rebuild: Boolean(st.audit_dirty?.value),         // a change waiting for the next run
    rebuild_error: st.audit_error?.value ?? null,
  });
}

// What's left out of the numbers, named: a tag as spelled, a bank by its institution, an account by
// its name (and the bank it's at, and the account ids that go with a bank, for the dashboard).
const LEFT_OUT_LIST = `
  SELECT x.kind, x.value,
         CASE x.kind WHEN 'tag' THEN x.value WHEN 'bank' THEN i.institution_name ELSE ${ACCOUNT_NAME("a")} END AS name,
         CASE x.kind WHEN 'account' THEN a.mask END AS mask, CASE x.kind WHEN 'account' THEN ai.institution_name END AS bank,
         coalesce(i.owner, a.owner) AS owner
  FROM analytics_exclusions x
  LEFT JOIN items i ON x.kind = 'bank' AND i.id = CAST(x.value AS INTEGER)
  LEFT JOIN accounts a ON x.kind = 'account' AND a.id = CAST(x.value AS INTEGER)
  LEFT JOIN items ai ON ai.id = a.item_id`;

/** GET /audit/exclusions: what's left out of the numbers, and the banks and accounts to choose from
 * (the tags come from GET /tags). A few dozen rows. */
export async function exclusions(env: Env): Promise<Response> {
  const [left, banks, accounts] = await env.DB.batch([
    env.DB.prepare(LEFT_OUT_LIST),
    env.DB.prepare("SELECT id, owner, institution_name AS name FROM items"),
    env.DB.prepare(`SELECT a.id, a.owner, a.item_id, ${ACCOUNT_NAME("a")} AS name, a.mask, a.type, a.subtype, i.institution_name AS bank
                    FROM accounts a JOIN items i ON i.id = a.item_id`),
  ]);
  return json({ left_out: left.results, banks: banks.results, accounts: accounts.results });
}

const MAX_TAG = 64;
/** PUT /audit/exclusions {kind: tag | bank | account, value, left_out: boolean}: leaves one out of
 * the numbers, or brings it back. Every month (and net worth's history) is rebuilt at the next
 * 10-minute run; the transactions themselves still show on the dashboard. */
export async function setExclusion(env: Env, request: Request): Promise<Response> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  const { kind, value, left_out } = b as Record<string, unknown>;
  if (kind !== "tag" && kind !== "bank" && kind !== "account") throw unprocessable("kind must be tag, bank or account");
  if (typeof left_out !== "boolean") throw unprocessable("left_out must be true or false");
  let v: string;
  if (kind === "tag") {
    v = typeof value === "string" ? value.trim() : "";
    if (!v || v.length > MAX_TAG) throw unprocessable(`a tag is 1–${MAX_TAG} characters`);
  } else {
    if (!Number.isInteger(value)) throw unprocessable(`value must be the ${kind === "bank" ? "bank" : "account"}'s id`);
    v = String(value);
    const found = await env.DB.prepare(`SELECT 1 FROM ${kind === "bank" ? "items" : "accounts"} WHERE id = ?`).bind(value).first();
    if (!found) throw new HttpError(404, `no such ${kind === "bank" ? "bank" : "account"}`);
  }
  await env.DB.prepare(left_out ? "INSERT OR IGNORE INTO analytics_exclusions (kind, value) VALUES (?, ?)" : "DELETE FROM analytics_exclusions WHERE kind = ? AND value = ?")
    .bind(kind, v).run();
  await markLeftOutChanged(env);
  return json({ left_out: (await env.DB.prepare(LEFT_OUT_LIST).all()).results });
}

const merchantKey = (merchant: unknown) => {
  const m = typeof merchant === "string" ? merchant.replace(/\s+/g, " ").trim().toUpperCase() : "";
  if (!m || m.length > MAX_MERCHANT) throw unprocessable(`merchant must be 1–${MAX_MERCHANT} characters`);
  return m;
};

/** GET /audit/buckets?merchant=…: one merchant's correction, or null when Minty decides itself
 * (the dashboard's "Counts as", on a transaction). One row, by the table's key. */
export async function getBucket(env: Env, url: URL): Promise<Response> {
  const m = merchantKey(url.searchParams.get("merchant"));
  const row = await env.DB.prepare("SELECT bucket FROM bucket_overrides WHERE merchant = ?").bind(m).first<{ bucket: string }>();
  return json({ merchant: m, bucket: row?.bucket ?? null });
}

/** PUT /audit/buckets {merchant, bucket | null}: a merchant's bucket, corrected (or the correction
 * removed). The totals follow at the next cron run (the 10-minute one, when nothing's syncing). */
export async function setBucket(env: Env, request: Request): Promise<Response> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  const { merchant, bucket } = b as Record<string, unknown>;
  const m = merchantKey(merchant);
  if (bucket !== null && !(typeof bucket === "string" && (BUCKETS as readonly string[]).includes(bucket))) {
    throw unprocessable(`bucket must be one of ${BUCKETS.join(", ")}, or null to remove the correction`);
  }
  if (bucket === null) await env.DB.prepare("DELETE FROM bucket_overrides WHERE merchant = ?").bind(m).run();
  else await env.DB.prepare(`INSERT INTO bucket_overrides (merchant, bucket) VALUES (?, ?)
                             ON CONFLICT (merchant) DO UPDATE SET bucket = excluded.bucket, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .bind(m, bucket).run();
  await markAuditDirty(env);
  return json({ merchant: m, bucket });
}
