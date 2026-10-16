import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";

/** Bills (docs/bills.md), part 2: bills the household adds itself (PG&E, water, trash and so on),
 * by hand or read from a PDF in the browser (the PDF never leaves the device; only these fields
 * and its SHA-256 are saved). One row per bill: a quarterly bill is one row a quarter. A bill is
 * paid when it's marked paid, or when a posted payment matches it: money out, named like the bill
 * (match_name), within $1 of its amount, from its statement date (or 40 days before it's due) to
 * 15 days after it's due. */

export const MATCH_CENTS = 100;
const MAX_AMOUNT_CENTS = 10_000_000;             // $100,000: a typo guard, not a policy
const MAX_NAME = 80, MAX_MATCH = 40;             // D1 allows 50 bytes in a LIKE pattern; %…% adds 2

const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v).toISOString().slice(0, 10) === v;

/** What a bill's payment is probably called in transactions: its first word of 3+ letters (PG&E,
 * SFPUC, Recology), in upper case. Editable. */
export function defaultMatchName(biller: string): string {
  const word = biller.toUpperCase().match(/[A-Z0-9&'.-]{3,}/)?.[0] ?? biller.toUpperCase().trim();
  return word.slice(0, MAX_MATCH);
}

// Each bill with the first posted payment that matches it (index-driven: the date index gives the
// window; amount and name are checked on those rows only). Bills marked paid, and bills more than
// 90 days past due, aren't searched.
const LIST_SQL = `
  SELECT b.id, b.owner, b.biller, b.match_name, b.amount_cents, b.due_date, b.statement_date, b.account_hint,
         b.source, b.paid_at, b.created_at,
         CASE WHEN b.paid_at IS NULL AND b.due_date >= date('now', '-90 days') THEN
           (SELECT json_object('id', t.id, 'date', t.date, 'amount_cents', t.amount_cents, 'name', t.name)
            FROM transactions t
            WHERE t.date >= coalesce(b.statement_date, date(b.due_date, '-40 days')) AND t.date <= date(b.due_date, '+15 days')
              AND t.pending = 0 AND t.amount_cents BETWEEN b.amount_cents - ${MATCH_CENTS} AND b.amount_cents + ${MATCH_CENTS}
              AND (upper(t.name) LIKE ('%' || replace(replace(replace(b.match_name, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%') ESCAPE '\\'
                   OR upper(coalesce(t.merchant_name, '')) LIKE ('%' || replace(replace(replace(b.match_name, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%') ESCAPE '\\')
            ORDER BY t.date LIMIT 1) END AS matched
  FROM bills b
  ORDER BY b.due_date, b.id`;

export interface BillRow {
  id: number; owner: string; biller: string; match_name: string; amount_cents: number; due_date: string;
  statement_date: string | null; account_hint: string | null; source: string; paid_at: string | null; created_at: string;
  matched: string | null;
}

export async function listBills(env: Env): Promise<BillRow[]> {
  return (await env.DB.prepare(LIST_SQL).all<BillRow>()).results;
}

/** A bill's status, like a card statement's: paid (by hand or matched), unpaid, overdue; and
 * attention when unpaid and due within `attentionDays`, or overdue. */
export function billStatus(b: Pick<BillRow, "amount_cents" | "due_date" | "paid_at"> & { matched: unknown }, today: string, attentionDays: number) {
  const days = Math.round((Date.parse(b.due_date) - Date.parse(today)) / 864e5);
  if (b.paid_at || b.matched || b.amount_cents === 0) return { status: b.amount_cents === 0 ? "nothing_due" : "paid", attention: false, days_left: days };
  if (days < 0) return { status: "overdue", attention: true, days_left: days };
  return { status: "unpaid", attention: days <= attentionDays, days_left: days };
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  return b as Record<string, unknown>;
}

/** The fields of a bill from a request body, checked. `partial` for an edit (only what's sent). */
function fields(config: Config, b: Record<string, unknown>, partial: boolean): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  const has = (k: string) => b[k] !== undefined;
  if (!partial || has("biller")) {
    const v = typeof b.biller === "string" ? b.biller.replace(/\s+/g, " ").trim() : "";
    if (!v || v.length > MAX_NAME) throw unprocessable(`biller must be 1–${MAX_NAME} characters`);
    out.biller = v;
  }
  // The name to look for in transactions: as sent, else (for a new bill) the biller's first word.
  // Renaming a bill keeps its match name unless a new one is sent.
  if (typeof b.match_name === "string" && b.match_name.trim()) {
    const v = b.match_name.replace(/\s+/g, " ").trim().toUpperCase();
    if (new TextEncoder().encode(v).length > MAX_MATCH) throw unprocessable(`match_name must be at most ${MAX_MATCH} bytes`);
    out.match_name = v;
  } else if (!partial) {
    out.match_name = defaultMatchName(out.biller as string);
  }
  if (!partial || has("amount_cents")) {
    if (!Number.isInteger(b.amount_cents) || (b.amount_cents as number) < 0 || (b.amount_cents as number) > MAX_AMOUNT_CENTS) {
      throw unprocessable("amount_cents must be a whole number of cents, 0 to 10,000,000");
    }
    out.amount_cents = b.amount_cents as number;
  }
  if (!partial || has("due_date")) {
    if (!isDate(b.due_date)) throw unprocessable("due_date must be a date (YYYY-MM-DD)");
    out.due_date = b.due_date;
  }
  if (has("statement_date") || !partial) {
    if (b.statement_date === null || b.statement_date === undefined || b.statement_date === "") out.statement_date = null;
    else if (!isDate(b.statement_date)) throw unprocessable("statement_date must be a date (YYYY-MM-DD)");
    else out.statement_date = b.statement_date;
  }
  if (has("account_hint") || !partial) {
    const v = b.account_hint ?? null;
    if (v !== null && v !== "" && !(typeof v === "string" && /^\d{4}$/.test(v))) throw unprocessable("account_hint must be the last 4 digits");
    out.account_hint = v === "" ? null : (v as string | null);
  }
  if (!partial || has("owner")) {
    const v = b.owner ?? [...config.users.keys()][0];
    if (typeof v !== "string" || !config.users.has(v)) throw unprocessable("owner must be one of the people in MINTY_USERS");
    out.owner = v;
  }
  return out;
}

/** POST /bills: add a bill (by hand, or read from a PDF: source "pdf" with the file's SHA-256). */
export async function createBill(env: Env, config: Config, request: Request): Promise<Response> {
  const b = await objectBody(request);
  const f = fields(config, b, false);
  const source = b.source === "pdf" ? "pdf" : "manual";
  const sha = b.file_sha256 ?? null;
  if (sha !== null && !(typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha))) throw unprocessable("file_sha256 must be a SHA-256 in hex");
  if (source === "pdf" && !sha) throw unprocessable("a bill read from a PDF needs file_sha256");
  const row = await env.DB.prepare(
    `INSERT INTO bills (owner, biller, match_name, amount_cents, due_date, statement_date, account_hint, source, file_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (file_sha256) DO NOTHING RETURNING id`)
    .bind(f.owner, f.biller, f.match_name, f.amount_cents, f.due_date, f.statement_date, f.account_hint, source, sha).first<{ id: number }>();
  if (!row) throw new HttpError(409, "This PDF was already added.");
  return json({ id: row.id }, 201);
}

