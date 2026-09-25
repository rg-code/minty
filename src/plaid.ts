import type { Env } from "./env";
import { ConfigError } from "./config";

/** Minimal Plaid REST client over fetch() (the Plaid SDKs don't target Workers). Credentials go in
 * headers; request/response bodies and access tokens are never logged. */

const HOSTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export class PlaidError extends Error {
  constructor(
    public httpStatus: number,
    public errorType: string,
    public errorCode: string,
    public requestId: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface PlaidResult<T> {
  body: T;
  /** The raw response text, so sync can hand a whole page to D1 without re-serialising it. */
  text: string;
}

export function plaidHost(env: Env): string {
  const name = (env.PLAID_ENV ?? "sandbox").trim();
  const host = HOSTS[name];
  if (!host) throw new ConfigError(`PLAID_ENV must be "sandbox" or "production" (got ${JSON.stringify(name)})`);
  return host;
}

export async function plaidPost<T>(
  env: Env,
  creds: { clientId: string; secret: string },
  path: string,
  body: Record<string, unknown>,
): Promise<PlaidResult<T>> {
  const res = await fetch(plaidHost(env) + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "PLAID-CLIENT-ID": creds.clientId,
      "PLAID-SECRET": creds.secret,
      "Plaid-Version": "2020-09-14",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PlaidError(res.status, "API_ERROR", "NON_JSON_RESPONSE", undefined, `Plaid ${path}: HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new PlaidError(res.status, String(parsed.error_type ?? "API_ERROR"), String(parsed.error_code ?? "UNKNOWN"),
      parsed.request_id, `Plaid ${path}: ${parsed.error_code ?? res.status}`);
  }
  return { body: parsed as T, text };
}

/** Item-level problems the user must fix by reconnecting the bank (Link update mode). */
const LOGIN_REQUIRED = new Set([
  "ITEM_LOGIN_REQUIRED", "ITEM_LOCKED", "INVALID_CREDENTIALS", "INVALID_MFA", "USER_SETUP_REQUIRED",
  "INSUFFICIENT_CREDENTIALS", "INVALID_UPDATED_USERNAME", "PENDING_EXPIRATION",
]);
/** Item-level problems that retrying won't fix. */
const PERMANENT = new Set([
  "ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN", "ACCESS_NOT_GRANTED", "NO_ACCOUNTS", "INVALID_API_KEYS",
  "INVALID_PRODUCT", "PRODUCTS_NOT_SUPPORTED", "ITEM_NOT_SUPPORTED", "INSTITUTION_NO_LONGER_SUPPORTED",
]);

/** What a sync failure means for the item's status. null = transient (Plaid/bank outage, rate
 * limit, PRODUCT_NOT_READY right after linking, network): keep the status and retry next run.
 * (The Python app marked every failure 'error', which then stopped syncing that item for good.) */
export function statusForError(e: unknown): "login_required" | "error" | null {
  if (!(e instanceof PlaidError)) return null;
  if (LOGIN_REQUIRED.has(e.errorCode)) return "login_required";
  if (PERMANENT.has(e.errorCode)) return "error";
  return null;
}
