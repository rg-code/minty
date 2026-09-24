import type { Env } from "./env";

/** Credential slots per person, in overflow order (primary first). Port of app/config.py. */
export const SLOTS = ["primary", "backup"] as const;

// Keys end up in secret names and in plaid_account ("<key>_<slot>"), so no underscores.
const USER_KEY = /^[a-z][a-z0-9]{0,23}$/;
const DEFAULT_USERS = "me:Me,spouse:Spouse";

/** A settings mistake (MINTY_USERS, TRIAL_ITEM_CAP). Reported to the caller, since only the
 * household's own Access users can reach the API and they need to see what to fix. */
export class ConfigError extends Error {}

/** "me:Me,spouse:Spouse" -> Map { me => "Me", spouse => "Spouse" }, preserving order. */
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
  /** owner -> ordered plaid_account keys, e.g. me -> [me_primary, me_backup] */
  ownerAccounts: Map<string, string[]>;
  /** plaid_account key -> owner */
  accountOwner: Map<string, string>;
  itemCap: number;
}

export function loadConfig(env: Env): Config {
  const users = parseUsers(env.MINTY_USERS?.trim() || DEFAULT_USERS);
  const ownerAccounts = new Map<string, string[]>();
  const accountOwner = new Map<string, string>();
  for (const owner of users.keys()) {
    const keys = SLOTS.map((slot) => `${owner}_${slot}`);
    ownerAccounts.set(owner, keys);
    for (const k of keys) accountOwner.set(k, owner);
  }
  const cap = Number(env.TRIAL_ITEM_CAP ?? "10");
  if (!Number.isInteger(cap) || cap < 1) throw new ConfigError("TRIAL_ITEM_CAP must be a positive integer");
  return { users, ownerAccounts, accountOwner, itemCap: cap };
}

export function credsFor(env: Env, config: Config, plaidAccount: string): { clientId: string; secret: string } {
  if (!config.accountOwner.has(plaidAccount)) throw new Error(`unknown plaid_account: ${plaidAccount}`);
  const suffix = plaidAccount.toUpperCase();
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return { clientId: str(env[`PLAID_CLIENT_ID_${suffix}`]), secret: str(env[`PLAID_SECRET_${suffix}`]) };
}

/** True when both the client id and secret for this credential set are present. */
export function isConfigured(env: Env, config: Config, plaidAccount: string): boolean {
  const c = credsFor(env, config, plaidAccount);
  return Boolean(c.clientId && c.secret);
}
