import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { ACCOUNT_NAME } from "../accounts";
import { PROGRAM_BY_ID } from "../points/programs";
import { attachedMessage, emailText, readMessage, viewOf } from "../kos/mime";
import { MAX_TAGS_PER_TXN, MAX_TAG_LENGTH, normaliseTags } from "./data";
import { markIfLeftOutTags } from "../audit/totals";
import { reservations } from "../kos/reservations";

/** Kos, trips (docs/trips.md): trips, their bookings, and the transactions in them. The household
 * writes these; sync never does. The Kos app (public/kos/) is the page; the dashboard filters by a
 * trip with GET /transactions?trip_id=. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
type Body = Record<string, unknown>;
const KINDS = ["flight", "lodging", "car", "train", "bus", "restaurant", "event", "other"] as const;
const SOURCES = ["typed", "paste", "pdf", "screenshot", "email"] as const;
/** The largest email file read by POST /trips/read-email (index.ts lets this one route past 16 KiB). */
export const MAX_EMAIL_BYTES = 2 * 1024 * 1024;

const body = async (request: Request): Promise<Body> => {
  const b = await jsonBody(request);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  return b as Body;
};
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
// a local date and time, as bookings give them: 2027-03-10T11:05, with seconds and an offset optional
const isWhen = (s: string) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && isDate(s.slice(0, 10));
function field<T>(b: Body, k: string, old: unknown, check: (v: unknown) => T): T | null {
  if (!(k in b)) return (old as T | null | undefined) ?? null;
  const v = b[k];
  return v === null || v === undefined || v === "" ? null : check(v);
}
const text = (max: number, k: string) => (v: unknown) => {
  if (typeof v !== "string") throw unprocessable(`${k} must be text`);
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length > max) throw unprocessable(`${k} must be at most ${max} characters`);
  return t;
};
const dateF = (k: string) => (v: unknown) => { if (typeof v !== "string" || !isDate(v)) throw unprocessable(`${k} must be a date, YYYY-MM-DD`); return v; };
const whenF = (k: string) => (v: unknown) => { if (typeof v !== "string" || !isWhen(v)) throw unprocessable(`${k} must be a date and time, e.g. 2027-03-10T11:05`); return v; };
const intF = (k: string, min: number, max: number) => (v: unknown) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw unprocessable(`${k} must be a whole number from ${min} to ${max}`);
  return v;
};
const coordF = (k: string, lim: number) => (v: unknown) => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > lim) throw unprocessable(`${k} must be a coordinate`); return v; };
const codeF = (k: string, re: RegExp, what: string) => (v: unknown) => {
  if (typeof v !== "string" || !re.test(v.trim().toUpperCase())) throw unprocessable(`${k} must be ${what}`);
  return v.trim().toUpperCase();
};
const oneOf = <T extends string>(k: string, list: readonly T[]) => (v: unknown) => { if (typeof v !== "string" || !list.includes(v as T)) throw unprocessable(`${k} must be one of ${list.join(", ")}`); return v as T; };

// --- trips --------------------------------------------------------------------------------------
interface TripRow { id: number; name: string; start_date: string; end_date: string; place: string | null; lat: number | null; lon: number | null; travellers: string; notes: string | null; tags: string }

function tripFields(config: Config, b: Body, old: TripRow | null) {
  const f = {
    name: field(b, "name", old?.name, text(100, "name")),
    start_date: field(b, "start_date", old?.start_date, dateF("start_date")),
    end_date: field(b, "end_date", old?.end_date, dateF("end_date")),
    place: field(b, "place", old?.place, text(150, "place")),
    lat: field(b, "lat", old?.lat, coordF("lat", 90)),
    lon: field(b, "lon", old?.lon, coordF("lon", 180)),
    notes: field(b, "notes", old?.notes, text(2000, "notes")),
    travellers: old?.travellers ?? "[]",
    tags: old?.tags ?? "[]",
  };
  if (!f.name) throw unprocessable("give the trip a name");
  if (!f.start_date || !f.end_date) throw unprocessable("a trip needs its first and last day");
  if (f.end_date < f.start_date) throw unprocessable("the last day can't be before the first");
  if ("travellers" in b) {
    const t = b.travellers ?? [];
    if (!Array.isArray(t) || t.some((k) => typeof k !== "string" || !config.users.has(k))) throw unprocessable("travellers must be the household's people (MINTY_USERS)");
    f.travellers = JSON.stringify([...new Set(t as string[])]);
  }
  if ("tags" in b) {
    const t = b.tags ?? [];
    if (!Array.isArray(t) || t.some((x) => typeof x !== "string")) throw unprocessable("tags must be a list of tags");
    const clean = normaliseTags(t as string[]);
    if (clean.length > MAX_TRIP_TAGS) throw unprocessable(`at most ${MAX_TRIP_TAGS} tags on a trip`);
    if (clean.some((x) => x.length > MAX_TAG_LENGTH)) throw unprocessable(`tags must be at most ${MAX_TAG_LENGTH} characters`);
    f.tags = JSON.stringify(clean);
  }
  return f;
}
const TRIP_COLS = ["name", "start_date", "end_date", "place", "lat", "lon", "travellers", "notes", "tags"] as const;

