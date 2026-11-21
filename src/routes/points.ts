import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { CHECKED, PROGRAMS, PROGRAM_BY_ID, type Program } from "../points/programs";
import { likeMatcher } from "../benefits/engine";
import { ACCOUNT_NAME } from "../accounts";

/** BAM (docs/bam.md): miles and points balances, typed in or read from a statement PDF in the
 * browser (source "pdf", with the file's SHA-256; the PDF never leaves the device). Each POST is a
 * new reading of a balance (a balance is a person + program + account); GET shows the newest
 * reading of each with its earlier ones, each program's expiry rule, and the linked cards that
 * likely earn each currency. */

const MAX_BALANCE = 10_000_000_000;                // a typo guard, not a policy
const MAX_PROGRAM = 40;
const HISTORY = 24;                                // earlier readings sent per balance

const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v).toISOString().slice(0, 10) === v;
const today = () => new Date().toISOString().slice(0, 10);

// Every reading, once. No ORDER BY: D1 counts a sort as reading every row again, and a household
// has a few hundred readings, so the Worker groups and orders them (cheap at that size).
const LIST_SQL = "SELECT id, owner, program, account_hint, balance, as_of, source, created_at FROM point_balances";

interface Reading {
  id: number; owner: string; program: string; account_hint: string | null; balance: number;
  as_of: string; source: string; created_at: string;
}

// The linked credit cards, for "earned by" (a few rows: one per card).
const CARDS_SQL = `SELECT a.id, a.owner, a.name, ${ACCOUNT_NAME("a")} AS shown, a.mask, i.institution_name AS bank
                   FROM accounts a JOIN items i ON i.id = a.item_id WHERE a.type = 'credit'`;

interface Card { id: number; owner: string; name: string | null; shown: string | null; mask: string | null; bank: string | null }

// Kos's award bookings (docs/trips.md §7, T4): a booking's points and program. trip_items is small (a
// household's bookings), so this reads it once; only rows with points and a program are kept.
const AWARDS_SQL = `SELECT i.id, i.points, i.points_program, i.name, i.kind, i.created_at, i.start_at, t.id AS trip_id, t.name AS trip, t.travellers
                    FROM trip_items i LEFT JOIN trips t ON t.id = i.trip_id WHERE i.points_program IS NOT NULL AND i.points > 0`;

export interface Award { id: number; points: number; points_program: string; name: string | null; kind: string; created_at: string; start_at: string | null;
                         trip_id: number | null; trip: string | null; travellers: string | null }
export interface Pending { item_id: number; trip_id: number | null; trip: string | null; name: string | null; kind: string; points: number;
                           program: string; owner: string | null; booked: string; start_at: string | null }

/** BAM's pending changes (docs/trips.md §7): each award booking in Kos whose points aren't in a balance
 * reading yet. Whose balance: the trip's one traveller, or the only person in the household; else
 * the household's (null). A reading of that program (that person's, when known) dated on or after the
 * day the booking was added to Kos is taken to include it, and the pending change goes. Readings stay
 * readings: nothing is ever written to point_balances. Pure, so it's tested on its own. */
export function pendingChanges(awards: Award[], readings: Pick<Reading, "owner" | "program" | "as_of">[], people: string[]): Pending[] {
  const out: Pending[] = [];
  for (const a of awards) {
    let travellers: unknown = [];
    try { travellers = JSON.parse(a.travellers ?? "[]"); } catch { /* none */ }
    const list = Array.isArray(travellers) ? travellers.filter((x): x is string => typeof x === "string" && people.includes(x)) : [];
    const owner = list.length === 1 ? list[0] : people.length === 1 ? people[0] : null;
    const booked = a.created_at.slice(0, 10);
    if (readings.some((r) => r.program === a.points_program && (owner === null || r.owner === owner) && r.as_of >= booked)) continue;
    out.push({ item_id: a.id, trip_id: a.trip_id, trip: a.trip, name: a.name, kind: a.kind, points: a.points, program: a.points_program, owner, booked, start_at: a.start_at });
  }
  return out.sort((x, y) => (x.booked < y.booked ? 1 : x.booked > y.booked ? -1 : y.item_id - x.item_id));
}

/** The program a card likely earns (its bank, then its name), or null. */
export function programForCard(card: Pick<Card, "name" | "bank">): Program | null {
  const bank = (card.bank ?? "").toLowerCase(), name = (card.name ?? "").toLowerCase();
  for (const p of PROGRAMS) {
    for (const r of p.earnedBy ?? []) {
      if (!likeMatcher([r.bank])(bank)) continue;
      if (r.names && !likeMatcher(r.names)(name)) continue;
      if (r.except && likeMatcher(r.except)(name)) continue;
      return p;
    }
  }
  return null;
}

/** GET /points: the programs Minty knows, each balance's newest reading with its history, the cards
 * that likely earn each currency, and Kos's award bookings not in a reading yet (`pending`). */
