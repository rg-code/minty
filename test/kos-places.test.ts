import { describe, expect, it } from "vitest";
import decodingCsv from "./fixtures/olc-decoding.csv?raw";
import shortCsv from "./fixtures/olc-short.csv?raw";
import { decodePlus, parseWhere, recoverPlus } from "../public/kos/where.js";
import { resolvePlaceLink } from "../src/routes/kos";
import { readShare, reportMail, shareLink, shareString } from "../public/kos/store.js";

// Kos: places on a day (docs/trips.md §22) and sharing a trip (§23).
const rows = (csv: string) => csv.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
const airports = { HND: ["Tokyo Haneda International Airport", "Tokyo", "JP", 35.5523, 139.7798] };

describe("plus codes, against Google's own test data (open-location-code, Apache 2.0)", () => {
  it("decodes every code to its area", () => {
    for (const l of rows(decodingCsv)) {
      const [code, , latLo, lngLo, latHi, lngHi] = l.split(",");
      const d = decodePlus(code);
      for (const [got, want] of [[d.latLo, latLo], [d.lngLo, lngLo], [d.latHi, latHi], [d.lngHi, lngHi]] as [number, string][]) expect(Math.abs(got - Number(want)), code).toBeLessThan(1e-9);
    }
  });
  it("recovers short codes from a reference point", () => {
    for (const l of rows(shortCsv)) {
      const [full, lat, lng, short, type] = l.split(",");
      if (/[RB]/.test(type)) expect(recoverPlus(short, Number(lat), Number(lng)), short).toBe(full);
    }
  });
});

