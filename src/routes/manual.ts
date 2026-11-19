import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { markNetWorthDirty } from "../audit/totals";

/** Manual accounts, holders and a beneficiary (docs/accounts.md). A manual account is an ordinary
 * accounts row (is_manual = 1) under its person's "manual" bank row (items.products = 'manual',
 * no Plaid credentials or token), so snapshots, net worth, display names, left-out and EGG treat
 * it like a linked one. Saving writes the account only: the hourly snapshot dates it by its
 * balance_as_of (CFA's rule: snapshots come from the cron, never a request). */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** The kinds a manual account can be: Plaid's own type and subtype spellings, so a manual 401(k)
 * goes to EGG and a manual card is a card. Only a home counts among other assets (§2).
 * public/accounts.js lists the same, with labels (a test checks they match). */
export const MANUAL_KINDS: Record<string, readonly string[]> = {
  depository: ["checking", "savings", "cd", "money market", "cash management"],
  investment: ["brokerage", "529", "education savings account", "ugma", "utma", "crypto exchange", "other",
               "401k", "403B", "457b", "roth 401k", "ira", "roth", "sep ira", "simple ira", "pension", "hsa", "retirement"],
  credit: ["credit card"],
  loan: ["mortgage", "auto", "student", "home equity", "personal", "other"],
  other: ["home", "vehicle", "valuables", "other"],
};

const MAX_NAME = 60, MAX_BANK = 80, MAX_NOTES = 1000, MAX_HOLDERS = 4, MAX_BENEFICIARY = 100;
const MAX_CENTS = 1e13;                                   // $100 billion: anything bigger is a typo

interface Row {
  id: number; owner: string; item_id: number; name: string | null; type: string | null; subtype: string | null; mask: string | null;
  currency: string | null; balance_current_cents: number | null; balance_as_of: string | null; institution: string | null;
  notes: string | null; holders: string; beneficiary: string | null;
}

const body = async (request: Request): Promise<Record<string, unknown>> => {
  const b = await jsonBody(request);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  return b as Record<string, unknown>;
};
const text = (v: unknown, field: string, max: number): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw unprocessable(`${field} must be text`);
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length > max) throw unprocessable(`${field} must be at most ${max} characters`);
  return t || null;
};
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
/** Today in UTC, plus a day: the browser sends its own date, which can be ahead of UTC's. */
const latestDay = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);

/** holders and beneficiary, validated: keys must be MINTY_USERS people; a beneficiary may instead
 * be a name, for someone who isn't a Minty person (a child's 529). */
function relations(config: Config, b: Record<string, unknown>, old: Row | null) {
  let holders = old ? old.holders : "[]", beneficiary = old ? old.beneficiary : null;
  if ("holders" in b) {
    const h = b.holders ?? [];
    if (!Array.isArray(h) || h.some((k) => typeof k !== "string")) throw unprocessable("holders must be a list of people");
    const keys = [...new Set(h as string[])];
    if (keys.length > MAX_HOLDERS) throw unprocessable(`at most ${MAX_HOLDERS} holders`);
    const unknown = keys.find((k) => !config.users.has(k));
    if (unknown) throw unprocessable(`"${unknown}" isn't one of the household's people (MINTY_USERS)`);
    holders = JSON.stringify(keys);
  }
  if ("beneficiary" in b) {
    const v = b.beneficiary;
    if (v === null || v === undefined || v === "") beneficiary = null;
    else if (typeof v === "object" && !Array.isArray(v) && typeof (v as { key?: unknown }).key === "string") {
      const key = (v as { key: string }).key;
      if (!config.users.has(key)) throw unprocessable(`"${key}" isn't one of the household's people (MINTY_USERS)`);
      beneficiary = JSON.stringify({ key });
    } else if (typeof v === "object" && !Array.isArray(v) && typeof (v as { name?: unknown }).name === "string") {
      const name = text((v as { name: string }).name, "beneficiary's name", MAX_BENEFICIARY);
      beneficiary = name ? JSON.stringify({ name }) : null;
    } else throw unprocessable('beneficiary must be {"key": person} or {"name": text}, or null');
  }
  return { holders, beneficiary };
}

