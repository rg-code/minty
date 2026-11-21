// Where Kos keeps its trips (docs/trips.md §17). One app, two places:
//   "minty":  served by a household's Minty at /kos/: Minty's API, on its D1, behind its sign-in.
//   "device": Kos on its own (built by scripts/build-kos.mjs, e.g. minty.milesmaximizer.com/kos/):
//             IndexedDB in this browser, nothing sent anywhere. Email files are read here too
//             (./mail/mime.js and ./mail/reservations.js, src/kos/ with its types stripped).
// public/kos/mode.js sets window.KOS_MODE before this loads. Both stores answer the same calls,
// with the same shapes as Minty's API (GET /trips and the rest), so kos.js doesn't care which.

export const MODE = globalThis.KOS_MODE === "device" ? "device" : "minty";

// --- checks shared by the device store and import (the server has its own, src/routes/kos.ts) --
const KINDS = ["flight", "lodging", "car", "train", "bus", "restaurant", "event", "other"];
const SOURCES = ["typed", "paste", "pdf", "screenshot", "email"];
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isWhen = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && isDate(s.slice(0, 10));
const text = (v, max) => (v === null || v === undefined || v === "" ? null : String(v).replace(/\s+/g, " ").trim().slice(0, max) || null);
const num = (v, lim) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > lim ? null : Number(v));
const int = (v, max) => (v === null || v === undefined || v === "" || !Number.isSafeInteger(Number(v)) || Number(v) < 0 || Number(v) > max ? null : Number(v));
const code = (v, re) => { const t = text(v, 10)?.toUpperCase() ?? null; return t && re.test(t) ? t : null; };

/** A trip's fields, checked: throws an Error with a plain message when one is wrong. */
// --- trip codes (docs/trips.md §21): a trip's email address is you+<code>@gmail.com ----------------
/** 10 characters from 31 (lowercase letters and digits without 0, 1, i, l or o), as the Worker makes them. */
export const isTripCode = (c) => /^[2-9a-hjkmnp-z]{10}$/.test(String(c ?? ""));
export function newTripCode() {
  const chars = "23456789abcdefghjkmnpqrstuvwxyz", out = [];
  while (out.length < 10) for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < 248 && out.length < 10) out.push(chars[b % 31]);
  return out.join("");
}
/** A trip's address: the person's Gmail with +code before the @, or just "+code" when it isn't known. */
export function tripAddress(code, gmailAddress) {
  const m = /^([^@\s+]+)(?:\+[^@\s]*)?@([^@\s]+)$/.exec(String(gmailAddress ?? "").trim());
  return m ? `${m[1]}+${code}@${m[2]}` : `+${code}`;
}

export function checkTrip(b) {
  const t = { name: text(b.name, 100), start_date: b.start_date, end_date: b.end_date, place: text(b.place, 150),
              lat: num(b.lat, 90), lon: num(b.lon, 180), notes: b.notes ? String(b.notes).slice(0, 2000) : null,
              travellers: Array.isArray(b.travellers) ? b.travellers.filter((k) => typeof k === "string").slice(0, 20) : [] };
  if (!t.name) throw new Error("give the trip a name");
  if (!isDate(t.start_date) || !isDate(t.end_date)) throw new Error("a trip needs its first and last day");
  if (t.end_date < t.start_date) throw new Error("the last day can't be before the first");
  return t;
}
/** A booking's fields, checked the way the server does (src/routes/kos.ts). */
export function checkItem(b) {
  if (!KINDS.includes(b.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  for (const k of ["start_at", "end_at"]) if (b[k] && !isWhen(b[k])) throw new Error(`${k} must be a date and time, e.g. 2027-03-10T11:05`);
  if (b.start_at && b.end_at && b.end_at.slice(0, 10) < b.start_at.slice(0, 10)) throw new Error("it can't end before it starts");
  for (const [k, re, what] of [["dep_airport", /^[A-Z]{3}$/, "an airport code, e.g. SFO"], ["arr_airport", /^[A-Z]{3}$/, "an airport code, e.g. NRT"],
                               ["airline", /^[A-Z0-9]{2,3}$/, "an airline code, e.g. UA"], ["flight_number", /^\d{1,4}[A-Z]?$/, "a flight number, e.g. 837"],
                               ["currency", /^[A-Z]{3}$/, "a 3-letter currency code"]]) {
    if (b[k] && !code(b[k], re)) throw new Error(`${k} must be ${what}`);
  }
  return {
    trip_id: b.trip_id ?? null, kind: b.kind, name: text(b.name, 150), confirmation: text(b.confirmation, 40), guest: text(b.guest, 100),
    start_at: b.start_at || null, end_at: b.end_at || null, place: text(b.place, 200), lat: num(b.lat, 90), lon: num(b.lon, 180),
    price_cents: int(b.price_cents, 1e11), currency: code(b.currency, /^[A-Z]{3}$/), points: int(b.points, 1e9), points_program: text(b.points_program, 40),
    airline: code(b.airline, /^[A-Z0-9]{2,3}$/), flight_number: code(b.flight_number, /^\d{1,4}[A-Z]?$/), dep_airport: code(b.dep_airport, /^[A-Z]{3}$/),
    arr_airport: code(b.arr_airport, /^[A-Z]{3}$/), dep_terminal: text(b.dep_terminal, 10), dep_gate: text(b.dep_gate, 10), arr_terminal: text(b.arr_terminal, 10),
    seat: text(b.seat, 10), source: SOURCES.includes(b.source) ? b.source : "typed",
    source_sha256: typeof b.source_sha256 === "string" && /^[0-9a-f]{64}$/i.test(b.source_sha256) ? b.source_sha256.toLowerCase() : null,
    notes: b.notes ? String(b.notes).slice(0, 2000) : null,
  };
}

/** The export file: every trip and booking, as JSON. Ids are kept only to tie bookings to trips. */
export function exportFile(list, notes = []) {
  const trips = list.trips.map(({ items, transactions, spent_cents, ...t }) => t);
  const items = [...list.trips.flatMap((t) => t.items), ...list.unassigned];
  return { app: "Kos", version: 1, exported_at: new Date().toISOString(), trips, items, notes };
}
/** The trips and bookings in an export file, checked, ready to save (a trip's `items` are its
 * bookings). Throws on a file that isn't Kos's. */
export function importFile(data) {
  if (!data || !["Kos", "JET"].includes(data.app) || data.version !== 1 || !Array.isArray(data.trips) || !Array.isArray(data.items)) throw new Error("That isn't a Kos export file.");
  if (data.trips.length > 500 || data.items.length > 5000) throw new Error("That file holds more than Kos takes at once.");
  const trips = data.trips.map((t) => ({ old: t.id, trip: { ...checkTrip(t), ...(isTripCode(t.code) ? { code: t.code } : {}) } }));   // its code goes with it
  const items = data.items.map((i) => ({ oldTrip: i.trip_id ?? null, item: checkItem({ ...i, trip_id: null }) }));
  // the journal's notes (docs/trips.md §20), when the file has them: re-tied to their trips on saving
  const notes = (Array.isArray(data.notes) ? data.notes : []).filter((n) => n && typeof n.text === "string" && (n.day === "trip" || isDate(n.day)))
    .slice(0, 5000).map((n) => ({ oldTrip: n.trip_id, day: n.day, text: n.text.slice(0, 5000) }));
  return notes.length ? { trips, items, notes } : { trips, items };
}

/** Kos on its own's sample trips (kos/sample.json, written by scripts/build-kos.mjs from the live
 * demo's made-up trips): dated from `sample_from`, moved to fall as far from `today` as they did
 * from that day, so the trip coming up is always coming up. */
export function shiftSample(file, today) {
  const day = (s) => Date.parse(`${s}T00:00:00Z`);
  const days = Math.round((day(today) - day(file.sample_from)) / 864e5);
  const move = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s)
    ? new Date(day(s.slice(0, 10)) + days * 864e5).toISOString().slice(0, 10) + s.slice(10) : s);
  return { ...file, trips: file.trips.map((t) => ({ ...t, start_date: move(t.start_date), end_date: move(t.end_date) })),
           items: file.items.map((i) => ({ ...i, start_at: move(i.start_at), end_at: move(i.end_at) })) };
}