export async function listPoints(env: Env, config: Config): Promise<Response> {
  const [{ results }, { results: cardRows }, { results: awards }] = await env.DB.batch([env.DB.prepare(LIST_SQL), env.DB.prepare(CARDS_SQL), env.DB.prepare(AWARDS_SQL)]) as
    [D1Result<Reading>, D1Result<Card>, D1Result<Award>];
  const pending = pendingChanges(awards, results, [...config.users.keys()]);
  const groups = new Map<string, Reading[]>();
  for (const r of results) {
    const key = `${r.owner}\u0000${r.program}\u0000${r.account_hint ?? ""}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const balances = [...groups.values()].map((rows) => {
    rows.sort((a, b) => (a.as_of === b.as_of ? b.id - a.id : a.as_of < b.as_of ? 1 : -1));   // newest first
    const [r, ...older] = rows;
    const p = PROGRAM_BY_ID.get(r.program);
    return { ...r, name: p?.name ?? r.program, kind: p?.kind ?? "other", unit: p?.unit ?? "points",
             history: older.slice(0, HISTORY).map(({ id, balance, as_of, source }) => ({ id, balance, as_of, source })) };
  });
  balances.sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name) || (a.account_hint ?? "").localeCompare(b.account_hint ?? ""));
  const cards = cardRows.flatMap((c) => {
    const p = programForCard(c);
    return p ? [{ account_id: c.id, owner: c.owner, name: c.shown, mask: c.mask, program: p.id }] : [];   // matched on Plaid's name, shown as the household's
  });
  return json({ today: today(), checked: CHECKED, balances, cards, pending,
                programs: PROGRAMS.map(({ id, name, kind, unit, expiry }) => ({ id, name, kind, unit, expiry: expiry ?? null })) });
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  return b as Record<string, unknown>;
}

/** A program as sent: a known id, a known name (any case), or a name typed in (kept as typed). */
function program(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!s || s.length > MAX_PROGRAM) throw unprocessable(`program must be 1–${MAX_PROGRAM} characters`);
  if (PROGRAM_BY_ID.has(s)) return s;
  return PROGRAMS.find((p) => p.name.toLowerCase() === s.toLowerCase())?.id ?? s;
}

/** The fields of a reading from a request body, checked. `partial` for an edit (only what's sent). */
function fields(config: Config, b: Record<string, unknown>, partial: boolean): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  const has = (k: string) => b[k] !== undefined;
  if (!partial || has("program")) out.program = program(b.program);
  if (!partial || has("balance")) {
    if (!Number.isSafeInteger(b.balance) || (b.balance as number) < 0 || (b.balance as number) > MAX_BALANCE) {
      throw unprocessable("balance must be a whole number, 0 to 10,000,000,000");
    }
    out.balance = b.balance as number;
  }
  if (!partial || has("as_of")) {
    const v = b.as_of ?? (partial ? undefined : today());
    if (!isDate(v) || v < "2000-01-01" || v > new Date(Date.now() + 864e5).toISOString().slice(0, 10)) {
      throw unprocessable("as_of must be a date (YYYY-MM-DD), not in the future");
    }
    out.as_of = v;
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

/** POST /points: a new reading of a balance (by hand, or read from a PDF: source "pdf" with its SHA-256). */
export async function createReading(env: Env, config: Config, request: Request): Promise<Response> {
  const b = await objectBody(request);
  const f = fields(config, b, false);
  const source = b.source === "pdf" ? "pdf" : "manual";
  const sha = b.file_sha256 ?? null;
  if (sha !== null && !(typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha))) throw unprocessable("file_sha256 must be a SHA-256 in hex");
  if (source === "pdf" && !sha) throw unprocessable("a balance read from a PDF needs file_sha256");
  const row = await env.DB.prepare(
    `INSERT INTO point_balances (owner, program, account_hint, balance, as_of, source, file_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (file_sha256) DO NOTHING RETURNING id`)
    .bind(f.owner, f.program, f.account_hint, f.balance, f.as_of, source, sha).first<{ id: number }>();
  if (!row) throw new HttpError(409, "This PDF was already added.");
  return json({ id: row.id }, 201);
}

/** PUT /points/{id}: correct a reading (only the fields sent). */
export async function updateReading(env: Env, config: Config, request: Request, id: number): Promise<Response> {
  const f = fields(config, await objectBody(request), true);
  const cols = Object.keys(f);
  if (!cols.length) throw unprocessable("nothing to change");
  const r = await env.DB.prepare(`UPDATE point_balances SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? RETURNING id`)
    .bind(...cols.map((c) => f[c]), id).first();
  if (!r) throw new HttpError(404, "balance not found");
  return json({ id });
}

/** POST /points/known {sha256: [...]}: which of these PDFs already gave a balance (so the review skips them). */
export async function knownPoints(env: Env, request: Request): Promise<Response> {
  const list = (await objectBody(request)).sha256;
  if (!Array.isArray(list) || list.length > 200 || !list.every((s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s))) {
    throw unprocessable("sha256 must be a list of up to 200 SHA-256 hex strings");
  }
  if (!list.length) return json({ known: [] });
  const { results } = await env.DB.prepare("SELECT file_sha256 FROM point_balances WHERE file_sha256 IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(list)).all<{ file_sha256: string }>();
  return json({ known: results.map((r) => r.file_sha256) });
}

/** DELETE /points/{id}: one reading (the balance then shows its previous one, if any). */
export async function deleteReading(env: Env, id: number): Promise<Response> {
  const r = await env.DB.prepare("DELETE FROM point_balances WHERE id = ? RETURNING id").bind(id).first();
  if (!r) throw new HttpError(404, "balance not found");
  return json({ id, deleted: true });
}

