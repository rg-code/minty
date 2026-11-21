// Kos: a booking's exact place from its name and address (docs/trips.md §31), with LocationIQ
// (OpenStreetMap data; its terms let Kos keep the coordinates). Only Minty's Worker asks, with the
// LOCATIONIQ_KEY secret (never in a page); what goes is the booking's name and address, never a person's
// name, a confirmation, a price or a card. When a booking is saved without a place, and from a quiet
// catch-up cron run for the rest (a few at a time). One that finds nothing waits 30 days.
import type { Env } from "./env";

const SEARCH = "https://us1.locationiq.com/v1/search";
const GAP_MS = 550;                    // LocationIQ's free plan: 2 requests a second
export const PER_RUN = 3;              // bookings the cron looks up in one quiet run
export type Place = { kind: string; name: string | null; place: string | null };
export type Found = { lat: number; lon: number } | null | "unavailable";   // null: nothing found

const tidy = (s: string | null) => String(s ?? "").replace(/\s+/g, " ").trim();
/** What to ask, best first: the name with its address ("Example Resort, 1 Example Rd, Town, ST 12345"),
 * the address alone, then the name with the address's town. A booking with neither asks nothing. */
export function queriesFor(b: Place): string[] {
  const name = tidy(b.name), place = tidy(b.place);
  const town = place.split(",").map((x) => x.trim()).filter((x) => x && !/\d/.test(x))[0] ?? "";
  const qs = [name && place && !place.toLowerCase().includes(name.toLowerCase()) ? `${name}, ${place}` : "", place,
              name && town ? `${name}, ${town}` : ""];
  return [...new Set(qs.filter((q): q is string => q.length >= 4))].map((q) => q.slice(0, 200)).slice(0, 3);
}
/** A hit that names a different postcode than the address's isn't it (a namesake in another town). */
function fits(hit: { display_name?: string }, place: string | null): boolean {
  const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(place ?? "")?.[1];
  if (!zip) return true;
  const zips: string[] = String(hit.display_name ?? "").match(/\b\d{5}\b/g) ?? [];
  return !zips.length || zips.includes(zip);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The booking's coordinates; null when LocationIQ found nothing for any query; "unavailable" when it
 * couldn't answer (no key, down, over its limit), so it's asked again later. */
export async function locate(key: string | undefined, b: Place, fetchFn: typeof fetch = fetch): Promise<Found> {
  if (!key || b.kind === "flight") return "unavailable";
  const qs = queriesFor(b);
  if (!qs.length) return null;
  for (const [n, q] of qs.entries()) {
    if (n) await wait(GAP_MS);
    let res: Response;
    try {
      res = await fetchFn(`${SEARCH}?${new URLSearchParams({ key, q, format: "json", limit: "1" })}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    } catch { return "unavailable"; }
    if (res.status === 404) { await res.body?.cancel(); continue; }            // LocationIQ's "nothing found"
    if (!res.ok) { await res.body?.cancel(); return "unavailable"; }
    const hit = ((await res.json().catch(() => [])) as { lat?: string; lon?: string; display_name?: string }[])[0];
    const lat = Number(hit?.lat), lon = Number(hit?.lon);
    if (hit && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && fits(hit, b.place)) return { lat, lon };
  }
  return null;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/** Looks one booking up and keeps the answer: its place (marked found), or that nothing was found. */
export async function locateItem(env: Env, id: number, fetchFn: typeof fetch = fetch): Promise<string> {
  const b = await env.DB.prepare("SELECT kind, name, place, lat FROM trip_items WHERE id = ?").bind(id).first<Place & { lat: number | null }>();
  if (!b || b.lat !== null) return "has a place";
  const found = await locate(env.LOCATIONIQ_KEY, b, fetchFn);
  if (found === "unavailable") return "unavailable";
  if (!found) {
    await env.DB.prepare(`UPDATE trip_items SET geo_tried_at = ${NOW} WHERE id = ?`).bind(id).run();
    return "not found";
  }
  await env.DB.prepare(`UPDATE trip_items SET lat = ?, lon = ?, geo_source = 'lookup', geo_tried_at = ${NOW} WHERE id = ? AND lat IS NULL`)
    .bind(found.lat, found.lon, id).run();
  return "found";
}
/** The quiet catch-up run: a few bookings still without a place (never one that found nothing in the
 * last 30 days), newest first. Nothing at all without the key. */
export async function locateSome(env: Env, fetchFn: typeof fetch = fetch): Promise<Record<string, string>> {
  if (!env.LOCATIONIQ_KEY) return {};
  const rows = (await env.DB.prepare(
    `SELECT id FROM trip_items INDEXED BY idx_trip_items_unplaced
     WHERE lat IS NULL AND kind <> 'flight' AND (place IS NOT NULL OR name IS NOT NULL)
       AND (geo_tried_at IS NULL OR geo_tried_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days'))
     ORDER BY id DESC LIMIT ${PER_RUN}`).all<{ id: number }>()).results;
  const out: Record<string, string> = {};
  for (const [n, r] of rows.entries()) {
    if (n) await wait(GAP_MS);
    const said = await locateItem(env, r.id, fetchFn);
    out[`booking ${r.id}`] = said;
    if (said === "unavailable") break;                  // down or over its limit: the next run tries again
  }
  return out;
}
