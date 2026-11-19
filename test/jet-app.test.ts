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
    expect(sw).toContain('const CACHE = "jet-v1"');
    expect(sw).toContain('k.startsWith("jet-")');                               // never deletes Minty's cache
    expect(await (await raw("/sw.js")).text()).toContain('k.startsWith("minty-")'); // and Minty's never deletes JET's
  });
  it("its policy allows OpenFreeMap and nothing else; the dashboard's doesn't", async () => {
    for (const p of ["/jet/", "/jet/jet.js", "/vendor/maplibre/maplibre-gl-csp-worker.js"]) {
      const csp = (await raw(p)).headers.get("content-security-policy") ?? "";
      expect(csp, p).toContain("connect-src 'self' https://tiles.openfreemap.org;");
      expect(csp, p).toContain("script-src 'self';");
      expect(csp.match(/default-src/g), p).toHaveLength(1);
    }
    expect((await raw("/")).headers.get("content-security-policy")).not.toContain("openfreemap");
  });
  it("airports are there, by IATA code", async () => {
    const a = await (await raw("/jet/airports.json")).json() as Record<string, [string, string, string, number, number]>;
    expect(Object.keys(a).length).toBeGreaterThan(2500);
    expect(a.NRT[2]).toBe("JP");
    expect(a.SFO[3]).toBeCloseTo(37.62, 1);
  });
});
