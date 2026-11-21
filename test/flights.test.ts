import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { getJson } from "./helpers";
import { localTime, nextCheck, pickLeg, pollFlights, toStatus, type AeroFlight } from "../src/flights";
import type { Env } from "../src/env";

// Kos T6c: live flight status and look-up from FlightAware AeroAPI (docs/trips.md §32). A fake AeroAPI:
// each path's answer; it records the paths asked (only a flight's number and date, or FlightAware's id).
const db = env.DB;
const KEY = { FLIGHT_STATUS_KEY: "fa-key" };
const FA = { ...env, ...KEY } as Env;
function fakeFa(answer: (path: string) => unknown | 404 | 429) {
  const asked: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("x-apikey")).toBe("fa-key");
    const u = new URL(url);
    expect(u.origin).toBe("https://aeroapi.flightaware.com");
    const path = u.pathname.replace("/aeroapi", "") + u.search;
    asked.push(path);
    const a = answer(path);
    if (a === 404 || a === 429) return new Response("{}", { status: a });
    return Response.json(a);
  }) as unknown as typeof fetch;
  return { fn, asked };
}
const flight = (o: Partial<AeroFlight> = {}): AeroFlight => ({
  fa_flight_id: "UAL1234-1700000000-schedule-0001", ident: "UAL1234", status: "Scheduled", cancelled: false, diverted: false,
  scheduled_out: "2027-04-05T16:00:00Z", estimated_out: "2027-04-05T16:00:00Z", actual_out: null,
  scheduled_in: "2027-04-05T21:30:00Z", estimated_in: "2027-04-05T21:30:00Z", actual_in: null,
  gate_origin: "F12", terminal_origin: "3", gate_destination: null, terminal_destination: null, baggage_claim: null,
  departure_delay: 0, arrival_delay: 0, aircraft_type: "B739",
  origin: { code_iata: "SFO", timezone: "America/Los_Angeles" }, destination: { code_iata: "KOA", timezone: "Pacific/Honolulu" }, ...o,
});

describe("a flight's status from FlightAware's answer", () => {
  it("reads the state, times, gates and delay", () => {
    expect(toStatus(flight())).toMatchObject({ state: "scheduled", dep: { gate: "F12", terminal: "3", tz: "America/Los_Angeles" }, aircraft: "B739", fa_id: "UAL1234-1700000000-schedule-0001" });
    expect(toStatus(flight({ departure_delay: 45 * 60, estimated_out: "2027-04-05T16:45:00Z" }))).toMatchObject({ state: "delayed", delay_min: 45 });
    expect(toStatus(flight({ actual_out: "2027-04-05T16:05:00Z" })).state).toBe("departed");
    expect(toStatus(flight({ actual_out: "2027-04-05T16:05:00Z", actual_in: "2027-04-05T21:20:00Z", baggage_claim: "5" }))).toMatchObject({ state: "landed", baggage: "5" });
    expect(toStatus(flight({ cancelled: true })).state).toBe("cancelled");
  });
  it("asks next 6 and 3 hours before, every 10 minutes from 2 hours before, every 30 in the air, once after landing", () => {
    const st = toStatus(flight()), out = Date.parse("2027-04-05T16:00:00Z"), H = 3_600_000;
    expect(nextCheck(st, out - 20 * H)).toBe("2027-04-05T10:00:00.000Z");
    expect(nextCheck(st, out - 5 * H)).toBe("2027-04-05T13:00:00.000Z");
    expect(nextCheck(st, out - 2.5 * H)).toBe("2027-04-05T14:00:00.000Z");
    expect(nextCheck(st, out - 1 * H)).toBe("2027-04-05T15:10:00.000Z");
    expect(nextCheck(toStatus(flight({ actual_out: "2027-04-05T16:05:00Z" })), out + H)).toBe("2027-04-05T17:30:00.000Z");
    const landed = toStatus(flight({ actual_out: "2027-04-05T16:05:00Z", actual_in: "2027-04-05T21:20:00Z" }));
    expect(nextCheck(landed, Date.parse("2027-04-05T21:25:00Z"))).toBe("2027-04-05T21:50:00.000Z");
    expect(nextCheck(landed, Date.parse("2027-04-05T22:00:00Z"))).toBeNull();
    expect(nextCheck(toStatus(flight({ cancelled: true })), out - H)).toBeNull();
  });
  it("picks the leg by its airports and the departure nearest its day", () => {
    const other = flight({ fa_flight_id: "next-day", scheduled_out: "2027-04-06T16:00:00Z" });
    const elsewhere = flight({ fa_flight_id: "elsewhere", origin: { code_iata: "LAX" } });
    expect(pickLeg([other, elsewhere, flight()], { airline: "UA", flight_number: "1234", dep_airport: "SFO", arr_airport: "KOA", start_at: "2027-04-05T09:00" })?.fa_flight_id)
      .toBe("UAL1234-1700000000-schedule-0001");
    expect(pickLeg([elsewhere], { airline: "UA", flight_number: "1234", dep_airport: "SFO", arr_airport: null, start_at: "2027-04-05" })).toBeNull();
  });
  it("turns FlightAware's UTC times into local times with their offsets", () => {
    expect(localTime("2027-04-05T16:00:00Z", "America/Los_Angeles")).toBe("2027-04-05T09:00-07:00");
    expect(localTime("2027-04-05T21:30:00Z", "Pacific/Honolulu")).toBe("2027-04-05T11:30-10:00");
    expect(localTime("2027-04-05T21:30:00Z", null)).toBeNull();
  });
});

