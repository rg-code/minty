import { describe, expect, it } from "vitest";
import { checkBooking, checkLegs, parseBookings } from "../public/kos/kos-parse.js";
import { journeys } from "../public/kos/store.js";

// Kos's edge cases (docs/trips.md §36): what a trip aggregator must get right from first principles, each written
// in a layout bookings use, with made-up values. Every case is read, checked field by field, and must pass the
// sanity checks (a flight lands after it takes off, a connection leaves after the leg before it lands, …).
const A: Record<string, [string, string, string, number, number]> = {
  PDX: ["Portland International Airport", "Portland", "US", 45.59, -122.6], PHX: ["Phoenix Sky Harbor International Airport", "Phoenix", "US", 33.43, -112.01],
  BWI: ["Baltimore/Washington International Airport", "Baltimore", "US", 39.18, -76.67], SEA: ["Seattle-Tacoma International Airport", "Seattle", "US", 47.45, -122.31],
  BOS: ["Logan International Airport", "Boston", "US", 42.36, -71.01], LAX: ["Los Angeles International Airport", "Los Angeles", "US", 33.94, -118.41],
  NRT: ["Narita International Airport", "Tokyo", "JP", 35.77, 140.39], DTW: ["Detroit Metropolitan Wayne County Airport", "Detroit", "US", 42.21, -83.35],
  ORD: ["O'Hare International Airport", "Chicago", "US", 41.98, -87.9], DEN: ["Denver International Airport", "Denver", "US", 39.86, -104.67],
  SYD: ["Sydney Kingsford Smith Airport", "Sydney", "AU", -33.95, 151.18], DFW: ["Dallas/Fort Worth International Airport", "Dallas", "US", 32.9, -97.04],
};
const ref = Date.parse("2027-01-15");
const read = (text: string) => parseBookings(text, { ref, airports: A }).bookings;
const pick = (b: any) => [b.kind, b.flight_number ?? b.name ?? null, b.dep_airport ?? null, b.arr_airport ?? null, b.start_at, b.end_at];
const sane = (bookings: any[]) => {
  for (const b of bookings) expect(checkBooking(b, A), JSON.stringify(pick(b))).toEqual([]);
  const flights = bookings.filter((b) => b.kind === "flight").map((b, k) => ({ ...b, id: k, confirmation: b.confirmation ?? "X" }));
  for (const g of journeys(flights)) expect(checkLegs(g, A).flat()).toEqual([]);
};

const CASES: { name: string; text: string; want: unknown[][] }[] = [
  { name: "a red-eye with a connection under one date, no '+1'",
    text: "Thursday, 03/11/2027\nFLIGHT\nWN #2222\nDEPARTS\nPDX 09:40PM\nARRIVES\nPHX 01:05AM\nStop: Change planes\nFLIGHT\nWN #3333\nDEPARTS\nPHX 05:50AM\nARRIVES\nBWI 01:30PM",
    want: [["flight", "2222", "PDX", "PHX", "2027-03-11T21:40", "2027-03-12T01:05"], ["flight", "3333", "PHX", "BWI", "2027-03-12T05:50", "2027-03-12T13:30"]] },
  { name: "a red-eye marked '+1'",
    text: "Confirmation: QZ7XKM\nAS 1234\nFri, Apr 9, 2027\nDepart SEA 11:55 PM\nArrive BOS 8:20 AM +1",
    want: [["flight", "1234", "SEA", "BOS", "2027-04-09T23:55", "2027-04-10T08:20"]] },
  { name: "westbound across the date line, the arrival with its own date",
    text: "Confirmation: QZ7XKM\nNH 105\nDeparture: Mon, Apr 5, 2027 11:30 PM Los Angeles (LAX)\nArrival: Wed, Apr 7, 2027 5:20 AM Tokyo (NRT)",
    want: [["flight", "105", "LAX", "NRT", "2027-04-05T23:30", "2027-04-07T05:20"]] },
  { name: "eastbound across the date line: lands 'earlier' the same day",
    text: "Confirmation: QZ7XKM\nNH 6\nSat, Apr 10, 2027\nDepart NRT 5:05 PM\nArrive LAX 10:35 AM",
    want: [["flight", "6", "NRT", "LAX", "2027-04-10T17:05", "2027-04-10T10:35"]] },
  { name: "Sydney to Dallas: across the date line, the same date",
    text: "Booking reference: QZ7XKM\nQF 7\nMon, 12 Apr 2027\nSYD 13:50 → DFW 13:20",
    want: [["flight", "7", "SYD", "DFW", "2027-04-12T13:50", "2027-04-12T13:20"]] },
  { name: "a short hop that lands 'earlier' across a zone line",
    text: "Confirmation: QZ7XKM\nFlight UA 1234\nMon, Apr 5, 2027\nDepart DTW 10:00 AM\nArrive ORD 9:55 AM",
    want: [["flight", "1234", "DTW", "ORD", "2027-04-05T10:00", "2027-04-05T09:55"]] },
  { name: "a daytime connection stays on its day",
    text: "Confirmation: QZ7XKM\nMon, Apr 5, 2027\nUA 100 DEN → ORD Depart 08:00 AM Arrive 11:40 AM\nUA 200 ORD → BOS Depart 12:55 PM Arrive 4:15 PM",
    want: [["flight", "100", "DEN", "ORD", "2027-04-05T08:00", "2027-04-05T11:40"], ["flight", "200", "ORD", "BOS", "2027-04-05T12:55", "2027-04-05T16:15"]] },
  { name: "a round trip, each leg on its own date",
    text: "Confirmation: QZ7XKM\nOutbound: Fri, May 14, 2027\nUA 300 SEA → DEN 06:10 → 09:45\nReturn: Sun, May 16, 2027\nUA 301 DEN → SEA 19:20 → 21:05",
    want: [["flight", "300", "SEA", "DEN", "2027-05-14T06:10", "2027-05-14T09:45"], ["flight", "301", "DEN", "SEA", "2027-05-16T19:20", "2027-05-16T21:05"]] },
  { name: "a night train arrives the next morning",
    text: "Booking number: 5550123\nNightjet 466\nFri, 14 May 2027\nWien Hbf 22:15 → Zürich HB 07:30\nSleeper compartment, 2 berths",
    want: [["train", "Nightjet 466", null, null, "2027-05-14T22:15", "2027-05-15T07:30"]] },
  { name: "a night bus arrives the next morning",
    text: "Booking number: 5550124\nFlixBus 1234\nSat, 15 May 2027\nDeparture 23:40 Praha ÚAN Florenc\nArrival 06:15 Berlin ZOB",
    want: [["bus", "FlixBus 1234", null, null, "2027-05-15T23:40", "2027-05-16T06:15"]] },
  { name: "a stay checked into after midnight's eve",
    text: "Reservation number: 5550125\nSeaside Example Hotel\nCheck-in: Fri, May 14, 2027 after 11:30 PM\nCheck-out: Sat, May 15, 2027 11:00 AM",
    want: [["lodging", "Seaside Example Hotel", null, null, "2027-05-14T23:30", "2027-05-15T11:00"]] },
];

