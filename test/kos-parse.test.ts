import { describe, expect, it } from "vitest";
import { dates, parseBookings, pointsIn, times } from "../public/kos/kos-parse.js";

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

  it("an eTicket that lays each leg out as a block, with a receipt's repeats after it (made-up copy)", () => {
    const t = `---------- Forwarded message ---------
From: Example Airlines <receipts@example.com>
Date: Mon, Feb 1, 2027 at 9:12 PM
Subject: eTicket Itinerary and Receipt for Confirmation QZ7XKM
To: <someone@example.com>


Example Airlines    Tue, Feb 2, 2027
Thank you for choosing Example.
Confirmation Number:
QZ7XKM
Flight 1 of 2 UA1234        Class: Economy (N)
Mon, Apr 5, 2027        Mon, Apr 5, 2027
06:00 AM        08:15 AM
Denver, CO, US (DEN)        Chicago, IL, US (ORD)
Flight 2 of 2 UA567        Class: Economy (N)
Mon, Apr 5, 2027        Mon, Apr 5, 2027
09:30 AM        12:40 PM
Chicago, IL, US (ORD)        Boston, MA, US (BOS)
Traveler Details
Fare breakdown
DEN-ORD-BOS  Feb 2, 2027
DEN-ORD
ORD-BOS`;
    expect(parseBookings(t, { year: 2027 }).bookings.map((b) => [b.airline, b.flight_number, b.dep_airport, b.arr_airport, b.start_at, b.end_at, b.confirmation])).toEqual([
      ["UA", "1234", "DEN", "ORD", "2027-04-05T06:00", "2027-04-05T08:15", "QZ7XKM"],
      ["UA", "567", "ORD", "BOS", "2027-04-05T09:30", "2027-04-05T12:40", "QZ7XKM"]]);
  });

  it("a car rental: company, pick-up and return with their times, the place, the confirmation and the total (made-up copy)", () => {
    const t = `Confirmation:
55500011

Your Reservation is Confirmed.

Thanks for choosing Enterprise. You reserved a Midsize vehicle on March 8, 2027 at DENVER INTL ARPT.

Your confirmation number is: 55500011

Itinerary

PICK UP

DENVER INTL ARPT (DEN)
Mon, March 8, 2027
10:00 AM

100 EXAMPLE BLVD
Sun-Sat
    6:00 AM-11:00 PM
Hours subject to change. Please call to verify.
DENVER CO 80000 US
(303) 555-0100


RETURN

DENVER INTL ARPT (DEN)
Thu, March 11, 2027
9:00 AM

Vehicle
Midsize
Example Sedan or similar

RATES & CHARGES

Vehicle
TIME & DISTANCE     3 DAILY @ $40.00      $120.00

Estimated Total
(includes taxes and fees)     $145.10
Total may vary slightly.`;
    const { bookings } = parseBookings(t, { year: 2027 });
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ kind: "car", name: "Enterprise", start_at: "2027-03-08T10:00", end_at: "2027-03-11T09:00",
      place: "DENVER INTL ARPT (DEN)", confirmation: "55500011", price_cents: 14510, currency: "USD" });
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

  // docs/trips.md §27: rules learned from a made-up corpus of six travellers (all values made up)
  it("a train: service and number, its date, departure and arrival lines, stations, the booking's code", () => {
    const t = `Booking code: TR7Q2X
Train / Treno: Frecciarossa 9512
Departure / Partenza: Milano Centrale 12/05/2027 ore 09:10
Arrival / Arrivo: Bologna Centrale 12/05/2027 ore 10:12
Coach 6 · Seat 8A
Total: € 39,90`;
    const [b] = parseBookings(t, { ref: Date.parse("2027-02-01") }).bookings;
    expect(b).toMatchObject({ kind: "train", name: "Frecciarossa 9512", start_at: "2027-05-12T09:10", end_at: "2027-05-12T10:12", confirmation: "TR7Q2X", price_cents: 3990, currency: "EUR" });
  });
  it("European forms: day-first dates, two-digit years, comma decimals, 24-hour times, 'h' times", () => {
    expect(dates("16/04/2027 · 16.04.2027 · Fri, 16 Apr 27 · 13-06-2027", { year: 2027 }).map((d) => d.date)).toEqual(["2027-04-16", "2027-04-16", "2027-04-16", "2027-06-13"]);
    expect(dates("04/16/2027", { year: 2027 }).map((d) => d.date)).toEqual(["2027-04-16"]);              // can only be month first
    expect(times("08h00 Paris · Duration 1h56 · 4:35 h").map((t) => t.time)).toEqual(["08:00"]);      // durations aren't times
    expect(times("12:25 Amsterdam (AMS)").map((t) => t.time)).toEqual(["12:25"]);                      // "Am…" isn't AM
  });
  it("a stay laid out in a table: 'Confirmation #:', an address over three lines, check-in and check-out side by side", () => {
    const text = `Trip to Example City\nMar 9, 2027 - Mar 10, 2027\nSeaside Resort Example\nEXAMPLE HOTEL COLLECTION\n12 Harbor Road\nExample City\nHI, United States, 96700\n+1-808-555-0100
Hotel Confirmation #: 5550001112223\nCheck-in: Check-out:\nTuesday, March 9, 2027 Wednesday, March 10, 2027\n03:00 PM 12:00 PM\nNumber of Nights: 1\nGuest Name: Alex Sample\nTotal: $1,230.50\nDue at Property: $0.00`;   // not the hotel's name
    const [b] = parseBookings(text, { ref: Date.parse("2027-01-15") }).bookings;
    expect(b).toMatchObject({ kind: "lodging", name: "Seaside Resort Example", confirmation: "5550001112223", start_at: "2027-03-09T15:00", end_at: "2027-03-10T12:00",
      place: "12 Harbor Road, Example City, HI, United States, 96700", price_cents: 123050 });
  });
  it("the booking's total, not a benefit's 'total value', and a named total over a bare one", () => {
    const stay = "Seaside Resort Kalani\nCheck-in: Tue, Mar 9, 2027 3:00 PM\nCheck-out: Wed, Mar 10, 2027 12:00 PM\nHotel Confirmation #: 5550001112223\n";
    const tail = "Cost & Billing\n\nCost:\n\n$980.00\n\nTaxes & Fees:\n\n$171.45\n\nTotal Cost:\n\n$1,151.45\n\nDue at Hotel:\n\n$0.00\n";
    for (const extra of ["Your benefits have an average total value of $600.\n", "Total value of your benefits: $600\n", "Total savings: $200.00\n", "Total: $600.00\n"])
      expect(parseBookings(stay + extra + tail, { ref: Date.parse("2027-01-15") }).bookings[0], extra).toMatchObject({ price_cents: 115145, currency: "USD" });
  });
  it("the card it was paid with, and the day it was booked (cardIn, bookedOn, docs/trips.md §28)", async () => {
    const { cardIn, bookedOn } = await import("../public/kos/kos-parse.js");
    expect(["Payment: Visa ending in 1234", "ALEX SAMPLE\nAccount Ending: 4321", "Card: VI ************5678", "Paid with Mastercard (x9012)", "American Express ••••• 53141\nTotal $40",
            "Reservation guaranteed with Visa ending in 3456", "Form of payment\nAMEX XXXXXXXXXXX6060", "Charged to card ending 7788"].map(cardIn)).toEqual([
      { last4: "1234", network: "visa" }, { last4: "4321", network: null }, { last4: "5678", network: "visa" }, { last4: "9012", network: "mastercard" },
      { last4: "3141", network: "amex" }, { last4: "3456", network: "visa" }, { last4: "6060", network: "amex" }, { last4: "7788", network: null }]);
    expect(["MileagePlus number: XXXXX1234\nTotal $10", "Phone ending 4455", "Earned 1,234 miles", "Room 1 · 2 nights", "Use your card: offer ends 2027"].map(cardIn)).toEqual([null, null, null, null, null]);
    expect(bookedOn("---------- Forwarded message ---------\nFrom: X <x@example.com>\nDate: Fri, Jan 15, 2027 at 9:12 AM\nSubject: y", "Mon, 18 Jan 2027 09:00:00 -0800")).toBe("2027-01-15");
    expect(bookedOn("hello", "Fri, 20 Nov 2026 09:00:00 -0800")).toBe("2026-11-20");
    expect(bookedOn("Your tickets\nDate: Sat, Mar 13, 2027 8:00 PM\nVenue: Example Hall", "Mon, 4 Jan 2027 10:00:00 +0000")).toBe("2027-01-04");   // the event's date isn't the booking's
    expect(bookedOn("-----Original Message-----\nFrom: X\nSent: Monday, January 4, 2027 9:00 AM\nTo: Y", "Fri, 20 Nov 2027 09:00:00 -0800")).toBe("2027-01-04");
    const [b] = parseBookings("Example Car Rental\nPick-up: Mon, Apr 5, 2027 10:00 AM\nReturn: Thu, Apr 8, 2027 10:00 AM\nConfirmation: 12345678US1\nCharged to Visa ending in 2468\nTotal: $300.00", { ref: Date.parse("2027-01-01") }).bookings;
    expect(b).toMatchObject({ kind: "car", card_last4: "2468", card_network: "visa" });
  });
  it("a charter's itinerary PDF: a route written with towns, a flight number after 'FLIGHT:', check-in times and notes left out", () => {
    const text = `TERMS AND CONDITIONS
Example Air is a charter air service. All reservations are booked and ticketed by Example Resorts LLC.
Passenger Itinerary
BOOKING NUMBER: 5550123
DEPARTING PASSENGER NAMES (2)
• ALEX SAMPLE
• JAMIE SAMPLE
ITINERARY
CHECK IN BY DEPARTURE ARRIVAL DETAILS
8:00 AM Bozeman -> Billings FLIGHT: 510
Tue, 9 Mar 2027 9:00 AM Tue, 9 Mar 2027 9:40 AM CLASS: STANDARD (Y)
12:15_UPON RETURNING YOUR VEHICLE AT THE 4-STORY GARAGE (12:15), TAKE THE ELEVATOR DOWN.
RETURNING PASSENGER NAMES (2)
CHECK IN BY DEPARTURE ARRIVAL DETAILS
3:00 PM Billings -> Bozeman FLIGHT: 733
Wed, 10 Mar 2027 4:00 PM Wed, 10 Mar 2027 4:40 PM CLASS: STANDARD (Y)
WE WILL PROVIDE GROUND TRANSPORTATION TO YOUR CONNECTING FLIGHT ON: WN_1111 TO DEN ETD_18:05)`;
    const airports = { BZN: ["Bozeman Yellowstone International Airport", "Bozeman", "US", 45.8, -111.2], BIL: ["Billings Logan International Airport", "Billings", "US", 45.8, -108.5],
                       DEN: ["Denver International Airport", "Denver", "US", 39.9, -104.7], THE: ["Teresina Airport", "Teresina", "BR", -5.1, -42.8] };
    const r = parseBookings(text, { ref: Date.parse("2027-01-15"), airports });
    expect(r.bookings.map((b) => [b.kind, b.flight_number, b.dep_airport, b.arr_airport, b.start_at, b.end_at, b.confirmation])).toEqual([
      ["flight", "510", "BZN", "BIL", "2027-03-09T09:00", "2027-03-09T09:40", "5550123"],
      ["flight", "733", "BIL", "BZN", "2027-03-10T16:00", "2027-03-10T16:40", "5550123"]]);   // never THE (a word) or DEN (a connection's note)
  });
  it("an email as Kos reads it: markup with the points from its text, else the text with its date and subject (readEmailBookings)", async () => {
    const { readEmailBookings } = await import("../public/kos/kos-parse.js");
    const markup = [{ kind: "lodging", name: "Example Lodge", start: "2027-05-10T15:00:00-06:00", end: "2027-05-13T11:00:00-06:00", confirmation: "EX12345", points: null }];
    const m = readEmailBookings({ markup, text: "Thanks for booking with World of Hyatt. Total: 45,000 Points", date: "Mon, 1 Feb 2027 10:00:00 +0000", subject: "Your stay" });
    expect(m.how).toBe("markup");
    expect(m.bookings[0]).toMatchObject({ points: 45000, points_program: "hyatt" });
    const t = readEmailBookings({ markup: [], text: "Confirmation: QZ7XKM\nUA 1234 DEN → ORD Mon, Apr 5 Depart 06:00 AM Arrive 08:15 AM", date: "Mon, 1 Feb 2027 10:00:00 +0000", subject: "Your flight" });
    expect(t).toMatchObject({ how: "text", bookings: [{ kind: "flight", start_at: "2027-04-05T06:00" }] });   // no year: the one after the email
    expect(readEmailBookings({ markup: [], text: null }).how).toBe("nothing");
  });
  it("a screenshot's misreads are fixed in numbers only: an email's code or a name keeps its letters", async () => {
    const { tidy } = await import("../public/kos/kos-parse.js");
    expect(tidy("16:3O · 2O27 · ¥28,34O · l8:16")).toBe("16:30 · 2027 · ¥28,340 · 18:16");
    expect(tidy("Confirmation K2OXYZ at the O2 Arena, seat I2")).toBe("Confirmation K2OXYZ at the O2 Arena, seat I2");
  });
  it("a date without a year is the next one after the email (or today, for a paste)", () => {
    expect(dates("Sat, Jul 17", { ref: Date.parse("2027-06-28") }).map((d) => d.date)).toEqual(["2027-07-17"]);
    expect(dates("Tue, Jan 12", { ref: Date.parse("2026-11-21") }).map((d) => d.date)).toEqual(["2027-01-12"]);
  });
  it("a cancellation's bookings come back marked; a marketing email gives nothing", () => {
    const c = parseBookings("Your flight has been cancelled.\nConfirmation: QZ7XKM\nUA 1234 DEN → ORD Mon, Apr 5, 2027 06:00 AM 08:15 AM", { ref: Date.parse("2027-02-01") });
    expect(c.cancelled).toBe(true);
    expect(c.bookings.map((b: any) => b.status)).toEqual(["cancelled"]);
    const promo = parseBookings("Spring sale! Fares from €19.99. Berlin (BER) → Bergamo (BGY), Oct 19. Book now, limited time.", { ref: Date.parse("2027-02-01") });
    expect(promo.bookings).toEqual([]);
    expect(promo.promotional).toBe(true);
  });
  it("a schedule change: the new times, not the old ones it still shows", () => {
    const t = `Confirmation: QZ7XKM
Your new itinerary
UA 1234 DEN → ORD Mon, Apr 5, 2027 Depart 07:30 AM Arrive 09:45 AM
Original flight (no longer valid)
UA 1234 DEN → ORD Mon, Apr 5, 2027 Depart 06:00 AM Arrive 08:15 AM`;
    const b = parseBookings(t, { ref: Date.parse("2027-02-01") }).bookings;
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ start_at: "2027-04-05T07:30", end_at: "2027-04-05T09:45" });
  });
  it("points: a total wins over a per-night breakdown; miles + cash on one line; earned miles aren't paid", () => {
    expect(pointsIn("Points + Cash per night: 20,000 points + 10,000 JPY\nTue, Mar 2, 2027 20,000 points + 10,000 JPY\nTotal points: 40,000\nTotal cash: 20,000 JPY")).toEqual({ points: 40000, cash: null });
    expect(pointsIn("Total paid: 52,500 Miles + 168,46 €")).toMatchObject({ points: 52500, cash: { price_cents: 16846, currency: "EUR" } });
    expect(pointsIn("You'll earn 2,140 miles on this trip")).toBeNull();
  });
  it("a leg laid out with its times first and its flight number after (two legs, a connection)", () => {
    const t = `Booking code: 5XKQ7P
Thursday, 10 June 2027
07:00 Denver (DEN), Terminal 1
08:10 Chicago (ORD), Terminal 1
UA 183 | Economy | Airbus A321
Connection in Chicago (ORD): 1 h 35 min
09:45 Chicago (ORD), Terminal 1
11:50 Boston (BOS), Terminal B
UA 1166 | Economy | Airbus A320`;
    expect(parseBookings(t, { ref: Date.parse("2027-03-01") }).bookings.map((b) => [b.airline, b.flight_number, b.dep_airport, b.arr_airport, b.start_at, b.end_at]))
      .toEqual([["UA", "183", "DEN", "ORD", "2027-06-10T07:00", "2027-06-10T08:10"], ["UA", "1166", "ORD", "BOS", "2027-06-10T09:45", "2027-06-10T11:50"]]);
  });
});

