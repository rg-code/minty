import type { Env } from "./env";
import { type Config, credsFor, isConfigured, loadConfig } from "./config";
import { FernetError } from "./fernet";
import { openAccessToken } from "./token-key";
import { PlaidError, plaidPostText } from "./plaid";
import type { ItemRow } from "./sync";

/** Card statements from Plaid Liabilities (docs/bills.md), for the banks the household turned
 * statement details on for. The cron fetches one due bank per catch-up run that had no download
 * work, so it never competes with transaction sync for the free plan's CPU or subrequests; a
 * bank is refreshed about once a day. A failure here is recorded on statement_sync only: it never
 * changes items.status or the transaction sync. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const STATEMENT_REFRESH_HOURS = 24;
export const STATEMENT_RETRY_HOURS = 1;
const MAX_RESPONSE_CHARS = 1_000_000;            // a bank's /liabilities/get is a few KB

// Plaid's response text is bound once and SQLite unpacks it (as sync does with its pages), so the
// Worker never parses it. One row per credit card with a dated statement, matched to Minty's own
// account row on this bank. A later fetch of the same statement updates it; a missing field never
// erases a value seen before.
const SAVE_STATEMENTS = `
  INSERT INTO card_statements (account_id, issue_date, balance_cents, minimum_payment_cents, due_date,
                               last_payment_cents, last_payment_date, is_overdue, first_seen_at, last_seen_at)
  SELECT a.id, c.value ->> 'last_statement_issue_date',
         CAST(round((c.value ->> 'last_statement_balance') * 100) AS INTEGER),
         CAST(round((c.value ->> 'minimum_payment_amount') * 100) AS INTEGER),
         c.value ->> 'next_payment_due_date',
         CAST(round((c.value ->> 'last_payment_amount') * 100) AS INTEGER),
         c.value ->> 'last_payment_date',
         CASE json_type(c.value, '$.is_overdue') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
         ${NOW}, ${NOW}
  FROM json_each(?2, '$.liabilities.credit') c
  JOIN accounts a ON a.plaid_account_id = c.value ->> 'account_id' AND a.item_id = ?1
  WHERE (c.value ->> 'last_statement_issue_date') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ON CONFLICT (account_id, issue_date) DO UPDATE SET
    balance_cents         = coalesce(excluded.balance_cents, card_statements.balance_cents),
    minimum_payment_cents = coalesce(excluded.minimum_payment_cents, card_statements.minimum_payment_cents),
    due_date              = coalesce(excluded.due_date, card_statements.due_date),
    last_payment_cents    = coalesce(excluded.last_payment_cents, card_statements.last_payment_cents),
    last_payment_date     = coalesce(excluded.last_payment_date, card_statements.last_payment_date),
    is_overdue            = coalesce(excluded.is_overdue, card_statements.is_overdue),
    last_seen_at          = excluded.last_seen_at`;

const SAVED = `UPDATE statement_sync SET status = 'ready', synced_at = ${NOW}, last_error = NULL,
  next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${STATEMENT_REFRESH_HOURS} hours') WHERE item_id = ?1`;

const FAILED = `UPDATE statement_sync SET status = ?2, last_error = ?3,
  next_attempt_at = CASE WHEN ?2 = 'error' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${STATEMENT_RETRY_HOURS} hours') END
  WHERE item_id = ?1`;

/** Which statement_sync status a Plaid error code means. consent_required and unsupported wait
 * for the household (turn it on again, or leave it off); anything else is retried in an hour. */
export function statusForStatementError(code: string): "consent_required" | "unsupported" | "error" {
  if (["ADDITIONAL_CONSENT_REQUIRED", "ACCESS_NOT_GRANTED", "ITEM_LOGIN_REQUIRED", "CONSENT_EXPIRED", "INVALID_ACCESS_TOKEN"].includes(code)) return "consent_required";
  if (["PRODUCTS_NOT_SUPPORTED", "PRODUCT_NOT_SUPPORTED", "INVALID_PRODUCT", "ITEM_NOT_SUPPORTED", "NO_LIABILITY_ACCOUNTS", "NO_ACCOUNTS"].includes(code)) return "unsupported";
  return "error";
}

/** Saves one /liabilities/get response for a bank (exported for tests). */
export async function saveStatements(env: Env, itemId: number, text: string): Promise<void> {
  if (text.length > MAX_RESPONSE_CHARS) throw new PlaidError(200, "API_ERROR", "RESPONSE_TOO_LARGE", undefined, "/liabilities/get response too large");
  await env.DB.batch([env.DB.prepare(SAVE_STATEMENTS).bind(itemId, text), env.DB.prepare(SAVED).bind(itemId)]);
}

/** Fetches and saves one bank's statement details. Returns the statement_sync status. */
export async function syncStatements(env: Env, config: Config, item: ItemRow): Promise<string> {
  let code = "STATEMENTS_FAILED";
  try {
    if (!config.accountOwner.has(item.plaid_account) || !isConfigured(env, config, item.plaid_account) || !env.TOKEN_ENC_KEY) {
      code = "CONFIGURATION_REQUIRED";                     // Setup checks explain the missing keys
      throw new Error(code);
    }
    let accessToken: string;
    try {
      accessToken = await openAccessToken(env, item);
    } catch (e) {
      if (e instanceof FernetError) code = "INVALID_ACCESS_TOKEN";
      throw e;
    }
    const text = await plaidPostText(env, credsFor(env, config, item.plaid_account), "/liabilities/get", { access_token: accessToken });
    await saveStatements(env, item.id, text);
    return "ready";
  } catch (e) {
    if (e instanceof PlaidError) code = e.errorCode;
    // Only the code: Plaid's messages and payloads may carry account details.
    console.error(`statements: item ${item.id}: ${code}`);
    const status = statusForStatementError(code);
    await env.DB.prepare(FAILED).bind(item.id, status, code).run();
    return status;
  }
}

/** One due bank per call. The lease (next_attempt_at moved 10 minutes on, in one statement) keeps
 * two overlapping runs off the same bank; a crash just retries after it. */
export async function runStatementSync(env: Env, config: Config = loadConfig(env)): Promise<Record<string, string>> {
  const leased = await env.DB.prepare(
    `UPDATE statement_sync SET attempted_at = ${NOW}, next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes')
     WHERE item_id = (SELECT s.item_id FROM statement_sync s JOIN items i ON i.id = s.item_id
                      WHERE s.next_attempt_at IS NOT NULL AND s.next_attempt_at <= ${NOW} AND i.status = 'good'
                      ORDER BY s.next_attempt_at, s.item_id LIMIT 1)
     RETURNING item_id`).first<{ item_id: number }>();
  if (!leased) return {};
  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(leased.item_id).first<ItemRow>();
  if (!item) return {};
  return { [item.id]: await syncStatements(env, config, item) };
}
