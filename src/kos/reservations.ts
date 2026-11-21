/** Bookings from a confirmation email's schema.org markup (Kos, docs/trips.md §3, step 1). Airlines,
 * hotels and booking sites put JSON-LD in their emails for Gmail's own trip cards; this reads those
 * blocks, and the same markup written as microdata (itemscope / itemprop), into one shape per booking. Pure, with
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

/** The schema.org microdata in an HTML document (itemscope / itemtype / itemprop), as the same objects
 * JSON-LD gives: {"@type": "http://schema.org/LodgingReservation", reservationFor: {...}, ...}. Gmail reads
 * both; hotels and travel agencies often send this one. A property's value is its content, datetime, href
 * or src attribute, else its text; a property given twice keeps the first. */
const VOID = new Set(["meta", "link", "img", "br", "hr", "input", "source", "area", "base", "col", "wbr"]);
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[e.toLowerCase()] ?? m);
export function microdata(html: string): Record<string, unknown>[] {
  if (!/\bitemscope\b/i.test(html)) return [];
  type Frame = { tag: string; scope?: Record<string, unknown>; text?: { into: Record<string, unknown>; name: string; buf: string } };
  const top: Record<string, unknown>[] = [], stack: Frame[] = [];
  const scope = (): Record<string, unknown> | null => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].scope) return stack[i].scope ?? null; return null; };
  const put = (o: Record<string, unknown> | null, name: string, v: unknown) => { if (o) for (const n of name.split(/\s+/)) if (n && !(n in o)) o[n] = v; };
  const body = html.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi, " ");
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g)) {
    if (m[4] !== undefined) { const t = decode(m[4]); for (const f of stack) if (f.text) f.text.buf += t; continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) {                                                  // a closing tag: close back to its opening
      const i = stack.map((f) => f.tag).lastIndexOf(tag);
      if (i < 0) continue;
      for (const f of stack.splice(i).reverse()) if (f.text) put(f.text.into, f.text.name, f.text.buf.replace(/\s+/g, " ").trim() || null);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([a-zA-Z][\w:-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) attrs[a[1].toLowerCase()] = decode((a[2] ?? "").replace(/^["']|["']$/g, ""));
    const prop = attrs.itemprop, closed = VOID.has(tag) || /\/\s*$/.test(m[3]);
    if ("itemscope" in attrs) {
      const o: Record<string, unknown> = attrs.itemtype ? { "@type": attrs.itemtype.trim().split(/\s+/)[0] } : {};
      if (prop && scope()) put(scope(), prop, o); else top.push(o);
      if (!closed) stack.push({ tag, scope: o });
    } else if (prop) {
      const v = attrs.content ?? attrs.datetime ?? (tag === "a" || tag === "link" ? attrs.href : undefined) ?? (tag === "img" ? attrs.src : undefined);
      if (v !== undefined || closed) put(scope(), prop, v?.trim() || null);
      else stack.push({ tag, text: { into: scope() ?? {}, name: prop, buf: "" } });
    } else if (!closed) stack.push({ tag });
  }
  return top;
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
  // "12 Harbor Road, Example City, HI 96700, US": the region and postcode together, as an address is written
  const parts = [str(a.streetAddress), str(a.addressLocality), [str(a.addressRegion), str(a.postalCode)].filter(Boolean).join(" ") || null, str(a.addressCountry)].filter(Boolean);
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
  for (const o of nodes([...jsonLd(html), ...microdata(html)])) {
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
  // the same reservation once per passenger (or repeated): once, keeping a price when one copy has it
  const kept: Booking[] = [];
  for (const b of out) {
    const k = kept.find((x) => x.kind === b.kind && x.start === b.start && x.end === b.end && x.name === b.name
      && (x.flight?.number ?? null) === (b.flight?.number ?? null) && (x.flight?.from ?? null) === (b.flight?.from ?? null));
    if (!k) { kept.push(b); continue; }
    if (k.price_cents === null && b.price_cents !== null) Object.assign(k, { price_cents: b.price_cents, currency: b.currency });
    k.confirmation ??= b.confirmation;
  }
  return kept;
}