// --- trip codes (docs/trips.md §21): a trip's own email address is you+<code>@gmail.com -------------
/** 10 characters from 31 (lowercase letters and digits without 0, 1, i, l, o): about 50 bits. */
export const TRIP_CODE = /^[2-9a-hjkmnp-z]{10}$/;
const CODE_CHARS = "23456789abcdefghjkmnpqrstuvwxyz";
export function newTripCode(): string {
  const out: string[] = [];
  while (out.length < 10) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < 248 && out.length < 10) out.push(CODE_CHARS[b % 31]);   // 248 = 8 × 31: no bias
  }
  return out.join("");
}
const MAX_TRIP_TAGS = 10;

// --- trip tags (docs/trips.md §18) --------------------------------------------------------------
// A trip's tags are written onto its confirmed transactions as ordinary tags, marked with the trip
// (transaction_tags.trip_id), so the dashboard's filter and CFA's "Left out of the numbers" follow
// them. A tag a person already put on a transaction stays theirs (ON CONFLICT DO NOTHING), and
// taking a tag off the trip, or a transaction out of it, removes only the rows the trip added.
/** Add one of a trip's tags to its confirmed transactions (or only to `ids`), after their own tags. */
const addTripTag = (env: Env, tripId: number, tag: string, ids?: number[]) => env.DB.prepare(
  `INSERT INTO transaction_tags (transaction_id, tag, position, trip_id)
   SELECT tl.transaction_id, ?2, coalesce((SELECT max(position) + 1 FROM transaction_tags x WHERE x.transaction_id = tl.transaction_id), 0), ?1
   FROM trip_transactions tl
   WHERE tl.trip_id = ?1 AND tl.state = 'confirmed'${ids ? " AND tl.transaction_id IN (SELECT value FROM json_each(?3))" : " AND ?3 IS NULL"}
     AND (SELECT count(*) FROM transaction_tags x WHERE x.transaction_id = tl.transaction_id) < ${MAX_TAGS_PER_TXN}
   ON CONFLICT (transaction_id, tag) DO NOTHING`).bind(tripId, tag, ids ? JSON.stringify(ids) : null);
const changes = (rs: D1Result[]) => rs.reduce((n, r) => n + (r.meta.changes ?? 0), 0);

