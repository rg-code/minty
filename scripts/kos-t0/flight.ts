// Kos T0 (docs/trips.md §14): what a flight-status provider returns for one flight, with your key.
// Run it in YOUR terminal, with the key in the environment (never in a file in this repo):
//
//   AEROAPI_KEY=... node scripts/kos-t0/flight.ts UA837 [2026-11-20]
//   AIRLABS_KEY=... node scripts/kos-t0/flight.ts UA837
//
// It prints the fields Minty would show (status, times, gates, delay, aircraft), never the key.
// One call each. Check AeroAPI's usage page afterwards for what the call cost.
const [ident, day] = process.argv.slice(2);
if (!ident) { console.error("usage: node scripts/kos-t0/flight.ts <flight, e.g. UA837> [YYYY-MM-DD]"); process.exit(1); }
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

if (process.env.AEROAPI_KEY) {
  const q = new URLSearchParams();
  if (day) { q.set("start", `${day}T00:00:00Z`); q.set("end", `${day}T23:59:59Z`); }
  const r = await fetch(`https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}?${q}`, { headers: { "x-apikey": process.env.AEROAPI_KEY } });
  const d: any = await r.json().catch(() => ({}));
  console.log(`AeroAPI: HTTP ${r.status}, ${d.flights?.length ?? 0} flight(s)`);
  for (const f of (d.flights ?? []).slice(0, 3)) {
    console.log(JSON.stringify(pick(f, ["ident", "status", "scheduled_out", "estimated_out", "actual_out", "scheduled_in", "estimated_in", "actual_in",
      "gate_origin", "terminal_origin", "gate_destination", "terminal_destination", "baggage_claim", "departure_delay", "arrival_delay", "aircraft_type", "cancelled", "diverted"])));
  }
  if (r.status !== 200) console.log(JSON.stringify(d).slice(0, 300));
}
if (process.env.AIRLABS_KEY) {
  const iata = ident.replace(/\s+/g, "");
  const r = await fetch(`https://airlabs.co/api/v9/flight?flight_iata=${encodeURIComponent(iata)}&api_key=${encodeURIComponent(process.env.AIRLABS_KEY)}`);
  const d: any = await r.json().catch(() => ({}));
  console.log(`AirLabs: HTTP ${r.status}`);
  console.log(JSON.stringify(d.response ? pick(d.response, ["flight_iata", "status", "dep_time", "dep_estimated", "dep_actual", "arr_time", "arr_estimated", "arr_actual",
    "dep_gate", "dep_terminal", "arr_gate", "arr_terminal", "arr_baggage", "delayed", "dep_delayed", "arr_delayed", "aircraft_icao"]) : d.error ?? d).slice(0, 600));
}
if (!process.env.AEROAPI_KEY && !process.env.AIRLABS_KEY) { console.error("set AEROAPI_KEY or AIRLABS_KEY"); process.exit(1); }