describe("first-principles cases a trip aggregator must get right", () => {
  for (const c of CASES) it(c.name, () => {
    const got = read(c.text);
    expect(got.map(pick)).toEqual(c.want);
    sane(got);
  });
});

describe("what can't be fixed is flagged, not guessed", () => {
  it("a garbled time isn't rolled into a 21-hour hop: it's left, and the checks say so", () => {
    const [b] = read("Confirmation: QZ7XKM\nMon, Apr 5, 2027\nUA 100 DEN → ORD Depart 08:00 AM Arrive 06:00 AM");
    expect(b).toMatchObject({ start_at: "2027-04-05T08:00", end_at: "2027-04-05T06:00" });
    expect(checkBooking(b, A)).toEqual(["lands before it takes off"]);
  });
});

describe("the sanity checks", () => {
  it("say what can't be true", () => {
    expect(checkBooking({ kind: "flight", dep_airport: "PDX", arr_airport: "PHX", start_at: "2027-03-11T21:40", end_at: "2027-03-11T01:05" }, A)).toEqual(["lands before it takes off"]);
    expect(checkBooking({ kind: "flight", dep_airport: "NRT", arr_airport: "LAX", start_at: "2027-04-10T17:05", end_at: "2027-04-10T10:35" }, A)).toEqual([]);
    expect(checkBooking({ kind: "flight", dep_airport: "SEA", arr_airport: "BOS", start_at: "2027-04-09T08:00", end_at: "2027-04-10T16:00" }, A)).toEqual(["over 28 hours in the air"]);
    expect(checkBooking({ kind: "train", start_at: "2027-05-14T22:15", end_at: "2027-05-14T07:30" }, A)).toEqual(["arrives before it leaves"]);
    expect(checkBooking({ kind: "lodging", start_at: "2027-05-14", end_at: "2027-05-14" }, A)).toEqual(["checks out the day it checks in"]);
    expect(checkBooking({ kind: "lodging", start_at: "2027-05-14", end_at: "2027-08-14" }, A)).toEqual(["92 nights"]);
    const legs = [{ kind: "flight", dep_airport: "PDX", arr_airport: "PHX", start_at: "2027-03-11T21:40", end_at: "2027-03-12T01:05" },
                  { kind: "flight", dep_airport: "PHX", arr_airport: "BWI", start_at: "2027-03-11T05:50", end_at: "2027-03-11T13:30" }];
    expect(checkLegs(legs, A)).toEqual([[], ["leaves before the flight before it lands"]]);
  });
});
