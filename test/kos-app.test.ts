import { describe, expect, it, vi } from "vitest";
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
    expect(sw).toContain('const CACHE = "kos-v4"');
    expect(sw).toContain('"/kos/where.js"');
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
        ? "connect-src 'self' https://tiles.openfreemap.org https://en.wikipedia.org https://script.google.com https://script.googleusercontent.com;"
        : "connect-src 'self' https://tiles.openfreemap.org;");
      expect(csp, p).toContain(p.startsWith("/kos/")                                          // a trip's city photo (Wikimedia), only on Kos's pages
        ? "img-src 'self' data: blob: https://tiles.openfreemap.org https://upload.wikimedia.org https://thumb.wikimedia.org;"
        : "img-src 'self' data: blob: https://tiles.openfreemap.org;");
      expect(csp, p).not.toContain("eox");
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

describe("backups and the theme (docs/trips.md §17.5)", () => {
  it("the backup reminder: own trips not backed up (or made) in 30 days, unless snoozed", async () => {
    const { backupDue } = await import("../public/kos/store.js");
    const now = Date.parse("2026-11-20T12:00:00Z"), day = 864e5;
    expect(backupDue({ now, backedUp: 0, oldestOwn: 0, snoozedUntil: 0 })).toBe(false);                 // no trips of one's own
    expect(backupDue({ now, backedUp: 0, oldestOwn: now - 10 * day, snoozedUntil: 0 })).toBe(false);    // made 10 days ago
    expect(backupDue({ now, backedUp: 0, oldestOwn: now - 40 * day, snoozedUntil: 0 })).toBe(true);     // 40 days, never backed up
    expect(backupDue({ now, backedUp: now - 5 * day, oldestOwn: now - 400 * day, snoozedUntil: 0 })).toBe(false);
    expect(backupDue({ now, backedUp: now - 31 * day, oldestOwn: now - 400 * day, snoozedUntil: 0 })).toBe(true);
    expect(backupDue({ now, backedUp: now - 31 * day, oldestOwn: now - 400 * day, snoozedUntil: now + day })).toBe(false);
  });
  it("Kos is light by default, and its theme button is an airplane window with a shutter", async () => {
    expect(await (await SELF.fetch("https://minty.example.workers.dev/kos/theme.js")).text()).toContain('|| "light";');
    const html = await (await SELF.fetch("https://minty.example.workers.dev/kos/")).text();
    expect(html).toMatch(/id="themeBtn"[^>]*><svg class="win"/);
    expect(html).toContain('class="win-shade"');
  });
});

