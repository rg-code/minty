import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import worker from "../src/index";
import { primeJwks } from "../src/access";
import type { Env } from "../src/env";

export const ISSUER = "https://minty-test.cloudflareaccess.com";
export const AUD = "test-aud";
export const HOST = "https://minty.example.workers.dev";

const { privateKey, publicKey } = await generateKeyPair("RS256");
primeJwks(ISSUER, createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] }));

export const otherKey = (await generateKeyPair("RS256")).privateKey;

export async function accessToken(
  claims: Record<string, unknown> = { email: "me@example.com" },
  opts: { iss?: string; aud?: string; exp?: string | number; key?: CryptoKey } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? privateKey);
}

/** Call the Worker's fetch handler as a signed-in Access user (token: null = no header). */
export async function call(
  path: string,
  init: RequestInit & { token?: string | null; envOverrides?: Partial<Env>; host?: string } = {},
): Promise<Response> {
  const { token, envOverrides, host, ...rest } = init;
  const headers = new Headers(rest.headers);
  const jwt = token === undefined ? await accessToken() : token;
  if (jwt) headers.set("cf-access-jwt-assertion", jwt);
  const request = new Request(`${host ?? HOST}${path}`, { ...rest, headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...(env as unknown as Env), ...envOverrides }, ctx);
  await waitOnExecutionContext(ctx);        // e.g. the first sync after /link/exchange
  return response;
}

export const getJson = async <T = any>(path: string, init?: Parameters<typeof call>[1]) => {
  const r = await call(path, init);
  return { status: r.status, body: (await r.json()) as T };
};

/** Wipe and load a small fixture: 2 items, 3 accounts, 5 transactions, some tags. */
export async function loadFixture(): Promise<void> {
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM transaction_tags"),
    db.prepare("DELETE FROM transactions"),
    db.prepare("DELETE FROM accounts"),
    db.prepare("DELETE FROM items"),
    db.prepare(`INSERT INTO items (id, owner, plaid_account, plaid_item_id, access_token_enc, institution_name, updated_at)
                VALUES (1, 'me', 'me_primary', 'item-1', 'gAAAA-not-a-real-token', 'Chase', '2026-09-01T00:00:00.000Z'),
                       (2, 'spouse', 'spouse_primary', 'item-2', 'gAAAA-not-a-real-token', 'Ally', '2026-09-01T00:00:00.000Z')`),
    db.prepare(`INSERT INTO accounts (id, owner, item_id, plaid_account_id, name, mask, type, subtype, balance_current_cents, balance_available_cents, currency)
                VALUES (10, 'me', 1, 'acct-10', 'Sapphire', '9912', 'credit', 'credit card', 128455, NULL, 'USD'),
                       (11, 'me', 1, 'acct-11', 'Checking', '4821', 'depository', 'checking', 624018, 624018, 'USD'),
                       (20, 'spouse', 2, 'acct-20', 'Savings', '2290', 'depository', 'savings', 2250000, 2250000, 'USD')`),
    db.prepare(`INSERT INTO transactions (id, owner, account_id, plaid_txn_id, amount_cents, currency, date, name, merchant_name, category, pending)
                VALUES (100, 'me', 10, 'txn-100', 8412, 'USD', '2026-09-20', 'WHOLE FOODS', 'Whole Foods Market', 'FOOD_AND_DRINK', 0),
                       (101, 'me', 10, 'txn-101', 5240, 'USD', '2026-09-19', 'Shell', 'Shell', 'TRANSPORTATION', 1),
                       (102, 'me', 11, 'txn-102', -245000, 'USD', '2026-09-18', 'ACME Payroll', NULL, 'INCOME', 0),
                       (200, 'spouse', 20, 'txn-200', 1549, 'USD', '2026-09-17', 'Netflix', 'Netflix', 'ENTERTAINMENT', 0),
                       (201, 'spouse', 20, 'txn-201', 31200, 'USD', '2026-09-16', 'Delta Air', 'Delta Airlines', 'TRAVEL', 0)`),
    db.prepare(`INSERT INTO transaction_tags (transaction_id, tag, position)
                VALUES (100, 'groceries', 0),
                       (101, 'car', 0),
                       (200, 'subscription', 0),
                       (201, 'travel', 0), (201, 'reimbursable', 1)`),
  ]);
}