describe("one box for where a place is (no lookup service)", () => {
  it("reads a short plus code near a city it names, a full one, coordinates and a long Google Maps link, which agree", () => {
    const short = parseWhere("PRF9+WQ Sumida City, Tokyo, Japan", { airports });
    expect(short).toMatchObject({ how: "a plus code", label: "Sumida City, Tokyo, Japan" });
    expect(short.near).toMatch(/km from Tokyo/);
    const full = parseWhere("8Q7XPRF9+WQ");
    const link = parseWhere("https://www.google.com/maps/place/Tobu+Museum/@35.7279197,139.4035807,11z/data=!4m7!3m6!1s0x0:0x0!8m2!3d35.7247828!4d139.8194468!15s");
    expect(link).toMatchObject({ how: "a Google Maps link", label: "Tobu Museum", lat: 35.724783, lon: 139.819447 });   // the place, not the map's centre
    for (const w of [short, full]) { expect(Math.abs(w.lat - link.lat)).toBeLessThan(0.0002); expect(Math.abs(w.lon - link.lon)).toBeLessThan(0.0002); }
    expect(parseWhere("35.7101, 139.8107")).toMatchObject({ lat: 35.7101, lon: 139.8107 });
    expect(parseWhere("35°43′29.2″N 139°49′10.0″E").lat).toBeCloseTo(35.72478, 4);
  });
  it("a short code: near a city it names first, else the trip's own places (and it says which); with neither, it asks", () => {
    const near = parseWhere("PRF9+WQ", { refs: [{ lat: 35.69, lon: 139.70, name: "Hotel Kinokuni" }] });
    expect(near.near).toMatch(/km from Hotel Kinokuni/);
    // a trip in Paris, but the code names Tokyo: Tokyo wins
    const named = parseWhere("PRF9+WQ Sumida City, Tokyo", { refs: [{ lat: 48.85, lon: 2.35, name: "Paris" }], airports });
    expect(named.near).toMatch(/km from Tokyo/);
    expect(named.lat).toBeCloseTo(35.7248, 3);
    expect(parseWhere("PRF9+WQ").error).toMatch(/needs to know roughly where/);
  });
  it("a short Google link needs following; an address stays an address; what3words isn't read", () => {
    expect(parseWhere("https://maps.app.goo.gl/ENpP2zPjiMDW8pNA9")).toEqual({ shortLink: "https://maps.app.goo.gl/ENpP2zPjiMDW8pNA9" });
    expect(parseWhere("4 Chome-28-16 Higashimukojima, Sumida City, Tokyo 131-0032, Japan")).toEqual({ address: "4 Chome-28-16 Higashimukojima, Sumida City, Tokyo 131-0032, Japan" });
    expect(parseWhere("///filled.count.soap").error).toMatch(/what3words/);
    expect(parseWhere("https://example.com/somewhere").error).toMatch(/doesn't say where/);
  });
});

describe("following a Google Maps short link (the Worker, on a Minty)", () => {
  const req = (url: unknown) => new Request("https://x/trips/place-link", { method: "POST", body: JSON.stringify({ url }), headers: { "content-type": "application/json" } });
  const hops = (...locations: string[]) => { let n = 0; const asked: string[] = []; const f = (async (u: string) => { asked.push(String(u)); const loc = locations[n++]; return new Response(null, loc ? { status: 302, headers: { location: loc } } : { status: 200 }); }) as unknown as typeof fetch; return { f, asked }; };
  it("returns the Google Maps address the link goes to, and only follows Google", async () => {
    const { f, asked } = hops("https://www.google.com/maps/place/Tobu+Museum/@35.72,139.40,11z/data=!3d35.7247828!4d139.8194468");
    const r = await resolvePlaceLink(req("https://maps.app.goo.gl/ENpP2zPjiMDW8pNA9"), f);
    expect((await r.json() as any).url).toMatch(/^https:\/\/www\.google\.com\/maps\/place\/Tobu/);
    expect(asked).toEqual(["https://maps.app.goo.gl/ENpP2zPjiMDW8pNA9"]);
    await expect(resolvePlaceLink(req("https://evil.example/x"), hops().f)).rejects.toThrow(/only a Google Maps short link/);
    await expect(resolvePlaceLink(req("https://maps.app.goo.gl/abc"), hops("https://evil.example/").f)).rejects.toThrow(/somewhere other than Google Maps/);
    await expect(resolvePlaceLink(req("https://maps.app.goo.gl/abc"), hops().f)).rejects.toThrow(/didn't say where/);
  });
});

describe("sharing one trip (a link with it inside)", () => {
  const trip = { id: 7, code: "k7f3x9p2ad", name: "Tokyo", start_date: "2027-03-10", end_date: "2027-03-18", place: "Tokyo, Japan", travellers: ["me"], notes: "private",
    items: [{ id: 3, trip_id: 7, kind: "lodging", name: "Hotel", start_at: "2027-03-10", end_at: "2027-03-14", confirmation: "ABC123", price_cents: 88000, currency: "JPY", guest: "Morgan" },
            { id: 4, trip_id: 7, kind: "event", name: "Skytree", start_at: "2027-03-12T10:00", lat: 35.7101, lon: 139.8107 }] };
  it("round-trips the trip, without its code, travellers, notes or (unless asked) its private details", async () => {
    const s = await shareString(trip);
    expect(s).toMatch(/^1\.[A-Za-z0-9_-]+$/);
    const back = await readShare(shareLink(s));
    expect(back.trips[0]).toEqual({ name: "Tokyo", start_date: "2027-03-10", end_date: "2027-03-18", place: "Tokyo, Japan", id: 1, travellers: [] });
    expect(back.items).toEqual([{ kind: "lodging", name: "Hotel", start_at: "2027-03-10", end_at: "2027-03-14", trip_id: 1 },
                                { kind: "event", name: "Skytree", start_at: "2027-03-12T10:00", lat: 35.7101, lon: 139.8107, trip_id: 1 }]);
    const withPrivate = await readShare(await shareString(trip, { withPrivate: true }));
    expect(withPrivate.items[0]).toMatchObject({ confirmation: "ABC123", price_cents: 88000, guest: "Morgan" });
  });
  it("refuses anything else", async () => {
    await expect(readShare("hello")).rejects.toThrow(/isn't a shared Kos trip/);
    await expect(readShare("t=1.AAAAAAAAAAAAAAAA")).rejects.toThrow(/damaged/);
  });
});

describe("send to the Kos developers (a mailto: from the person's own mail app)", () => {
  const trip = { name: "Tokyo", start_date: "2027-03-10", end_date: "2027-03-18", place: "Tokyo, Japan" };
  it("addresses the email, with the note and the trip's link written in", () => {
    const m = reportMail({ to: "kos-reports@example.com", trip, link: "https://minty.milesmaximizer.com/kos/#/import?t=1.abc", note: "The check-out day is wrong." });
    const u = new URL(m.href);
    expect(u.protocol).toBe("mailto:");
    expect(u.pathname).toBe("kos-reports@example.com");
    expect(u.searchParams.get("subject")).toBe("Kos trip with a problem: Tokyo");
    const body = u.searchParams.get("body")!;
    expect(body.startsWith("The check-out day is wrong.")).toBe(true);
    expect(body).toContain("Open it in Kos: https://minty.milesmaximizer.com/kos/#/import?t=1.abc");
    expect(m.tooLong).toBe(false);
  });
  it("to be featured: its own subject, and the person's permission written in", () => {
    const m = reportMail({ to: "kos-reports@example.com", trip, link: "https://minty.milesmaximizer.com/kos/#/import?t=1.abc", why: "feature" });
    const u = new URL(m.href);
    expect(u.searchParams.get("subject")).toBe("Kos trip to feature: Tokyo");
    expect(u.searchParams.get("body")).toContain("You may feature this trip in Kos");
    expect(new URL(reportMail({ to: "a@b.co", trip, link: "x" }).href).searchParams.get("subject")).toBe("Kos trip with a problem: Tokyo");
  });
  it("leaves out a link too long for some mail apps, and says to paste it", () => {
    const m = reportMail({ to: "kos-reports@example.com", trip, link: `https://minty.milesmaximizer.com/kos/#/import?t=1.${"a".repeat(3000)}` });
    expect(m.tooLong).toBe(true);
    expect(m.href.length).toBeLessThan(2000);
    expect(new URL(m.href).searchParams.get("body")).toContain("paste it here");
  });
});

