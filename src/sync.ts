import type { Env } from "./env";
import { type Config, credsFor, isConfigured, loadConfig } from "./config";
import { fernetDecrypt, FernetError } from "./fernet";
import { PlaidError, plaidPost, statusForError } from "./plaid";

/** Port of app/sync_engine.py for Workers limits (free plan: 10 ms CPU, 50 subrequests).
 *  - Each /transactions/sync page is persisted in ONE D1 batch (a single transaction): accounts,
 *    added/modified transactions, removals and the cursor advance. The cursor therefore only
 *    moves after its page is saved, and a crash mid-page changes nothing.
 *  - The page's raw JSON is bound as one parameter and unpacked by SQLite (json_each), so the
 *    Worker spends almost no CPU per row and each page costs 4 statements, not ~500.
 *  - A per-run page budget bounds Plaid calls and D1 queries; when it runs out the next run
 *    resumes from the stored cursor. Transaction tags (transaction_tags) are never touched. */

export const PAGE_SIZE = 250;            // Plaid allows up to 500; keeps each bound page well under D1's 2 MB
export const DEFAULT_PAGES_PER_RUN = 10;

export type ItemResult = "good" | "partial" | "login_required" | "error" | "retry" | "skipped";

export interface Budget { pages: number }

export interface ItemRow {
  id: number;
  owner: string;
  plaid_account: string;
  access_token_enc: string;
  txn_cursor: string | null;
  status: string;
}

interface SyncPage {
  next_cursor: string;
  has_more: boolean;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const UPSERT_ACCOUNTS = `
  INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype,
                        balance_current_cents, balance_available_cents, currency, updated_at)
  SELECT ?2, ?3, a.value ->> 'account_id', a.value ->> 'name', a.value ->> 'mask',
         a.value ->> 'type', a.value ->> 'subtype',
         CAST(round((a.value -> 'balances' ->> 'current') * 100) AS INTEGER),
         CAST(round((a.value -> 'balances' ->> 'available') * 100) AS INTEGER),
         a.value -> 'balances' ->> 'iso_currency_code', ${NOW}
  FROM json_each(?1, '$.accounts') a
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
  FROM (SELECT value FROM json_each(?1, '$.added') UNION ALL SELECT value FROM json_each(?1, '$.modified')) t
  JOIN accounts acc ON acc.plaid_account_id = t.value ->> 'account_id'
  WHERE true
  ON CONFLICT (plaid_txn_id) DO UPDATE SET
    amount_cents = excluded.amount_cents, date = excluded.date, datetime = excluded.datetime,
    name = excluded.name, merchant_name = excluded.merchant_name, category = excluded.category,
    pending = excluded.pending, pending_txn_id = excluded.pending_txn_id`;

const DELETE_REMOVED = `
  DELETE FROM transactions
  WHERE plaid_txn_id IN (SELECT value ->> 'transaction_id' FROM json_each(?1, '$.removed'))`;

export function pagesPerRun(env: Env): number {
  const n = Number(env.SYNC_MAX_PAGES_PER_RUN ?? DEFAULT_PAGES_PER_RUN);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PAGES_PER_RUN;
}

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
  while (budget.pages > 0) {
    budget.pages--;
    let page: { body: SyncPage; text: string };
    try {
      page = await plaidPost<SyncPage>(env, creds, "/transactions/sync",
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

    await env.DB.batch([
      env.DB.prepare(UPSERT_ACCOUNTS).bind(page.text, item.owner, item.id),
      env.DB.prepare(UPSERT_TRANSACTIONS).bind(page.text, item.owner),
      env.DB.prepare(DELETE_REMOVED).bind(page.text),
      env.DB.prepare(`UPDATE items SET txn_cursor = ?, status = 'good', updated_at = ${NOW} WHERE id = ?`)
        .bind(page.body.next_cursor, item.id),
    ]);
    cursor = page.body.next_cursor;
    if (!page.body.has_more) return "good";
  }
  return "partial";
}

async function setStatus(env: Env, itemId: number, status: string): Promise<void> {
  await env.DB.prepare(`UPDATE items SET status = ?, updated_at = ${NOW} WHERE id = ?`).bind(status, itemId).run();
}

/** Sweep every syncable Item, least recently updated first, within one run's budget.
 * Called only by the cron trigger (scheduled handler) — there is no HTTP sync endpoint. */
export async function runSyncAll(env: Env, budget: Budget = { pages: pagesPerRun(env) }): Promise<Record<number, ItemResult>> {
  const config = loadConfig(env);
  const { results: items } = await env.DB.prepare(
    "SELECT * FROM items WHERE status IN ('good', 'login_required') ORDER BY updated_at, id",
  ).all<ItemRow>();
  const out: Record<number, ItemResult> = {};
  for (const item of items) {
    if (budget.pages <= 0) break;
    out[item.id] = await syncItem(env, config, item, budget);
  }
  return out;
}