/** The fields of a manual account from a body, over what's saved (an update sends only changes). */
function fields(config: Config, b: Record<string, unknown>, old: Row | null) {
  const owner = "owner" in b ? b.owner : old?.owner;
  if (typeof owner !== "string" || !config.users.has(owner)) throw unprocessable("owner must be one of the household's people (MINTY_USERS)");
  const name = "name" in b ? text(b.name, "name", MAX_NAME) : old?.name ?? null;
  if (!name) throw unprocessable("give the account a name");
  const type = "type" in b ? b.type : old?.type, subtype = "subtype" in b ? b.subtype : old?.subtype;
  if (typeof type !== "string" || typeof subtype !== "string" || !MANUAL_KINDS[type]?.includes(subtype)) {
    throw unprocessable("type and subtype must be one of the manual kinds (cash, investments, retirement, cards, loans, other assets)");
  }
  const mask = "mask" in b ? text(b.mask, "mask", 4) : old?.mask ?? null;
  if (mask && !/^\d{4}$/.test(mask)) throw unprocessable("mask must be the last 4 digits");
  const currency = "currency" in b ? text(b.currency, "currency", 3)?.toUpperCase() ?? "USD" : old?.currency ?? "USD";
  if (!/^[A-Z]{3}$/.test(currency)) throw unprocessable("currency must be a 3-letter code, e.g. USD");
  const institution = "institution" in b ? text(b.institution, "bank", MAX_BANK) : old?.institution ?? null;
  const notes = "notes" in b ? text(b.notes, "notes", MAX_NOTES) : old?.notes ?? null;
  let balance = old?.balance_current_cents ?? null;
  if ("balance_cents" in b) {
    const v = b.balance_cents;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || Math.abs(v) > MAX_CENTS) throw unprocessable("balance_cents must be a whole number of cents");
    balance = v;
  }
  if (balance === null) throw unprocessable("give the balance (balance_cents)");
  let asOf = old?.balance_as_of ?? null;
  if ("balance_as_of" in b || "balance_cents" in b) {
    const v = b.balance_as_of ?? new Date().toISOString().slice(0, 10);
    if (typeof v !== "string" || !isDate(v)) throw unprocessable("balance_as_of must be a date, YYYY-MM-DD");
    if (v > latestDay()) throw unprocessable("balance_as_of can't be in the future");
    // Snapshots are dated by it, so it only moves forward: an older value than the one saved would
    // put the current balance behind the history (docs/accounts.md §3).
    if (old?.balance_as_of && v < old.balance_as_of && balance !== old.balance_current_cents) {
      throw unprocessable(`the saved balance is from ${old.balance_as_of}; a new one needs that date or a later one`);
    }
    asOf = v;
  }
  return { owner, name, type, subtype, mask, currency, institution, notes, balance, asOf, ...relations(config, b, old) };
}

const SELECT = `SELECT id, owner, item_id, name, type, subtype, mask, currency, balance_current_cents, balance_as_of, institution, notes, holders, beneficiary
                FROM accounts`;

/** The person's "manual" bank row, made the first time they add a manual account. */
const ensureBank = (env: Env, owner: string) => env.DB.prepare(
  `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, status, products)
   VALUES (?1, '', 'manual:' || ?1, '', NULL, 'manual', 'manual') ON CONFLICT (plaid_item_id) DO NOTHING`).bind(owner);

