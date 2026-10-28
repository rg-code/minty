import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { CATEGORY_ROWS, LEFT_OUT_ACCOUNTS, LEFT_OUT_TAGGED, OTHER_ROWS, RANGE_ROWS, accountMaps, leftOutIndex, markAuditDirty, markLeftOutChanged } from "../audit/totals";
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

const MAX_ROWS = 500;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** GET /audit/transactions?category=A[,B]&from=&to=&owner=&bucket=spend: the transactions behind a
 * figure (CFA's categories, the dashboard's donut), sorted as the audit sorts them, so they add up
 * to it: corrections apply, transfers aren't spending, what's left out stays out. The newest 500.
 * A statement credit or interest charged (categories CREDITS, INTEREST) is found under BANK_FEES. */
export async function categoryTransactions(env: Env, config: Config, url: URL): Promise<Response> {
  const cats = (url.searchParams.get("category") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  if (!cats.length || cats.length > 30 || cats.some((c) => !/^[A-Z_]{2,48}$/.test(c))) throw unprocessable("category must be one or more of the audit's categories, like FOOD_AND_DRINK");
  const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? "";
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) throw unprocessable("from and to must be dates (YYYY-MM-DD), from on or before to");
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 800) throw unprocessable("at most about two years at a time");
  const owner = url.searchParams.get("owner");
  if (owner !== null && !config.users.has(owner)) throw unprocessable("owner must be one of the people in MINTY_USERS");
  const bucket = url.searchParams.get("bucket") ?? "spend";
  if (!(BUCKETS as readonly string[]).includes(bucket)) throw unprocessable(`bucket must be one of ${BUCKETS.join(", ")}`);
  const source = [...new Set(cats.map((c) => (c === "CREDITS" || c === "INTEREST" ? "BANK_FEES" : c)).filter((c) => c !== "OTHER"))];
  const maps = await accountMaps(env);
  const wrap = (rows: string) => `
    SELECT c.id, c.date, c.label AS name, c.amount_cents, c.owner, c.category, c.bucket, ${ACCOUNT_NAME("a")} AS account_name, a.mask AS account_mask, i.institution_name
    FROM (${rows}) c JOIN transactions t ON t.id = c.id JOIN accounts a ON a.id = t.account_id JOIN items i ON i.id = a.item_id
    WHERE c.bucket = ?9 AND c.category IN (SELECT value FROM json_each(?10))${owner === null ? " AND ?11 IS NULL" : " AND c.owner = ?11"}`;
  const bind = [ "0000-01-01", ...maps, from, to, JSON.stringify(source), bucket, JSON.stringify(cats), owner ];
  const queries = [
    ...(source.length ? [env.DB.prepare(wrap(CATEGORY_ROWS)).bind(...bind)] : []),
    ...(cats.includes("OTHER") ? [env.DB.prepare(wrap(OTHER_ROWS)).bind(...bind)] : []),
  ];
  const rows = (await env.DB.batch(queries)).flatMap((r) => r.results as { id: number; date: string; amount_cents: number }[])
    .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));    // sorted here: D1 counts a sort as another read
  return json({
    categories: cats, from, to, owner, bucket,
    count: rows.length, total_cents: rows.reduce((s, r) => s + r.amount_cents, 0),
    transactions: rows.slice(0, MAX_ROWS), more: rows.length > MAX_ROWS,
  });
}

interface Classified { id: number; owner: string; date: string; month: string; label: string; amount_cents: number; category: string; bucket: string }
const rangeOf = (url: URL, maxDays = 800) => {
  const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? "";
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) throw unprocessable("from and to must be dates (YYYY-MM-DD), from on or before to");
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > maxDays) throw unprocessable(`at most ${maxDays} days at a time`);
  return { from, to };
};
const ownerOf = (config: Config, url: URL) => {
  const owner = url.searchParams.get("owner");
  if (owner !== null && !config.users.has(owner)) throw unprocessable("owner must be one of the people in MINTY_USERS");
  return owner;
};
const add = (o: Record<string, number>, k: string, v: number) => { o[k] = (o[k] ?? 0) + v; };

/** GET /audit/daily?from=&to=&owner=: spending by day and by category, for the dashboard's 1M
 * range (the stored totals are by month). The range's rows only, by the date index. */
