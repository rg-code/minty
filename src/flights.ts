// Kos T6c: live flight status and looking a flight up by its number (docs/trips.md §14, §32), from
// FlightAware AeroAPI (Personal), with the household's own key (FLIGHT_STATUS_KEY, a Worker secret).
// What goes to FlightAware: a flight's number and date, never a person, a confirmation or a price.
// - Status: only from a quiet catch-up cron run, a few legs a run. A leg is first asked once its date is
//   today or tomorrow; then FlightAware's own times set the next ask (6 and 3 hours before, every 10
//   minutes from 2 hours before until it leaves, every 30 minutes in the air, once after it lands).
// - Look-up: one ask when someone taps "Look up" on a flight's form (its airports and local times).
// Both share FLIGHT_STATUS_CALLS_PER_DAY (default 50), counted per UTC day in app_state.
import type { Env } from "./env";

const API = "https://aeroapi.flightaware.com/aeroapi";
export const PER_RUN = 5;
const MIN = 60_000, HOUR = 60 * MIN;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const flightsOn = (env: Env) => Boolean(env.FLIGHT_STATUS_KEY) && (env.FLIGHT_STATUS_PROVIDER ?? "aeroapi").trim().toLowerCase() === "aeroapi";
const cap = (env: Env) => { const n = Number((env.FLIGHT_STATUS_CALLS_PER_DAY ?? "").trim()); return Number.isInteger(n) && n > 0 ? n : 50; };
const capKey = (now: Date) => `flight_calls:${now.toISOString().slice(0, 10)}`;

