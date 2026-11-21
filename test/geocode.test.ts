import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { getJson } from "./helpers";
import { locate, locateSome, queriesFor } from "../src/geocode";
import type { Env } from "../src/env";

// Kos: a booking's exact place from LocationIQ (docs/trips.md §31). A fake LocationIQ: each query's answer
// by its text; it records what was asked (never a person's name, a code or a price).
const db = env.DB;
function fakeIq(answers: Record<string, { lat: string; lon: string; display_name?: string } | 404 | 429>) {
  const asked: string[] = [];
  const fn = (async (url: string) => {
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://us1.locationiq.com/v1/search");
    expect(u.searchParams.get("key")).toBe("iq-key");
    const q = u.searchParams.get("q")!;
    asked.push(q);
    const a = answers[q];
    if (a === 429) return new Response("{}", { status: 429 });
    if (!a || a === 404) return new Response('{"error":"Unable to geocode"}', { status: 404 });
    return Response.json([a]);
  }) as unknown as typeof fetch;
  return { fn, asked };
}
const IQ = { ...env, LOCATIONIQ_KEY: "iq-key" } as Env;

describe("what Kos asks LocationIQ", () => {
  it("the name with its address, the address, then the name with its town; nothing for a name alone", () => {
    expect(queriesFor({ kind: "lodging", name: "Example Resort", place: "100 Example Rd, Exampleville, HI 96700" }))
      .toEqual(["Example Resort, 100 Example Rd, Exampleville, HI 96700", "100 Example Rd, Exampleville, HI 96700", "Example Resort, Exampleville"]);
    expect(queriesFor({ kind: "restaurant", name: "The Table", place: null })).toEqual([]);   // a name alone is too vague to place
    expect(queriesFor({ kind: "other", name: null, place: null })).toEqual([]);
  });
  it("takes the first answer that fits; a namesake with another postcode isn't it; 'unavailable' when LocationIQ can't answer", async () => {
    const b = { kind: "lodging", name: "Example Resort", place: "100 Example Rd, Exampleville, HI 96700" };
    const wrongTown = fakeIq({ "Example Resort, 100 Example Rd, Exampleville, HI 96700": { lat: "40.1", lon: "-75.2", display_name: "Example Resort, Elsewhere, PA, 19000, USA" },
                               "100 Example Rd, Exampleville, HI 96700": { lat: "20.5", lon: "-156.4", display_name: "100, Example Road, Exampleville, Hawaii, 96700, USA" } });
    expect(await locate("iq-key", b, wrongTown.fn)).toEqual({ lat: 20.5, lon: -156.4 });
    expect(wrongTown.asked).toHaveLength(2);
    expect(await locate("iq-key", b, fakeIq({}).fn)).toBeNull();
    expect(await locate("iq-key", b, fakeIq({ "Example Resort, 100 Example Rd, Exampleville, HI 96700": 429 }).fn)).toBe("unavailable");
    expect(await locate(undefined, b, fakeIq({}).fn)).toBe("unavailable");
    expect(await locate("iq-key", { ...b, kind: "flight" }, fakeIq({}).fn)).toBe("unavailable");
  });
});

