import type { Env } from "../env";
import { type Config, keyState, secretNames } from "../config";
import { fernetDecrypt, fernetEncrypt } from "../fernet";
import { plaidHost } from "../plaid";
import { json } from "../http";

/** GET /status: setup checks for the household, shown on the /add-user page. Behind Access like
 * every API route; reports only whether things are set, never values. */

/** Must list every file in d1/migrations (a test checks this). */
export const EXPECTED_MIGRATIONS = ["0001_init.sql", "0002_sync_pages.sql", "0003_account_owner.sql"];

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
    const accounts = config.ownerAccounts.get(key)!;
    const slotOf = (a: string) => a.slice(a.indexOf("_") + 1);
    const set = accounts.filter((a) => keyState(env, config, a) === "set");
    const partial = accounts.filter((a) => keyState(env, config, a) === "partial");
    if (!set.length) {
      const n = secretNames(accounts[0]);
      add({ id: `plaid_keys_${key}`, ok: false, level: "warn", message: `${label}: no Plaid keys yet, so they can't link banks.`,
            fix: `Add secrets ${n.clientId} and ${n.secret}` +
                 (accounts.length > 1 ? ` (more Plaid accounts go in the next slots: ${accounts.slice(1).map(slotOf).join(", ")}).` : ".") });
    } else {
      const unused = accounts.filter((a) => keyState(env, config, a) === "missing").map(slotOf);
      add({ id: `plaid_keys_${key}`, ok: true, level: "warn",
            message: `${label}: Plaid keys set for ${set.map(slotOf).join(", ")}` +
                     ` (${set.length} of ${accounts.length} slot${accounts.length === 1 ? "" : "s"}, up to ${set.length * config.itemCap} bank logins)` +
                     (unused.length ? `; ${unused.join(", ")} unused.` : ".") });
    }
    for (const a of partial) {                   // half-set keys are a typo, not an unused slot
      const n = secretNames(a);
      add({ id: `plaid_keys_partial_${a}`, ok: false, level: "error",
            message: `${label}: slot ${slotOf(a)} has only one of its two Plaid keys, so it's skipped.`,
            fix: `Set both ${n.clientId} and ${n.secret}, or remove the one that's there.` });
    }
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
  // Plaid keys for someone who isn't in MINTY_USERS (e.g. set up for a second person who was never
  // added): they're never used, so say so rather than leave them silently ignored.
  const known = new Set([...config.users.keys()].map((k) => k.toUpperCase()));
  const orphans = [...new Set(Object.keys(env)
    .filter((k) => typeof (env as Record<string, unknown>)[k] === "string" && (env as Record<string, unknown>)[k] !== "")
    .map((k) => /^PLAID_(?:CLIENT_ID|SECRET)_([A-Z][A-Z0-9]*)_[A-Z0-9]+$/.exec(k)?.[1])
    .filter((k): k is string => !!k && !known.has(k)))];
  if (orphans.length) {
    const example = [...[...config.users].map(([k, l]) => `${k}:${l}`), ...orphans.map((o) => `${o.toLowerCase()}:Name`)].join(",");
    add({ id: "keys_unused", ok: false, level: "warn",
          message: `Plaid keys are set for ${orphans.join(", ")}, who ${orphans.length === 1 ? "isn't" : "aren't"} in MINTY_USERS, so they aren't used.`,
          fix: `To add ${orphans.length === 1 ? "them" : "those people"}, set MINTY_USERS to e.g. ${example}. Otherwise delete those secrets.` });
  }

  // Banks whose credential set is gone (person removed from MINTY_USERS, slot removed from
  // PLAID_SLOTS) or has no keys any more: sync skips them, so say so instead of failing silently.
  const { results: perAccount } = await env.DB.prepare(
    "SELECT plaid_account, count(*) AS n FROM items WHERE status IN ('good', 'login_required') GROUP BY plaid_account",
  ).all<{ plaid_account: string; n: number }>().catch(() => ({ results: [] as { plaid_account: string; n: number }[] }));
  const stranded = perAccount.filter((r) => !config.accountOwner.has(r.plaid_account) || keyState(env, config, r.plaid_account) !== "set");
  if (stranded.length) {
    const total = stranded.reduce((t, r) => t + r.n, 0);
    const why = stranded.map((r) => `${r.plaid_account} (${config.accountOwner.has(r.plaid_account)
      ? "no keys" : "not in MINTY_USERS / PLAID_SLOTS"})`).join(", ");
    add({ id: "items_stranded", ok: false, level: "error", message: `${total} bank(s) can't sync: ${why}.`,
          fix: "Restore that person / slot and its keys. Banks stay with the Plaid account they were linked under." });
  }
  if (byStatus.error) {
    add({ id: "items_error", ok: false, level: "warn", message: `${byStatus.error} bank(s) stopped syncing with a permanent Plaid error.`,
          fix: "Link them again from Add account." });
  }

  // Card members (Plaid's account_owner) per bank, so a household can see whether a multi-card
  // account (e.g. Amex authorized-user cards) reports who made each charge. Shown for American
  // Express and for any bank where Plaid sends it. Informational: never a warning, because Plaid
  // fills it in only for some accounts.
  const { results: members } = await env.DB.prepare(
    `SELECT i.id, i.institution_name AS name, count(t.id) AS n, count(t.account_owner) AS with_member,
            count(DISTINCT t.account_owner) AS distinct_members
     FROM items i JOIN accounts a ON a.item_id = i.id LEFT JOIN transactions t ON t.account_id = a.id
     WHERE i.status IN ('good', 'login_required')
     GROUP BY i.id
     HAVING with_member > 0 OR i.institution_name LIKE 'American Express%'
     ORDER BY i.id`,
  ).all<{ id: number; name: string | null; n: number; with_member: number; distinct_members: number }>()
    .catch(() => ({ results: [] as { id: number; name: string | null; n: number; with_member: number; distinct_members: number }[] }));
  for (const m of members) {
    const bank = m.name || `Bank #${m.id}`;
    const txns = `${m.n} transaction${m.n === 1 ? "" : "s"}`;
    add({ id: `card_members_${m.id}`, ok: true, level: "warn",
          message: m.with_member
            ? `${bank}: card member on ${m.with_member} of ${txns} (${m.distinct_members} card member${m.distinct_members === 1 ? "" : "s"}).`
            : `${bank}: no card members on its ${txns} yet. Plaid fills this in only for some accounts, such as Amex authorized-user cards.` });
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