// --- the trip's summary strip (kos.js summaryHtml): its kinds, and their labels --------------------
export const SUM_KINDS = [["flight", "Flight"], ["lodging", "Lodging"], ["car", "Rental car"], ["train", "Train"], ["restaurant", "Restaurant"], ["event", "Activity"], ["other", "Other"]];
/** Each kind's count (train counts buses too) and the trip's money: its linked spending on a Minty,
 * else what its bookings cost, by currency. */
export function tripSummary(t, spending) {
  const count = Object.fromEntries(SUM_KINDS.map(([k]) => [k, 0]));
  const booked = {};
  for (const i of t.items) {
    count[i.kind === "bus" ? "train" : count[i.kind] === undefined ? "other" : i.kind]++;
    if (i.price_cents) booked[i.currency || "USD"] = (booked[i.currency || "USD"] ?? 0) + i.price_cents;
  }
  return { count, money: spending ? { spent: t.spent_cents ?? 0, transactions: t.transactions ?? 0 } : { booked } };
}

// --- a trip's city photo (kos.js cityPhoto): which city, and which addresses are Wikimedia's --------
/** The names to look up for a trip's photo, best first: its place as typed ("Tokyo, Japan"), its first
 * part ("Tokyo"), then the city its first flight lands in (airports: IATA → [name, city, …]). */
const US_STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "Washington, D.C.", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico" };
/** The names to ask Wikipedia for a trip's city photo, best first (docs/trips.md §19.1):
 * - a street address's town, as Wikipedia titles US places ("Town, State"), and the part before a hyphen
 *   ("Example-north, CO 80000" → "Example-north, Colorado", "Example, Colorado");
 * - the place as typed and its first part, unless that's a street ("100 Example Road");
 * - the city the first day's flights end in: the destination, never a connection's stop;
 * - the trip's name, last ("Weekend" has a Wikipedia article and a photo of its own). */
