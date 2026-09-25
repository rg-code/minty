import type { Env } from "./env";
import { type Config, credsFor, isConfigured, loadConfig } from "./config";
import { fernetDecrypt, FernetError } from "./fernet";
import { PlaidError, plaidPostText, statusForError } from "./plaid";

/** Port of app/sync_engine.py for Workers limits (free plan: 10 ms CPU, 50 subrequests).
 *  - Each /transactions/sync page is persisted in ONE D1 batch (a single transaction): accounts,
 *    added/modified transactions, removals and the cursor advance. The cursor therefore only
 *    moves after its page is saved, and a crash mid-page changes nothing.
 *  - The Worker never parses a page. Plaid's response text is sent to D1 once, into sync_pages;
 *    SQLite unpacks it (json_each) and hands back just next_cursor / has_more.
 *  - CPU, measured on Cloudflare (2026-09-25): ~4 ms fixed per run plus ~1.5-2 ms per 100
 *    full-detail transactions (~150 KiB of page text). The free plan allows 10 ms per run, so
 *    each run has a byte budget (SYNC_MAX_BYTES_PER_RUN, default 150 KB = ~1 page, measured
 *    ~8 ms) as well as a page budget (SYNC_MAX_PAGES_PER_RUN, bounds subrequests). Hourly runs
 *    are tiny once caught up; a new bank's full history fills in over many runs. On Workers Paid
 *    (30 s CPU) raise both, e.g. 20000000 bytes / 50 pages.
 *  - A per-run page budget bounds Plaid calls and D1 queries; when it runs out the next run
 *    resumes from the stored cursor. Transaction tags (transaction_tags) are never touched. */

export const PAGE_SIZE = 100;            // ~150 KiB of full-detail transactions; small steps for the byte budget
export const DEFAULT_PAGES_PER_RUN = 10;
export const DEFAULT_BYTES_PER_RUN = 150_000;

export type ItemResult = "good" | "partial" | "login_required" | "error" | "retry" | "skipped";

/** What one run may still spend. bytes: page text (~7 us CPU per KiB); omitted = unlimited. */
export interface Budget { pages: number; bytes?: number }

const canSpend = (b: Budget) => b.pages > 0 && (b.bytes === undefined || b.bytes > 0);

