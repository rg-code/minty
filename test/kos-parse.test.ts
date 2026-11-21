import { describe, expect, it } from "vitest";
import { dates, parseBookings, times } from "../public/kos/kos-parse.js";

// Reading bookings from pasted, PDF or screenshot text (public/kos/kos-parse.js). Made-up texts.
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
    expect(bookings).toEqual([expect.objectContaining({ kind: "lodging", name: "Park Example Hotel Tokyo", start_at: "2027-03-11T15:00", end_at: "2027-03-15T11:00",   // with the check-in and check-out times
      confirmation: "88213345", price_cents: 8800000, currency: "JPY" })]);
  });

  it("a confirmation code is a code, not the word after 'booking'", () => {
    expect(parseBookings("TAP TP 238 EWR → LIS May 1, 2027 9:20 PM 9:40 AM. Booking reference: ABC1234").bookings[0].confirmation).toBe("ABC1234");
    expect(parseBookings("UA 837 SFO → NRT Mar 10 2027 11:05. Confirmation QXRTAB").bookings[0].confirmation).toBe("QXRTAB");
    expect(parseBookings("UA 837 SFO → NRT Mar 10 2027 11:05. Your booking details").bookings[0].confirmation).toBe(null);
  });

  it("finds nothing in text without a booking, and never guesses", () => {
    expect(parseBookings("Lovely to see you last week. See you in March!").bookings).toEqual([]);
  });

  it("a stay laid out like a vacation club's confirmation: dates above the labels, the year on its own line, points (made-up copy)", () => {
    const t = `Example Vacation Clubs
 Alex Example
Member: XXXXXX123A
Your Reservation Is Confirmed, Alex!

Club Example 'Alpine Lodge
100 Example Road, Example Town, CO 80000 US (303) 555-0100
Confirmation Number: 12345EF000001
See Trip Details
MAR 11     THU
2027

MAR 14     SUN
2027
Hotel Details
Reservation Details
1 Room(s) / 3 Night(s)
One Bedroom
Check-In
4:00 p.m.     Checkout
10:00 a.m.
Rate Details
Free Night     45,000 Pts.
Taxes & Fees     0
Total for Stay     45,000 Pts.
    10% Points Discount
Cancellation Policy
Cancel 72 Hours prior to 4pm day of arrival.`;
    const { bookings } = parseBookings(t, { year: 2025 });                     // the year written wins over the one given
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ kind: "lodging", name: "Club Example 'Alpine Lodge", start_at: "2027-03-11T16:00", end_at: "2027-03-14T10:00",
      place: "100 Example Road, Example Town, CO 80000", confirmation: "12345EF000001", points: 45000, points_program: null });
    // with its program named, as such emails do ("Wyndham Rewards Redemption Guarantee"): BAM's id
    const named = parseBookings(t.replace("Cancellation Policy", "Deposit Policy\nWyndham Rewards Redemption Guarantee\nCancellation Policy"), { year: 2025 });
    expect(named.bookings[0]).toMatchObject({ points: 45000, points_program: "wyndham" });
  });

  it("a forwarded eTicket: the flight's date, not the forwarded header's or when it was booked (made-up copy)", () => {
    const t = `---------- Forwarded message ---------
From: Example Air <noreply@example.com>
Date: Tue, Jan 5, 2027 at 3:14 PM
Subject: eTicket Itinerary and Receipt for Confirmation QZ7XKM

Confirmation #: QZ7XKM
Thu, Mar 11, 2027
Flight UA 100 SFO → ORD Depart 7:00 AM Arrive 8:30 AM
Flight UA 200 ORD → BOS Depart 10:00 AM Arrive 1:15 PM
Passenger: ALEX EXAMPLE
Receipt
Issue date: Jan 5, 2027`;
    expect(parseBookings(t, { year: 2027 }).bookings.map((b) => [b.dep_airport, b.arr_airport, b.start_at, b.end_at, b.confirmation])).toEqual([
      ["SFO", "ORD", "2027-03-11T07:00", "2027-03-11T08:30", "QZ7XKM"], ["ORD", "BOS", "2027-03-11T10:00", "2027-03-11T13:15", "QZ7XKM"]]);
  });

  it("an itinerary's 26NOV dates", () => {
    expect(dates("DEPART 11MAR SFO, RETURN 15MAR27 BOS", 2027).map((d) => d.date)).toEqual(["2027-03-11", "2027-03-15"]);
  });

  it("an award flight's miles and its program", () => {
    const { bookings } = parseBookings("United Airlines UA 837 SFO → NRT Mar 10 2027 11:05 15:00. Paid with MileagePlus. Total: 35,000 miles. Confirmation QXRTAB");
    expect(bookings[0]).toMatchObject({ points: 35000, points_program: "united" });
  });

  it("dates with the weekday before the year, or the year on the next line", () => {
    expect(dates("MAR 11 THU\n2027, Mar 3, Wed, 2027 and Apr 9 2027", 2020).map((d) => d.date)).toEqual(["2027-03-11", "2027-03-03", "2027-04-09"]);
  });
});
