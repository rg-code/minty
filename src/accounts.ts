import type { Env } from "./env";
import { HttpError, json, jsonBody, unprocessable } from "./http";

/** Account names, as shown. Plaid's name (accounts.name) is kept as Plaid sends it, because card
 * recognition matches on it (ABC's products, BAM's "earned by"). What pages show is the household's
 * own name for the account (accounts.display_name, set with PUT /accounts/{id}/name), else Plaid's,
 * tidied: characters Plaid sent garbled (U+FFFD, a "®" that didn't survive) are dropped, and a
 * trailing "...6323" is dropped when it's the account's own last 4 (pages show "••6323" anyway). */

const MAX_NAME = 60;

const cleaned = (a: string) => `rtrim(replace(replace(${a}.name, char(65533), ''), '  ', ' '))`;

/** SQL: the name to show for account `a`. */
/** SQL: true when the household left this account (or its bank) out of the numbers (CFA, the
 * dashboard's cards, EGG; analytics_exclusions). `a` is the accounts table's alias. */
export const LEFT_OUT = (a: string) => `EXISTS (SELECT 1 FROM analytics_exclusions x
  WHERE (x.kind = 'account' AND x.value = CAST(${a}.id AS TEXT)) OR (x.kind = 'bank' AND x.value = CAST(${a}.item_id AS TEXT)))`;

export const ACCOUNT_NAME = (a: string) => `coalesce(nullif(${a}.display_name, ''),
  CASE WHEN ${a}.mask IS NOT NULL AND ${cleaned(a)} LIKE '%...' || ${a}.mask
       THEN rtrim(substr(${cleaned(a)}, 1, length(${cleaned(a)}) - length('...' || ${a}.mask)))
       ELSE ${cleaned(a)} END)`;

/** PUT /accounts/{id}/name {name}: the household's name for an account; null or "" goes back to Plaid's. */
export async function renameAccount(env: Env, request: Request, id: number): Promise<Response> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  const raw = (b as Record<string, unknown>).name;
  if (raw !== null && raw !== undefined && typeof raw !== "string") throw unprocessable("name must be text, or null for Plaid's name");
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (name.length > MAX_NAME) throw unprocessable(`name must be at most ${MAX_NAME} characters`);
  const r = await env.DB.prepare(`UPDATE accounts SET display_name = ? WHERE id = ? RETURNING ${ACCOUNT_NAME("accounts")} AS shown, name AS plaid_name`)
    .bind(name || null, id).first<{ shown: string | null; plaid_name: string | null }>();
  if (!r) throw new HttpError(404, "account not found");
  return json({ id, name: r.shown, plaid_name: r.plaid_name, renamed: Boolean(name) });
}
