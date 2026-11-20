// Kos's trip journal (docs/trips.md §20): what a journal says about a trip, from its bookings alone,
// without the page. kos.js draws it (journalView), with the household's notes beside each day.
// No AI: the words are these templates, so they're the same everywhere and cost nothing.

/** Distance between two [lon, lat] points, in km (haversine). */
export function km([lon1, lat1], [lon2, lat2]) {
  const r = (d) => (d * Math.PI) / 180, h = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
/** The journal's cover numbers. `airports`: IATA → [name, city, country, lat, lon] (airports.json). */
export function tripStats(t, airports = {}) {
  const day = (s) => Date.parse(`${s}T00:00:00Z`);
  const nights = Math.max(0, Math.round((day(t.end_date) - day(t.start_date)) / 864e5));
  const flights = t.items.filter((i) => i.kind === "flight");
  let dist = 0;
  const countries = new Set();
  for (const f of flights) {
    const a = airports[f.dep_airport], b = airports[f.arr_airport];
    if (a) countries.add(a[2]);
    if (b) countries.add(b[2]);
    if (a && b) dist += km([a[4], a[3]], [b[4], b[3]]);
  }
  const places = new Set(t.items.filter((i) => i.kind !== "flight" && (i.name || i.place)).map((i) => (i.name || i.place).toLowerCase()));
  return { days: nights + 1, nights, flights: flights.length, km: Math.round(dist), countries: countries.size, places: places.size };
}
const meal = (at) => { const h = Number(String(at ?? "").slice(0, 2)); return !at || Number.isNaN(h) ? "A meal" : h < 11 ? "Breakfast" : h < 16 ? "Lunch" : "Dinner"; };
/** One line for one entry of a day's plan ({item, role, at}, as kos.js's plan() makes them). */
export function lineFor(e, airports = {}) {
  const i = e.item, name = i.name || "";
  const city = (code) => airports[code]?.[1] || code || "?";
  switch (i.kind) {
    case "flight": return `Flew ${city(i.dep_airport)} → ${city(i.arr_airport)}${i.airline || i.flight_number ? ` on ${[i.airline, i.flight_number].filter(Boolean).join(" ")}` : ""}`;
    case "lodging": return e.role === "Check out" ? `Checked out of ${name || "the stay"}` : `Checked in at ${name || "a stay"}`;
    case "restaurant": return `${meal(e.at)} at ${name || "a restaurant"}`;
    case "train": case "bus": return `Took ${name || `the ${i.kind}`}`;
    case "car": return `Picked up the car${name ? ` from ${name}` : ""}`;
    case "event": return name || "An activity";
    default: return name || "A booking";
  }
}
/** A day's spending, from the trip's transactions on Minty (amount: dollars, positive = out). */
export function daySpend(rows, date) {
  const out = rows.filter((r) => r.date === date && r.amount > 0);
  const by = {};
  for (const r of out) { const n = r.merchant_name || r.name; by[n] = (by[n] ?? 0) + Math.round(r.amount * 100); }
  return { cents: out.reduce((a, r) => a + Math.round(r.amount * 100), 0), top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n) };
}