export async function saveTrip(env: Env, config: Config, request: Request, id?: number): Promise<Response> {
  const old = id === undefined ? null : await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<TripRow>();
  if (id !== undefined && !old) throw new HttpError(404, "trip not found");
  const b = await body(request);
  const f = tripFields(config, b, old);
  const v = TRIP_COLS.map((c) => f[c]);
  if (!old) {
    // its code: one an import brings (when it's free), else a new one; a clash (vanishingly rare) tries again
    const insert = (code: string) => env.DB.prepare(`INSERT INTO trips (${TRIP_COLS.join(", ")}, code) VALUES (${TRIP_COLS.map(() => "?").join(", ")}, ?) RETURNING id`).bind(...v, code).first<{ id: number }>();
    let r: { id: number } | null = null;
    for (const code of [typeof b.code === "string" && TRIP_CODE.test(b.code) ? b.code : newTripCode(), newTripCode(), newTripCode()]) {
      try { r = await insert(code); break; } catch (e) { if (!/UNIQUE/i.test(String(e))) throw e; }
    }
    if (!r) throw new HttpError(500, "couldn't give the trip a code");
    const tripId = r.id;
    // bookings chosen when the trip is made (e.g. "make a trip from these")
    if (Array.isArray(b.items) && b.items.length) await moveItems(env, b.items, tripId);
    return json({ id: tripId }, 201);
  }
  // its tags: the ones added go onto its transactions, the ones taken off come off what the trip added
  const low = (j: string) => (JSON.parse(j) as string[]);
  const was = low(old.tags), now = low(f.tags);
  const added = now.filter((t) => !was.some((w) => w.toLowerCase() === t.toLowerCase()));
  const removed = was.filter((t) => !now.some((n) => n.toLowerCase() === t.toLowerCase()));
  const rs = await env.DB.batch([
    env.DB.prepare(`UPDATE trips SET ${TRIP_COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ${NOW} WHERE id = ?`).bind(...v, id),
    ...(removed.length ? [env.DB.prepare("DELETE FROM transaction_tags WHERE trip_id = ? AND tag IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(removed))] : []),
    ...added.map((t) => addTripTag(env, id!, t)),
  ]);
  if (changes(rs.slice(1))) await markIfLeftOutTags(env, [...added, ...removed]);
  return json({ id });
}

async function moveItems(env: Env, ids: unknown[], tripId: number | null) {
  if (ids.length > 200 || ids.some((x) => typeof x !== "number" || !Number.isSafeInteger(x))) throw unprocessable("items must be booking ids, at most 200");
  await env.DB.prepare("UPDATE trip_items SET trip_id = ?, updated_at = " + NOW + " WHERE id IN (SELECT value FROM json_each(?))").bind(tripId, JSON.stringify(ids)).run();
}

export async function deleteTrip(env: Env, id: number): Promise<Response> {
  // its bookings stay, with no trip (ON DELETE SET NULL); its links to transactions go (CASCADE);
  // the tags it put on them stay, as ordinary tags (a reimbursed trip's spending stays left out)
  const [, r] = await env.DB.batch([
    env.DB.prepare("UPDATE transaction_tags SET trip_id = NULL WHERE trip_id = ?").bind(id),
    env.DB.prepare("DELETE FROM trips WHERE id = ? RETURNING id").bind(id),
  ]);
  if (!r.results.length) throw new HttpError(404, "trip not found");
  return json({ id, removed: true });
}

/** GET /trips: every trip with its bookings (and the count of its transactions), and the bookings
 * not in a trip yet. Reads the trips and bookings once each, and the links by index. */
export async function listTrips(env: Env): Promise<Response> {
  const [trips, items, counts, off] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM trips ORDER BY start_date DESC, id DESC"),
    env.DB.prepare("SELECT * FROM trip_items ORDER BY coalesce(start_at, '9999'), id"),
    env.DB.prepare(`SELECT trip_id, count(*) AS n, sum(t.amount_cents) AS cents FROM trip_transactions tl CROSS JOIN transactions t ON t.id = tl.transaction_id
                    WHERE tl.state = 'confirmed' GROUP BY trip_id`),
    env.DB.prepare("SELECT value FROM analytics_exclusions WHERE kind = 'tag'"),     // CFA's left-out tags, to say so on a trip
  ]);
  const I = items.results as { trip_id: number | null }[];
  const C = new Map((counts.results as { trip_id: number; n: number; cents: number }[]).map((c) => [c.trip_id, c]));
  return json({
    trips: (trips.results as TripRow[]).map((t) => ({ ...t, travellers: JSON.parse(t.travellers), tags: JSON.parse(t.tags), items: I.filter((i) => i.trip_id === t.id),
      transactions: C.get(t.id)?.n ?? 0, spent_cents: C.get(t.id)?.cents ?? 0 })),
    unassigned: I.filter((i) => i.trip_id === null),
    left_out_tags: (off.results as { value: string }[]).map((r) => r.value),
  });
}

// --- bookings -----------------------------------------------------------------------------------
type ItemRow = Record<string, unknown> & { id: number };
const ITEM_COLS = ["trip_id", "kind", "name", "confirmation", "guest", "start_at", "end_at", "place", "lat", "lon", "price_cents", "currency", "points",
  "points_program", "airline", "flight_number", "dep_airport", "arr_airport", "dep_terminal", "dep_gate", "arr_terminal", "seat", "source", "source_sha256", "notes",
  "card_last4", "card_network", "booked_on"] as const;
export const CARD_NETWORKS = ["visa", "mastercard", "amex", "discover"] as const;

async function itemFields(env: Env, b: Body, old: ItemRow | null) {
  const f = {
    trip_id: field(b, "trip_id", old?.trip_id, intF("trip_id", 1, Number.MAX_SAFE_INTEGER)),
    kind: field(b, "kind", old?.kind, oneOf("kind", KINDS)),
    name: field(b, "name", old?.name, text(150, "name")),
    confirmation: field(b, "confirmation", old?.confirmation, text(40, "confirmation")),
    guest: field(b, "guest", old?.guest, text(100, "guest")),
    start_at: field(b, "start_at", old?.start_at, whenF("start_at")),
    end_at: field(b, "end_at", old?.end_at, whenF("end_at")),
    place: field(b, "place", old?.place, text(200, "place")),
    lat: field(b, "lat", old?.lat, coordF("lat", 90)),
    lon: field(b, "lon", old?.lon, coordF("lon", 180)),
    price_cents: field(b, "price_cents", old?.price_cents, intF("price_cents", 0, 1e11)),
    currency: field(b, "currency", old?.currency, codeF("currency", /^[A-Z]{3}$/, "a 3-letter currency code")),
    points: field(b, "points", old?.points, intF("points", 0, 1e9)),
    points_program: field(b, "points_program", old?.points_program, text(40, "points_program")),
    airline: field(b, "airline", old?.airline, codeF("airline", /^[A-Z0-9]{2,3}$/, "an airline code, e.g. UA")),
    flight_number: field(b, "flight_number", old?.flight_number, codeF("flight_number", /^\d{1,4}[A-Z]?$/, "a flight number, e.g. 837")),
    dep_airport: field(b, "dep_airport", old?.dep_airport, codeF("dep_airport", /^[A-Z]{3}$/, "an airport code, e.g. SFO")),
    arr_airport: field(b, "arr_airport", old?.arr_airport, codeF("arr_airport", /^[A-Z]{3}$/, "an airport code, e.g. NRT")),
    dep_terminal: field(b, "dep_terminal", old?.dep_terminal, text(10, "dep_terminal")),
    dep_gate: field(b, "dep_gate", old?.dep_gate, text(10, "dep_gate")),
    arr_terminal: field(b, "arr_terminal", old?.arr_terminal, text(10, "arr_terminal")),
    seat: field(b, "seat", old?.seat, text(10, "seat")),
    source: field(b, "source", old?.source, oneOf("source", SOURCES)) ?? "typed",
    source_sha256: field(b, "source_sha256", old?.source_sha256, codeF("source_sha256", /^[0-9A-F]{64}$/, "a SHA-256 in hex")),
    notes: field(b, "notes", old?.notes, text(2000, "notes")),
    card_last4: field(b, "card_last4", old?.card_last4, codeF("card_last4", /^\d{4}$/, "the card's last 4 digits")),
    card_network: field(b, "card_network", old?.card_network, oneOf("card_network", CARD_NETWORKS)),
    booked_on: field(b, "booked_on", old?.booked_on, dateF("booked_on")),
  };
  if (!f.kind) throw unprocessable(`kind must be one of ${KINDS.join(", ")}`);
  if (f.source_sha256) f.source_sha256 = f.source_sha256.toLowerCase();
  if (f.points_program && !PROGRAM_BY_ID.has(f.points_program)) throw unprocessable("points_program must be one of BAM's programs");
  if (f.trip_id !== null && !(await env.DB.prepare("SELECT 1 FROM trips WHERE id = ?").bind(f.trip_id).first())) throw unprocessable("no trip with that id");
  if (f.start_at && f.end_at && f.end_at.slice(0, 10) < f.start_at.slice(0, 10)) throw unprocessable("it can't end before it starts");
  return f;
}

export async function saveItem(env: Env, request: Request, id?: number): Promise<Response> {
  const old = id === undefined ? null : await env.DB.prepare("SELECT * FROM trip_items WHERE id = ?").bind(id).first<ItemRow>();
  if (id !== undefined && !old) throw new HttpError(404, "booking not found");
  const f = await itemFields(env, await body(request), old);
  const v = ITEM_COLS.map((c) => f[c]);
  if (!old) {
    const r = await env.DB.prepare(`INSERT INTO trip_items (${ITEM_COLS.join(", ")}) VALUES (${ITEM_COLS.map(() => "?").join(", ")}) RETURNING id`).bind(...v).first<{ id: number }>();
    return json({ id: r!.id }, 201);
  }
  await env.DB.prepare(`UPDATE trip_items SET ${ITEM_COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ${NOW} WHERE id = ?`).bind(...v, id).run();
  return json({ id });
}

export async function deleteItem(env: Env, id: number): Promise<Response> {
  const r = await env.DB.prepare("DELETE FROM trip_items WHERE id = ? RETURNING id").bind(id).first();
  if (!r) throw new HttpError(404, "booking not found");
  return json({ id, removed: true });
}

/** POST /trips/read-email: an email file's bytes (a .eml, as Gmail's "Download message" gives it),
 * read with Kos's reader into suggested bookings. Nothing is stored: the app shows them to confirm,
 * then saves the ones kept with POST /trips/items. Up to MAX_EMAIL_BYTES. */
export async function readEmail(env: Env, request: Request): Promise<Response> {
  // read up to the cap, also when no Content-Length was sent (index.ts checks it when it was)
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EMAIL_BYTES) { await reader.cancel().catch(() => {}); throw new HttpError(413, "email file too large (at most 2 MB)"); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  if (!bytes.length) throw unprocessable("send the email file's bytes");
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));   // one char per byte, as the reader takes
  const outer = readMessage(raw);
  const m = attachedMessage(raw) ?? outer;                    // forwarded as an attachment: the original, with its markup
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return json({ subject: m.subject, from: m.from, date: m.date, view: viewOf(outer), sha256: sha, bookings: reservations(m.html),
                text: (emailText(m) ?? "").slice(0, 20000) || null, attachments: m.attachments.map((a) => ({ filename: a.filename, content_type: a.contentType, size: a.size })) });
}

