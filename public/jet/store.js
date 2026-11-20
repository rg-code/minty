// Where JET keeps its trips (docs/trips.md §17). One app, two places:
//   "minty":  served by a household's Minty at /jet/: Minty's API, on its D1, behind its sign-in.
//   "device": JET on its own (built by scripts/build-jet.mjs, e.g. minty.milesmaximizer.com/jet/):
//             IndexedDB in this browser, nothing sent anywhere. Email files are read here too
//             (./mail/mime.js and ./mail/reservations.js, src/jet/ with its types stripped).
// public/jet/mode.js sets window.JET_MODE before this loads. Both stores answer the same calls,
// with the same shapes as Minty's API (GET /trips and the rest), so jet.js doesn't care which.

export const MODE = globalThis.JET_MODE === "device" ? "device" : "minty";

// --- checks shared by the device store and import (the server has its own, src/routes/jet.ts) --
const KINDS = ["flight", "lodging", "car", "train", "bus", "restaurant", "event", "other"];
const SOURCES = ["typed", "paste", "pdf", "screenshot", "email"];
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isWhen = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && isDate(s.slice(0, 10));
const text = (v, max) => (v === null || v === undefined || v === "" ? null : String(v).replace(/\s+/g, " ").trim().slice(0, max) || null);
const num = (v, lim) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > lim ? null : Number(v));
const int = (v, max) => (v === null || v === undefined || v === "" || !Number.isSafeInteger(Number(v)) || Number(v) < 0 || Number(v) > max ? null : Number(v));
const code = (v, re) => { const t = text(v, 10)?.toUpperCase() ?? null; return t && re.test(t) ? t : null; };

