// Kos: where a place is, read from what people paste (docs/trips.md §22), with no maps or lookup
// service. One box takes:
// - a plus code: full ("8Q7XPRF9+WQ") anywhere; short ("PRF9+WQ Sumida City, Tokyo", what Google
//   Maps copies) near a reference point (the trip's places, or a city in its text, from airports.json);
// - coordinates: "35.7101, 139.8107", or 35°43'29.2"N 139°49'10.0"E;
// - a Google Maps link: the long address in a browser's bar (the place itself, !3d…!4d…, else the
//   map's centre); a short maps.app.goo.gl link needs following, which only a Minty's Worker can do;
// - anything else is kept as an address, shown with an "Open in Maps" link, but not placed on the map.
// what3words isn't read: it needs their paid service.

// --- plus codes (Open Location Code, Apache 2.0: github.com/google/open-location-code) -----------------
const A = "23456789CFGHJMPQRVWX";
const ix = (ch) => A.indexOf(ch);
/** The area a full plus code covers, and its centre. */
export function decodePlus(code) {
  const c = String(code).toUpperCase().replace("+", "").replace(/0+$/, "").slice(0, 15);   // digits past the 15th are ignored
  let latLo = -90, lngLo = -180, res = 20;
  const pairs = Math.min(c.length, 10);
  for (let i = 0; i < pairs; i += 2) {
    latLo += ix(c[i]) * res; lngLo += ix(c[i + 1]) * res;
    if (i + 2 < pairs) res /= 20;
  }
  let latSize = res, lngSize = res;
  for (let i = 10; i < c.length; i++) {
    latSize /= 5; lngSize /= 4;
    const d = ix(c[i]);
    latLo += Math.floor(d / 4) * latSize; lngLo += (d % 4) * lngSize;
  }
  return { latLo, lngLo, latHi: latLo + latSize, lngHi: lngLo + lngSize, lat: latLo + latSize / 2, lng: lngLo + lngSize / 2 };
}
/** A full plus code for a point, `len` digits long (10 by default). */
export function encodePlus(lat, lng, len = 10) {
  let a = Math.min(Math.max(lat, -90), 90) + 90, o = ((lng + 180) % 360 + 360) % 360;
  if (a >= 180) a = 180 - 1e-10;
  let code = "", res = 20;
  for (let i = 0; i < Math.min(len, 10); i += 2) {
    const da = Math.floor(a / res + 1e-9), dn = Math.floor(o / res + 1e-9);
    a -= da * res; o -= dn * res; code += A[da] + A[dn];
    if (i + 2 < Math.min(len, 10)) res /= 20;
  }
  let latSize = res, lngSize = res;
  for (let i = 10; i < len; i++) {
    latSize /= 5; lngSize /= 4;
    const r = Math.min(4, Math.floor(a / latSize + 1e-9)), c = Math.min(3, Math.floor(o / lngSize + 1e-9));
    a -= r * latSize; o -= c * lngSize; code += A[r * 4 + c];
  }
  code = code.padEnd(8, "0");
  return `${code.slice(0, 8)}+${code.slice(8)}`;
}
const FULL = /^[2-9CFGHJMPQRVWX]{8}\+[2-9CFGHJMPQRVWX]{0,7}$/i;
const SHORT = /^[2-9CFGHJMPQRVWX]{2,6}\+[2-9CFGHJMPQRVWX]{1,7}$/i;
/** A short plus code's full one, the nearest to a reference point (as Google's recoverNearest). */
export function recoverPlus(short, refLat, refLng) {
  const s = String(short).toUpperCase();
  if (FULL.test(s)) return s;
  const pad = 8 - s.indexOf("+"), resolution = 20 ** (2 - pad / 2), half = resolution / 2;
  const full = encodePlus(refLat, refLng).replace("+", "").slice(0, pad) + s;
  const area = decodePlus(full);
  let lat = area.lat, lng = area.lng;
  if (refLat + half < lat && lat - resolution >= -90) lat -= resolution;
  else if (refLat - half > lat && lat + resolution <= 90) lat += resolution;
  if (refLng + half < lng) lng -= resolution;
  else if (refLng - half > lng) lng += resolution;
  return encodePlus(lat, lng, s.replace("+", "").length + pad);
}