describe("bookings' places (saved, and the quiet cron run)", () => {
  beforeEach(async () => { await db.batch(["trip_items", "trips"].map((t) => db.prepare(`DELETE FROM ${t}`))); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const item = async (b: Record<string, unknown>, e: Partial<Env> = {}) =>
    (await getJson<any>("/trips/items", { method: "POST", body: JSON.stringify(b), envOverrides: e })).body.id as number;
  const row = (id: number) => db.prepare("SELECT lat, lon, geo_source, geo_tried_at FROM trip_items WHERE id = ?").bind(id).first<any>();

  it("a booking saved without a place is looked up once; one with its own place, or a flight, isn't; a changed address looks again", async () => {
    const iq = fakeIq({ "Example Inn, 12 Example St, Exampleville, HI 96700": { lat: "20.1", lon: "-155.1" }, "Example Inn, 99 Other St, Exampleville, HI 96700": { lat: "20.2", lon: "-155.2" } });
    vi.stubGlobal("fetch", iq.fn);
    const inn = await item({ kind: "lodging", name: "Example Inn", place: "12 Example St, Exampleville, HI 96700", confirmation: "QZ7XKM", guest: "Alex Sample", price_cents: 50000 }, { LOCATIONIQ_KEY: "iq-key" });
    expect(await row(inn)).toMatchObject({ lat: 20.1, lon: -155.1, geo_source: "lookup" });
    expect(iq.asked.join(" ")).not.toMatch(/QZ7XKM|Alex|500/);                        // only the name and address go
    await item({ kind: "lodging", name: "Own Spot", place: "1 Example Way", lat: 21, lon: -157 }, { LOCATIONIQ_KEY: "iq-key" });
    await item({ kind: "flight", airline: "UA", flight_number: "1234", dep_airport: "SFO", arr_airport: "KOA" }, { LOCATIONIQ_KEY: "iq-key" });
    expect(iq.asked).toHaveLength(1);
    // a new address: the old lookup goes, and the new one is asked
    await getJson<any>(`/trips/items/${inn}`, { method: "PUT", body: JSON.stringify({ kind: "lodging", name: "Example Inn", place: "99 Other St, Exampleville, HI 96700", lat: 20.1, lon: -155.1 }), envOverrides: { LOCATIONIQ_KEY: "iq-key" } });
    expect(await row(inn)).toMatchObject({ lat: 20.2, lon: -155.2, geo_source: "lookup" });
    // an existing booking without a place, saved unchanged, is asked at once too (Save asks now)
    const iq2 = fakeIq({ "Old Inn, 7 Example St, Exampleville, HI 96700": { lat: "20.3", lon: "-155.3" } });
    const old = await item({ kind: "lodging", name: "Old Inn", place: "7 Example St, Exampleville, HI 96700" });   // saved before the key
    vi.stubGlobal("fetch", iq2.fn);
    await getJson<any>(`/trips/items/${old}`, { method: "PUT", body: JSON.stringify({ kind: "lodging", name: "Old Inn", place: "7 Example St, Exampleville, HI 96700" }), envOverrides: { LOCATIONIQ_KEY: "iq-key" } });
    expect(await row(old)).toMatchObject({ lat: 20.3, lon: -155.3, geo_source: "lookup" });
    vi.stubGlobal("fetch", iq.fn);
    // no key: nothing is asked
    const quiet = await item({ kind: "restaurant", name: "The Table", place: "5 Example Ave, Exampleville, HI 96700" });
    expect(await row(quiet)).toMatchObject({ lat: null, geo_source: null });
    expect(iq.asked).toHaveLength(2);
  });

  it("the cron fills in a few at a time, waits 30 days after nothing was found, and stops when LocationIQ can't answer", async () => {
    const ids = [];
    for (const n of [1, 2, 3, 4]) ids.push(await item({ kind: "event", name: `Example Show ${n}`, place: `${n} Example Ave, Exampleville, HI 96700` }));
    const iq = fakeIq({ "Example Show 4, 4 Example Ave, Exampleville, HI 96700": { lat: "20.4", lon: "-155.4" } });
    expect(await locateSome({ ...env } as Env, iq.fn)).toEqual({});                    // no key, nothing
    const first = await locateSome(IQ, iq.fn);
    expect(first).toEqual({ [`booking ${ids[3]}`]: "found", [`booking ${ids[2]}`]: "not found", [`booking ${ids[1]}`]: "not found" });
    expect(await locateSome(IQ, iq.fn)).toEqual({ [`booking ${ids[0]}`]: "not found" });
    expect(await locateSome(IQ, iq.fn)).toEqual({});                                     // the rest wait 30 days
    await db.prepare("UPDATE trip_items SET geo_tried_at = NULL").run();
    expect(await locateSome(IQ, fakeIq({ "Example Show 3, 3 Example Ave, Exampleville, HI 96700": 429 }).fn)).toEqual({ [`booking ${ids[2]}`]: "unavailable" });
  });
});