// --- a trip's transactions ----------------------------------------------------------------------
const SPEND_FIRST = ["TRAVEL", "FOOD_AND_DRINK", "TRANSPORTATION", "ENTERTAINMENT"];
const day = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const ROW = `t.id, t.date, t.amount_cents, t.currency, coalesce(t.merchant_name, t.name) AS name, t.category, t.pending, t.owner,
             ${ACCOUNT_NAME("a")} AS account_name, a.mask AS account_mask`;

// Booked before (docs/trips.md §28): a booking's charge, matched in SQL.
//  - Paid with a card Kos knows (card_last4): only that card's account (its mask ends in the same 4 digits;
//    its network, when the bank or the card's name tells it, not a different one).
//  - Otherwise, or when no account has those digits (an additional card has its own number): a charge
//    from the same company (a word of the booking's name, or its airline's) at the price.
//  - Both by idx_txn_pair: the price band, whatever the card's volume.
//  - Never a card payment, a transfer, income or a fee. From 3 days before the day it was booked (a year
//    before the trip when that isn't known) to a week after the trip (a stay or a car is often charged at
//    the end). The price within 2%, a stay's or a car's within 10% (taxes, fuel, extras).
const NOT_MONEY_MOVES = `t.amount_cents > 0 AND coalesce(t.category, '') NOT IN ('LOAN_PAYMENTS', 'TRANSFER_IN', 'TRANSFER_OUT', 'INCOME', 'BANK_FEES')`;
const BANK = "lower(coalesce(i.institution_name, a.institution, '') || ' ' || coalesce(a.name, ''))";
export const ACCOUNT_NETWORK = `CASE WHEN ${BANK} LIKE '%american express%' OR ${BANK} LIKE '%amex%' THEN 'amex'
  WHEN ${BANK} LIKE '%discover%' THEN 'discover' WHEN lower(coalesce(a.name, '')) LIKE '%visa%' THEN 'visa'
  WHEN lower(coalesce(a.name, '')) LIKE '%mastercard%' OR lower(coalesce(a.name, '')) LIKE '%world elite%' THEN 'mastercard' END`;