/** One call off today's allowance; false when it's used up (nothing is asked then). */
export async function takeCall(env: Env, now = new Date()): Promise<boolean> {
  const r = await env.DB.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?1, '1', ${NOW_SQL})
     ON CONFLICT (key) DO UPDATE SET value = CAST(app_state.value AS INTEGER) + 1, updated_at = excluded.updated_at
       WHERE CAST(app_state.value AS INTEGER) < ?2
     RETURNING value`).bind(capKey(now), cap(env)).first<{ value: string }>();
  return r !== null;
}
export async function callsToday(env: Env, now = new Date()): Promise<number> {
  const r = await env.DB.prepare("SELECT value FROM app_state WHERE key = ?").bind(capKey(now)).first<{ value: string }>();
  return Number(r?.value ?? 0);
}

// --- FlightAware's answer -------------------------------------------------------------------------
export interface AeroFlight {
  fa_flight_id?: string; ident?: string; status?: string; cancelled?: boolean; diverted?: boolean;
  scheduled_out?: string | null; estimated_out?: string | null; actual_out?: string | null;
  scheduled_in?: string | null; estimated_in?: string | null; actual_in?: string | null;
  gate_origin?: string | null; terminal_origin?: string | null; gate_destination?: string | null; terminal_destination?: string | null;
  baggage_claim?: string | null; departure_delay?: number | null; arrival_delay?: number | null; aircraft_type?: string | null;
  origin?: { code_iata?: string | null; timezone?: string | null } | null; destination?: { code_iata?: string | null; timezone?: string | null } | null;
}
export interface FlightStatus {
  state: "scheduled" | "delayed" | "departed" | "landed" | "cancelled" | "diverted";
  text: string | null;                                  // FlightAware's words ("En Route / On Time")
  dep: { sched: string | null; est: string | null; act: string | null; gate: string | null; terminal: string | null; tz: string | null };
  arr: { sched: string | null; est: string | null; act: string | null; gate: string | null; terminal: string | null; tz: string | null };
  baggage: string | null; delay_min: number | null; aircraft: string | null; fa_id: string | null; provider: "aeroapi";
}
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : null);
export function toStatus(f: AeroFlight): FlightStatus {
  const delay = typeof f.departure_delay === "number" ? Math.round(f.departure_delay / 60) : null;
  const state: FlightStatus["state"] = f.cancelled ? "cancelled" : f.diverted ? "diverted" : f.actual_in ? "landed" : f.actual_out ? "departed"
    : delay !== null && delay >= 15 ? "delayed" : "scheduled";
  return {
    state, text: s(f.status),
    dep: { sched: s(f.scheduled_out), est: s(f.estimated_out), act: s(f.actual_out), gate: s(f.gate_origin), terminal: s(f.terminal_origin), tz: s(f.origin?.timezone) },
    arr: { sched: s(f.scheduled_in), est: s(f.estimated_in), act: s(f.actual_in), gate: s(f.gate_destination), terminal: s(f.terminal_destination), tz: s(f.destination?.timezone) },
    baggage: s(f.baggage_claim), delay_min: delay, aircraft: s(f.aircraft_type), fa_id: s(f.fa_flight_id), provider: "aeroapi",
  };
}
const at = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
/** When to ask about this leg next (docs/trips.md §14), or null when there's nothing more to learn. */
export function nextCheck(st: FlightStatus, now: number): string | null {
  const out = at(st.dep.est ?? st.dep.sched), landed = at(st.arr.act);
  const iso = (t: number) => new Date(Math.max(t, now + MIN)).toISOString();
  // cancelled: once more at its departure time (it stays on Minty's status strip until then), then done
  if (st.state === "cancelled") return Number.isFinite(out) && out > now ? iso(out) : null;
  if (Number.isFinite(landed)) return now < landed + 30 * MIN ? iso(landed + 30 * MIN) : null;   // once after it lands
  if (st.dep.act) {                                                                          // in the air: every 30 minutes
    const inAt = at(st.arr.est ?? st.arr.sched);
    return Number.isFinite(inAt) && now > inAt + 6 * HOUR ? null : iso(now + 30 * MIN);
  }
  if (!Number.isFinite(out)) return iso(now + 6 * HOUR);
  if (now > out + 12 * HOUR) return null;                                                    // long gone, never seen leaving
  for (const before of [6 * HOUR, 3 * HOUR, 2 * HOUR]) if (now < out - before) return iso(out - before);
  return iso(now + 10 * MIN);                                                                // the last 2 hours: every 10 minutes
}

type Leg = { airline: string | null; flight_number: string | null; dep_airport: string | null; arr_airport: string | null; start_at: string | null };
/** Of the flights with this number, the one that's this leg: its airports, and the departure nearest its day. */
export function pickLeg(flights: AeroFlight[], leg: Leg): AeroFlight | null {
  const day = String(leg.start_at ?? "").slice(0, 10), noon = Date.parse(`${day}T12:00:00Z`);
  const fits = flights.filter((f) => (!leg.dep_airport || !f.origin?.code_iata || f.origin.code_iata === leg.dep_airport)
    && (!leg.arr_airport || !f.destination?.code_iata || f.destination.code_iata === leg.arr_airport));
  if (!Number.isFinite(noon)) return fits[0] ?? null;
  return fits.map((f) => ({ f, d: Math.abs(at(f.scheduled_out ?? null) - noon) })).filter((x) => Number.isFinite(x.d) && x.d < 36 * HOUR)
    .sort((a, b) => a.d - b.d)[0]?.f ?? null;
}

async function ask(env: Env, path: string, fetchFn: typeof fetch): Promise<{ flights?: AeroFlight[]; scheduled?: unknown[]; timezone?: string } | "unavailable" | "none"> {
  let res: Response;
  try { res = await fetchFn(`${API}${path}`, { headers: { "x-apikey": env.FLIGHT_STATUS_KEY!, accept: "application/json" }, signal: AbortSignal.timeout(8000) }); }
  catch { return "unavailable"; }
  if (res.status === 404 || res.status === 400) { await res.body?.cancel(); return "none"; }
  if (!res.ok) { await res.body?.cancel(); return "unavailable"; }
  return (await res.json().catch(() => ({}))) as { flights?: AeroFlight[] };
}
const dayAdd = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const flightsPath = (ident: string, day: string) =>
  `/flights/${encodeURIComponent(ident)}?${new URLSearchParams({ ident_type: "designator", start: `${dayAdd(day, -1)}T00:00:00Z`, end: `${dayAdd(day, 2)}T00:00:00Z` })}`;

// --- the cron: status for the legs that are due ---------------------------------------------------
export async function pollFlights(env: Env, fetchFn: typeof fetch = fetch, now = new Date()): Promise<Record<string, string>> {
  if (!flightsOn(env)) return {};
  const today = now.toISOString().slice(0, 10);
  const legs = (await env.DB.prepare(
    `SELECT id, airline, flight_number, dep_airport, arr_airport, start_at, flight_status FROM trip_items INDEXED BY idx_trip_items_flight_due
     WHERE kind = 'flight' AND airline IS NOT NULL AND flight_number IS NOT NULL
       AND ((status_next_at IS NOT NULL AND status_next_at <= ?1)
            OR (status_checked_at IS NULL AND substr(start_at, 1, 10) BETWEEN ?2 AND ?3))
     ORDER BY coalesce(status_next_at, start_at) LIMIT ${PER_RUN}`).bind(now.toISOString(), dayAdd(today, -1), dayAdd(today, 1))
    .all<Leg & { id: number; flight_status: string | null }>()).results;
  const out: Record<string, string> = {};
  for (const leg of legs) {
    if (!(await takeCall(env, now))) { out.cap = "today's calls are used up"; break; }
    const prev = leg.flight_status ? (JSON.parse(leg.flight_status) as FlightStatus) : null;
    const got = await ask(env, prev?.fa_id ? `/flights/${encodeURIComponent(prev.fa_id)}` : flightsPath(`${leg.airline}${leg.flight_number}`, String(leg.start_at).slice(0, 10)), fetchFn);
    if (got === "unavailable") { out[`leg ${leg.id}`] = "unavailable"; break; }               // down or limited: the next run tries again
    const f = got === "none" ? null : pickLeg(got.flights ?? [], leg);
    if (!f) {
      // not listed (yet): ask again in 6 hours while its day is near, never after
      const next = String(leg.start_at).slice(0, 10) >= dayAdd(today, -1) ? new Date(now.getTime() + 6 * HOUR).toISOString() : null;
      await env.DB.prepare(`UPDATE trip_items SET status_checked_at = ${NOW_SQL}, status_next_at = ? WHERE id = ?`).bind(next, leg.id).run();
      out[`leg ${leg.id}`] = "not found";
      continue;
    }
    const st = toStatus(f);
    await env.DB.prepare(`UPDATE trip_items SET flight_status = ?, status_checked_at = ${NOW_SQL}, status_next_at = ? WHERE id = ?`)
      .bind(JSON.stringify(st), nextCheck(st, now.getTime()), leg.id).run();
    out[`leg ${leg.id}`] = st.state;
  }
  return out;
}

// --- "Look up": a flight's airports and local times from its number and date -----------------------
/** "2026-11-26T06:00:00Z" in Pacific/Honolulu → "2026-11-25T20:00-10:00" (Kos keeps local times with offsets). */
export function localTime(iso: string | null, tz: string | null): string | null {
  const t = at(iso);
  if (!Number.isFinite(t)) return null;
  if (!tz) return null;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" })
      .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const off = /GMT([+-]\d{2}:\d{2})?/.exec(parts.timeZoneName ?? "")?.[1] ?? "+00:00";
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${off}`;
  } catch { return null; }
}
async function airportZone(env: Env, code: string, fetchFn: typeof fetch, now: Date): Promise<string | null> {
  const key = `airport_tz:${code}`;
  const kept = await env.DB.prepare("SELECT value FROM app_state WHERE key = ?").bind(key).first<{ value: string }>();
  if (kept?.value) return kept.value;
  if (!(await takeCall(env, now))) return null;
  const got = await ask(env, `/airports/${encodeURIComponent(code)}`, fetchFn);
  const tz = typeof got === "object" && typeof got.timezone === "string" ? got.timezone : null;
  if (tz) await env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ${NOW_SQL}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(key, tz).run();
  return tz;
}
export type LookedUp = { airline: string; flight_number: string; dep_airport: string | null; arr_airport: string | null; start_at: string | null; end_at: string | null; dep_terminal: string | null; aircraft: string | null };
/** A flight by its number on a day: from FlightAware's flights near today, else its schedules (months
 * ahead), with each airport's time zone (kept once asked). null when there's no such flight; throws
 * "unavailable" or "cap" otherwise. */