/** A trip's fields, checked: throws an Error with a plain message when one is wrong. */
export function checkTrip(b) {
  const t = { name: text(b.name, 100), start_date: b.start_date, end_date: b.end_date, place: text(b.place, 150),
              lat: num(b.lat, 90), lon: num(b.lon, 180), notes: b.notes ? String(b.notes).slice(0, 2000) : null,
              travellers: Array.isArray(b.travellers) ? b.travellers.filter((k) => typeof k === "string").slice(0, 20) : [] };
  if (!t.name) throw new Error("give the trip a name");
  if (!isDate(t.start_date) || !isDate(t.end_date)) throw new Error("a trip needs its first and last day");
  if (t.end_date < t.start_date) throw new Error("the last day can't be before the first");
  return t;
}
/** A booking's fields, checked the way the server does (src/routes/jet.ts). */
export function checkItem(b) {
  if (!KINDS.includes(b.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  for (const k of ["start_at", "end_at"]) if (b[k] && !isWhen(b[k])) throw new Error(`${k} must be a date and time, e.g. 2027-03-10T11:05`);
  if (b.start_at && b.end_at && b.end_at.slice(0, 10) < b.start_at.slice(0, 10)) throw new Error("it can't end before it starts");
  for (const [k, re, what] of [["dep_airport", /^[A-Z]{3}$/, "an airport code, e.g. SFO"], ["arr_airport", /^[A-Z]{3}$/, "an airport code, e.g. NRT"],
                               ["airline", /^[A-Z0-9]{2,3}$/, "an airline code, e.g. UA"], ["flight_number", /^\d{1,4}[A-Z]?$/, "a flight number, e.g. 837"],
                               ["currency", /^[A-Z]{3}$/, "a 3-letter currency code"]]) {
    if (b[k] && !code(b[k], re)) throw new Error(`${k} must be ${what}`);
  }
  return {
    trip_id: b.trip_id ?? null, kind: b.kind, name: text(b.name, 150), confirmation: text(b.confirmation, 40), guest: text(b.guest, 100),
    start_at: b.start_at || null, end_at: b.end_at || null, place: text(b.place, 200), lat: num(b.lat, 90), lon: num(b.lon, 180),
    price_cents: int(b.price_cents, 1e11), currency: code(b.currency, /^[A-Z]{3}$/), points: int(b.points, 1e9), points_program: text(b.points_program, 40),
    airline: code(b.airline, /^[A-Z0-9]{2,3}$/), flight_number: code(b.flight_number, /^\d{1,4}[A-Z]?$/), dep_airport: code(b.dep_airport, /^[A-Z]{3}$/),
    arr_airport: code(b.arr_airport, /^[A-Z]{3}$/), dep_terminal: text(b.dep_terminal, 10), dep_gate: text(b.dep_gate, 10), arr_terminal: text(b.arr_terminal, 10),
    seat: text(b.seat, 10), source: SOURCES.includes(b.source) ? b.source : "typed",
    source_sha256: typeof b.source_sha256 === "string" && /^[0-9a-f]{64}$/i.test(b.source_sha256) ? b.source_sha256.toLowerCase() : null,
    notes: b.notes ? String(b.notes).slice(0, 2000) : null,
  };
}

/** The export file: every trip and booking, as JSON. Ids are kept only to tie bookings to trips. */
export function exportFile(list) {
  const trips = list.trips.map(({ items, transactions, spent_cents, ...t }) => t);
  const items = [...list.trips.flatMap((t) => t.items), ...list.unassigned];
  return { app: "JET", version: 1, exported_at: new Date().toISOString(), trips, items };
}
/** The trips and bookings in an export file, checked, ready to save (a trip's `items` are its
 * bookings). Throws on a file that isn't JET's. */
export function importFile(data) {
  if (!data || data.app !== "JET" || data.version !== 1 || !Array.isArray(data.trips) || !Array.isArray(data.items)) throw new Error("That isn't a JET export file.");
  if (data.trips.length > 500 || data.items.length > 5000) throw new Error("That file holds more than JET takes at once.");
  const trips = data.trips.map((t) => ({ old: t.id, trip: checkTrip(t) }));
  const items = data.items.map((i) => ({ oldTrip: i.trip_id ?? null, item: checkItem({ ...i, trip_id: null }) }));
  return { trips, items };
}

// --- Minty: its API ---------------------------------------------------------------------------
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: raw ? { "content-type": "message/rfc822" } : body ? { "content-type": "application/json" } : {},
                                body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `${r.status}`);
  return d;
}
const mintyStore = {
  list: () => api("GET", "/trips"),
  users: () => api("GET", "/users").catch(() => []),
  programs: async () => { try { return (await api("GET", "/points")).programs ?? []; } catch { return []; } },
  saveTrip: (id, b) => (id ? api("PUT", `/trips/${id}`, b) : api("POST", "/trips", b)),
  deleteTrip: (id) => api("DELETE", `/trips/${id}`),
  saveItem: (id, b) => (id ? api("PUT", `/trips/items/${id}`, b) : api("POST", "/trips/items", b)),
  deleteItem: (id) => api("DELETE", `/trips/items/${id}`),
  readEmail: (buf) => api("POST", "/trips/read-email", null, buf),
  suggestions: (id) => api("GET", `/trips/${id}/suggestions`),
  transactions: (id) => api("GET", `/transactions?trip_id=${id}&limit=1000`),
  link: (id, b) => api("POST", `/trips/${id}/transactions`, b),
  tags: () => api("GET", "/tags").catch(() => []),       // the household's tags, to suggest for a trip
  spending: true,
};

// --- the device: IndexedDB ----------------------------------------------------------------------
let dbp = null;
function db() {
  dbp ??= new Promise((ok, fail) => {
    const req = indexedDB.open("jet", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("trips", { keyPath: "id", autoIncrement: true });
      d.createObjectStore("items", { keyPath: "id", autoIncrement: true }).createIndex("trip_id", "trip_id");
    };
    req.onsuccess = () => {
      // another tab upgrading or deleting the database: let it, and open again next time
      req.result.onversionchange = () => { req.result.close(); dbp = null; };
      ok(req.result);
    };
    req.onerror = () => fail(new Error("This browser won't keep JET's trips here (private window, or storage turned off)."));
  });
  return dbp;
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((ok, fail) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, fail);
    t.oncomplete = () => ok(out);
    t.onerror = () => fail(t.error ?? new Error("couldn't save"));
    t.onabort = () => fail(t.error ?? new Error("couldn't save"));
  });
}
const req = (r) => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const now = () => new Date().toISOString();
const byStart = (a, b) => ((a.start_at ?? "9999") < (b.start_at ?? "9999") ? -1 : (a.start_at ?? "9999") > (b.start_at ?? "9999") ? 1 : a.id - b.id);