const AIRLINE_WORD: Record<string, string> = { UA: "united", DL: "delta", AA: "american air", AS: "alaska air", WN: "southwest", B6: "jetblue", HA: "hawaiian",
  F9: "frontier", NK: "spirit", AC: "air canada", BA: "british a", AF: "air france", LH: "lufthansa", KL: "klm", VS: "virgin atl", NH: "ana ", JL: "japan air",
  EK: "emirates", QR: "qatar", SQ: "singapore", CX: "cathay", QF: "qantas", IB: "iberia", AM: "aeromexico", WS: "westjet", SY: "sun country", G4: "allegiant" };
const COMMON_WORDS = new Set(["hotel", "hotels", "resort", "resorts", "suites", "inn", "the", "and", "spa", "airlines", "airline", "airways", "lines", "air", "rental",
  "rent", "car", "cars", "restaurant", "international", "collection", "club", "travel", "tours", "tour", "booking", "reservation", "flight", "stay", "trip",
  "beach", "city", "golf", "lodge", "villa", "villas", "house", "grand", "royal", "park", "plaza", "center", "centre", "tickets", "ticket", "train", "bus"]);
/** The words a charge from the same company would carry: the airline's, and the name's own (not "hotel"). */
export function companyWords(item: { name: string | null; airline: string | null }): string[] {
  const words = new Set<string>();
  if (item.airline && AIRLINE_WORD[item.airline]) words.add(AIRLINE_WORD[item.airline]);
  for (const w of String(item.name ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !COMMON_WORDS.has(w) && !/^\d+$/.test(w)) words.add(w);
  }
  return [...words].slice(0, 3).map((w) => w.slice(0, 30));         // D1: a LIKE pattern is at most 50 bytes
}
const KIND_WORD: Record<string, string> = { lodging: "the stay", car: "the car", train: "the train", bus: "the bus", restaurant: "the table", event: "the tickets", other: "the booking" };
type Priced = { id: number; name: string | null; kind: string; price_cents: number; currency: string | null; airline: string | null; flight_number: string | null;
  dep_airport: string | null; arr_airport: string | null; start_at: string | null; card_last4: string | null; card_network: string | null; booked_on: string | null };