export interface ItemRow {
  id: number;
  owner: string;
  plaid_account: string;
  access_token_enc: string;
  txn_cursor: string | null;
  status: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// The current page's JSON text, from the scratch row for item ?1.
const PAGE = "(SELECT body FROM sync_pages WHERE item_id = ?1)";

// Stored only if it's JSON with a text next_cursor. Otherwise nothing is stored, every statement
// below becomes a no-op (the cursor stays put), and PAGE_INFO returns no row -> retry next run.
const STAGE_PAGE = `
  INSERT OR REPLACE INTO sync_pages (item_id, body)
  SELECT ?1, ?2 WHERE json_valid(?2) AND json_type(?2, '$.next_cursor') = 'text'`;

const UPSERT_ACCOUNTS = `
  INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype,
                        balance_current_cents, balance_available_cents, currency, updated_at)
  SELECT ?2, ?1, a.value ->> 'account_id', a.value ->> 'name', a.value ->> 'mask',
         a.value ->> 'type', a.value ->> 'subtype',
         CAST(round((a.value -> 'balances' ->> 'current') * 100) AS INTEGER),
         CAST(round((a.value -> 'balances' ->> 'available') * 100) AS INTEGER),
         a.value -> 'balances' ->> 'iso_currency_code', ${NOW}
  FROM json_each(${PAGE}, '$.accounts') a
  WHERE true
  ON CONFLICT (plaid_account_id) DO UPDATE SET
    name = excluded.name, mask = excluded.mask, type = excluded.type, subtype = excluded.subtype,
    balance_current_cents = excluded.balance_current_cents,
    balance_available_cents = excluded.balance_available_cents,
    currency = excluded.currency, updated_at = excluded.updated_at`;

// Transactions whose account isn't known yet are skipped (the JOIN drops them), as in Python;
// a later page's accounts[] backfills them. 'tags' live elsewhere and are never written here.
const UPSERT_TRANSACTIONS = `
  INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, datetime,
                            name, merchant_name, category, pending, pending_txn_id)
  SELECT ?2, acc.id, t.value ->> 'transaction_id',
         CAST(round((t.value ->> 'amount') * 100) AS INTEGER),
         t.value ->> 'iso_currency_code', t.value ->> 'date', t.value ->> 'datetime',
         t.value ->> 'name', t.value ->> 'merchant_name',
         t.value -> 'personal_finance_category' ->> 'primary',
         CASE WHEN t.value ->> 'pending' THEN 1 ELSE 0 END,
         t.value ->> 'pending_transaction_id'
  FROM (SELECT value FROM json_each(${PAGE}, '$.added') UNION ALL SELECT value FROM json_each(${PAGE}, '$.modified')) t
  JOIN accounts acc ON acc.plaid_account_id = t.value ->> 'account_id'
  WHERE true
  ON CONFLICT (plaid_txn_id) DO UPDATE SET
    amount_cents = excluded.amount_cents, date = excluded.date, datetime = excluded.datetime,
    name = excluded.name, merchant_name = excluded.merchant_name, category = excluded.category,
    pending = excluded.pending, pending_txn_id = excluded.pending_txn_id`;

const DELETE_REMOVED = `
  DELETE FROM transactions
  WHERE plaid_txn_id IN (SELECT value ->> 'transaction_id' FROM json_each(${PAGE}, '$.removed'))`;

const ADVANCE_CURSOR = `
  UPDATE items SET txn_cursor = ${PAGE} ->> '$.next_cursor', status = 'good', updated_at = ${NOW}
  WHERE id = ?1 AND EXISTS (SELECT 1 FROM sync_pages WHERE item_id = ?1)`;

const PAGE_INFO = `SELECT ${PAGE} ->> '$.next_cursor' AS next_cursor, ${PAGE} ->> '$.has_more' AS has_more
                   WHERE EXISTS (SELECT 1 FROM sync_pages WHERE item_id = ?1)`;

const UNSTAGE_PAGE = "DELETE FROM sync_pages WHERE item_id = ?1";

const positiveInt = (raw: string | undefined, def: number) => {
  const n = Number(raw ?? def);
  return Number.isInteger(n) && n > 0 ? n : def;
};

export const pagesPerRun = (env: Env) => positiveInt(env.SYNC_MAX_PAGES_PER_RUN, DEFAULT_PAGES_PER_RUN);
export const bytesPerRun = (env: Env) => positiveInt(env.SYNC_MAX_BYTES_PER_RUN, DEFAULT_BYTES_PER_RUN);

/** Sync one Item from its stored cursor until caught up or the budget is spent. */
export async function syncItem(env: Env, config: Config, item: ItemRow, budget: Budget): Promise<ItemResult> {
  if (!config.accountOwner.has(item.plaid_account) || !isConfigured(env, config, item.plaid_account)) {
    // e.g. the person was removed from MINTY_USERS, or their keys aren't set: don't touch the item
    console.warn(`sync: skipping item ${item.id}: plaid_account ${item.plaid_account} is not configured`);
    return "skipped";
  }
  if (!env.TOKEN_ENC_KEY) {
    console.error("sync: TOKEN_ENC_KEY is not set");
    return "retry";
  }
  const creds = credsFor(env, config, item.plaid_account);   // routes to the item's own Trial account

  let accessToken: string;
  try {
    accessToken = await fernetDecrypt(item.access_token_enc, env.TOKEN_ENC_KEY);
  } catch (e) {
    if (!(e instanceof FernetError)) throw e;
    console.error(`sync: item ${item.id}: access token doesn't decrypt with TOKEN_ENC_KEY`);
    await setStatus(env, item.id, "error");
    return "error";
  }

  const loopStart = item.txn_cursor ?? "";
  let cursor = loopStart;
  let restarts = 0;
  while (canSpend(budget)) {
    budget.pages--;
    let page: string;
    try {
      page = await plaidPostText(env, creds, "/transactions/sync",
        { access_token: accessToken, cursor: cursor || undefined, count: PAGE_SIZE });
    } catch (e) {
      if (e instanceof PlaidError && e.errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && restarts < 2) {
        // Plaid: restart pagination from the cursor this loop began with. Upserts are idempotent.
        restarts++;
        cursor = loopStart;
        continue;
      }
      const status = statusForError(e);
      const code = e instanceof PlaidError ? `${e.errorCode} (request ${e.requestId ?? "?"})` : String(e);
      console.error(`sync: item ${item.id}: ${code}`);
      if (status) {
        await setStatus(env, item.id, status);
        return status;
      }
      return "retry";
    }

    if (budget.bytes !== undefined) budget.bytes -= page.length;
    let info: { next_cursor: string; has_more: number } | undefined;
    try {
      const results = await env.DB.batch([
        env.DB.prepare(STAGE_PAGE).bind(item.id, page),       // the only time the page leaves the Worker
        env.DB.prepare(UPSERT_ACCOUNTS).bind(item.id, item.owner),
        env.DB.prepare(UPSERT_TRANSACTIONS).bind(item.id, item.owner),
        env.DB.prepare(DELETE_REMOVED).bind(item.id),
        env.DB.prepare(ADVANCE_CURSOR).bind(item.id),
        env.DB.prepare(PAGE_INFO).bind(item.id),
        env.DB.prepare(UNSTAGE_PAGE).bind(item.id),
      ]);
      info = results[5].results[0] as typeof info;
    } catch (e) {
      console.error(`sync: item ${item.id}: saving a page failed: ${e instanceof Error ? e.message : e}`);
      return "retry";
    }
    if (!info) {
      console.error(`sync: item ${item.id}: Plaid returned a page that isn't valid sync JSON; will retry`);
      return "retry";
    }
    cursor = info.next_cursor;
    if (!info.has_more) return "good";
  }
  return "partial";
}

async function setStatus(env: Env, itemId: number, status: string): Promise<void> {
  await env.DB.prepare(`UPDATE items SET status = ?, updated_at = ${NOW} WHERE id = ?`).bind(status, itemId).run();
}

/** Sweep every syncable Item, least recently updated first, within one run's budget.
 * Called only by the cron trigger (scheduled handler) — there is no HTTP sync endpoint. */
export async function runSyncAll(
  env: Env, budget: Budget = { pages: pagesPerRun(env), bytes: bytesPerRun(env) },
): Promise<Record<number, ItemResult>> {
  const config = loadConfig(env);
  const { results: items } = await env.DB.prepare(
    "SELECT * FROM items WHERE status IN ('good', 'login_required') ORDER BY updated_at, id",
  ).all<ItemRow>();
  const out: Record<number, ItemResult> = {};
  for (const item of items) {
    if (!canSpend(budget)) break;
    out[item.id] = await syncItem(env, config, item, budget);
  }
  return out;
}
