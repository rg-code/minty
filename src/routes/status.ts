import type { Env } from "../env";
import { type Config, isConfigured } from "../config";
import { fernetDecrypt, fernetEncrypt } from "../fernet";
import { plaidHost } from "../plaid";
import { json } from "../http";

/** GET /status: setup checks for the household, shown on the /add-user page. Behind Access like
 * every API route; reports only whether things are set, never values. The Python backend has no
 * /status, which is how the page knows which instructions to show. */

/** Must list every file in d1/migrations (a test checks this). */
export const EXPECTED_MIGRATIONS = ["0001_init.sql"];

const STALE_SYNC_HOURS = 3;          // cron runs hourly; allow a couple of misses

interface Check { id: string; ok: boolean; level: "error" | "warn"; message: string; fix?: string }

async function tokenKeyWorks(key: string | undefined): Promise<boolean> {
  if (!key) return false;
  try {
    return (await fernetDecrypt(await fernetEncrypt("check", key), key)) === "check";
  } catch {
    return false;
  }
}

export async function status(env: Env, config: Config, email: string): Promise<Response> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  if (email === "dev@localhost") {
    add({ id: "access", ok: false, level: "warn", message: "Cloudflare Access is bypassed (local development)." });
  } else {
    add({ id: "access", ok: true, level: "error", message: `Signed in through Cloudflare Access as ${email}.` });
  }

  add((await tokenKeyWorks(env.TOKEN_ENC_KEY))
    ? { id: "token_key", ok: true, level: "error", message: "TOKEN_ENC_KEY is set." }
    : { id: "token_key", ok: false, level: "error", message: "TOKEN_ENC_KEY is missing or not a valid key, so banks can't be linked.",
        fix: "Add a secret TOKEN_ENC_KEY. Generate one with: openssl rand -base64 32 | tr '+/' '-_'" });

  let plaidEnv = (env.PLAID_ENV ?? "sandbox").trim() || "sandbox";
  try {
    plaidHost(env);
    add(plaidEnv === "production"
      ? { id: "plaid_env", ok: true, level: "warn", message: "Plaid: production (real banks)." }
      : { id: "plaid_env", ok: false, level: "warn", message: "Plaid: sandbox (test banks only).",
          fix: "Set the variable PLAID_ENV to production when you're ready to link real banks." });
  } catch (e) {
    plaidEnv = "invalid";
    add({ id: "plaid_env", ok: false, level: "error", message: (e as Error).message, fix: "Set PLAID_ENV to sandbox or production." });
  }

  for (const [key, label] of config.users) {
    const [primary, backup] = config.ownerAccounts.get(key)!;
    const P = primary.toUpperCase(), B = backup.toUpperCase();
    add(isConfigured(env, config, primary)
      ? { id: `plaid_keys_${key}`, ok: true, level: "warn",
          message: `${label}: Plaid keys set${isConfigured(env, config, backup) ? " (primary + backup)" : " (primary)"}.` }
      : { id: `plaid_keys_${key}`, ok: false, level: "warn", message: `${label}: no Plaid keys yet, so they can't link banks.`,
          fix: `Add secrets PLAID_CLIENT_ID_${P} and PLAID_SECRET_${P} (backup, optional: PLAID_CLIENT_ID_${B} / PLAID_SECRET_${B}).` });
  }

  let applied: string[] = [];
  try {
    applied = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map((r) => r.name);
  } catch { /* table missing: nothing applied */ }
  const missing = EXPECTED_MIGRATIONS.filter((m) => !applied.includes(m));
  add(missing.length
    ? { id: "migrations", ok: false, level: "error", message: `Database schema is out of date (missing ${missing.join(", ")}).`,
        fix: "Redeploy (npm run deploy applies migrations), or run: npx wrangler d1 migrations apply DB --remote" }
    : { id: "migrations", ok: true, level: "error", message: "Database schema is up to date." });

  const { results: counts } = await env.DB.prepare("SELECT status, count(*) AS n FROM items GROUP BY status")
    .all<{ status: string; n: number }>().catch(() => ({ results: [] as { status: string; n: number }[] }));
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  if (byStatus.login_required) {
    add({ id: "items_login", ok: false, level: "warn", message: `${byStatus.login_required} bank(s) need you to sign in again.`,
          fix: "Open Add account and use Reconnect." });
  }
  if (byStatus.error) {
    add({ id: "items_error", ok: false, level: "warn", message: `${byStatus.error} bank(s) stopped syncing with a permanent Plaid error.`,
          fix: "Link them again from Add account." });
  }

  const last = await env.DB.prepare("SELECT max(updated_at) AS t FROM items WHERE status IN ('good', 'login_required') AND txn_cursor IS NOT NULL")
    .first<{ t: string | null }>().catch(() => null);
  if (last?.t) {
    const hours = (Date.now() - Date.parse(last.t)) / 3.6e6;
    add(hours > STALE_SYNC_HOURS
      ? { id: "sync", ok: false, level: "warn", message: `No successful sync for ${Math.round(hours)} hours.`,
          fix: "Check the Worker's cron trigger and logs (Workers & Pages → minty → Logs)." }
      : { id: "sync", ok: true, level: "warn", message: `Last sync ${hours < 1 ? "within the hour" : `${Math.round(hours)} h ago`}.` });
  }

  return json({ backend: "workers", plaid_env: plaidEnv, checks, items: byStatus });
}
