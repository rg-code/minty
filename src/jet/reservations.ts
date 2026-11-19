/** Bookings from a confirmation email's schema.org markup (JET, docs/trips.md §3, step 1). Airlines,
 * hotels and booking sites put JSON-LD in their emails for Gmail's own trip cards; this reads those
 * blocks into one shape per booking. Microdata and known-sender layouts come later (T2). Pure, with
 * no imports, so the T0 scripts run it in Node too. Nothing is guessed: a field that isn't there
 * stays null. */

export type Kind = "flight" | "lodging" | "car" | "train" | "bus" | "restaurant" | "event" | "other";
export interface Booking {
  kind: Kind;
  confirmation: string | null;
  name: string | null;                    // the hotel, restaurant, event; for a flight, the airline
  guest: string | null;                   // the name on the booking
  start: string | null;                   // ISO 8601 as given (with its offset when it has one)
  end: string | null;
  place: string | null;                   // an address, or a place's name
  lat: number | null; lon: number | null;
  price_cents: number | null; currency: string | null;
  points: number | null;                  // an award booking's points or miles, when the markup gives them
  flight?: { airline: string | null; number: string | null; from: string | null; to: string | null;
             terminal: string | null; gate: string | null; seat: string | null };
  type: string;                           // the schema.org type it came from
}

const TYPES: Record<string, Kind> = {
  FlightReservation: "flight", LodgingReservation: "lodging", RentalCarReservation: "car", TrainReservation: "train",
  BusReservation: "bus", FoodEstablishmentReservation: "restaurant", EventReservation: "event", TaxiReservation: "other",
  ReservationPackage: "other",
};

/** The JSON-LD blocks in an HTML document, parsed; a block that isn't valid JSON is skipped. */
export function jsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1].replace(/^\s*<!--|-->\s*$/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
    try { out.push(JSON.parse(body)); } catch { /* a broken block: the text parser may still read the email */ }
  }
  return out;
}

/** Every object in a JSON-LD value: arrays, @graph and nested reservations (a package) flattened. */
function nodes(v: unknown, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (depth > 6 || v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) { for (const x of v) nodes(x, out, depth + 1); return out; }
  const o = v as Record<string, unknown>;
  out.push(o);
  if (o["@graph"]) nodes(o["@graph"], out, depth + 1);
  if (o.subReservation) nodes(o.subReservation, out, depth + 1);
  return out;
}

const typeOf = (o: Record<string, unknown>) => [o["@type"]].flat().map((t) => String(t ?? "").replace(/^https?:\/\/schema\.org\//, ""));
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return str(o.name ?? o["@value"] ?? o.iataCode ?? o.text);
  }
  return null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^0-9.\-]/g, "")); return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? n : null; };

function address(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  const a = obj(v);
  const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, str(a.addressCountry)].map(str).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}
function geo(...places: unknown[]): { lat: number | null; lon: number | null } {
  for (const p of places) {
    const g = obj(obj(p).geo);
    const lat = num(g.latitude), lon = num(g.longitude);
    if (lat !== null && lon !== null) return { lat, lon };
  }
  return { lat: null, lon: null };
}
function price(o: Record<string, unknown>): { price_cents: number | null; currency: string | null; points: number | null } {
  const spec = obj(o.priceSpecification ?? o.totalPrice);
  const raw = o.totalPrice ?? o.price ?? spec.price;
  const currency = str(o.priceCurrency ?? spec.priceCurrency);
  const n = num(typeof raw === "object" ? obj(raw).price ?? obj(raw).value : raw);
  // an award booking: the price is in points or miles (some airlines say so in priceCurrency)
  if (n !== null && currency && /^(points?|miles?|avios|pts)$/i.test(currency)) return { price_cents: null, currency: null, points: Math.round(n) };
  return { price_cents: n === null ? null : Math.round(n * 100), currency: currency?.toUpperCase() ?? null, points: null };
}

/** The bookings in an email's HTML (its JSON-LD), one per reservation, each flight leg its own. */
export function reservations(html: string | null): Booking[] {
  if (!html) return [];
  const out: Booking[] = [];
  for (const o of nodes(jsonLd(html))) {
    const t = typeOf(o).find((x) => x in TYPES);
    if (!t) continue;
    const f = obj(o.reservationFor), kind = TYPES[t];
    const base = { kind, type: t, confirmation: str(o.reservationNumber ?? o.confirmationNumber), guest: str(o.underName), ...price(o) };
    if (kind === "flight") {
      const seat = str(obj(obj(o.reservedTicket).ticketedSeat).seatNumber) ?? str(o.airplaneSeat);
      out.push({ ...base, name: str(f.airline), start: str(f.departureTime), end: str(f.arrivalTime),
        place: str(f.departureAirport), ...geo(f.departureAirport),
        flight: { airline: str(obj(f.airline).iataCode) ?? str(f.airline), number: str(f.flightNumber),
                  from: str(obj(f.departureAirport).iataCode) ?? str(f.departureAirport), to: str(obj(f.arrivalAirport).iataCode) ?? str(f.arrivalAirport),
                  terminal: str(f.departureTerminal), gate: str(f.departureGate), seat } });
    } else if (kind === "lodging") {
      out.push({ ...base, name: str(f.name), start: str(o.checkinTime ?? o.checkinDate), end: str(o.checkoutTime ?? o.checkoutDate),
        place: address(f.address) ?? str(f.name), ...geo(f) });
    } else if (kind === "car") {
      const at = obj(o.pickupLocation);
      out.push({ ...base, name: str(obj(f.rentalCompany).name ?? f.brand ?? o.provider), start: str(o.pickupTime), end: str(o.dropoffTime),
        place: address(at.address) ?? str(at), ...geo(at) });
    } else if (kind === "train" || kind === "bus") {
      const dep = obj(f.departureStation ?? f.departureBusStop);
      out.push({ ...base, name: str(f.provider) ?? ([str(f.trainName), str(f.trainNumber ?? f.busNumber)].filter(Boolean).join(" ") || null),
        start: str(f.departureTime), end: str(f.arrivalTime), place: str(dep), ...geo(dep) });
    } else {
      const loc = obj(f.location ?? f);
      out.push({ ...base, name: str(f.name), start: str(o.startTime ?? f.startDate ?? f.startTime), end: str(f.endDate ?? o.endTime ?? null),
        place: address(loc.address ?? f.address) ?? str(loc.name ?? null), ...geo(loc, f) });
    }
  }
  return out;
}