const deviceStore = {
  async list() {
    const [trips, items] = await tx(["trips", "items"], "readonly", async (t) => [await req(t.objectStore("trips").getAll()), await req(t.objectStore("items").getAll())]);
    items.sort(byStart);
    return {
      trips: trips.sort((a, b) => (a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : b.id - a.id))
        .map((t) => ({ ...t, items: items.filter((i) => i.trip_id === t.id), transactions: 0, spent_cents: 0 })),
      unassigned: items.filter((i) => i.trip_id === null || i.trip_id === undefined),
    };
  },
  users: async () => [],
  programs: async () => [],
  tags: async () => [],
  async saveTrip(id, b) {
    const t = checkTrip(b);
    return tx(["trips", "items"], "readwrite", async (x) => {
      const s = x.objectStore("trips");
      const old = id ? await req(s.get(id)) : null;
      if (id && !old) throw new Error("trip not found");
      const row = { ...(old ?? { created_at: now() }), ...t, updated_at: now(), ...(id ? { id } : {}) };
      const key = await req(s.put(row));
      if (!id && Array.isArray(b.items)) {
        const items = x.objectStore("items");
        for (const iid of b.items) { const i = await req(items.get(Number(iid))); if (i) await req(items.put({ ...i, trip_id: key, updated_at: now() })); }
      }
      return { id: key };
    });
  },
  async deleteTrip(id) {
    return tx(["trips", "items"], "readwrite", async (x) => {
      // its bookings stay, with no trip (as on Minty)
      const items = x.objectStore("items");
      for (const i of await req(items.index("trip_id").getAll(id))) await req(items.put({ ...i, trip_id: null }));
      await req(x.objectStore("trips").delete(id));
      return { id, removed: true };
    });
  },
  async saveItem(id, b) {
    const f = checkItem(b);
    return tx(["trips", "items"], "readwrite", async (x) => {
      if (f.trip_id !== null && !(await req(x.objectStore("trips").get(f.trip_id)))) throw new Error("no trip with that id");
      const s = x.objectStore("items");
      const old = id ? await req(s.get(id)) : null;
      if (id && !old) throw new Error("booking not found");
      return { id: await req(s.put({ ...(old ?? { created_at: now() }), ...f, updated_at: now(), ...(id ? { id } : {}) })) };
    });
  },
  async deleteItem(id) { return tx(["items"], "readwrite", async (x) => { await req(x.objectStore("items").delete(id)); return { id, removed: true }; }); },
  /** An email file, read in this browser with the same reader Minty runs (src/jet/). Nothing is kept. */
  async readEmail(buf) {
    const [{ readMessage, viewOf }, { reservations }] = await Promise.all([import("./mail/mime.js"), import("./mail/reservations.js")]);
    const bytes = new Uint8Array(buf);
    if (bytes.length > 2 * 1024 * 1024) throw new Error("email file too large (at most 2 MB)");
    let raw = "";
    for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const m = readMessage(raw);
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { subject: m.subject, from: m.from, date: m.date, view: viewOf(m), sha256: sha, bookings: reservations(m.html), text: (m.text ?? "").slice(0, 8000) || null, attachments: [] };
  },
  spending: false,
};

export const store = MODE === "device" ? deviceStore : mintyStore;

/** Asks the browser to keep JET's trips even when space runs low (device mode). */
export async function keepData() {
  try { return Boolean(await navigator.storage?.persist?.()); } catch { return false; }
}
