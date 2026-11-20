import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { greatCircle, latinLabels } from "../public/kos/map.js";
import { nightStyle } from "../public/kos/map-style.js";

// The Kos app (public/kos/, docs/trips.md): its map helpers, and the page as served.
describe("the map", () => {
  it("a great circle across the date line is one unbroken line", () => {
    const line = greatCircle([-122.375, 37.62], [140.389, 35.769], 32);
    expect(line).toHaveLength(33);
    for (let i = 1; i < line.length; i++) expect(Math.abs(line[i][0] - line[i - 1][0])).toBeLessThan(20);
    expect(line.at(-1)[0]).toBeCloseTo(140.389 - 360, 2);                     // unwrapped west, past -180
    expect(Math.max(...line.map((p) => p[1]))).toBeGreaterThan(45);             // it bends north, over the Pacific
  });
  it("labels keep their Latin name (OpenFreeMap's fonts have no CJK); the night style recolours", () => {
    const both = ["case", ["has", "name:nonlatin"], ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]], ["coalesce", ["get", "name_en"], ["get", "name"]]];
    const style = { layers: [{ id: "label_city", type: "symbol", layout: { "text-field": both }, paint: {} }, { id: "water", type: "fill", paint: { "fill-color": "#9cf" } }] };
    expect(latinLabels(style).layers[0].layout["text-field"]).toEqual(["coalesce", ["get", "name:latin"], ["get", "name"]]);
    expect(nightStyle(style).layers[1].paint["fill-color"]).toBe("#0e1b2c");
  });
});