export function cityNames(t, airports = {}) {
  const place = String(t.place ?? "").trim(), out = [];
  const addr = /,\s*([^,\d]+?),?\s+([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/.exec(place);
  if (addr) {
    const town = addr[1].trim(), state = US_STATES[addr[2]];
    if (state) out.push(`${town}, ${state}`, ...(town.includes("-") ? [`${town.split("-")[0].trim()}, ${state}`] : []));
    out.push(town);
  } else if (place) {
    out.push(place);
    const first = place.split(",")[0].trim();
    if (!/\d/.test(first)) out.push(first);
  }
  const flights = (t.items ?? []).filter((i) => i.kind === "flight" && i.arr_airport).sort((a, b) => ((a.start_at ?? "") < (b.start_at ?? "") ? -1 : 1));
  const firstDay = (flights[0]?.start_at ?? "").slice(0, 10);
  const dest = flights.filter((f) => (f.start_at ?? "").slice(0, 10) === firstDay).at(-1);
  if (dest && airports[dest.arr_airport]?.[1]) out.push(airports[dest.arr_airport][1]);
  if (t.name) out.push(String(t.name).trim());              // last: "Weekend" has an article (and a photo) of its own
  return [...new Set(out.filter(Boolean))].slice(0, 5);
}
/** Only Wikimedia's own image hosts, over https (the page's policy allows just these for photos). */
export const isWikimediaImage = (u) => /^https:\/\/(upload|thumb)\.wikimedia\.org\/[^\s"'()\\]+$/.test(String(u ?? ""));

// --- backups (Kos on its own, docs/trips.md §17.5): when to remind ------------------------------------
/** Whether to show the backup reminder: trips of one's own, last backed up (or, never, the oldest of
 * them made) more than 30 days ago, and not snoozed. Times in ms. */
/** The trip a booking on `day` (YYYY-MM-DD) belongs to, from the trips' dates: the one trip that covers it,
 * else the one starting the next day (the flight out the night before). Two trips that both fit: none, the
 * person picks (docs/trips.md §21.1). */
export function tripFor(day, trips) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(day ?? "")) return null;
  day = day.slice(0, 10);
  const inside = trips.filter((t) => t.start_date <= day && day <= t.end_date);
  if (inside.length) return inside.length === 1 ? inside[0] : null;
  const next = new Date(day + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
  const eve = trips.filter((t) => t.start_date === next.toISOString().slice(0, 10));
  return eve.length === 1 ? eve[0] : null;
}

export function backupDue({ now, backedUp, oldestOwn, snoozedUntil }) {
  if (!oldestOwn) return false;
  if (snoozedUntil && now < snoozedUntil) return false;
  return now - (backedUp || oldestOwn) > 30 * 864e5;
}

// --- sharing one trip (docs/trips.md §23): the trip in the link itself, compressed --------------------
// The link opens Kos on its own, which asks before adding anything. Left out always: ids, the trip's code
// (the one who adds it gets their own), travellers, tags, spending, notes; and unless asked for,
// confirmation numbers, prices and guests (a booking reference with a surname can change a booking).
export const SHARE_BASE = "https://minty.milesmaximizer.com/kos/";
const MAX_SHARE = 256 * 1024;                                    // a link can't unpack into more than this
const b64u = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function pipe(bytes, stream) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader(), parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_SHARE) { await reader.cancel(); throw new Error("That shared trip is too big."); }
    parts.push(value);
  }
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}
/* A share string (docs/trips.md §23.1): "2." and the trip as short text, deflated, in base64url. No server:
 * the trip is the link, so the text keeps only what a trip needs, in rows of fields joined by "|":
 *   name|first day (YYYYMMDD)|last day (days after the first)|place|lat|lon|time zone (hours, the trip's usual)
 *   kind (KINDS' index)|name|start|end|place|lat|lon|airline|flight number|from|to|dep. terminal|arr. terminal|gate|seat
 *     [|confirmation|guest|price in cents|currency|points|points program: only when shared with them]
 * A time is days after the first day, then "T" and HHMM when it has one, then its UTC offset in hours when
 * it isn't the trip's ("~" for none). Coordinates are 1e5ths (about a metre), a booking's from the trip's.
 * Empty fields at a row's end are left off; "|" and line breaks in text become "/" and spaces.
 * "1." strings (the trip's JSON) still open. */
const SHARE_PUBLIC = 15, SHARE_FIELDS = 21;                       // a booking row's fields, without and with the private ones
const offsetHours = (s) => { const m = /(Z|[+-]\d\d:?\d\d)$/.exec(s ?? ""); if (!m) return null; if (m[1] === "Z") return 0;
  const [, sign, h, mm] = /([+-])(\d\d):?(\d\d)/.exec(m[1]); return (sign === "-" ? -1 : 1) * (Number(h) + Number(mm) / 60); };