describe("the cron, and Look up", () => {
  beforeEach(async () => {
    await db.batch(["trip_items", "trips"].map((t) => db.prepare(`DELETE FROM ${t}`)));
    await db.prepare("DELETE FROM app_state WHERE key LIKE 'flight_calls:%' OR key LIKE 'airport_tz:%'").run();
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const leg = (o: Record<string, unknown>) => db.prepare(
    `INSERT INTO trip_items (kind, airline, flight_number, dep_airport, arr_airport, start_at, confirmation, guest) VALUES ('flight', ?, ?, ?, ?, ?, 'QZ7XKM', 'Alex Sample') RETURNING id`)
    .bind(o.airline ?? "UA", o.flight_number ?? "1234", o.dep ?? "SFO", o.arr ?? "KOA", o.start_at).first<{ id: number }>().then((r) => r!.id);
  const row = (id: number) => db.prepare("SELECT flight_status, status_checked_at, status_next_at FROM trip_items WHERE id = ?").bind(id).first<any>();

  it("asks for legs flying today or tomorrow, then by FlightAware's id when due; never a leg far off; nothing without a key", async () => {
    const now = new Date("2027-04-04T20:00:00Z");
    const soon = await leg({ start_at: "2027-04-05T09:00" });
    const far = await leg({ flight_number: "999", start_at: "2027-06-01T09:00" });
    const fa = fakeFa((p) => (p.startsWith("/flights/UA1234") || p.startsWith("/flights/UAL1234") ? { flights: [flight()] } : 404));
    expect(await pollFlights({ ...env } as Env, fa.fn, now)).toEqual({});
    expect(await pollFlights(FA, fa.fn, now)).toEqual({ [`leg ${soon}`]: "scheduled" });
    expect(fa.asked).toEqual(["/flights/UA1234?ident_type=designator&start=2027-04-04T00%3A00%3A00Z&end=2027-04-07T00%3A00%3A00Z"]);
    expect(fa.asked.join(" ")).not.toMatch(/QZ7XKM|Alex/);
    const r = await row(soon);
    expect(JSON.parse(r.flight_status)).toMatchObject({ state: "scheduled", dep: { gate: "F12" } });
    expect(r.status_next_at).toBe("2027-04-05T10:00:00.000Z");                            // 6 hours before
    expect((await row(far)).status_checked_at).toBeNull();
    // not due yet: nothing; due: by its id
    expect(await pollFlights(FA, fa.fn, new Date("2027-04-05T09:00:00Z"))).toEqual({});
    expect(await pollFlights(FA, fa.fn, new Date("2027-04-05T10:01:00Z"))).toEqual({ [`leg ${soon}`]: "scheduled" });
    expect(fa.asked.at(-1)).toBe("/flights/UAL1234-1700000000-schedule-0001");
  });

  it("stops at the day's cap, and when FlightAware can't answer", async () => {
    const now = new Date("2027-04-04T20:00:00Z");
    for (const n of ["1", "2", "3"]) await leg({ flight_number: n, start_at: "2027-04-05T09:00" });
    const fa = fakeFa(() => ({ flights: [] }));
    const out = await pollFlights({ ...FA, FLIGHT_STATUS_CALLS_PER_DAY: "2" } as Env, fa.fn, now);
    expect(Object.values(out).filter((v) => v === "not found")).toHaveLength(2);
    expect(out.cap).toBe("today's calls are used up");
    expect(fa.asked).toHaveLength(2);
    await db.prepare("DELETE FROM app_state WHERE key LIKE 'flight_calls:%'").run();
    await db.prepare("UPDATE trip_items SET status_checked_at = NULL, status_next_at = NULL").run();
    const down = fakeFa(() => 429);
    expect(Object.values(await pollFlights(FA, down.fn, now))).toEqual(["unavailable"]);
  });

  it("Look up: a flight soon from FlightAware's flights, one months ahead from its schedules and the airports' time zones; none, no key, the cap", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const todays = flight({ scheduled_out: `${today}T16:00:00Z`, scheduled_in: `${today}T21:30:00Z` });
    const fa = fakeFa((p) => p.startsWith("/flights/UA1234") ? { flights: [todays] }
      : p.startsWith("/schedules/2027-09-10/2027-09-11") && p.includes("flight_number=1234") ? { scheduled: [{ origin_iata: "SFO", destination_iata: "KOA", scheduled_out: "2027-09-10T16:00:00Z", scheduled_in: "2027-09-10T21:30:00Z", aircraft_type: "B739" }] }
      : p === "/airports/SFO" ? { timezone: "America/Los_Angeles" } : p === "/airports/KOA" ? { timezone: "Pacific/Honolulu" } : 404);
    vi.stubGlobal("fetch", fa.fn);
    const ask = (b: Record<string, unknown>, e: Partial<Env> = KEY) => getJson<any>("/trips/flight-lookup", { method: "POST", body: JSON.stringify(b), envOverrides: e });
    // soon: its day is today (FlightAware's flights window)
    const soon = await ask({ airline: "ua", flight_number: "1234", date: today });
    expect(soon.status).toBe(200);
    expect(soon.body).toMatchObject({ dep_airport: "SFO", arr_airport: "KOA", start_at: localTime(`${today}T16:00:00Z`, "America/Los_Angeles"), end_at: `${today}T11:30-10:00`, dep_terminal: "3" });
    const later = await ask({ airline: "UA", flight_number: "1234", date: "2027-09-10" });
    expect(later.body).toMatchObject({ dep_airport: "SFO", arr_airport: "KOA", start_at: "2027-09-10T09:00-07:00", end_at: "2027-09-10T11:30-10:00" });
    const asked = fa.asked.length;
    await ask({ airline: "UA", flight_number: "1234", date: "2027-09-10" });
    expect(fa.asked.length - asked).toBe(1);                                              // the time zones are kept
    expect((await ask({ airline: "UA", flight_number: "77", date: "2027-09-10" })).status).toBe(404);
    expect((await ask({ airline: "UA", flight_number: "1234", date: today }, {})).status).toBe(404);   // no key
    expect((await ask({ airline: "UA", flight_number: "x", date: today })).status).toBe(422);
    expect((await ask({ airline: "UA", flight_number: "1234", date: today }, { ...KEY, FLIGHT_STATUS_CALLS_PER_DAY: "1" })).status).toBe(503);   // used up
  });

  it("a leg's status starts afresh when its number, day or airports change, and stays otherwise", async () => {
    const id = await leg({ start_at: "2027-04-05T09:00" });
    await db.prepare("UPDATE trip_items SET flight_status = '{\"state\":\"delayed\"}', status_checked_at = 'x', status_next_at = '2027-04-05T10:00:00.000Z' WHERE id = ?").bind(id).run();
    const put = (b: Record<string, unknown>) => getJson<any>(`/trips/items/${id}`, { method: "PUT", body: JSON.stringify({ kind: "flight", airline: "UA", flight_number: "1234", dep_airport: "SFO", arr_airport: "KOA", start_at: "2027-04-05T09:00", ...b }) });
    await put({ seat: "12A" });
    expect((await row(id)).flight_status).toBe('{"state":"delayed"}');
    await put({ flight_number: "1235" });
    expect(await row(id)).toMatchObject({ flight_status: null, status_checked_at: null, status_next_at: null });
  });
});
