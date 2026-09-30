import type { Env } from "./env";

// Keys and slot names end up in secret names and in plaid_account ("<key>_<slot>"), so they
// can't contain underscores.
const USER_KEY = /^[a-z][a-z0-9]{0,23}$/;
const SLOT_NAME = /^[a-z][a-z0-9]{0,15}$/;
const DEFAULT_USERS = "me:Me";      // one person; add more with MINTY_USERS

/** Plaid credential sets ("slots") each person can have, in overflow order: new links go to the
 * first slot that has keys and is under the Item cap. PLAID_SLOTS overrides the default; each
 * extra Plaid Trial account is one more slot (10 more bank logins per person). */
export const DEFAULT_SLOTS = ["primary", "backup"];
export const MAX_SLOTS = 10;

/** A settings mistake (MINTY_USERS, PLAID_SLOTS, TRIAL_ITEM_CAP). Reported to the caller, since
 * only the household's own Access users can reach the API and they need to see what to fix. */
export class ConfigError extends Error {}

/** "primary, backup, extra1" -> ["primary", "backup", "extra1"]. Unset or blank -> the default. */
export function parseSlots(raw: string | undefined): string[] {
  const names = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) return [...DEFAULT_SLOTS];
  const seen = new Set<string>();
  for (const name of names) {
    if (!SLOT_NAME.test(name)) {
      throw new ConfigError(`PLAID_SLOTS: invalid slot name ${JSON.stringify(name)} ` +
        "(lowercase letters and digits, starting with a letter, up to 16 characters)");
    }
    if (seen.has(name)) throw new ConfigError(`PLAID_SLOTS: duplicate slot ${JSON.stringify(name)}`);
    seen.add(name);
  }
  if (names.length > MAX_SLOTS) throw new ConfigError(`PLAID_SLOTS: at most ${MAX_SLOTS} slots`);
  return names;
}

/** "me:Alex,sam:Sam" -> Map { me => "Alex", sam => "Sam" }, preserving order. */
export function parseUsers(raw: string): Map<string, string> {
  const users = new Map<string, string>();
  for (const part of raw.split(",")) {
    if (!part.trim()) continue;
    const i = part.indexOf(":");
    const key = (i < 0 ? part : part.slice(0, i)).trim();
    const label = (i < 0 ? "" : part.slice(i + 1)).trim();
    if (!USER_KEY.test(key)) {
      throw new ConfigError(`MINTY_USERS: invalid user key ${JSON.stringify(key)} ` +
        "(lowercase letters and digits, starting with a letter)");
    }
    if (users.has(key)) throw new ConfigError(`MINTY_USERS: duplicate user key ${JSON.stringify(key)}`);
    users.set(key, label || key[0].toUpperCase() + key.slice(1));
  }
  if (!users.size) throw new ConfigError("MINTY_USERS is empty");
  return users;
}

export interface Config {
  /** key -> display label, in display order */
  users: Map<string, string>;
  /** credential slot names, in overflow order (PLAID_SLOTS) */
  slots: string[];
  /** owner -> ordered plaid_account keys, e.g. me -> [me_primary, me_backup] */
  ownerAccounts: Map<string, string[]>;
  /** plaid_account key -> owner */
  accountOwner: Map<string, string>;
  itemCap: number;
}

export function loadConfig(env: Env): Config {
  const users = parseUsers(env.MINTY_USERS?.trim() || DEFAULT_USERS);
  const slots = parseSlots(env.PLAID_SLOTS);
  const ownerAccounts = new Map<string, string[]>();
  const accountOwner = new Map<string, string>();
  for (const owner of users.keys()) {
    const keys = slots.map((slot) => `${owner}_${slot}`);
    ownerAccounts.set(owner, keys);
    for (const k of keys) accountOwner.set(k, owner);
  }
  const cap = Number(env.TRIAL_ITEM_CAP ?? "10");
  if (!Number.isInteger(cap) || cap < 1) throw new ConfigError("TRIAL_ITEM_CAP must be a positive integer");
  return { users, slots, ownerAccounts, accountOwner, itemCap: cap };
}

export function credsFor(env: Env, config: Config, plaidAccount: string): { clientId: string; secret: string } {
  if (!config.accountOwner.has(plaidAccount)) throw new Error(`unknown plaid_account: ${plaidAccount}`);
  const suffix = plaidAccount.toUpperCase();
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return { clientId: str(env[`PLAID_CLIENT_ID_${suffix}`]), secret: str(env[`PLAID_SECRET_${suffix}`]) };
}

/** True when both the client id and secret for this credential set are present. */
export function isConfigured(env: Env, config: Config, plaidAccount: string): boolean {
  return keyState(env, config, plaidAccount) === "set";
}

/** "set": both keys; "partial": only one of client id / secret (a typo or a half-finished edit);
 * "missing": neither (an unused slot, which is fine). */
export function keyState(env: Env, config: Config, plaidAccount: string): "set" | "partial" | "missing" {
  const c = credsFor(env, config, plaidAccount);
  return c.clientId && c.secret ? "set" : c.clientId || c.secret ? "partial" : "missing";
}

/** The secret names for a credential set, e.g. me_extra1 -> PLAID_CLIENT_ID_ME_EXTRA1 / PLAID_SECRET_ME_EXTRA1. */
export function secretNames(plaidAccount: string): { clientId: string; secret: string } {
  const s = plaidAccount.toUpperCase();
  return { clientId: `PLAID_CLIENT_ID_${s}`, secret: `PLAID_SECRET_${s}` };
}