export async function daily(env: Env, config: Config, url: URL): Promise<Response> {
  const { from, to } = rangeOf(url, 62), owner = ownerOf(config, url);
  const maps = await accountMaps(env);
  const { results } = await env.DB.prepare(RANGE_ROWS).bind("0000-01-01", ...maps, from, to).all<Classified>();
  const days: Record<string, Record<string, number>> = {};
  for (const r of results) if (r.bucket === "spend" && (owner === null || r.owner === owner)) add((days[r.date] ??= {}), r.category, r.amount_cents);
  return json({ from, to, owner, days });
}

/** GET /audit/left-out?from=&to=&owner=[&by=day][&item=kind:value]: the left-out transactions
 * themselves, bucketed as the audit would (the dashboard's "Left out" view). Without item: by month
 * (or day): spending by what left each out (a transaction left out twice counts once, under its
 * account or bank first), and the rest by bucket. With item: that item's spending, listed. */
export async function leftOutView(env: Env, config: Config, url: URL): Promise<Response> {
  const { from, to } = rangeOf(url), owner = ownerOf(config, url), byDay = url.searchParams.get("by") === "day";
  const item = url.searchParams.get("item");
  const idx = await leftOutIndex(env);
  if (item !== null && !idx.keys.includes(item)) throw unprocessable("item must be one of what's left out (kind:value)");
  const maps = await accountMaps(env);
  const tagIds = Object.keys(idx.tagged).map(Number), accIds = Object.keys(idx.accounts).map(Number);
  const q = (sql: string, ids: number[]) => env.DB.prepare(sql).bind("0000-01-01", ...maps, from, to, JSON.stringify(ids));
  const queries = [...(accIds.length ? [q(LEFT_OUT_ACCOUNTS, accIds)] : []), ...(tagIds.length ? [q(LEFT_OUT_TAGGED, tagIds)] : [])];
  const res = queries.length ? await env.DB.batch(queries) : [];                     // D1 refuses an empty batch
  const seen = new Set<number>(), rows: (Classified & { by: string })[] = [];
  const accountOf = new Map<number, number>();
  if (accIds.length) {
    const { results } = await env.DB.prepare("SELECT id, account_id FROM transactions WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify((res[0].results as Classified[]).map((r) => r.id))).all<{ id: number; account_id: number }>();
    for (const r of results) accountOf.set(r.id, r.account_id);
  }
  for (const [i, r] of res.entries()) {
    const viaAccount = accIds.length > 0 && i === 0;
    for (const t of r.results as Classified[]) {
      if (seen.has(t.id) || (owner !== null && t.owner !== owner)) continue;
      seen.add(t.id);
      rows.push({ ...t, by: viaAccount ? idx.accounts[accountOf.get(t.id) ?? -1] ?? "" : idx.tagged[t.id] ?? "" });
    }
  }
  if (item !== null) {
    const list = rows.filter((r) => r.by === item && r.bucket === "spend").sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
    const ids = list.slice(0, MAX_ROWS).map((r) => r.id);
    const names = ids.length ? (await env.DB.prepare(`SELECT t.id, ${ACCOUNT_NAME("a")} AS account_name, a.mask AS account_mask, i.institution_name FROM transactions t
        JOIN accounts a ON a.id = t.account_id JOIN items i ON i.id = a.item_id WHERE t.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<Record<string, unknown>>()).results : [];
    const byId = new Map(names.map((n) => [n.id, n]));
    return json({ item, from, to, owner, count: list.length, total_cents: list.reduce((s, r) => s + r.amount_cents, 0), more: list.length > MAX_ROWS,
      transactions: list.slice(0, MAX_ROWS).map((r) => ({ id: r.id, date: r.date, name: r.label, amount_cents: r.amount_cents, owner: r.owner, category: r.category, ...byId.get(r.id) })) });
  }
  const spend: Record<string, Record<string, number>> = {}, other: Record<string, Record<string, number>> = {};
  for (const r of rows) add(((r.bucket === "spend" ? spend : other)[byDay ? r.date : r.month] ??= {}), r.bucket === "spend" ? r.by : r.bucket, r.amount_cents);
  return json({ from, to, owner, by: byDay ? "day" : "month", left_out: idx.keys, spend, other });
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
