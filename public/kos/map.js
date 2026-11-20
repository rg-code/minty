// Kos's map (docs/trips.md §13): MapLibre GL (vendored, its CSP build: public/vendor/maplibre/) on
// OpenFreeMap's tiles, recoloured at night (map-style.js, GRAZE's palette). Flights are great-circle
// arcs between airports (airports.json, from OurAirports, public domain); places with coordinates
// are pins. Tiles, the style and its fonts come from tiles.openfreemap.org, which the /kos/ page's
// policy allows (public/_headers); nothing else is loaded from another host.
import { LIBERTY_STYLE, nightStyle, satelliteStyle } from "./map-style.js";

/** Latin names only. Liberty prints "name:latin" over "name:nonlatin"; OpenFreeMap's fonts have
 * no Japanese, Chinese or Korean glyphs, so the second line drew as empty boxes. A label with both
 * keeps its Latin name; the rest are as published. */
export function latinLabels(style) {
  const isBoth = (f) => Array.isArray(f) && f[0] === "case" && JSON.stringify(f[1]) === JSON.stringify(["has", "name:nonlatin"]);
  return { ...style, layers: style.layers.map((l) => (l.type === "symbol" && isBoth(l.layout?.["text-field"])
    ? { ...l, layout: { ...l.layout, "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]] } } : l)) };
}

let airports = null;
export async function loadAirports() {
  airports ??= fetch("/kos/airports.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return airports;
}

/** Points along the great circle from a to b ([lon, lat]), with longitudes unwrapped so a flight
 * across the antimeridian is drawn as one line. */
export function greatCircle(a, b, n = 64) {
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  const [l1, p1, l2, p2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!d) return [a, b];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  for (let i = 1; i < out.length; i++) {                      // unwrap: no jump of more than 180 degrees
    while (out[i][0] - out[i - 1][0] > 180) out[i][0] -= 360;
    while (out[i][0] - out[i - 1][0] < -180) out[i][0] += 360;
  }
  return out;
}

const KIND_COLOR = { flight: "#4c6ef5", lodging: "#e8590c", car: "#1098ad", train: "#ae3ec9", bus: "#ae3ec9", restaurant: "#d6336c", event: "#0ca678", other: "#868e96", photos: "#f59f00", spend: "#20c997" };

/** A map in `el`, dark or light. Resolves to the map once its style has loaded; null when the map
 * can't load (no WebGL, or the tiles are unreachable), so the page can say so and carry on. */
export async function createMap(el, { dark, satellite = false }) {
  const gl = window.maplibregl;
  if (!gl) return null;
  try {
    gl.setWorkerUrl("/vendor/maplibre/maplibre-gl-csp-worker.js");
    const style = latinLabels(await (await fetch(LIBERTY_STYLE)).json());
    const map = new gl.Map({ container: el, style: satellite ? satelliteStyle(style) : dark ? nightStyle(style) : style, center: [0, 20], zoom: 1, attributionControl: { compact: true },
                             cooperativeGestures: matchMedia("(hover: none)").matches });
    map.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");
    await new Promise((ok, fail) => { map.once("load", ok); map.once("error", fail); setTimeout(() => fail(new Error("timeout")), 15000); });
    return map;
  } catch {
    return null;
  }
}

/** Shifts a longitude by whole turns to within half a turn of `ref`, so places either side of the
 * date line are drawn (and framed) next to each other, not a world apart. */
const near = (lon, ref) => lon + 360 * Math.round((ref - lon) / 360);

/** Draws a trip: arcs [{from, to, label, id}] ([lon, lat]) and pins [{lon, lat, kind, label, id, color}].
 * `onPick(id)` is called when a pin or arc is tapped. `fit`: "pins" frames the trip's places (the
 * itinerary, like Wanderlog), "lodging" the stays (the Lodging tab), "all" the flights too (like Flighty). */
export function drawTrip(map, { arcs = [], pins = [], paths = [] }, onPick, fit = "all", dark = true) {
  const gl = window.maplibregl;
  // everything around one reference longitude: the trip's first place, else the first flight's arrival
  const ref = pins[0]?.lon ?? arcs[0]?.to[0] ?? 0;
  pins = pins.map((p) => ({ ...p, lon: near(p.lon, ref) }));
  const arcLines = arcs.map((a) => {
    const c = greatCircle(a.from, a.to), shift = near(c.at(-1)[0], ref) - c.at(-1)[0];
    return { ...a, coords: c.map(([x, y]) => [x + shift, y]) };
  });
  const lines = { type: "FeatureCollection", features: [
    ...arcLines.map((a) => ({ type: "Feature", properties: { id: a.id ?? "", kind: "flight", label: a.label ?? "" }, geometry: { type: "LineString", coordinates: a.coords } })),
    ...paths.map((p) => ({ type: "Feature", properties: { id: p.id ?? "", kind: "path", color: p.color ?? "#868e96" }, geometry: { type: "LineString", coordinates: p.coords } })),
  ] };
  const points = { type: "FeatureCollection", features: pins.map((p) => ({ type: "Feature", properties: { id: p.id ?? "", kind: p.kind, label: p.label ?? "", color: p.color ?? KIND_COLOR[p.kind] ?? KIND_COLOR.other },
    geometry: { type: "Point", coordinates: [p.lon, p.lat] } })) };
  for (const [id, data] of [["kos-lines", lines], ["kos-pins", points]]) {
    if (map.getSource(id)) map.getSource(id).setData(data); else map.addSource(id, { type: "geojson", data });
  }
  if (!map.getLayer("kos-arcs")) {
    map.addLayer({ id: "kos-paths", type: "line", source: "kos-lines", filter: ["==", ["get", "kind"], "path"],
                   paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.8 }, layout: { "line-cap": "round", "line-join": "round" } });
    map.addLayer({ id: "kos-arcs", type: "line", source: "kos-lines", filter: ["==", ["get", "kind"], "flight"],
                   paint: { "line-color": KIND_COLOR.flight, "line-width": 2.5, "line-dasharray": [2, 1.5] }, layout: { "line-cap": "round" } });
    // Flighty's glow under the flight arcs
    map.addLayer({ id: "kos-arcs-glow", type: "line", source: "kos-lines", filter: ["==", ["get", "kind"], "flight"],
                   paint: { "line-color": KIND_COLOR.flight, "line-width": 8, "line-blur": 6, "line-opacity": 0.45 } }, "kos-arcs");
    map.addLayer({ id: "kos-pins", type: "circle", source: "kos-pins",
                   paint: { "circle-radius": 7, "circle-color": ["get", "color"], "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
    map.addLayer({ id: "kos-labels", type: "symbol", source: "kos-pins", minzoom: 3,
                   layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-offset": [0, 1.2], "text-anchor": "top", "text-optional": true },
                   paint: { "text-color": dark ? "#eef1f8" : "#11162a", "text-halo-color": dark ? "#0b1020" : "#ffffff", "text-halo-width": 1.6 } });
    for (const layer of ["kos-pins", "kos-arcs"]) {
      map.on("click", layer, (e) => { const id = e.features?.[0]?.properties?.id; if (id && onPick) onPick(String(id)); });
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }
  }
  const placed = points.features.map((f) => f.geometry.coordinates);
  const stays = points.features.filter((f) => f.properties.kind === "lodging").map((f) => f.geometry.coordinates);
  // "lodging" frames the stays (falling back to the places), "pins" the places, "all" the flights too
  const all = fit === "lodging" && stays.length ? stays : (fit === "pins" || fit === "lodging") && placed.length ? placed : [...lines.features.flatMap((f) => f.geometry.coordinates), ...placed];
  if (all.length) {
    const b = all.reduce((bb, c) => bb.extend(c), new gl.LngLatBounds(all[0], all[0]));
    map.fitBounds(b, { padding: 48, maxZoom: all.length === 1 ? 12 : 14, duration: 0 });
  }
}

/** Centres the map on one place (a tapped booking), keeping what's drawn. */
export function focus(map, lon, lat) { map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 12) }); }
