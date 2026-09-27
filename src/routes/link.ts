import type { Env } from "../env";
import { type Config, ConfigError, credsFor, isConfigured } from "../config";
import { FernetError, fernetDecrypt, fernetEncrypt } from "../fernet";
import { HttpError, json, unprocessable } from "../http";
import { plaidPost } from "../plaid";
import { type ItemRow, syncItem } from "../sync";

/** Plaid Link flow: /link/token -> Link in the browser ->
 * /link/exchange (stores the encrypted access token, starts the first sync in the background).
 * /link/token/update opens Link in update mode to repair an Item (e.g. login_required). */

// First sync inside the /link/exchange request, which also does the token exchange and has the
// same 10 ms CPU limit on the free plan: one page. The rest of the backfill happens on cron runs.
const FIRST_SYNC = { pages: 1, bytes: 150_000 };
const HISTORY_DAYS = 730;            // ask for up to 24 months (Plaid's default is 90 days)

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* fall through */ }
  throw unprocessable("body must be a JSON object");
}

function str(b: Record<string, unknown>, name: string): string {
  const v = b[name];
  if (typeof v !== "string" || !v) throw unprocessable(`${name} is required`);
  return v;
}

function tokenKey(env: Env): string {
  if (!env.TOKEN_ENC_KEY) {
    throw new ConfigError("TOKEN_ENC_KEY is not set. Add it as a Worker secret: npx wrangler secret put TOKEN_ENC_KEY");
  }
  return env.TOKEN_ENC_KEY;
}

function linkBase(env: Env, owner: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    client_name: "Minty",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: owner },
  };
  const redirect = env.PLAID_REDIRECT_URI?.trim();
  if (redirect) base.redirect_uri = redirect;       // omitted entirely when unset (Plaid rejects an empty one)
  return base;
}

async function countItems(env: Env, plaidAccount: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM items WHERE plaid_account = ?")
    .bind(plaidAccount).first<{ n: number }>();
  return row?.n ?? 0;
}

/** This person's first Trial account under the Item cap (primary, then backup). Never another person's. */
export async function chooseAccountFor(env: Env, config: Config, owner: string): Promise<string> {
  for (const key of config.ownerAccounts.get(owner) ?? []) {
    if ((await countItems(env, key)) < config.itemCap) return key;
  }
  throw new HttpError(409,
    `All Plaid trial accounts for '${owner}' are at the ${config.itemCap}-item cap. ` +
    "Add another overflow account or upgrade to a paid Plaid plan.");
}

export async function createLinkToken(env: Env, config: Config, request: Request): Promise<Response> {
  const owner = (await body(request)).owner;
  if (typeof owner !== "string" || !config.users.has(owner)) throw new HttpError(400, "unknown owner");
  const account = await chooseAccountFor(env, config, owner);     // overflow decision happens here
  if (!isConfigured(env, config, account)) {
    const s = account.toUpperCase();
    throw new HttpError(400,
      `Plaid keys for '${account}' aren't set. Add Worker secrets PLAID_CLIENT_ID_${s} and PLAID_SECRET_${s} ` +
      `(npx wrangler secret put PLAID_CLIENT_ID_${s}).`);
  }
  const { body: resp } = await plaidPost<{ link_token: string }>(env, credsFor(env, config, account), "/link/token/create", {
    ...linkBase(env, owner),
    products: ["transactions"],
    transactions: { days_requested: HISTORY_DAYS },
  });
  // Return which account was used so /link/exchange uses the SAME credentials.
  return json({ link_token: resp.link_token, plaid_account: account });
}

export async function exchange(env: Env, config: Config, request: Request, ctx: ExecutionContext): Promise<Response> {
  const b = await body(request);
  const owner = str(b, "owner");
  const plaidAccount = str(b, "plaid_account");
  const publicToken = str(b, "public_token");
  const institution = typeof b.institution_name === "string" ? b.institution_name.slice(0, 200) : null;
  if (!config.accountOwner.has(plaidAccount)) throw new HttpError(400, "unknown plaid_account");
  if (config.accountOwner.get(plaidAccount) !== owner) throw new HttpError(400, "owner/account mismatch");
  const key = tokenKey(env);

  const { body: resp } = await plaidPost<{ access_token: string; item_id: string }>(
    env, credsFor(env, config, plaidAccount), "/item/public_token/exchange", { public_token: publicToken });
  const enc = await fernetEncrypt(resp.access_token, key);

  // Re-linking the same Plaid Item refreshes its token instead of failing on the unique key.
  const item = await env.DB.prepare(
    `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (plaid_item_id) DO UPDATE SET
       access_token_enc = excluded.access_token_enc, status = 'good',
       institution_name = COALESCE(excluded.institution_name, items.institution_name),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING *`,
  ).bind(owner, plaidAccount, resp.item_id, enc, institution).first<ItemRow>();

  // Initial backfill in the background; the response doesn't wait for it.
  ctx.waitUntil(syncItem(env, config, item!, { ...FIRST_SYNC }).catch((e) =>
    console.error(`first sync of item ${item!.id} failed:`, e instanceof Error ? e.message : e)));
  return json({ item_id: item!.id, plaid_account: plaidAccount, status: item!.status });
}

export async function updateMode(env: Env, config: Config, request: Request): Promise<Response> {
  const itemId = (await body(request)).item_id;
  if (!Number.isInteger(itemId)) throw unprocessable("item_id must be an integer");
  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(itemId).first<ItemRow>();
  if (!item) throw new HttpError(404, "item not found");
  if (!config.accountOwner.has(item.plaid_account)) throw new HttpError(400, "item's plaid_account is not configured");
  let accessToken: string;
  try {
    accessToken = await fernetDecrypt(item.access_token_enc, tokenKey(env));
  } catch (e) {
    if (!(e instanceof FernetError)) throw e;
    throw new HttpError(409, "This bank's stored token can't be decrypted with TOKEN_ENC_KEY; link it again instead.");
  }
  const { body: resp } = await plaidPost<{ link_token: string }>(env, credsFor(env, config, item.plaid_account), "/link/token/create", {
    ...linkBase(env, item.owner),
    access_token: accessToken,          // update mode; no products
  });
  return json({ link_token: resp.link_token, plaid_account: item.plaid_account });
}