const hoursText = (h) => `${h >= 0 ? "+" : "-"}${Math.abs(h)}`;
const hoursOffset = (h) => { const a = Math.round(Math.abs(h) * 60); return `${h < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`; };
const dayNum = (ymd) => Date.parse(`${ymd}T00:00:00Z`) / 864e5;
const ymdOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const field = (v) => (v === null || v === undefined ? "" : String(v).replace(/\|/g, "/").replace(/[\r\n]+/g, " "));
export function shareText(t, { withPrivate = false } = {}) {
  const items = t.items ?? [];
  const zones = items.flatMap((i) => [offsetHours(i.start_at), offsetHours(i.end_at)]).filter((z) => z !== null);
  const tz = zones.length ? zones.slice().sort((a, b) => zones.filter((z) => z === b).length - zones.filter((z) => z === a).length)[0] : null;
  const first = dayNum(t.start_date);
  const when = (s) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d\d):(\d\d))?/.exec(s ?? "");
    if (!m) return "";
    let out = String(dayNum(m[1]) - first);
    if (m[2]) { out += `T${m[2]}${m[3]}`; const z = offsetHours(s); if (z === null) { if (tz !== null) out += "~"; } else if (z !== tz) out += hoursText(z); }
    return out;
  };
  const e5 = (x) => (Number.isFinite(x) ? Math.round(x * 1e5) : null);
  const lat0 = e5(t.lat) ?? 0, lon0 = e5(t.lon) ?? 0;
  const row = (fields) => { const f = fields.map(field); while (f.length && f[f.length - 1] === "") f.pop(); return f.join("|"); };
  const lines = [row([t.name, t.start_date.replace(/-/g, ""), dayNum(t.end_date) - first, t.place, e5(t.lat), e5(t.lon), tz === null ? "" : hoursText(tz)])];
  for (const i of items) {
    const f = [KINDS.indexOf(i.kind), i.name, when(i.start_at), when(i.end_at), i.place, e5(i.lat) === null ? null : e5(i.lat) - lat0, e5(i.lon) === null ? null : e5(i.lon) - lon0,
      i.airline, i.flight_number, i.dep_airport, i.arr_airport, i.dep_terminal, i.arr_terminal, i.dep_gate, i.seat];
    if (withPrivate) f.push(i.confirmation, i.guest, i.price_cents, i.currency, i.points, i.points_program);
    lines.push(row(f));
  }
  return lines.join("\n");
}
/** shareText back to a trip and its bookings (fields as the export file has them), not yet checked. */
export function fromShareText(text) {
  const [head, ...rows] = String(text).split("\n");
  const h = head.split("|");
  if (!/^\d{8}$/.test(h[1] ?? "") || !/^\d+$/.test(h[2] ?? "")) throw new Error("That isn't a shared Kos trip.");
  const start = `${h[1].slice(0, 4)}-${h[1].slice(4, 6)}-${h[1].slice(6)}`, first = dayNum(start);
  const tz = h[6] ? Number(h[6]) : null;
  const num = (v) => (v === "" || v === undefined ? null : Number(v));
  const lat0 = num(h[4]) ?? 0, lon0 = num(h[5]) ?? 0;
  const when = (v) => {
    const m = /^(-?\d+)(?:T(\d\d)(\d\d)(~|[+-][\d.]+)?)?$/.exec(v ?? "");
    if (!m) return null;
    const day = ymdOf(first + Number(m[1]));
    if (!m[2]) return day;
    const z = m[4] === "~" ? null : m[4] ? Number(m[4]) : tz;
    return `${day}T${m[2]}:${m[3]}${z === null || !Number.isFinite(z) ? "" : hoursOffset(z)}`;
  };
  const trip = { name: h[0], start_date: start, end_date: ymdOf(first + Number(h[2])), place: h[3] || null,
                 lat: num(h[4]) === null ? null : num(h[4]) / 1e5, lon: num(h[5]) === null ? null : num(h[5]) / 1e5 };
  const items = rows.filter(Boolean).slice(0, 500).map((r) => {
    const f = r.split("|").concat(Array(SHARE_FIELDS).fill("")).slice(0, SHARE_FIELDS).map((x) => x || null);
    return { kind: KINDS[Number(f[0])] ?? f[0], name: f[1], start_at: when(f[2] ?? ""), end_at: when(f[3] ?? ""), place: f[4],
      lat: f[5] === null ? null : (lat0 + Number(f[5])) / 1e5, lon: f[6] === null ? null : (lon0 + Number(f[6])) / 1e5,
      airline: f[7], flight_number: f[8], dep_airport: f[9], arr_airport: f[10], dep_terminal: f[11], arr_terminal: f[12], dep_gate: f[13], seat: f[14],
      ...(f.slice(SHARE_PUBLIC).some((x) => x !== null) ? { confirmation: f[15], guest: f[16], price_cents: num(f[17] ?? ""), currency: f[18], points: num(f[19] ?? ""), points_program: f[20] } : {}) };
  });
  const set = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));   // as "1." strings had them: only what's there
  return { trip: set(trip), items: items.map(set) };
}
/** A trip (with its items) as a share string: "2." and shareText, deflated, in base64url. */
export async function shareString(t, opts = {}) {
  return `2.${b64u(await pipe(new TextEncoder().encode(shareText(t, opts)), new CompressionStream("deflate-raw")))}`;
}
/** A share string in any text: a link (…/kos/#2.…, or the older #/import?t=1.…) or the string alone. */
export const SHARE_RE = /(?:^|[?&#\s])(?:t=)?([12]\.[A-Za-z0-9_-]{8,})/;
export const shareLink = (str) => `${SHARE_BASE}#${str}`;
/** "Share with the Kos team" (docs/trips.md §24): an email for the person's own mail app (mailto:, no
 * server), to the address the landing site's build gives Kos on its own. `why`: "feature" (the team may
 * use it, dates moved and nothing personal, as a sample trip or in a catalog; the email says so, as the
 * person's permission) or "problem" (a bug report). The trip goes as its share link (never with
 * confirmation numbers, prices or guests). Some mail apps cut a mailto past about 2,000 characters: then
 * the link is left out (`tooLong`) and the page copies it for the person to paste. */
export function reportMail({ to, trip, link, note = "", why = "problem" }) {
  const feature = why === "feature";
  const subject = `${feature ? "Kos trip to feature" : "Kos trip with a problem"}: ${trip.name}`;
  const lines = (withLink) => [note.trim() || (feature ? "(Anything about the trip worth knowing?)" : "(What's wrong, or what should Kos have read differently?)"), "",
    ...(feature ? ["You may feature this trip in Kos (as a sample trip or in a catalog), with its dates moved and nothing personal.", ""] : []),
    `Trip: ${trip.name}, ${trip.start_date} to ${trip.end_date}${trip.place ? `, ${trip.place}` : ""}`,
    withLink ? `Open it in Kos: ${link}` : "The trip's link is copied: paste it here.", "", "Sent from Kos (minty.milesmaximizer.com/kos/)"].join("\n");
  const href = (withLink) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines(withLink))}`;
  const full = href(true);
  return full.length <= 2000 ? { href: full, tooLong: false } : { href: href(false), tooLong: true };
}
/** A share string, or any link carrying one, back to a Kos export (one trip), checked like an import. */
export async function readShare(text) {
  const m = SHARE_RE.exec(String(text ?? "").trim());
  if (!m) throw new Error("That isn't a shared Kos trip.");
  let data;
  try {
    const plain = new TextDecoder().decode(await pipe(unb64u(m[1].slice(2)), new DecompressionStream("deflate-raw")));
    data = m[1][0] === "2" ? { app: "Kos", share: 1, ...fromShareText(plain) } : JSON.parse(plain);
  } catch (e) { throw new Error(/too big/.test(e.message) ? e.message : "That shared trip is damaged: ask for the link again."); }
  if (data?.app !== "Kos" || data.share !== 1 || !data.trip || !Array.isArray(data.items)) throw new Error("That isn't a shared Kos trip.");
  const file = { app: "Kos", version: 1, trips: [{ ...data.trip, id: 1, travellers: [] }], items: data.items.slice(0, 500).map((i) => ({ ...i, trip_id: 1 })) };
  importFile(file);                                              // throws on anything a trip or booking can't be
  return file;
}

// --- Minty: its API ---------------------------------------------------------------------------
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: raw ? { "content-type": "message/rfc822" } : body ? { "content-type": "application/json" } : {},
                                body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `${r.status}`);
  return d;
}
const mintyStore = {
  list: () => api("GET", "/trips"),
  users: () => api("GET", "/users").catch(() => []),
  programs: async () => { try { return (await api("GET", "/points")).programs ?? []; } catch { return []; } },
  saveTrip: (id, b) => (id ? api("PUT", `/trips/${id}`, b) : api("POST", "/trips", b)),
  deleteTrip: (id) => api("DELETE", `/trips/${id}`),
  saveItem: (id, b) => (id ? api("PUT", `/trips/items/${id}`, b) : api("POST", "/trips/items", b)),
  deleteItem: (id) => api("DELETE", `/trips/items/${id}`),
  readEmail: (buf) => api("POST", "/trips/read-email", null, buf),
  suggestions: (id) => api("GET", `/trips/${id}/suggestions`),
  transactions: (id) => api("GET", `/transactions?trip_id=${id}&limit=1000`),
  link: (id, b) => api("POST", `/trips/${id}/transactions`, b),
  flightLookup: (b) => api("POST", "/trips/flight-lookup", b),   // FlightAware, through the Worker (docs/trips.md §32)
  journal: (id) => api("GET", `/trips/${id}/journal`),
  saveJournal: (id, b) => api("PUT", `/trips/${id}/journal`, b),
  allNotes: async () => [],                              // on a Minty, the journal's notes stay in its database
  placeLink: async (url) => (await api("POST", "/trips/place-link", { url })).url,   // a maps.app.goo.gl link, followed by the Worker
  // K2 (docs/trips.md §25): the trip's Immich album, made by the cron; a photo's thumbnail comes through the Worker
  photos: (id) => api("GET", `/trips/${id}/photos`),
  // Bills by email (docs/bills.md): Kos reads the +bills emails and adds the bills to Minty's Bills
  bills: {
    known: async (shas) => (shas.length ? (await api("POST", "/bills/known", { sha256: shas })).known : []),
    add: (b) => api("POST", "/bills", b),
    remove: (id) => api("DELETE", `/bills/${id}`),
  },
  makeAlbum: (id) => api("POST", `/trips/${id}/photos`, { make: true }),
  photoUrl: (id, asset) => `/trips/${id}/photos/${encodeURIComponent(asset)}`,
  tags: () => api("GET", "/tags").catch(() => []),       // the household's tags, to suggest for a trip
  spending: true,
};

// --- the device: IndexedDB ----------------------------------------------------------------------
// --- Kos was JET until 2026-11-20: what a browser kept under the old names comes across, once ------
/** The old localStorage keys (both modes: Gmail pull's address, key and read emails; the sample's ids). */
export function carryOverOldNames(ls = globalThis.localStorage) {
  try {
    for (const k of ["gmail", "gmail-key", "gmail-seen", "sample"]) {
      const old = ls.getItem(`jet-${k}`);
      if (old !== null && ls.getItem(`kos-${k}`) === null) ls.setItem(`kos-${k}`, old);
      ls.removeItem(`jet-${k}`);
    }
  } catch { /* storage turned off, or none (tests) */ }
}
carryOverOldNames();
/** JET on its own's trips (IndexedDB "jet"), copied with their ids into Kos's new database. The old
 * one is left as it was; it's read only when Kos's database is first made. */
function fromJet(d) {
  return new Promise((done) => {
    let req;
    try { req = indexedDB.open("jet"); } catch { done(0); return; }
    req.onupgradeneeded = (e) => e.target.transaction.abort();         // there was none: don't make one
    req.onerror = () => done(0);
    req.onsuccess = () => {
      const old = req.result;
      if (!old.objectStoreNames.contains("trips") || !old.objectStoreNames.contains("items")) { old.close(); done(0); return; }
      const r = old.transaction(["trips", "items"]), trips = r.objectStore("trips").getAll(), items = r.objectStore("items").getAll();
      r.oncomplete = () => {
        old.close();
        if (!trips.result.length && !items.result.length) { done(0); return; }
        const w = d.transaction(["trips", "items"], "readwrite");
        for (const t of trips.result) w.objectStore("trips").put(t);
        for (const i of items.result) w.objectStore("items").put(i);
        w.oncomplete = () => done(trips.result.length);
        w.onerror = () => done(0);
      };
      r.onerror = () => { old.close(); done(0); };
    };
  });
}
let dbp = null;
function db() {
  dbp ??= new Promise((ok, fail) => {
    const req = indexedDB.open("kos", 2);                    // v2: the journal's notes (docs/trips.md §20)
    let fresh = false;
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 2) d.createObjectStore("notes", { keyPath: ["trip_id", "day"] }).createIndex("trip_id", "trip_id");
      if (e.oldVersion >= 1) return;
      fresh = true;
      d.createObjectStore("trips", { keyPath: "id", autoIncrement: true });
      d.createObjectStore("items", { keyPath: "id", autoIncrement: true }).createIndex("trip_id", "trip_id");
    };
    req.onsuccess = async () => {
      // another tab upgrading or deleting the database: let it, and open again next time
      req.result.onversionchange = () => { req.result.close(); dbp = null; };
      if (fresh) await fromJet(req.result);
      ok(req.result);
    };
    req.onerror = () => fail(new Error("This browser won't keep Kos's trips here (private window, or storage turned off)."));
  });
  return dbp;
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((ok, fail) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, fail);
    t.oncomplete = () => ok(out);
    t.onerror = () => fail(t.error ?? new Error("couldn't save"));
    t.onabort = () => fail(t.error ?? new Error("couldn't save"));
  });
}
const req = (r) => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const now = () => new Date().toISOString();
const byStart = (a, b) => ((a.start_at ?? "9999") < (b.start_at ?? "9999") ? -1 : (a.start_at ?? "9999") > (b.start_at ?? "9999") ? 1 : a.id - b.id);

const deviceStore = {
  flightLookup: null,                                          // Kos on its own has no server to ask FlightAware
  async list() {
    let [trips, items] = await tx(["trips", "items"], "readonly", async (t) => [await req(t.objectStore("trips").getAll()), await req(t.objectStore("items").getAll())]);
    if (trips.some((t) => !isTripCode(t.code))) {                 // trips made before codes get theirs now, once
      const used = new Set(trips.map((t) => t.code).filter(isTripCode));
      trips = await tx(["trips"], "readwrite", async (x) => {
        const out = [];
        for (const t of trips) {
          if (isTripCode(t.code)) { out.push(t); continue; }
          let code = newTripCode(); while (used.has(code)) code = newTripCode();
          used.add(code); const row = { ...t, code }; await req(x.objectStore("trips").put(row)); out.push(row);
        }
        return out;
      });
    }
    items.sort(byStart);
    return {
      trips: trips.sort((a, b) => (a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : b.id - a.id))
        .map((t) => ({ ...t, items: items.filter((i) => i.trip_id === t.id), transactions: 0, spent_cents: 0 })),
      unassigned: items.filter((i) => i.trip_id === null || i.trip_id === undefined),
    };
  },
  users: async () => [],
  programs: async () => [],
  tags: async () => [],
  async saveTrip(id, b) {
    const t = checkTrip(b);
    return tx(["trips", "items"], "readwrite", async (x) => {
      const s = x.objectStore("trips");
      const old = id ? await req(s.get(id)) : null;
      if (id && !old) throw new Error("trip not found");
      let code = old?.code;
      if (!isTripCode(code)) {                                     // a new trip: an import's code when it's free, else a new one
        const used = new Set((await req(s.getAll())).map((x) => x.code));
        code = isTripCode(b.code) && !used.has(b.code) ? b.code : newTripCode();
        while (used.has(code)) code = newTripCode();
      }
      const row = { ...(old ?? { created_at: now() }), ...t, code, updated_at: now(), ...(id ? { id } : {}) };
      const key = await req(s.put(row));
      if (!id && Array.isArray(b.items)) {
        const items = x.objectStore("items");
        for (const iid of b.items) { const i = await req(items.get(Number(iid))); if (i) await req(items.put({ ...i, trip_id: key, updated_at: now() })); }
      }
      return { id: key };
    });
  },
  async deleteTrip(id) {
    return tx(["trips", "items", "notes"], "readwrite", async (x) => {
      // its bookings stay, with no trip (as on Minty); its journal's notes go
      const items = x.objectStore("items"), notes = x.objectStore("notes");
      for (const i of await req(items.index("trip_id").getAll(id))) await req(items.put({ ...i, trip_id: null }));
      for (const n of await req(notes.index("trip_id").getAll(id))) await req(notes.delete([n.trip_id, n.day]));
      await req(x.objectStore("trips").delete(id));
      return { id, removed: true };
    });
  },
  async saveItem(id, b) {
    const f = checkItem(b);
    return tx(["trips", "items"], "readwrite", async (x) => {
      if (f.trip_id !== null && !(await req(x.objectStore("trips").get(f.trip_id)))) throw new Error("no trip with that id");
      const s = x.objectStore("items");
      const old = id ? await req(s.get(id)) : null;
      if (id && !old) throw new Error("booking not found");
      return { id: await req(s.put({ ...(old ?? { created_at: now() }), ...f, updated_at: now(), ...(id ? { id } : {}) })) };
    });
  },
  /** The trip journal (docs/trips.md §20), answering as Minty's API does: ready once the trip has
   * ended, first opened as this browser remembers it, and the notes kept in IndexedDB. */
  async journal(id) {
    const [t, notes] = await tx(["trips", "notes"], "readonly", async (x) => [await req(x.objectStore("trips").get(id)), await req(x.objectStore("notes").index("trip_id").getAll(id))]);
    if (!t) throw new Error("trip not found");
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem("kos-journal-seen") ?? "[]"); } catch { /* none */ }
    const today = new Date().toISOString().slice(0, 10);
    return { id, ready_at: t.end_date < today ? t.end_date : null, seen_at: seen.includes(id) ? "seen" : null,
             notes: Object.fromEntries(notes.map((n) => [n.day, n.text])) };
  },
  async saveJournal(id, b) {
    if (b.seen === true) {
      try { const seen = new Set(JSON.parse(localStorage.getItem("kos-journal-seen") ?? "[]")); seen.add(id); localStorage.setItem("kos-journal-seen", JSON.stringify([...seen])); } catch { /* not kept */ }
      return { id, seen: true };
    }
    if (!(b.day === "trip" || isDate(b.day)) || typeof b.text !== "string") throw new Error("a note needs its day and text");
    const text = b.text.trim().slice(0, 5000);
    return tx(["trips", "notes"], "readwrite", async (x) => {
      if (!(await req(x.objectStore("trips").get(id)))) throw new Error("trip not found");
      if (text) await req(x.objectStore("notes").put({ trip_id: id, day: b.day, text, updated_at: now() }));
      else await req(x.objectStore("notes").delete([id, b.day]));
      return { id, day: b.day, saved: true };
    });
  },
  async allNotes() { return tx(["notes"], "readonly", async (x) => req(x.objectStore("notes").getAll())); },
  placeLink: null,                                       // no server here to follow a short link
  photos: null, makeAlbum: null, photoUrl: null,         // no Immich without a server
  bills: null,                                           // no Bills without a Minty
  async deleteItem(id) { return tx(["items"], "readwrite", async (x) => { await req(x.objectStore("items").delete(id)); return { id, removed: true }; }); },
  /** An email file, read in this browser with the same reader Minty runs (src/kos/). Nothing is kept. */
  async readEmail(buf) {
    const [{ attachedMessage, emailText, readMessage, viewOf }, { reservations }] = await Promise.all([import("./mail/mime.js"), import("./mail/reservations.js")]);
    const bytes = new Uint8Array(buf);
    if (bytes.length > 2 * 1024 * 1024) throw new Error("email file too large (at most 2 MB)");
    let raw = "";
    for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const outer = readMessage(raw), m = attachedMessage(raw) ?? outer;   // forwarded as an attachment: the original
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { subject: m.subject, from: m.from, date: m.date, view: viewOf(outer), sha256: sha, bookings: reservations(m.html), text: (emailText(m) ?? "").slice(0, 20000) || null, attachments: [] };
  },
  spending: false,
};

export const store = MODE === "device" ? deviceStore : mintyStore;

/** Asks the browser to keep Kos's trips even when space runs low (device mode). */
export async function keepData() {
  try { return Boolean(await navigator.storage?.persist?.()); } catch { return false; }
}

/** Bills by email (docs/bills.md): what Kos does with each bill it read from a +bills email. A new
 * one with a biller, an amount and a due date is added to Bills (`add`); one missing any of them is
 * listed for the person to add by hand (`incomplete`); a card statement is set aside (Bills shows those
 * from the bank); one Bills already has (`known`, by its SHA-256) or that couldn't be read is left. */
export function splitBills(rows) {
  const out = { add: [], incomplete: [], cards: [], known: [], unreadable: [] };
  for (const r of rows) {
    if (r.known) out.known.push(r);
    else if (r.error && !r.card) out.unreadable.push(r);
    else if (r.card) out.cards.push(r);
    else if (r.biller && Number.isInteger(r.amount_cents) && r.amount_cents >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.due_date ?? "")) out.add.push(r);
    else out.incomplete.push(r);
  }
  return out;
}

/** Kos pools waiting bookings into trips by itself (owner, 2026-11-20; docs/trips.md §26): a booking whose
 * date falls in an existing trip goes in it (`tripFor`); the rest are grouped by date (a booking starting
 * within 2 days of the group's end joins it; a group that starts with a flight stays open, up to 30 days,
 * until a flight lands back where it left from) and each group becomes a new trip, named after where it
 * goes: its stay's town, else the last flight's arrival city on its first day. Undated bookings wait,
 * and so does a group with no travel in it (a restaurant or an event on its own).
 * `airports`: code → [name, city, country, lat, lon]. Returns { into: [{ trip_id, items }], make: [trip
 * with `items`] }. Pure. */
/** A city from an address: before a US state and ZIP ("…, Lake Delton, WI 53940"), after a postcode
 * ("…, 50123 Florence, Italy"), or before a Japanese one ("…, Chuo-ku, Tokyo 104-0061"); else its last part
 * that's a place and not a country or a number. */
export function cityOf(address) {
  const a = String(address ?? "");
  const states = Object.values(US_STATES).filter((x) => !x.includes(",")).join("|");
  const us = new RegExp(`,\\s*([^,\\d]+?),?\\s+(?:[A-Z]{2}|${states}),?\\s+\\d{5}(?:-\\d{4})?\\b`).exec(a);
  if (us) return us[1].trim();
  const usLong = new RegExp(`,\\s*([^,\\d]+?),\\s*(?:[A-Z]{2}|${states}),\\s*(?:united states|usa|us)\\b,?\\s*\\d{5}\\b`, "i").exec(a);   // "…, Example City, HI, United States, 96700"
  if (usLong) return usLong[1].trim();
  const jp = /([A-Za-zÀ-ÿ' .-]{2,30}?),?\s+\d{3}-\d{4}\b/.exec(a);
  if (jp) return jp[1].trim();
  const eu = /(?:^|[\s,])(?:\d{4,5}|\d{4}-\d{3}|\d{3} \d{2})\s+([A-Za-zÀ-ÿ'’ .-]{2,30}?)(?:\s+\d+)?(?:,|$|\s+[-–])/.exec(a);
  if (eu) return eu[1].trim();
  const parts = a.split(",").map((x) => x.trim()).filter((x) => x && !/\d/.test(x) && !/^(usa|us|united states|uk|united kingdom|japan|italy|france|spain|portugal|germany|mexico|canada|czechia|czech republic)$/i.test(x));
  return parts.at(-1) ?? null;
}
export function planTrips(waiting, trips, airports = {}) {
  const day = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
  const into = new Map(), loose = [];
  for (const i of waiting) {
    const d = day(i.start_at);
    if (!d) continue;
    const t = tripFor(d, trips);
    if (t) (into.get(t.id) ?? into.set(t.id, []).get(t.id)).push(i.id); else loose.push(i);
  }
  loose.sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : a.id - b.id));
  const groups = [];
  const gap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  for (const i of loose) {
    const start = day(i.start_at), end = day(i.end_at) ?? start;
    const g = groups.at(-1);
    const away = g && g.home && !g.back && gap(g.start, start) <= 30;      // left home by air, not back yet
    if (g && (away || gap(g.end, start) <= 2)) {
      g.items.push(i);
      if (end > g.end) g.end = end;
      if (g.home && i.kind === "flight" && i.arr_airport === g.home) g.back = true;
    } else {
      groups.push({ start, end: end > start ? end : start, items: [i], home: i.kind === "flight" ? i.dep_airport ?? null : null, back: false });
    }
  }
  // a trip needs travel in it (a flight, stay, train, bus or car): a dinner or a show on its own waits
  const TRAVEL = ["flight", "lodging", "train", "bus", "car"];
  const make = groups.filter((g) => g.items.some((i) => TRAVEL.includes(i.kind))).map((g) => {
    // the stay with the most nights names the trip (its city, from its address); else where the flights stop longest
    const nightsOf = (i) => (day(i.end_at) && day(i.start_at) ? (Date.parse(day(i.end_at)) - Date.parse(day(i.start_at))) / 864e5 : 0);
    const stay = g.items.filter((i) => i.kind === "lodging").sort((a, b) => nightsOf(b) - nightsOf(a) || (b.place ? 1 : 0) - (a.place ? 1 : 0))[0];
    const town = stay?.place ? cityOf(stay.place) : null;
    const flights = g.items.filter((i) => i.kind === "flight" && i.arr_airport).sort((a, b) => ((a.start_at ?? "") < (b.start_at ?? "") ? -1 : 1));
    // the arrival with the longest wait until the next departure (the last one: until the trip's end):
    // a connection is an hour, the destination days; a day trip's turnaround is hours
    let dest = null, longest = -1;
    flights.forEach((f, k) => {
      const next = flights[k + 1], arr = Date.parse(String(f.end_at ?? f.start_at ?? "").slice(0, 16));
      const leave = next ? Date.parse(String(next.start_at ?? "").slice(0, 16)) : Date.parse(`${g.end}T23:59`);
      const wait = Number.isFinite(arr) && Number.isFinite(leave) ? leave - arr : -1;
      if (wait > longest && f.arr_airport !== flights[0].dep_airport) { longest = wait; dest = f; }
    });
    const ap = dest ? airports[dest.arr_airport] : null;
    const name = (town || ap?.[1] || stay?.name || g.items[0].name || "A trip").slice(0, 100);
    const place = stay?.place ?? (ap ? [ap[1], ap[2]].filter(Boolean).join(", ") : null);
    const lat = Number.isFinite(stay?.lat) ? stay.lat : ap ? ap[3] : null, lon = Number.isFinite(stay?.lon) ? stay.lon : ap ? ap[4] : null;
    return { name, start_date: g.start, end_date: g.end, place, lat, lon, items: g.items.map((i) => i.id) };
  });
  return { into: [...into].map(([trip_id, items]) => ({ trip_id, items })), make };
}

/** Bookings as the person thinks of them: a connection's legs (flights with the same confirmation, each
 * leaving within a day of the last one landing) are one booking; everything else is its own. The legs
 * stay separate items underneath (each leg has its own times, gate and seat). Returns arrays, in order. */
export function journeys(items) {
  const sorted = [...items].sort((a, b) => ((a.start_at ?? "") < (b.start_at ?? "") ? -1 : (a.start_at ?? "") > (b.start_at ?? "") ? 1 : a.id - b.id));
  const out = [];
  for (const i of sorted) {
    const g = out.at(-1), last = g?.at(-1);
    const joins = last && i.kind === "flight" && last.kind === "flight" && i.confirmation && i.confirmation === last.confirmation
      && last.arr_airport && last.arr_airport === i.dep_airport && i.start_at && (last.end_at ?? last.start_at)
      && Date.parse(i.start_at.slice(0, 16)) - Date.parse((last.end_at ?? last.start_at).slice(0, 16)) <= 864e5;
    if (joins) g.push(i); else out.push([i]);
  }
  return out;
}

/** A trip's dates widened to cover its bookings (docs/trips.md §26): the earliest start and the latest end
 * of its dated bookings, never narrower than the trip already is (free days planned stay). Returns
 * { start_date, end_date, outside } where `outside` counts the bookings beyond the trip's dates. Pure. */
export function tripSpan(t) {
  const day = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
  let start = t.start_date, end = t.end_date, outside = 0;
  for (const i of t.items ?? []) {
    const a = day(i.start_at), b = day(i.end_at) ?? a;
    if (!a) continue;
    if (a < t.start_date || b > t.end_date) outside++;
    if (a < start) start = a;
    if (b > end) end = b;
  }
  return { start_date: start, end_date: end, outside };
}

/** A booking read from an email or a paste against the ones already in Kos (owner, 2026-11-21: "update",
 * docs/trips.md §27): the same flight (number and day, or route and day), or the same confirmation and
 * kind. Returns { item, same, changes } where `changes` are the fields the new one has and differ (a
 * schedule change's times, say); `same` when there are none. No match: { item: null }. Pure. */
export function matchBooking(b, items) {
  const day = (s) => (s ? String(s).slice(0, 10) : null);
  const min = (s) => (s ? String(s).slice(0, 16) : null);
  const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const same = items.filter((i) => i.kind === b.kind);
  let item = null;
  const near = (i, days) => !day(b.start_at) || !day(i.start_at) || Math.abs(Date.parse(day(b.start_at)) - Date.parse(day(i.start_at))) <= 864e5 * days;
  if (b.kind === "flight") {
    // two different confirmations are two bookings, whatever else they share
    const cand = same.filter((i) => !(norm(b.confirmation) && norm(i.confirmation) && norm(i.confirmation) !== norm(b.confirmation)));
    item = cand.find((i) => b.flight_number && norm(i.flight_number) === norm(b.flight_number) && (!b.airline || !i.airline || i.airline === b.airline) && b.dep_airport === i.dep_airport && near(i, 2))
      ?? cand.find((i) => b.dep_airport && i.dep_airport === b.dep_airport && i.arr_airport === b.arr_airport && day(i.start_at) && day(i.start_at) === day(b.start_at))
      ?? cand.find((i) => norm(b.confirmation) && norm(i.confirmation) === norm(b.confirmation) && i.dep_airport === b.dep_airport && i.arr_airport === b.arr_airport && near(i, 7));
  } else {
    // one code can cover several bookings (a train out and back, two tickets on one order): then the day
    // tells them apart; a train, bus, event or meal must match its day, a stay or a car may have moved
    const byCode = norm(b.confirmation) ? same.filter((i) => norm(i.confirmation) === norm(b.confirmation)) : [];
    const sameDay = (i) => day(i.start_at) && day(i.start_at) === day(b.start_at);
    if (byCode.length) item = byCode.find(sameDay) ?? (byCode.length === 1 && (b.kind === "lodging" || b.kind === "car") && near(byCode[0], 14) ? byCode[0] : null);
    item ??= same.find((i) => b.name && norm(i.name) === norm(b.name) && sameDay(i));
  }
  if (!item) return { item: null, same: false, changes: [] };
  const fields = ["start_at", "end_at", "airline", "flight_number", "dep_airport", "arr_airport", "place", "confirmation", "price_cents", "currency", "points", "points_program"];
  const changes = fields.filter((k) => {
    const v = b[k];
    if (v === null || v === undefined || v === "") return false;
    if (k === "start_at" || k === "end_at") return min(v) !== min(item[k]) && !(String(v).length <= 10 && day(v) === day(item[k]));
    if (k === "confirmation" || k === "flight_number") return norm(v) !== norm(item[k]);
    return v !== item[k];
  });
  // the card it was paid with (docs/trips.md §28): filled in when Kos doesn't have it yet, never replaced
  if (b.card_last4 && !item.card_last4) changes.push("card_last4", ...(b.card_network && !item.card_network ? ["card_network"] : []));
  return { item, same: !changes.length, changes };
}