export async function lookUp(env: Env, airline: string, number: string, day: string, depHint: string | null, fetchFn: typeof fetch = fetch, now = new Date()): Promise<LookedUp | null> {
  const today = now.toISOString().slice(0, 10);
  const near = day >= dayAdd(today, -9) && day <= dayAdd(today, 2);
  if (!(await takeCall(env, now))) throw new Error("cap");
  if (near) {
    const got = await ask(env, flightsPath(`${airline}${number}`, day), fetchFn);
    if (got === "unavailable") throw new Error("unavailable");
    const f = got === "none" ? null : pickLeg(got.flights ?? [], { airline, flight_number: number, dep_airport: depHint, arr_airport: null, start_at: day });
    if (!f) return null;
    return { airline, flight_number: number, dep_airport: s(f.origin?.code_iata), arr_airport: s(f.destination?.code_iata),
             start_at: localTime(f.scheduled_out ?? null, f.origin?.timezone ?? null), end_at: localTime(f.scheduled_in ?? null, f.destination?.timezone ?? null),
             dep_terminal: s(f.terminal_origin), aircraft: s(f.aircraft_type) };
  }
  const got = await ask(env, `/schedules/${day}/${dayAdd(day, 1)}?${new URLSearchParams({ airline, flight_number: number })}`, fetchFn);
  if (got === "unavailable") throw new Error("unavailable");
  type Sched = { origin_iata?: string; destination_iata?: string; scheduled_out?: string; scheduled_in?: string; aircraft_type?: string };
  const rows = (got === "none" ? [] : (got.scheduled ?? [])) as Sched[];
  const f = rows.find((r) => !depHint || r.origin_iata === depHint) ?? null;
  if (!f) return null;
  const dep = s(f.origin_iata), arr = s(f.destination_iata);
  const [tzDep, tzArr] = [dep ? await airportZone(env, dep, fetchFn, now) : null, arr ? await airportZone(env, arr, fetchFn, now) : null];
  return { airline, flight_number: number, dep_airport: dep, arr_airport: arr, start_at: localTime(f.scheduled_out ?? null, tzDep), end_at: localTime(f.scheduled_in ?? null, tzArr),
           dep_terminal: null, aircraft: s(f.aircraft_type) };
}