/** POST /accounts/manual: a new manual account. */
export async function create(env: Env, config: Config, request: Request): Promise<Response> {
  const f = fields(config, await body(request), null);
  const [, ins] = await env.DB.batch([
    ensureBank(env, f.owner),
    env.DB.prepare(
      `INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype, balance_current_cents, currency, updated_at,
                             is_manual, balance_as_of, institution, notes, holders, beneficiary)
       SELECT ?1, id, 'manual:' || lower(hex(randomblob(12))), ?2, ?3, ?4, ?5, ?6, ?7, ${NOW}, 1, ?8, ?9, ?10, ?11, ?12
       FROM items WHERE plaid_item_id = 'manual:' || ?1 RETURNING id`)
      .bind(f.owner, f.name, f.mask, f.type, f.subtype, f.balance, f.currency, f.asOf, f.institution, f.notes, f.holders, f.beneficiary),
  ]);
  const id = (ins.results[0] as { id: number } | undefined)?.id;
  if (!id) throw new HttpError(500, "the account wasn't saved");
  return json({ id }, 201);
}

const manualRow = async (env: Env, id: number) => {
  const old = await env.DB.prepare(`${SELECT} WHERE id = ? AND is_manual = 1`).bind(id).first<Row>();
  if (!old) throw new HttpError(404, "no manual account with that id (linked accounts change through their bank)");
  return old;
};

/** PUT /accounts/{id}/manual: change a manual account; send only what changes. */
export async function update(env: Env, config: Config, request: Request, id: number): Promise<Response> {
  const old = await manualRow(env, id);
  const f = fields(config, await body(request), old);
  const moved = f.owner !== old.owner;
  // net worth's history depends on these; a new balance or date only needs the next snapshot
  const reshaped = moved || f.type !== old.type || f.subtype !== old.subtype || f.currency !== (old.currency ?? "USD");
  await env.DB.batch([
    ...(moved ? [ensureBank(env, f.owner)] : []),
    env.DB.prepare(
      `UPDATE accounts SET owner = ?2, item_id = (SELECT id FROM items WHERE plaid_item_id = 'manual:' || ?2), name = ?3, mask = ?4,
              type = ?5, subtype = ?6, balance_current_cents = ?7, currency = ?8, balance_as_of = ?9, institution = ?10, notes = ?11,
              holders = ?12, beneficiary = ?13, updated_at = ${NOW}
       WHERE id = ?1 AND is_manual = 1`)
      .bind(id, f.owner, f.name, f.mask, f.type, f.subtype, f.balance, f.currency, f.asOf, f.institution, f.notes, f.holders, f.beneficiary),
    ...(reshaped ? [markNetWorthDirty(env)] : []),
    ...(moved ? [dropEmptyBank(env, old.item_id)] : []),
  ]);
  return json({ id });
}

const dropEmptyBank = (env: Env, itemId: number) => env.DB.prepare(
  "DELETE FROM items WHERE id = ? AND products = 'manual' AND NOT EXISTS (SELECT 1 FROM accounts WHERE item_id = items.id)").bind(itemId);

/** DELETE /accounts/{id}/manual: remove a manual account, its snapshots (ON DELETE CASCADE) and
 * its "left out" entry; net worth's history is rebuilt without it. Linked accounts can't be. */
export async function remove(env: Env, id: number): Promise<Response> {
  const old = await manualRow(env, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM analytics_exclusions WHERE kind = 'account' AND value = ?").bind(String(id)),   // a bound number is a REAL in D1
    env.DB.prepare("DELETE FROM accounts WHERE id = ? AND is_manual = 1").bind(id),
    dropEmptyBank(env, old.item_id),
    markNetWorthDirty(env),
  ]);
  return json({ id, removed: true });
}

/** PUT /accounts/{id}/holders {holders, beneficiary}: on any account, linked or manual. Labels and
 * a filter in Accounts, never an access boundary or a way to choose Plaid keys; sync never writes them. */
export async function setHolders(env: Env, config: Config, request: Request, id: number): Promise<Response> {
  const old = await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(id).first<Row>();
  if (!old) throw new HttpError(404, "account not found");
  const r = relations(config, await body(request), old);
  await env.DB.prepare("UPDATE accounts SET holders = ?, beneficiary = ? WHERE id = ?").bind(r.holders, r.beneficiary, id).run();
  return json({ id, holders: JSON.parse(r.holders), beneficiary: r.beneficiary ? JSON.parse(r.beneficiary) : null });
}