describe("trip codes and addresses (docs/trips.md §21)", () => {
  it("codes are 10 characters without look-alikes; a trip's address is the person's Gmail with +code", async () => {
    const { newTripCode, isTripCode, tripAddress } = await import("../public/kos/store.js");
    const many = Array.from({ length: 300 }, () => newTripCode());
    expect(many.every(isTripCode)).toBe(true);
    expect(new Set(many).size).toBe(300);
    expect(many.join("")).not.toMatch(/[01ilo]/);
    for (const bad of ["k7f3x9p2a", "k7f3x9p2adx", "K7F3X9P2AD", "k7f3x9p2a0", "k7f3x9p2al"]) expect(isTripCode(bad), bad).toBe(false);
    expect(tripAddress("k7f3x9p2ad", "ourminty@gmail.com")).toBe("ourminty+k7f3x9p2ad@gmail.com");
    expect(tripAddress("k7f3x9p2ad", "ourminty+kos@gmail.com")).toBe("ourminty+k7f3x9p2ad@gmail.com");   // its own + replaced
    expect(tripAddress("k7f3x9p2ad", "")).toBe("+k7f3x9p2ad");
  });
  it("a booking with no trip address goes in the one trip its dates fall in (§21.1)", async () => {
    const { tripFor } = await import("../public/kos/store.js");
    const lisbon = { id: 1, start_date: "2027-03-10", end_date: "2027-03-15" }, tokyo = { id: 2, start_date: "2027-04-02", end_date: "2027-04-09" };
    const trips = [lisbon, tokyo];
    expect(tripFor("2027-03-12T19:30", trips)).toBe(lisbon);
    expect(tripFor("2027-03-15", trips)).toBe(lisbon);                 // the last day
    expect(tripFor("2027-04-01T22:10", trips)).toBe(tokyo);            // the flight out the night before
    expect(tripFor("2027-03-20", trips)).toBeNull();                   // between trips: waits for one
    expect(tripFor(null, trips)).toBeNull();
    expect(tripFor("2027-03-12", [...trips, { id: 3, start_date: "2027-03-11", end_date: "2027-03-13" }])).toBeNull();   // overlapping: the person picks
  });
  it("the Gmail script reads the label or a trip's address, says which trip, and checks the codes it's given", async () => {
    const g = await import("../public/kos/gmail.js");
    const code = g.script(g.newKey());
    expect(code).toContain("const CODE = /^[2-9a-hjkmnp-z]{10}$/;");
    expect(code).toContain('filter(function (c) { return CODE.test(c); }).slice(0, 40)');
    expect(code).toContain('sentTo.indexOf("+" + c + "@")');
    expect(code).toContain("trip: trip");
    expect(code).not.toMatch(/GmailApp\.(send|move|mark|delete|create)|addLabel|UrlFetchApp|MailApp/);    // still only reads
  });
  it("on a Minty, the script's Bills view returns the Bills label's emails as text and PDFs, still only reading (docs/bills.md)", async () => {
    const g = await import("../public/kos/gmail.js");
    const code = g.script(g.newKey(), "Kos", true);
    expect(code).toContain("|| /\\.pdf$/i.test(a.getName())");
    expect(code).toContain('if (e.parameter.view === "bills") return out({ view: "bills", messages: bills(skip, String(e.parameter.address || "")');
    expect(code).toContain('const BILLS = ["Bills", "Bill"];');
    expect(code).toContain('terms.push("to:" + p[0] + "+bills@" + p[1]);');
    expect(code).toContain('GmailApp.search("newer_than:90d {" + terms.join(" ") + "}", 0, 30)');
    expect(code).toContain("getAttachments({ includeInlineImages: false })");
    expect(code).toContain("a.getSize() <= 5000000");
    expect(code).not.toMatch(/GmailApp\.(send|move|mark|delete|create)|addLabel|UrlFetchApp|MailApp|DriveApp/);
    expect(() => new Function(code)).not.toThrow();
    // Kos on its own has no Bills: its script never reads a Bills label
    const alone = g.script(g.newKey());
    expect(alone).not.toMatch(/bills\(|BILLS|Bills/);
    expect(() => new Function(alone)).not.toThrow();
  });
  it("Bills by email: a complete new bill is added, an incomplete one listed, card statements and known ones left (splitBills)", async () => {
    const { splitBills } = await import("../public/kos/store.js");
    const pge = { file: "pge.pdf", sha: "a", biller: "PG&E", amount_cents: 12033, due_date: "2026-12-05" };
    const out = splitBills([pge, { ...pge, sha: "b", due_date: null }, { ...pge, sha: "c", biller: null }, { ...pge, sha: "d", amount_cents: null },
                            { ...pge, sha: "e", card: true }, { ...pge, sha: "f", known: true }, { file: "x.pdf", sha: "g", error: "Couldn't read this PDF" },
                            { ...pge, sha: "h", amount_cents: 0 }]);
    expect(out.add.map((r: any) => r.sha)).toEqual(["a", "h"]);                  // a $0 bill is still a bill
    expect(out.incomplete.map((r: any) => r.sha)).toEqual(["b", "c", "d"]);
    expect(out.cards.map((r: any) => r.sha)).toEqual(["e"]);
    expect(out.known.map((r: any) => r.sha)).toEqual(["f"]);
    expect(out.unreadable.map((r: any) => r.sha)).toEqual(["g"]);
  });
  it("pullBills asks with view=bills, decodes the PDFs, and leaves out what Bills already offered", async () => {
    const store = new Map<string, string>();
    const was = (globalThis as any).localStorage;
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    try {
      const g = await import("../public/kos/gmail.js");
      await expect(g.pullBills()).rejects.toThrow(/isn't set up/);
      g.save("https://script.google.com/macros/s/AKfycbx_example_deployment_id_1234/exec");
      const asked: string[] = [];
      let reply: any = { view: "bills", v: 3, messages: [
        { id: "m1", date: "2026-11-01T10:00:00Z", subject: "Your PG&E bill", text: "", pdfs: [{ name: "bill.pdf", data: btoa("%PDF-1.4 x") }] },
        { id: "m2", date: "2026-11-02T10:00:00Z", subject: "Water bill", text: "Amount due $42.10 by 11/20/2026", pdfs: [] }] };
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u: any) => { asked.push(String(u)); return new Response(JSON.stringify(reply)); });
      const got = await g.pullBills();
      expect(new URL(asked[0]).searchParams.get("view")).toBe("bills");
      expect(got.map((m: any) => m.id)).toEqual(["m1", "m2"]);
      expect(new TextDecoder().decode(got[0].pdfs[0].bytes)).toBe("%PDF-1.4 x");
      g.markBillsSeen(["m1"]);
      expect((await g.pullBills()).map((m: any) => m.id)).toEqual(["m2"]);
      expect(new URL(asked[1]).searchParams.get("seen")).toBe("m1");
      expect(store.get("kos-gmail-seen") ?? null).toBeNull();                 // Kos's own list is separate
      reply = { label: "Kos", v: 2, messages: [] };                             // a script from before Bills by email
      await expect(g.pullBills()).rejects.toThrow(/older than Bills by email/);
      spy.mockRestore();
    } finally { (globalThis as any).localStorage = was; }
  });
  it("an export keeps each trip's code, and an import brings it back", async () => {
    const { exportFile, importFile } = await import("../public/kos/store.js");
    const file = exportFile({ trips: [{ id: 2, name: "Lisbon", start_date: "2027-05-01", end_date: "2027-05-05", travellers: [], code: "k7f3x9p2ad", items: [] }], unassigned: [] });
    expect(importFile(JSON.parse(JSON.stringify(file))).trips[0].trip.code).toBe("k7f3x9p2ad");
    expect(importFile({ ...file, trips: [{ ...file.trips[0], code: "bad" }] }).trips[0].trip.code).toBeUndefined();
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
    expect(kos).toContain("Set it up in three steps");
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
  it("the journal's map is minimal: Positron cut to land, water, big roads, borders and city names, recoloured for the theme", async () => {
    const { minimalStyle } = await import("../public/kos/map-style.js");
    const style = { sources: { openmaptiles: { type: "vector" } }, layers: [
      { id: "background", type: "background", paint: {} }, { id: "water", type: "fill", paint: {} }, { id: "building", type: "fill", paint: {} },
      { id: "highway_major_inner", type: "line", paint: { "line-width": 2 } }, { id: "highway-name-major", type: "symbol", paint: {} },
      { id: "boundary_2", type: "line", paint: {} }, { id: "label_city", type: "symbol", paint: {} }] };
    const dark = minimalStyle(style, true), light = minimalStyle(style, false);
    expect(dark.layers.map((l: any) => l.id)).toEqual(["background", "water", "highway_major_inner", "boundary_2", "label_city"]);
    expect(dark.layers[0].paint["background-color"]).not.toBe(light.layers[0].paint["background-color"]);
    expect(dark.layers[2].paint["line-width"]).toBe(2);                                       // shapes kept, colours changed
  });
  it("the trip's map is Liberty, a little quieter: no points of interest, buildings, road names, minor streets or footpaths; main roads, rail and places stay", async () => {
    const { quietStyle } = await import("../public/kos/map-style.js");
    const ids = ["water", "park", "park_outline", "landuse_school", "building", "building-3d", "poi_r1", "poi_transit", "road_minor", "road_path_pedestrian",
      "tunnel_service_track", "road_trunk_primary", "road_major_rail", "road_major_rail_hatching", "road_one_way_arrow", "highway-name-major", "highway-shield-non-us", "road_shield_us", "label_city", "airport"];
    expect(quietStyle({ layers: [...ids, "label_state", "tunnel_motorway", "road_link"].map((id) => ({ id })) }).layers.map((l: any) => l.id))
      .toEqual(["water", "park", "road_trunk_primary", "road_major_rail", "label_city", "airport"]);
    const light = quietStyle({ layers: [{ id: "road_trunk_primary", type: "line", "source-layer": "transportation", paint: { "line-color": "#fc8" } }] }, false);
    expect(light.layers[0].paint["line-color"]).toBe("#ece8df");                              // soft grey roads in light
  });
  it("a trip's city photo: which city to ask for, and only Wikimedia's image hosts", async () => {
    const { cityNames, isWikimediaImage } = await import("../public/kos/store.js");
    expect(cityNames({ place: "Tokyo, Japan", items: [{ kind: "flight", arr_airport: "NRT", start_at: "2027-03-10" }] }, airports)).toEqual(["Tokyo, Japan", "Tokyo"]);
    expect(cityNames({ place: "", items: [{ kind: "flight", arr_airport: "NRT", start_at: "2027-03-10" }] }, airports)).toEqual(["Tokyo"]);
    expect(cityNames({ place: null, items: [] })).toEqual([]);
    expect(isWikimediaImage("https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b2/Shinjuku.jpg/960px-Shinjuku.jpg")).toBe(true);
    expect(isWikimediaImage("https://upload.wikimedia.org/wikipedia/commons/4/41/Lisbon.jpg")).toBe(true);
    for (const bad of ["http://upload.wikimedia.org/x.jpg", "https://upload.wikimedia.org.evil.example/x.jpg", "https://upload.wikimedia.org/x.jpg\") url(https://evil.example", "javascript:alert(1)"])
      expect(isWikimediaImage(bad), bad).toBe(false);
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