// --- Minty's status strip (GET /health): flights FlightAware is following ------------------------------
export type StripFlight = { trip_id: number | null; flight: string; to: string | null; state: FlightStatus["state"]; delay_min: number | null;
  gate: string | null; terminal: string | null; baggage: string | null; dep: string | null; dep_tz: string | null; arr: string | null; arr_tz: string | null; checked_at: string | null };
/** Legs leaving within 24 hours, in the air, or just landed or cancelled, from the legs the cron is still
 * following (status_next_at set: the partial index, a handful of rows). Times in UTC with each airport's
 * zone; the page writes them out. */
export async function stripFlights(env: Env, now = Date.now()): Promise<StripFlight[]> {
  const rows = (await env.DB.prepare(
    `SELECT trip_id, airline, flight_number, arr_airport, flight_status, status_checked_at FROM trip_items INDEXED BY idx_trip_items_flight_due
     WHERE kind = 'flight' AND status_next_at IS NOT NULL AND flight_status IS NOT NULL`)
    .all<{ trip_id: number | null; airline: string | null; flight_number: string | null; arr_airport: string | null; flight_status: string; status_checked_at: string | null }>()).results;
  const out: (StripFlight & { at: number })[] = [];
  for (const r of rows) {
    let st: FlightStatus;
    try { st = JSON.parse(r.flight_status) as FlightStatus; } catch { continue; }
    if (!r.status_checked_at || now - Date.parse(r.status_checked_at) > 12 * HOUR) continue;   // stale (the key was taken away)
    const leaves = at(st.dep.act ?? st.dep.est ?? st.dep.sched);
    const soon = Number.isFinite(leaves) && leaves - now <= 24 * HOUR && leaves - now > -2 * HOUR;
    if (!(soon || st.state === "departed" || st.state === "diverted" || st.state === "landed")) continue;
    out.push({ at: Number.isFinite(leaves) ? leaves : now, trip_id: r.trip_id, flight: [r.airline, r.flight_number].filter(Boolean).join(" "), to: r.arr_airport,
      state: st.state, delay_min: st.delay_min, gate: st.dep.gate, terminal: st.dep.terminal, baggage: st.baggage,
      dep: st.dep.act ?? st.dep.est ?? st.dep.sched, dep_tz: st.dep.tz, arr: st.arr.act ?? st.arr.est ?? st.arr.sched, arr_tz: st.arr.tz, checked_at: r.status_checked_at });
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...f }) => f);
}