// --- everything one box takes ------------------------------------------------------------------------
/** Distance in km between two points. */
export function kmBetween(a, b) {
  const r = (d) => (d * Math.PI) / 180, h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const round = (x) => Math.round(x * 1e6) / 1e6;
const SHORT_LINK = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\/[\w-]+\/?(\?[^\s]*)?$/i;
export const isShortMapsLink = (s) => SHORT_LINK.test(String(s ?? "").trim());
/** Coordinates in a Google Maps address: the place itself (!3d…!4d…), else ?q= / ll= / query=, else the map's centre (@). */
export function fromMapsUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname) || !/^\/maps/.test(u.pathname)) return null;
  const s = decodeURIComponent(u.href);
  const name = (/\/maps\/place\/([^/@]+)/.exec(u.pathname)?.[1] ?? "").replace(/\+/g, " ");
  const label = name ? decodeURIComponent(name) : "";
  const num = "(-?\\d{1,3}(?:\\.\\d+)?)";
  const at = (re) => { const m = new RegExp(re).exec(s); return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null; };
  const p = at(`!3d${num}!4d${num}`) ?? at(`[?&](?:q|query|ll|center|destination)=${num},\\s*${num}`) ?? at(`@${num},${num}`);
  return p && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 ? { ...p, label } : null;
}
function fromDms(t) {
  const m = /(\d{1,2})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([NS])[\s,]+(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([EW])/i.exec(t);
  if (!m) return null;
  const v = (d, mi, se, h) => (Number(d) + Number(mi) / 60 + Number(se) / 3600) * (/[SW]/i.test(h) ? -1 : 1);
  return { lat: v(m[1], m[2], m[3], m[4]), lon: v(m[5], m[6], m[7], m[8]) };
}
/**
 * Where a pasted text is. `refs`: points it may be near ([{lat, lon, name}], best first: the trip's own
 * places); `airports`: IATA → [name, city, country, lat, lon], for a city named after a short code.
 * Returns { lat, lon, how, label?, near? } placed; { shortLink } (a Minty can follow it); { address }
 * (kept as text); or { error } (said plainly).
 * @param {string} text
 * @param {{ refs?: { lat: number, lon: number, name: string }[], airports?: Record<string, any[]> }} [opts]
 * @returns {any}
 */
export function parseWhere(text, { refs = [], airports = {} } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return { error: "Paste an address, a plus code, coordinates or a Google Maps link." };
  if (isShortMapsLink(t)) return { shortLink: t };
  if (/^https?:\/\//i.test(t)) {
    const m = fromMapsUrl(t);
    return m ? { lat: round(m.lat), lon: round(m.lon), how: "a Google Maps link", label: m.label } : { error: "That link doesn't say where the place is. Paste a Google Maps link, or the place's plus code." };
  }
  if (/^\/{3}|^[a-z]+\.[a-z]+\.[a-z]+$/i.test(t) || /what3words|w3w\.co/i.test(t)) return { error: "what3words addresses can't be read without their paid service. Paste the place's plus code or a Google Maps link instead." };
  const dec = /^\s*(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)\s*$/.exec(t);
  if (dec && Math.abs(+dec[1]) <= 90 && Math.abs(+dec[2]) <= 180) return { lat: round(+dec[1]), lon: round(+dec[2]), how: "coordinates" };
  const dms = fromDms(t);
  if (dms) return { lat: round(dms.lat), lon: round(dms.lon), how: "coordinates" };
  const pc = /(?:^|\s)([2-9CFGHJMPQRVWX]{2,8}\+[2-9CFGHJMPQRVWX]{0,7})(?=\s|,|$)/i.exec(t);
  if (pc) {
    const code = pc[1].toUpperCase(), rest = t.replace(pc[1], "").replace(/^[\s,]+|[\s,]+$/g, "");
    if (FULL.test(code)) { const d = decodePlus(code); return { lat: round(d.lat), lon: round(d.lng), how: "a plus code", label: rest }; }
    if (!SHORT.test(code)) return { error: "That plus code isn't complete." };
    // A short code is only the last part of a place's code: it needs a point within about 50 km, and it
    // always finds the match nearest that point, so the point must be right. A city named after the code
    // (what Google Maps copies) comes first, then the trip's own places; the hint says which it used.
    const cities = rest.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const named = cities.length ? Object.values(airports).find((a) => cities.includes(String(a[1]).toLowerCase())) : null;
    const ref = named ? { lat: named[3], lon: named[4], name: named[1] } : refs[0];
    if (!ref) return { error: "A short plus code needs to know roughly where: add a city after it (e.g. \"PRF9+WQ Tokyo\"), or paste the full code (with its first 4 characters)." };
    const d = decodePlus(recoverPlus(code, ref.lat, ref.lon)), at = { lat: d.lat, lon: d.lng };
    return { lat: round(at.lat), lon: round(at.lon), how: "a plus code", label: rest, near: `about ${Math.max(1, Math.round(kmBetween(ref, at)))} km from ${ref.name}` };
  }
  return { address: t };
}