/** PUT /bills/{id}: change a bill's fields (only those sent). */
export async function updateBill(env: Env, config: Config, request: Request, id: number): Promise<Response> {
  const f = fields(config, await objectBody(request), true);
  const cols = Object.keys(f);
  if (!cols.length) throw unprocessable("nothing to change");
  const r = await env.DB.prepare(`UPDATE bills SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? RETURNING id`)
    .bind(...cols.map((c) => f[c]), id).first();
  if (!r) throw new HttpError(404, "bill not found");
  return json({ id });
}

/** POST /bills/{id}/paid {paid}: mark a bill paid (now) or not. */
export async function markBillPaid(env: Env, request: Request, id: number): Promise<Response> {
  const paid = (await objectBody(request)).paid;
  if (typeof paid !== "boolean") throw unprocessable("paid must be true or false");
  const r = await env.DB.prepare(`UPDATE bills SET paid_at = ${paid ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : "NULL"} WHERE id = ? RETURNING paid_at`)
    .bind(id).first<{ paid_at: string | null }>();
  if (!r) throw new HttpError(404, "bill not found");
  return json({ id, paid_at: r.paid_at });
}

/** DELETE /bills/{id}. */
export async function deleteBill(env: Env, id: number): Promise<Response> {
  const r = await env.DB.prepare("DELETE FROM bills WHERE id = ? RETURNING id").bind(id).first();
  if (!r) throw new HttpError(404, "bill not found");
  return json({ id, deleted: true });
}

/** POST /bills/known {sha256: [...]}: which of these PDFs were already added (so the review skips them). */
export async function knownBills(env: Env, request: Request): Promise<Response> {
  const list = (await objectBody(request)).sha256;
  if (!Array.isArray(list) || list.length > 200 || !list.every((s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s))) {
    throw unprocessable("sha256 must be a list of up to 200 SHA-256 hex strings");
  }
  if (!list.length) return json({ known: [] });
  const { results } = await env.DB.prepare(`SELECT file_sha256 FROM bills WHERE file_sha256 IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(list)).all<{ file_sha256: string }>();
  return json({ known: results.map((r) => r.file_sha256) });
}
