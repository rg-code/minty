import type { Env } from "../env";
import { type Config, isConfigured } from "../config";
import { HttpError, dateParam, intParam, json, unprocessable } from "../http";

/** Read API for the pages in public/, plus tag editing. */

const MAX_FILTER_TAGS = 20;   // D1 allows 100 bound parameters per query
const MAX_TAGS_PER_TXN = 50;
const MAX_TAG_LENGTH = 64;

export async function users(env: Env, config: Config): Promise<Response> {
  // Reports only whether keys are present, never the keys themselves.
  return json([...config.users].map(([key, label]) => ({
    key,
    label,
    slots: config.ownerAccounts.get(key)!.map((account) => ({
      account,
      slot: account.slice(account.indexOf("_") + 1),
      configured: isConfigured(env, config, account),
    })),
  })));
}

export async function items(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, owner, plaid_account, institution_name, status, updated_at FROM items ORDER BY owner, id",
  ).all();
  return json(results);
}

export async function accounts(env: Env, url: URL): Promise<Response> {
  const owner = url.searchParams.get("owner");
  const select = `SELECT id, owner, item_id, plaid_account_id, name, mask, type, subtype,
                         balance_current_cents / 100.0 AS balance_current,
                         balance_available_cents / 100.0 AS balance_available,
                         currency, updated_at
                  FROM accounts`;
  const stmt = owner
    ? env.DB.prepare(`${select} WHERE owner = ? ORDER BY name`).bind(owner)
    : env.DB.prepare(`${select} ORDER BY owner, name`);
  return json((await stmt.all()).results);
}

export async function capacity(env: Env, config: Config): Promise<Response> {
  // Per-person Trial-account usage: how many Items each credential set holds vs the cap.
  const { results } = await env.DB.prepare(
    "SELECT plaid_account, count(*) AS n FROM items GROUP BY plaid_account",
  ).all<{ plaid_account: string; n: number }>();
  const counts = new Map(results.map((r) => [r.plaid_account, r.n]));
  const out: Record<string, unknown[]> = {};
  for (const [owner, keys] of config.ownerAccounts) {
    out[owner] = keys.map((k) => ({
      account: k,
      slot: k.slice(k.indexOf("_") + 1),
      used: counts.get(k) ?? 0,
      cap: config.itemCap,
    }));
  }
  return json(out);
}

/** Trim, drop blanks, dedupe case-insensitively keeping the first spelling. */
export function normaliseTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      clean.push(t);
    }
  }
  return clean;
}

interface TxnRow {
  pending: number;
  tags: string;
  [k: string]: unknown;
}

export async function transactions(env: Env, url: URL): Promise<Response> {
  const p = url.searchParams;
  const owner = p.get("owner") || undefined;
  const accountId = intParam(url, "account_id");
  const start = dateParam(url, "start");
  const end = dateParam(url, "end");
  const q = p.get("q") || undefined;
  const tags = normaliseTags(p.getAll("tag"));
  const tagMode = p.get("tag_mode") ?? "any";
  if (tagMode !== "any" && tagMode !== "all") throw unprocessable("tag_mode must be 'any' or 'all'");
  if (tags.length > MAX_FILTER_TAGS) throw unprocessable(`at most ${MAX_FILTER_TAGS} tags can be filtered on`);
  const limit = intParam(url, "limit", { def: 500, min: 1, max: 1000 })!;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (owner)                   { clauses.push("t.owner = ?");      params.push(owner); }
  if (accountId !== undefined) { clauses.push("t.account_id = ?"); params.push(accountId); }
  if (start)                   { clauses.push("t.date >= ?");      params.push(start); }
  if (end)                     { clauses.push("t.date <= ?");      params.push(end); }
  if (tags.length) {
    // transaction_tags.tag is COLLATE NOCASE, so IN matches case-insensitively; the
    // (transaction_id, tag) primary key means "all" is a plain count of matching rows.
    const marks = tags.map(() => "?").join(", ");
    clauses.push(tagMode === "any"
      ? `EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag IN (${marks}))`
      : `(SELECT count(*) FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag IN (${marks})) = ?`);
    params.push(...tags);
    if (tagMode === "all") params.push(tags.length);
  }
  if (q) {
    clauses.push("(t.name LIKE ? OR t.merchant_name LIKE ?)");   // LIKE is case-insensitive for ASCII
    params.push(`%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);

  const sql = `
    SELECT t.id, t.owner, t.account_id, t.plaid_txn_id,
           t.amount_cents / 100.0 AS amount,
           t.currency, t.date, t.datetime, t.name, t.merchant_name, t.category,
           t.pending, t.pending_txn_id,
           (SELECT json_group_array(tag) FROM
              (SELECT tag FROM transaction_tags tt WHERE tt.transaction_id = t.id ORDER BY tt.position)) AS tags,
           a.name    AS account_name,
           a.mask    AS account_mask,
           a.type    AS account_type,
           a.subtype AS account_subtype
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    ${where}
    ORDER BY t.date DESC, t.id DESC
    LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...params).all<TxnRow>();
  return json(results.map((r) => ({ ...r, pending: Boolean(r.pending), tags: JSON.parse(r.tags) as string[] })));
}

export async function listTags(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT tag FROM transaction_tags GROUP BY tag ORDER BY tag",
  ).all<{ tag: string }>();
  return json(results.map((r) => r.tag));
}

export async function setTags(env: Env, request: Request, txnId: number): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw unprocessable("body must be JSON: {\"tags\": [...]}");
  }
  const tags = (body as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) {
    throw unprocessable("tags must be a list of strings");
  }
  const clean = normaliseTags(tags);
  if (clean.length > MAX_TAGS_PER_TXN) throw unprocessable(`at most ${MAX_TAGS_PER_TXN} tags per transaction`);
  if (clean.some((t) => t.length > MAX_TAG_LENGTH)) throw unprocessable(`tags must be at most ${MAX_TAG_LENGTH} characters`);

  const exists = await env.DB.prepare("SELECT id FROM transactions WHERE id = ?").bind(txnId).first();
  if (!exists) throw new HttpError(404, "transaction not found");

  // One batch = one transaction: replace the row's tags atomically.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM transaction_tags WHERE transaction_id = ?").bind(txnId),
    ...clean.map((tag, i) =>
      env.DB.prepare("INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, ?, ?)").bind(txnId, tag, i)),
  ]);
  return json({ id: txnId, tags: clean });
}
