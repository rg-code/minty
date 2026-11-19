import { describe, expect, it } from "vitest";
import { dates, parseBookings, times } from "../public/jet/jet-parse.js";

// Reading bookings from pasted, PDF or screenshot text (public/jet/jet-parse.js). Made-up texts.
describe("dates and times", () => {
  it("in their usual forms, in order", () => {
    expect(dates("Wed, Mar 10, 2027 and 15 March 2027 then 2027-03-20, also Apr 2", 2027).map((d) => d.date))
      .toEqual(["2027-03-10", "2027-03-15", "2027-03-20", "2027-04-02"]);
    expect(times("Departs 11:05 AM, arrives 3:00pm; train 23:05").map((t) => t.time)).toEqual(["11:05", "15:00", "23:05"]);
  });
});

describe("parseBookings", () => {
  it("a flight: number, airports, date, times, confirmation and total", () => {
    const t = `Your itinerary. Confirmation code: QX7RTA
      United UA 837  SFO → NRT  Wed, Mar 10, 2027  Depart 11:05 AM  Arrive 3:00 PM
      Total: $1,240.60`;
    const { bookings } = parseBookings(t);
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ kind: "flight", airline: "UA", flight_number: "837", dep_airport: "SFO", arr_airport: "NRT",
      start_at: "2027-03-10T11:05", end_at: "2027-03-10T15:00", confirmation: "QX7RTA", price_cents: 124060, currency: "USD" });
  });

  it("two legs, each its own booking; airports kept to real ones", () => {
    const t = "Flight NH 9 HND-SFO Mar 20 2027 17:00 09:40. Flight NH 10 SFO-HND Apr 2 2027 11:00 15:30. Ref ABC-XYZ";
    const real = new Set(["HND", "SFO"]);
    const { bookings } = parseBookings(t, { isAirport: (c: string) => real.has(c) });
    expect(bookings.map((b) => [b.airline, b.flight_number, b.dep_airport, b.arr_airport, b.start_at])).toEqual([
      ["NH", "9", "HND", "SFO", "2027-03-20T17:00"], ["NH", "10", "SFO", "HND", "2027-04-02T11:00"]]);
  });

  it("a stay: the hotel's name, check-in and check-out", () => {
    const t = "Thank you for booking Park Example Hotel Tokyo. Check-in: Thu, Mar 11, 2027 from 3:00 PM. Check-out: Mon, Mar 15, 2027 by 11:00 AM. Confirmation number 88213345. Total ¥88,000";
    const { bookings } = parseBookings(t);
    expect(bookings).toEqual([expect.objectContaining({ kind: "lodging", name: "Park Example Hotel Tokyo", start_at: "2027-03-11", end_at: "2027-03-15",
      confirmation: "88213345", price_cents: 8800000, currency: "JPY" })]);
  });

  it("finds nothing in text without a booking, and never guesses", () => {
    expect(parseBookings("Lovely to see you last week. See you in March!").bookings).toEqual([]);
  });
});