const label = (p: Priced) => p.kind === "flight"
  ? `${[p.airline, p.flight_number].filter(Boolean).join(" ") || p.name || "the flight"}${p.dep_airport && p.arr_airport ? ` ${p.dep_airport}→${p.arr_airport}` : ""}`
  : `${KIND_WORD[p.kind] ?? "the booking"}${p.name ? `: ${p.name}` : ""}`;

/** GET /trips/{id}/suggestions: transactions that look like this trip's, for a person to confirm.
 * During: the day before it starts to the day after it ends, by the date index (bounded at both
 * ends). Booked before: each priced booking's charge (above). Already confirmed or dismissed ones
 * aren't suggested, and a charge is suggested for one booking only. */
export async function suggestions(env: Env, id: number): Promise<Response> {
  const trip = await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<TripRow>();
  if (!trip) throw new HttpError(404, "trip not found");
  const from = day(trip.start_date, -1), to = day(trip.end_date, 1), late = day(trip.end_date, 7);
  const [items, masks] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, kind, price_cents, currency, airline, flight_number, dep_airport, arr_airport, start_at, card_last4, card_network, booked_on
                    FROM trip_items WHERE trip_id = ? AND price_cents > 0 ORDER BY start_at, id`).bind(id),
    env.DB.prepare("SELECT DISTINCT substr(mask, -4) AS last4 FROM accounts WHERE mask IS NOT NULL"),      // one row per account
  ]);
  const priced = (items.results as Priced[]).slice(0, 20);
  const cards = new Set((masks.results as { last4: string }[]).map((m) => m.last4));
  const notLinked = "NOT EXISTS (SELECT 1 FROM trip_transactions x WHERE x.trip_id = ?1 AND x.transaction_id = t.id)";
  const plans = priced.map((p) => {
    const loose = p.kind === "lodging" || p.kind === "car" ? 0.1 : 0.02;
    const booked = p.booked_on && isDate(p.booked_on) && (!p.start_at || p.booked_on <= p.start_at.slice(0, 10)) ? p.booked_on : null;   // a date after it starts isn't when it was booked
    const since = booked ? day(booked, -3) : day(trip.start_date, -365);
    const common = [id, Math.floor(p.price_cents * (1 - loose)), Math.ceil(p.price_cents * (1 + loose)), since, late, (p.currency ?? "USD").toUpperCase(), p.price_cents];
    const words = companyWords(p);
    // INDEXED BY: by the price, not the dates or the card's account (measured: a busy card's year read 3,000
    // rows per booking that way; the price band, 2 to 700)
    const onCard = !!p.card_last4 && cards.has(p.card_last4);        // an additional card's own number isn't any account's
    const card = onCard ? env.DB.prepare(
      `SELECT ${ROW}, 'card' AS how FROM transactions t INDEXED BY idx_txn_pair JOIN accounts a ON a.id = t.account_id
       WHERE t.amount_cents >= ?2 AND t.amount_cents <= ?3 AND t.date >= ?4 AND t.date <= ?5 AND upper(coalesce(t.currency, 'USD')) = ?6
         AND t.account_id IN (SELECT a.id FROM accounts a JOIN items i ON i.id = a.item_id
                              WHERE substr(a.mask, -4) = ?8 AND (?9 IS NULL OR (${ACCOUNT_NETWORK}) IS NULL OR (${ACCOUNT_NETWORK}) = ?9))
         AND ${NOT_MONEY_MOVES} AND ${notLinked}
       ORDER BY abs(t.amount_cents - ?7), t.date LIMIT 3`).bind(...common, p.card_last4, p.card_network) : null;
    const named = !onCard && words.length ? env.DB.prepare(
      `SELECT ${ROW}, 'name' AS how FROM transactions t INDEXED BY idx_txn_pair JOIN accounts a ON a.id = t.account_id
       WHERE t.amount_cents >= ?2 AND t.amount_cents <= ?3 AND t.date >= ?4 AND t.date <= ?5 AND upper(coalesce(t.currency, 'USD')) = ?6
         AND ${NOT_MONEY_MOVES} AND ${notLinked}
         AND (${words.map((_, k) => `lower(coalesce(t.merchant_name, '') || ' ' || coalesce(t.name, '')) LIKE ?${k + 8}`).join(" OR ")})
       ORDER BY abs(t.amount_cents - ?7), t.date LIMIT 3`).bind(...common, ...words.map((w) => `%${w}%`)) : null;
    return { p, stmts: [card, named].filter((x): x is D1PreparedStatement => x !== null) };
  });
  const [during, ...rest] = await env.DB.batch([
    env.DB.prepare(`SELECT ${ROW} FROM transactions t JOIN accounts a ON a.id = t.account_id
                    WHERE t.date >= ?2 AND t.date <= ?3 AND t.amount_cents > 0 AND ${notLinked}
                      AND coalesce(t.category, '') NOT IN ('LOAN_PAYMENTS', 'TRANSFER_IN', 'TRANSFER_OUT', 'INCOME')
                    ORDER BY t.date, t.id LIMIT 300`).bind(id, from, to),
    ...plans.flatMap((x) => x.stmts),
  ]);
  const taken = new Set<number>();
  let k = 0;
  const booked = plans.map(({ p, stmts }) => {
    const rows = stmts.flatMap(() => rest[k++].results as { id: number; how: string }[]);
    const best = rows.find((r) => r.how === "card" && !taken.has(r.id)) ?? rows.find((r) => !taken.has(r.id));
    if (best) taken.add(best.id);
    return { item_id: p.id, item: label(p), price_cents: p.price_cents, how: best?.how ?? null, card: best?.how === "card" ? p.card_last4 : null, matches: best ? [best] : [] };
  }).filter((b) => b.matches.length);
  const D = (during.results as { id: number; category: string | null }[]).filter((t) => !taken.has(t.id));
  return json({
    from, to,
    during: D.filter((t) => SPEND_FIRST.includes(t.category ?? "")),
    also: D.filter((t) => !SPEND_FIRST.includes(t.category ?? "")),
    booked,
  });
}

/** POST /trips/{id}/transactions {confirm: [ids], dismiss: [ids], remove: [ids], item_id?}: link,
 * dismiss (not suggested again), or unlink transactions. */
export async function linkTransactions(env: Env, request: Request, id: number): Promise<Response> {
  const trip = await env.DB.prepare("SELECT tags FROM trips WHERE id = ?").bind(id).first<{ tags: string }>();
  if (!trip) throw new HttpError(404, "trip not found");
  const tags = JSON.parse(trip.tags) as string[];
  const b = await body(request);
  const list = (k: string) => {
    const v = b[k] ?? [];
    if (!Array.isArray(v) || v.length > 500 || v.some((x) => typeof x !== "number" || !Number.isSafeInteger(x))) throw unprocessable(`${k} must be transaction ids, at most 500`);
    return v as number[];
  };
  const confirm = list("confirm"), dismiss = list("dismiss"), remove = list("remove");
  const itemId = b.item_id === undefined || b.item_id === null ? null : intF("item_id", 1, Number.MAX_SAFE_INTEGER)(b.item_id);
  const set = (ids: number[], state: string) => env.DB.prepare(
    `INSERT INTO trip_transactions (trip_id, transaction_id, state, item_id)
     SELECT ?1, t.id, ?2, ?3 FROM transactions t WHERE t.id IN (SELECT value FROM json_each(?4))
     ON CONFLICT (trip_id, transaction_id) DO UPDATE SET state = excluded.state, item_id = coalesce(excluded.item_id, trip_transactions.item_id)`)
    .bind(id, state, itemId, JSON.stringify(ids));
  const out = [...dismiss, ...remove];
  const stmts = [
    ...(confirm.length ? [set(confirm, "confirmed")] : []),
    ...(dismiss.length ? [set(dismiss, "dismissed")] : []),
    ...(remove.length ? [env.DB.prepare("DELETE FROM trip_transactions WHERE trip_id = ? AND transaction_id IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(remove))] : []),
  ];
  // the trip's tags follow: onto the ones confirmed, off the ones taken out (only what the trip added)
  const tagStmts = [
    ...(confirm.length ? tags.map((t) => addTripTag(env, id, t, confirm)) : []),
    ...(out.length && tags.length ? [env.DB.prepare("DELETE FROM transaction_tags WHERE trip_id = ? AND transaction_id IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(out))] : []),
  ];
  if (stmts.length) {
    const rs = await env.DB.batch([...stmts, ...tagStmts]);
    if (changes(rs.slice(stmts.length))) await markIfLeftOutTags(env, tags);
  }
  return json({ id, confirmed: confirm.length, dismissed: dismiss.length, removed: remove.length });
}

// --- the trip journal (docs/trips.md §20) ---------------------------------------------------------
const MAX_NOTE = 5000, MAX_NOTES = 60;
/** GET /trips/{id}/journal: the household's notes, by day ('trip' for the journal's own), and when it
 * was ready and first opened. The rest of a journal is the trip's bookings, drawn by the page. */
export async function journal(env: Env, id: number): Promise<Response> {
  const [trip, notes] = await env.DB.batch([
    env.DB.prepare("SELECT journal_ready_at, journal_seen_at FROM trips WHERE id = ?").bind(id),
    env.DB.prepare("SELECT day, text FROM trip_journal_notes WHERE trip_id = ?").bind(id),
  ]);
  const t = trip.results[0] as { journal_ready_at: string | null; journal_seen_at: string | null } | undefined;
  if (!t) throw new HttpError(404, "trip not found");
  return json({ id, ready_at: t.journal_ready_at, seen_at: t.journal_seen_at,
                notes: Object.fromEntries((notes.results as { day: string; text: string }[]).map((n) => [n.day, n.text])) });
}
/** PUT /trips/{id}/journal: {day, text} keeps a note (empty text removes it), or {seen: true}. */
export async function saveJournal(env: Env, request: Request, id: number): Promise<Response> {
  if (!(await env.DB.prepare("SELECT 1 FROM trips WHERE id = ?").bind(id).first())) throw new HttpError(404, "trip not found");
  const b = await body(request);
  if (b.seen === true) {
    await env.DB.prepare(`UPDATE trips SET journal_seen_at = coalesce(journal_seen_at, ${NOW}) WHERE id = ?`).bind(id).run();
    return json({ id, seen: true });
  }
  const day = b.day;
  if (typeof day !== "string" || !(day === "trip" || isDate(day))) throw unprocessable("day must be a date (YYYY-MM-DD) or \"trip\"");
  if (typeof b.text !== "string") throw unprocessable("text must be a string");
  const text = b.text.trim();
  if (text.length > MAX_NOTE) throw unprocessable(`a note is at most ${MAX_NOTE} characters`);
  if (!text) {
    await env.DB.prepare("DELETE FROM trip_journal_notes WHERE trip_id = ? AND day = ?").bind(id, day).run();
    return json({ id, day, removed: true });
  }
  const r = await env.DB.prepare(
    `INSERT INTO trip_journal_notes (trip_id, day, text)
     SELECT ?1, ?2, ?3 WHERE (SELECT count(*) FROM trip_journal_notes WHERE trip_id = ?1 AND day <> ?2) < ${MAX_NOTES}
     ON CONFLICT (trip_id, day) DO UPDATE SET text = excluded.text, updated_at = ${NOW}`).bind(id, day, text).run();
  if (!r.meta.changes) throw unprocessable(`at most ${MAX_NOTES} notes in a journal`);
  return json({ id, day, saved: true });
}
/** The hourly run: a trip that has ended gets its journal marked ready (the day after its last day,
 * in UTC), so the app can say "Your Tokyo journal is ready". Trips are few: this reads them all. */
export async function markJournalsReady(env: Env): Promise<number> {
  const r = await env.DB.prepare(`UPDATE trips SET journal_ready_at = ${NOW} WHERE journal_ready_at IS NULL AND end_date < date('now')`).run();
  return r.meta.changes ?? 0;
}

// --- a Google Maps short link, followed (docs/trips.md §22) --------------------------------------------
// maps.app.goo.gl links only tell where a place is after a redirect, which a page can't read across
// sites. The Worker follows it: only from Google's short-link hosts, at most 3 hops, each only to a
// Google host, and it returns the final address (never a page). Kos reads the place from it.
const LINK_START = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\/[\w-]+\/?(\?[\w=&.-]*)?$/;
const LINK_HOP = /^(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.[a-z.]{2,6})$/;
export async function resolvePlaceLink(request: Request, fetchFn: typeof fetch = fetch): Promise<Response> {
  const b = await body(request);
  const start = String(b.url ?? "").trim();
  if (!LINK_START.test(start)) throw unprocessable("only a Google Maps short link (maps.app.goo.gl/…) can be followed");
  let url = start;
  for (let hop = 0; hop < 3; hop++) {
    const r = await fetchFn(url, { method: "GET", redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (Kos)" } });
    const next = r.headers.get("location");
    await r.body?.cancel();
    if (!next || r.status < 300 || r.status >= 400) break;
    const u = new URL(next, url);
    if (u.protocol !== "https:" || !LINK_HOP.test(u.hostname)) throw unprocessable("that link went somewhere other than Google Maps");
    url = u.href;
    if (/^(www\.|maps\.)?google\./.test(u.hostname) && u.pathname.startsWith("/maps")) return json({ url });
  }
  throw unprocessable("Google didn't say where that link goes: open it, and paste the long address from the browser's bar");
}
