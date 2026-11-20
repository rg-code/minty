import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { greatCircle, latinLabels } from "../public/jet/map.js";
import { nightStyle } from "../public/jet/map-style.js";

// The JET app (public/jet/, docs/trips.md): its map helpers, and the page as served.
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
    const html = await (await raw("/jet/")).text();
    expect(html).toContain('<link rel="manifest" href="/jet/manifest.webmanifest" crossorigin="use-credentials" />');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(html).toContain('<script src="/lock.js"></script>');                 // the device lock, as on every page with data
    const m = await (await raw("/jet/manifest.webmanifest")).json() as any;
    expect(m).toMatchObject({ id: "/jet/", start_url: "/jet/", scope: "/jet/", name: "JET" });
    const sw = await (await raw("/jet/sw.js")).text();
    expect(sw).toContain('const CACHE = "jet-v3"');
    expect(sw).toContain('"/jet/gmail.js"');
    // Share to JET (Android's share menu, once installed): sw.js takes the POST and keeps it on the device
    expect(m.share_target).toMatchObject({ action: "/jet/share", method: "POST", enctype: "multipart/form-data" });
    expect(m.share_target.params.files[0].accept).toEqual(expect.arrayContaining(["application/pdf", "image/*", "message/rfc822"]));
    expect(sw).toContain('url.pathname === "/jet/share"');
    expect(sw).toContain('k.startsWith("jet-")');                               // never deletes Minty's cache
    expect(await (await raw("/sw.js")).text()).toContain('k.startsWith("minty-")'); // and Minty's never deletes JET's
  });
  it("its policy allows OpenFreeMap (and, for JET's pages, the person's own Gmail script) and nothing else; the dashboard's doesn't", async () => {
    for (const p of ["/jet/", "/jet/jet.js", "/vendor/maplibre/maplibre-gl-csp-worker.js"]) {
      const csp = (await raw(p)).headers.get("content-security-policy") ?? "";
      expect(csp, p).toContain(p.startsWith("/jet/")
        ? "connect-src 'self' https://tiles.openfreemap.org https://script.google.com https://script.googleusercontent.com;"
        : "connect-src 'self' https://tiles.openfreemap.org;");
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
    expect(await (await raw("/jet/jet.js")).text()).toContain('import("/vendor/qrcode/qrcode.mjs")');
  });
  it("airports are there, by IATA code", async () => {
    const a = await (await raw("/jet/airports.json")).json() as Record<string, [string, string, string, number, number]>;
    expect(Object.keys(a).length).toBeGreaterThan(2500);
    expect(a.NRT[2]).toBe("JP");
    expect(a.SFO[3]).toBeCloseTo(37.62, 1);
  });
});

describe("Gmail pull (public/jet/gmail.js)", () => {
  it("takes only an Apps Script web app's address, and writes the key into a read-only script", async () => {
    const g = await import("../public/jet/gmail.js");
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
    const g = await import("../public/jet/gmail.js");
    const url = "https://script.google.com/macros/s/AKfycbx1234567890abcdefghij/exec", key = g.newKey();
    const link = g.linkFor("https://jet.example", url, key);
    expect(link).toMatch(/^https:\/\/jet\.example\/jet\/#\/gmail\?connect=[\w-]+$/);   // nothing before the # but the page
    expect(g.readLink(link)).toEqual({ url, key });
    expect(g.readLink(link.split("connect=")[1])).toEqual({ url, key });                 // the code alone
    expect(g.readLink(g.linkFor("https://jet.example", "https://evil.example/exec", key))).toBe(null);
    expect(g.readLink(g.linkFor("https://jet.example", url, "short"))).toBe(null);
    expect(g.readLink("not a link")).toBe(null);
  });
  it("a raw message becomes its bytes: one per character, or UTF-8 when there's a wide one", async () => {
    const { rawBytes } = await import("../public/jet/gmail.js");
    expect([...rawBytes("A\u00e9")]).toEqual([65, 0xe9]);
    expect([...rawBytes("A\u2192")]).toEqual([65, 0xe2, 0x86, 0x92]);
  });
});

describe("JET on its own (public/jet/store.js)", () => {
  it("checks a trip and a booking as the server does", async () => {
    const { checkItem, checkTrip } = await import("../public/jet/store.js");
    expect(checkTrip({ name: " Lisbon ", start_date: "2027-05-01", end_date: "2027-05-05" })).toMatchObject({ name: "Lisbon", travellers: [] });
    expect(() => checkTrip({ name: "x", start_date: "2027-05-05", end_date: "2027-05-01" })).toThrow(/can't be before/);
    expect(checkItem({ kind: "flight", airline: "tp", dep_airport: "ewr", arr_airport: "LIS", start_at: "2027-05-01T21:20" }))
      .toMatchObject({ airline: "TP", dep_airport: "EWR", arr_airport: "LIS", source: "typed" });
    expect(() => checkItem({ kind: "boat" })).toThrow(/kind/);
    expect(() => checkItem({ kind: "flight", dep_airport: "LISBON" })).toThrow(/airport/);
    expect(() => checkItem({ kind: "event", start_at: "soon" })).toThrow(/date and time/);
  });
  it("exports every trip and booking, and imports only JET's own files, re-tying bookings to their trips", async () => {
    const { exportFile, importFile } = await import("../public/jet/store.js");
    const list = { trips: [{ id: 7, name: "Lisbon", start_date: "2027-05-01", end_date: "2027-05-05", travellers: [], items: [{ id: 3, trip_id: 7, kind: "lodging", name: "Hotel" }], transactions: 0, spent_cents: 0 }],
                   unassigned: [{ id: 4, trip_id: null, kind: "event", name: "Later" }] };
    const file = exportFile(list);
    expect(file).toMatchObject({ app: "JET", version: 1 });
    expect(file.trips[0]).not.toHaveProperty("items");
    expect(file.items.map((i: any) => i.id)).toEqual([3, 4]);
    const back = importFile(JSON.parse(JSON.stringify(file)));
    expect(back.trips.map((t: any) => t.old)).toEqual([7]);
    expect(back.items.map((i: any) => [i.oldTrip, i.item.name, i.item.trip_id])).toEqual([[7, "Hotel", null], [null, "Later", null]]);
    expect(() => importFile({ app: "Other", version: 1, trips: [], items: [] })).toThrow(/isn't a JET export/);
  });
  it("the sample trips move to today: dates and times shift by whole days, keeping their time and offset", async () => {
    const { shiftSample, importFile } = await import("../public/jet/store.js");
    const file = { app: "JET", version: 1, sample_from: "2026-01-15",
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
    expect(await (await raw("/jet/mode.js")).text()).toContain('window.JET_MODE = "minty";');
    const html = await (await raw("/jet/")).text();
    expect(html.indexOf('/jet/mode.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/jet/mode.js')).toBeLessThan(html.indexOf('/jet/jet.js'));
  });
});