describe("the page", () => {
  const raw = (p: string) => SELF.fetch(`https://minty.example.workers.dev${p}`);
  it("is its own installable app, with no inline scripts", async () => {
    const html = await (await raw("/kos/")).text();
    expect(html).toContain('<link rel="manifest" href="/kos/manifest.webmanifest" crossorigin="use-credentials" />');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(html).toContain('<script src="/lock.js"></script>');                 // the device lock, as on every page with data
    const m = await (await raw("/kos/manifest.webmanifest")).json() as any;
    expect(m).toMatchObject({ id: "/kos/", start_url: "/kos/", scope: "/kos/", name: "Kos" });
    const sw = await (await raw("/kos/sw.js")).text();
    expect(sw).toContain('const CACHE = "kos-v3"');
    expect(sw).toContain('"/kos/journal.js"');
    // its icon (the owner's, 2026-11-20): PNGs only, the old SVG gone
    expect(html).toContain('<link rel="icon" href="/kos/icon-64.png" type="image/png" />');
    expect(m.icons.map((i: any) => i.src)).toEqual(["/kos/icon-192.png", "/kos/icon-512.png", "/kos/maskable-512.png"]);
    for (const f of ["icon-64.png", "icon-192.png", "icon-512.png", "maskable-512.png", "apple-touch-icon.png"]) expect((await raw(`/kos/${f}`)).headers.get("content-type"), f).toContain("image/png");
    expect((await raw("/kos/icon.svg")).status).toBe(404);
    expect(sw).toContain('"/kos/gmail.js"');
    // Share to Kos (Android's share menu, once installed): sw.js takes the POST and keeps it on the device
    expect(m.share_target).toMatchObject({ action: "/kos/share", method: "POST", enctype: "multipart/form-data" });
    expect(m.share_target.params.files[0].accept).toEqual(expect.arrayContaining(["application/pdf", "image/*", "message/rfc822"]));
    expect(sw).toContain('url.pathname === "/kos/share"');
    expect(sw).toContain('k.startsWith("kos-")');                               // never deletes Minty's cache
    expect(await (await raw("/sw.js")).text()).toContain('k.startsWith("minty-")'); // and Minty's never deletes Kos's
  });
  it("its policy allows OpenFreeMap (and, for Kos's pages, the person's own Gmail script) and nothing else; the dashboard's doesn't", async () => {
    for (const p of ["/kos/", "/kos/kos.js", "/vendor/maplibre/maplibre-gl-csp-worker.js"]) {
      const csp = (await raw(p)).headers.get("content-security-policy") ?? "";
      expect(csp, p).toContain(p.startsWith("/kos/")
        ? "connect-src 'self' https://tiles.openfreemap.org https://tiles.maps.eox.at https://script.google.com https://script.googleusercontent.com;"
        : "connect-src 'self' https://tiles.openfreemap.org https://tiles.maps.eox.at;");
      expect(csp, p).toContain("img-src 'self' data: blob: https://tiles.openfreemap.org https://tiles.maps.eox.at;");   // the journal's satellite (EOX)
      expect(csp, p).toContain("script-src 'self';");
      expect(csp.match(/default-src/g), p).toHaveLength(1);
    }
    expect((await raw("/")).headers.get("content-security-policy")).not.toContain("openfreemap");
  });
  it("the QR library is vendored (no CDN), loaded only by the Gmail set-up page, with no eval", async () => {
    const r = await raw("/vendor/qrcode/qrcode.mjs");
    expect(r.status).toBe(200);
    const js = await r.text();
    expect(js).toContain("export const qrcode");
    expect(js).not.toMatch(/\beval\(|new Function\(/);
    expect(await (await raw("/kos/kos.js")).text()).toContain('import("/vendor/qrcode/qrcode.mjs")');
  });
  it("airports are there, by IATA code", async () => {
    const a = await (await raw("/kos/airports.json")).json() as Record<string, [string, string, string, number, number]>;
    expect(Object.keys(a).length).toBeGreaterThan(2500);
    expect(a.NRT[2]).toBe("JP");
    expect(a.SFO[3]).toBeCloseTo(37.62, 1);
  });
});

describe("Kos was JET (until 2026-11-20)", () => {
  const raw = (p: string) => SELF.fetch(`https://minty.example.workers.dev${p}`, { redirect: "manual" });
  it("the old address redirects, keeping the path (public/_redirects)", async () => {
    for (const [from, to] of [["/jet", "/kos/"], ["/jet/", "/kos/"], ["/jet/kos.js", "/kos/kos.js"]]) {
      const r = await raw(from);
      expect(r.status, from).toBe(301);
      expect(new URL(r.headers.get("location")!, "https://x").pathname, from).toBe(to);
    }
  });
  it("what a browser kept under the old names comes across once; an old export still imports", async () => {
    const { carryOverOldNames, importFile } = await import("../public/kos/store.js");
    const m = new Map<string, string>([["jet-gmail", "{\"url\":1}"], ["jet-gmail-seen", "[\"m1\"]"], ["kos-sample", "new"], ["jet-sample", "old"]]);
    const ls = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    carryOverOldNames(ls);
    expect(Object.fromEntries(m)).toEqual({ "kos-gmail": "{\"url\":1}", "kos-gmail-seen": "[\"m1\"]", "kos-sample": "new" });   // a newer kos- one wins
    expect(importFile({ app: "JET", version: 1, trips: [], items: [] })).toEqual({ trips: [], items: [] });
  });
});

describe("Kos on its own: set-up first, the device lock last (docs/trips.md §17.4)", () => {
  it("lock.js says Kos and trips there, and never offers itself on arrival; Minty's offer is unchanged", async () => {
    const js = await (await SELF.fetch("https://minty.example.workers.dev/lock.js")).text();
    expect(js).toContain('const KOS = window.KOS_MODE === "device";');
    expect(js).toContain('if (KOS && !(st && st.state === "on")) return;');
    expect(js).toContain("Lock Kos on this device?");
    expect(js).toContain('show(st && st.state === "on" ? "unlock" : "setup")');            // Minty: unset = offer it
    const kos = await (await SELF.fetch("https://minty.example.workers.dev/kos/kos.js")).text();
    expect(kos).toContain(`<section class="welcome">`);                                     // a newcomer's first screen
    expect(kos).toContain("Set it up in four steps");
    expect(kos).toContain("Every trip,<br />in one place.");
    expect(kos).toContain('Kos <span>by</span> <a href="https://minty.milesmaximizer.com/');
    expect(kos).toContain('href="https://ko-fi.com/mintyme"');
    expect(kos).toContain('href="https://github.com/rg-code/minty"');
    // taps are counted only where GoatCounter is on the page (the landing site's build); a Minty has none
    expect(kos).toContain("if (el && window.goatcounter?.count)");
    const page = await (await SELF.fetch("https://minty.example.workers.dev/kos/")).text();
    expect(page).not.toMatch(/goatcounter|gc\.zgo\.at/);
    expect((await SELF.fetch("https://minty.example.workers.dev/kos/")).headers.get("content-security-policy")).not.toContain("goatcounter");
    expect(kos).toContain("Last: lock Kos on this device.");
  });
});

describe("the trip journal (public/kos/journal.js, map-style.js)", () => {
  const airports = { SFO: ["San Francisco Intl", "San Francisco", "US", 37.62, -122.38], NRT: ["Narita Intl", "Tokyo", "JP", 35.77, 140.39] };
  it("its cover numbers: days, nights, flights, km flown, countries, places", async () => {
    const { tripStats } = await import("../public/kos/journal.js");
    const st = tripStats({ start_date: "2027-03-10", end_date: "2027-03-17", items: [
      { kind: "flight", dep_airport: "SFO", arr_airport: "NRT" }, { kind: "flight", dep_airport: "NRT", arr_airport: "SFO" },
      { kind: "lodging", name: "Hotel" }, { kind: "restaurant", name: "Sushi" }, { kind: "restaurant", name: "sushi" }] }, airports);
    expect(st).toMatchObject({ days: 8, nights: 7, flights: 2, countries: 2, places: 2 });
    expect(st.km).toBeGreaterThan(16000); expect(st.km).toBeLessThan(17000);                     // about 8,200 km each way
  });
  it("a line for each booking, and each day's spending", async () => {
    const { lineFor, daySpend } = await import("../public/kos/journal.js");
    expect(lineFor({ item: { kind: "flight", dep_airport: "SFO", arr_airport: "NRT", airline: "UA", flight_number: "837" } }, airports)).toBe("Flew San Francisco → Tokyo on UA 837");
    expect(lineFor({ item: { kind: "lodging", name: "Hotel Kinokuni" }, role: "Check in" })).toBe("Checked in at Hotel Kinokuni");
    expect(lineFor({ item: { kind: "lodging", name: "Hotel Kinokuni" }, role: "Check out" })).toBe("Checked out of Hotel Kinokuni");
    expect(lineFor({ item: { kind: "restaurant", name: "Sushi Mitsuba" }, at: "19:30" })).toBe("Dinner at Sushi Mitsuba");
    expect(lineFor({ item: { kind: "restaurant", name: "Cafe" }, at: "08:00" })).toBe("Breakfast at Cafe");
    expect(lineFor({ item: { kind: "train", name: "Odakyu Romancecar" } })).toBe("Took Odakyu Romancecar");
    const rows = [{ date: "2027-03-12", amount: 85, name: "SUSHI", merchant_name: "Sushi Example" }, { date: "2027-03-12", amount: 12.5, name: "SUICA", merchant_name: null },
                  { date: "2027-03-12", amount: -500, name: "PAYMENT" }, { date: "2027-03-13", amount: 42, name: "UNIQLO" }];
    expect(daySpend(rows, "2027-03-12")).toEqual({ cents: 9750, top: ["Sushi Example", "SUICA"] });
  });
  it("the satellite map: EOX's imagery under the style's place names and borders only, with EOX's credit", async () => {
    const { satelliteStyle, EOX } = await import("../public/kos/map-style.js");
    const style = { sources: { openmaptiles: { type: "vector" }, ne2_shaded: { type: "raster" } }, layers: [
      { id: "water", type: "fill", "source-layer": "water" }, { id: "boundary_2", type: "line", "source-layer": "boundary", paint: {} },
      { id: "label_city", type: "symbol", "source-layer": "place", paint: {} }, { id: "road_label", type: "symbol", "source-layer": "transportation_name", paint: {} }] };
    const sat = satelliteStyle(style);
    expect(sat.layers.map((l: any) => l.id)).toEqual(["eox-satellite", "boundary_2", "label_city"]);
    expect(Object.keys(sat.sources)).toEqual(["openmaptiles", "eox"]);
    expect(sat.sources.eox.tiles[0]).toMatch(/^https:\/\/tiles\.maps\.eox\.at\//);
    expect(EOX.attribution).toContain("Sentinel-2 cloudless - https://s2maps.eu");
    expect(EOX.attribution).toContain("Contains modified Copernicus Sentinel data");
  });
  it("an export carries the journal's notes, and an import re-ties them to their trips", async () => {
    const { exportFile, importFile } = await import("../public/kos/store.js");
    const file = exportFile({ trips: [{ id: 4, name: "Lisbon", start_date: "2027-05-01", end_date: "2027-05-05", travellers: [], items: [] }], unassigned: [] },
                            [{ trip_id: 4, day: "trip", text: "Lovely" }, { trip_id: 4, day: "not a day", text: "x" }]);
    expect(importFile(JSON.parse(JSON.stringify(file))).notes).toEqual([{ oldTrip: 4, day: "trip", text: "Lovely" }]);
  });
});

describe("the trip's summary strip", () => {
  it("counts each kind (a bus as a train, anything else as other), and the money: spending on a Minty, prices on its own", async () => {
    const { tripSummary } = await import("../public/kos/store.js");
    const t = { spent_cents: 79256, transactions: 6, items: [
      { kind: "flight", price_cents: 41260, currency: "USD" }, { kind: "flight" }, { kind: "lodging", price_cents: 53800, currency: "USD" },
      { kind: "bus" }, { kind: "train", price_cents: 4200, currency: "EUR" }, { kind: "car" }, { kind: "boat" }] };
    const m = tripSummary(t, true);
    expect(m.count).toEqual({ flight: 2, lodging: 1, car: 1, train: 2, restaurant: 0, event: 0, other: 1 });
    expect(m.money).toEqual({ spent: 79256, transactions: 6 });
    expect(tripSummary(t, false).money).toEqual({ booked: { USD: 95060, EUR: 4200 } });
  });
});

describe("Gmail pull (public/kos/gmail.js)", () => {
  it("takes only an Apps Script web app's address, and writes the key into a read-only script", async () => {
    const g = await import("../public/kos/gmail.js");
    expect(g.isWebApp("https://script.google.com/macros/s/AKfycbx1234567890abcdefghij/exec")).toBe(true);
    for (const bad of ["http://script.google.com/macros/s/AKfycbx1234567890abcdefghij/exec", "https://script.google.com.evil.example/macros/s/AKfycbx1234567890abcdefghij/exec",
      "https://script.google.com/macros/s/AKfycbx1234567890abcdefghij/dev", "https://example.com/exec", ""]) expect(g.isWebApp(bad), bad).toBe(false);
    const key = g.newKey();
    expect(key).toMatch(/^[0-9a-f]{48}$/);
    const code = g.script(key);
    expect(code).toContain(`const KEY = "${key}";`);
    expect(code).toContain('e.parameter.key !== KEY');
    expect(code).not.toMatch(/GmailApp\.(send|move|mark|delete|create)|addLabel|UrlFetchApp|MailApp/);  // it only reads
    expect(JSON.parse(g.MANIFEST).oauthScopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  });
  it("the phone link carries the address and the key after a #, and reads back; anything else is refused", async () => {
    const g = await import("../public/kos/gmail.js");
    const url = "https://script.google.com/macros/s/AKfycbx1234567890abcdefghij/exec", key = g.newKey();
    const link = g.linkFor("https://kos.example", url, key);
    expect(link).toMatch(/^https:\/\/kos\.example\/kos\/#\/gmail\?connect=[\w-]+$/);   // nothing before the # but the page
    expect(g.readLink(link)).toEqual({ url, key });
    expect(g.readLink(link.split("connect=")[1])).toEqual({ url, key });                 // the code alone
    expect(g.readLink(g.linkFor("https://kos.example", "https://evil.example/exec", key))).toBe(null);
    expect(g.readLink(g.linkFor("https://kos.example", url, "short"))).toBe(null);
    expect(g.readLink("not a link")).toBe(null);
  });
  it("a raw message becomes its bytes: one per character, or UTF-8 when there's a wide one", async () => {
    const { rawBytes } = await import("../public/kos/gmail.js");
    expect([...rawBytes("A\u00e9")]).toEqual([65, 0xe9]);
    expect([...rawBytes("A\u2192")]).toEqual([65, 0xe2, 0x86, 0x92]);
  });
});

describe("Kos on its own (public/kos/store.js)", () => {
  it("checks a trip and a booking as the server does", async () => {
    const { checkItem, checkTrip } = await import("../public/kos/store.js");
    expect(checkTrip({ name: " Lisbon ", start_date: "2027-05-01", end_date: "2027-05-05" })).toMatchObject({ name: "Lisbon", travellers: [] });
    expect(() => checkTrip({ name: "x", start_date: "2027-05-05", end_date: "2027-05-01" })).toThrow(/can't be before/);
    expect(checkItem({ kind: "flight", airline: "tp", dep_airport: "ewr", arr_airport: "LIS", start_at: "2027-05-01T21:20" }))
      .toMatchObject({ airline: "TP", dep_airport: "EWR", arr_airport: "LIS", source: "typed" });
    expect(() => checkItem({ kind: "boat" })).toThrow(/kind/);
    expect(() => checkItem({ kind: "flight", dep_airport: "LISBON" })).toThrow(/airport/);
    expect(() => checkItem({ kind: "event", start_at: "soon" })).toThrow(/date and time/);
  });
  it("exports every trip and booking, and imports only Kos's own files, re-tying bookings to their trips", async () => {
    const { exportFile, importFile } = await import("../public/kos/store.js");
    const list = { trips: [{ id: 7, name: "Lisbon", start_date: "2027-05-01", end_date: "2027-05-05", travellers: [], items: [{ id: 3, trip_id: 7, kind: "lodging", name: "Hotel" }], transactions: 0, spent_cents: 0 }],
                   unassigned: [{ id: 4, trip_id: null, kind: "event", name: "Later" }] };
    const file = exportFile(list);
    expect(file).toMatchObject({ app: "Kos", version: 1 });
    expect(file.trips[0]).not.toHaveProperty("items");
    expect(file.items.map((i: any) => i.id)).toEqual([3, 4]);
    const back = importFile(JSON.parse(JSON.stringify(file)));
    expect(back.trips.map((t: any) => t.old)).toEqual([7]);
    expect(back.items.map((i: any) => [i.oldTrip, i.item.name, i.item.trip_id])).toEqual([[7, "Hotel", null], [null, "Later", null]]);
    expect(() => importFile({ app: "Other", version: 1, trips: [], items: [] })).toThrow(/isn't a Kos export/);
  });
  it("the sample trips move to today: dates and times shift by whole days, keeping their time and offset", async () => {
    const { shiftSample, importFile } = await import("../public/kos/store.js");
    const file = { app: "Kos", version: 1, sample_from: "2026-01-15",
      trips: [{ id: 3, name: "Tokyo", start_date: "2026-02-08", end_date: "2026-02-16", travellers: [] }],
      items: [{ id: 9, trip_id: 3, kind: "flight", airline: "UA", start_at: "2026-02-07T11:05-08:00", end_at: "2026-02-08T15:00+09:00" }, { id: 10, trip_id: null, kind: "event", start_at: null }] };
    const moved = shiftSample(file, "2026-11-19");                                        // 308 days later
    expect(moved.trips[0]).toMatchObject({ start_date: "2026-12-13", end_date: "2026-12-21" });
    expect(moved.items.map((i: any) => [i.start_at, i.end_at])).toEqual([["2026-12-12T11:05-08:00", "2026-12-13T15:00+09:00"], [null, undefined]]);
    expect(file.trips[0].start_date).toBe("2026-02-08");                                  // the file itself is left as it was
    expect(importFile(moved).items[0].oldTrip).toBe(3);                                     // and it imports as an export does
  });
  it("on a Minty it's in Minty mode; the standalone build sets device mode", async () => {
    const raw = (p: string) => SELF.fetch(`https://minty.example.workers.dev${p}`);
    expect(await (await raw("/kos/mode.js")).text()).toContain('window.KOS_MODE = "minty";');
    const html = await (await raw("/kos/")).text();
    expect(html.indexOf('/kos/mode.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/kos/mode.js')).toBeLessThan(html.indexOf('/kos/kos.js'));
  });
});
