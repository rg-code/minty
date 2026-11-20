// Kos (docs/trips.md): the household's trips, as an app of its own at /kos/. Served by Minty's
// Worker, behind Minty's sign-in, on Minty's data: trips and bookings (GET /trips…), the trip's
// transactions (GET /transactions?trip_id=, suggestions to confirm), BAM's programs for award
// bookings. Bookings come typed, pasted, from a PDF (pdf.js, read on the device), a screenshot
// (/sub-scan?for=kos, read on the device) or an email file (POST /trips/read-email, read on the
// server and not stored). The look: flights, the theme and the map after Flighty; trips after
// Wanderlog. Hash routes: #/ · #/trip/ID[/flights|/spending] · #/trip/ID/edit · #/new · #/add[?trip=ID] · #/item/ID.
import { createMap, drawTrip, focus, loadAirports } from "./map.js";
import { MODE, SUM_KINDS, exportFile, importFile, keepData, shiftSample, store, tripSummary } from "./store.js";
import * as gmail from "./gmail.js";
import { daySpend, lineFor, tripStats } from "./journal.js";

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (c, cur = "USD") => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", maximumFractionDigits: (c ?? 0) % 100 ? 2 : 0 }).format((c ?? 0) / 100); } catch { return `${cur} ${((c ?? 0) / 100).toFixed(2)}`; } };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const asDay = (d) => new Date(`${d}T00:00:00Z`);
const fmtDay = (d) => d ? `${DOW[asDay(d).getUTCDay()]}, ${MON[asDay(d).getUTCMonth()]} ${asDay(d).getUTCDate()}` : "";
const fmtShort = (d) => d ? `${MON[asDay(d).getUTCMonth()]} ${asDay(d).getUTCDate()}` : "";
const addDays = (d, n) => { const t = asDay(d); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dateOf = (s) => (s ? s.slice(0, 10) : null);
const timeOf = (s) => (s && s.length >= 16 ? s.slice(11, 16) : "");
/** An instant, only when the time carries its offset (bookings from email do); typed local times don't. */
const instant = (s) => (s && /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? Date.parse(s) : null);
const localDay = () => new Date().toLocaleDateString("en-CA");
const DAY_COLORS = ["#6b8cff", "#ff7a59", "#2fbf71", "#c96bff", "#ffb020", "#27b9d6", "#ff5d8f", "#9aa95b"];
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);
const KIND = { flight: "Flight", lodging: "Stay", car: "Car", train: "Train", bus: "Bus", restaurant: "Restaurant", event: "Activity", other: "Booking" };
const NAME_LABEL = { flight: "Airline", lodging: "Hotel or stay", car: "Company", train: "Train or company", bus: "Company", restaurant: "Restaurant", event: "Activity or event", other: "Name" };
const AIRLINE_COLORS = ["#2f6fec", "#d8344a", "#1d9a6c", "#7d4cdb", "#e07b1f", "#178aa1"];
const CAT = { FOOD_AND_DRINK: "Food & drink", TRAVEL: "Travel", TRANSPORTATION: "Transport", ENTERTAINMENT: "Activities", GENERAL_MERCHANDISE: "Shopping",
              PERSONAL_CARE: "Personal care", GENERAL_SERVICES: "Services", RENT_AND_UTILITIES: "Home", MEDICAL: "Medical", BANK_FEES: "Fees" };

let data = null, users = [], airports = {}, programs = null, map = null, mapKey = "", focused = null;

// Trips and bookings come from the store (store.js): Minty's API at /kos/ on a Minty, this
// browser's IndexedDB when Kos runs on its own.
async function load() {
  const [t, u, a] = await Promise.all([store.list(), store.users(), loadAirports()]);
  data = t; users = Array.isArray(u) ? u : []; airports = a;
}
const label = (k) => users.find((u) => u.key === k)?.label ?? k;
const airport = (code) => (code && airports[code] ? { name: airports[code][0], city: airports[code][1], country: airports[code][2], lat: airports[code][3], lon: airports[code][4] } : null);
const tripById = (id) => data.trips.find((t) => t.id === id);
const itemById = (id) => [...data.trips.flatMap((t) => t.items), ...data.unassigned].find((i) => i.id === id);

// --- Flighty: the flight card -----------------------------------------------------------------
function status(f) {
  const dep = instant(f.start_at), arr = instant(f.end_at), now = Date.now();
  if (dep && arr && now >= arr) return { label: "Landed", cls: "dim", progress: 1 };
  if (dep && arr && now >= dep) return { label: "In the air", cls: "info", progress: (now - dep) / (arr - dep) };
  if (dep && dep - now < 864e5 && dep > now) return { label: "Today", cls: "good", progress: 0 };
  const d = dateOf(f.start_at);
  if (d && d < localDay()) return { label: "Flown", cls: "dim", progress: 1 };
  return { label: "Scheduled", cls: "good", progress: 0 };
}
const until = (ms) => { const m = Math.round(ms / 6e4); if (m < 60) return `${m} min`; const h = Math.floor(m / 60); return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`; };
function duration(f) {
  const a = instant(f.start_at), b = instant(f.end_at);
  if (!a || !b || b <= a) return "";
  const m = Math.round((b - a) / 6e4);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const PLANE = `<svg class="plane" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>`;
function flightCard(f, { compact = false, countdown = false } = {}) {
  const dep = airport(f.dep_airport), arr = airport(f.arr_airport), st = status(f), dur = duration(f);
  const color = AIRLINE_COLORS[hue(f.airline ?? f.name ?? "") % AIRLINE_COLORS.length];
  const plusDays = dateOf(f.end_at) && dateOf(f.start_at) && dateOf(f.end_at) > dateOf(f.start_at) ? Math.round((asDay(dateOf(f.end_at)) - asDay(dateOf(f.start_at))) / 864e5) : 0;
  const dep0 = instant(f.start_at);
  const cd = countdown && dep0 && dep0 > Date.now() ? `<span class="countdown">Departs in ${until(dep0 - Date.now())}</span>` : "";
  return `<article class="flight${compact ? " compact" : ""}" data-item="${f.id}">
    <div class="flight-top"><span class="who"><span class="airline" style="background:${color}">${esc(f.airline ?? "✈")}</span>${esc([f.airline, f.flight_number].filter(Boolean).join(" ") || f.name || "Flight")}${f.name && f.airline ? ` <span class="muted">· ${esc(f.name)}</span>` : ""}</span>
      <span class="pill ${st.cls}">${st.label}</span></div>
    <div class="route">
      <div class="end"><div class="code">${esc(f.dep_airport ?? "—")}</div><div class="city">${esc(dep?.city || dep?.name || "")}</div><div class="time">${esc(timeOf(f.start_at) || "—")}<small>${esc(fmtShort(dateOf(f.start_at)))}</small></div></div>
      <div class="track"><span class="done" style="width:${Math.round(st.progress * 100)}%"></span><span style="position:absolute;left:${Math.round(Math.max(0, Math.min(1, st.progress)) * 100)}%;top:50%">${PLANE}</span>${dur ? `<span class="dur">${dur}</span>` : ""}</div>
      <div class="end arr"><div class="code">${esc(f.arr_airport ?? "—")}</div><div class="city">${esc(arr?.city || arr?.name || "")}</div><div class="time">${esc(timeOf(f.end_at) || "—")}${plusDays ? `<small>+${plusDays}</small>` : ""}</div></div>
    </div>
    <div class="facts"><div><span>Terminal</span><b>${esc(f.dep_terminal ?? "—")}</b></div><div><span>Gate</span><b>${esc(f.dep_gate ?? "—")}</b></div>
      <div><span>Seat</span><b>${esc(f.seat ?? "—")}</b></div><div><span>Confirmation</span><b>${esc(f.confirmation ?? "—")}</b></div></div>
    <div class="flight-foot">${cd || `<span>${esc(fmtDay(dateOf(f.start_at)))}</span>`}<span>${f.points ? `${f.points.toLocaleString()} pts` : f.price_cents ? money(f.price_cents, f.currency) : ""}
      ${compact ? "" : ` · <button type="button" class="btn small ghost" data-ics="${f.id}">Add to calendar</button>`}</span></div>
  </article>`;
}

// --- the trips list ---------------------------------------------------------------------------
function home() {
  const today = localDay();
  const flights = data.trips.flatMap((t) => t.items).concat(data.unassigned).filter((i) => i.kind === "flight" && dateOf(i.start_at) && (dateOf(i.end_at) ?? dateOf(i.start_at)) >= today)
    .sort((a, b) => (a.start_at < b.start_at ? -1 : 1));
  const upcoming = data.trips.filter((t) => t.end_date >= today).sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  const past = data.trips.filter((t) => t.end_date < today);
  const tripCard = (t) => `<a class="trip-card" href="#/trip/${t.id}">
    <div class="cover" style="--h:${hue(t.name)}"><h3>${esc(t.name)}</h3><div class="when">${esc(fmtShort(t.start_date))} – ${esc(fmtShort(t.end_date))}, ${t.end_date.slice(0, 4)}${t.place ? ` · ${esc(t.place)}` : ""}</div></div>
    <div class="meta">${t.start_date > today ? `<span class="pill info">in ${Math.round((asDay(t.start_date) - asDay(today)) / 864e5)} days</span>` : t.end_date >= today ? `<span class="pill good">On now</span>` : ""}
      ${["flight", "lodging"].map((k) => { const n = t.items.filter((i) => i.kind === k).length; return n ? `<span class="pill dim">${n} ${k === "flight" ? (n === 1 ? "flight" : "flights") : (n === 1 ? "stay" : "stays")}</span>` : ""; }).join("")}
      ${t.transactions ? `<span class="pill dim">${money(t.spent_cents)} spent</span>` : ""}</div></a>`;
  const sample = MODE === "device" && sampleIds();
  const empty = !data.trips.length && !data.unassigned.length;
  if (MODE === "device" && empty) return welcome();                  // a newcomer: how to set Kos up
  // the device lock's offer, once there are trips of the person's own (not only the sample's)
  const own = [...data.trips.map((t) => ["trips", t.id]), ...data.unassigned.map((i) => ["items", i.id])].some(([k, id]) => !(sample?.[k] ?? []).includes(id));
  // a finished trip's journal, ready and not opened yet (docs/trips.md §20): on Minty the hourly run
  // marks it; on its own, the trip's end. Only trips that ended in the last 60 days.
  let seenHere = [];
  try { seenHere = JSON.parse(localStorage.getItem("kos-journal-seen") ?? "[]"); } catch { /* none */ }
  const recent = addDays(today, -60);
  const ready = data.trips.filter((t) => t.end_date < today && t.end_date >= recent
    && (MODE === "device" ? !seenHere.includes(t.id) : t.journal_ready_at && !t.journal_seen_at)).slice(0, 2);
  return `${ready.map((t) => `<a class="card j-ready" href="#/trip/${t.id}/journal"><span class="grow"><b>Your ${esc(t.name)} journal is ready.</b> <span class="muted">Its days, its map and room for your notes.</span></span><span class="btn small primary">Open</span></a>`).join("")}
    ${sample ? `<div class="card sample-note"><span class="grow"><b>Sample trips.</b> Made up, to show what Kos does: open one, look at its flights and map, change anything. They're only in this browser.
      Start your own with <a href="#/new">New trip</a> or <a href="#/add">Add a booking</a>.</span><button type="button" class="btn small" data-sample-remove>Remove them</button></div>` : ""}
    ${flights.length ? `<div class="section-title"><h2>Next flight</h2><span class="muted">${flights.length > 1 ? `${flights.length - 1} more after it` : ""}</span></div>
      <div class="hero">${flightCard(flights[0], { countdown: true })}</div>` : ""}
    <div class="section-title"><h2>Trips</h2><a class="btn small" href="#/new">New trip</a></div>
    ${upcoming.length ? `<div class="trips">${upcoming.map(tripCard).join("")}</div>` : `<div class="card muted">No trips coming up. Make one, or add a booking and Kos will hold it until you do.${MODE === "device" && empty ? `
      <div class="actions"><button type="button" class="btn primary" data-sample>Try a sample trip</button><span class="err" id="sampleErr"></span></div>` : ""}</div>`}
    ${data.unassigned.length ? `<div class="section-title"><h2>Bookings waiting for a trip</h2><span class="muted">${data.unassigned.length}</span></div>
      <div class="list">${data.unassigned.map((i) => `<label class="row"><input type="checkbox" data-pick="${i.id}" /><span class="grow"><b>${esc(itemTitle(i))}</b><span class="muted">${esc(KIND[i.kind])} · ${esc(fmtDay(dateOf(i.start_at)) || "no date")}</span></span><a href="#/item/${i.id}" class="btn small ghost">Edit</a></label>`).join("")}</div>
      <div class="actions"><button type="button" class="btn primary" data-make-trip>Make a trip from the ticked ones</button></div>` : ""}
    ${past.length ? `<div class="section-title"><h2>Past trips</h2></div><div class="trips">${past.map(tripCard).join("")}</div>` : ""}
    ${MODE === "device" && own ? `<div id="lockLater"></div>` : ""}
    <a class="fab" href="#/add" aria-label="Add a booking" title="Add a booking">+</a>`;
}

// --- Kos on its own: the first screen, and the device lock as the last step (docs/trips.md §17.4) ----
function welcome() {
  // a made-up flight, drawn by the real flight card (decorative: the page's own look, not a screenshot)
  const demo = { id: 0, kind: "flight", airline: "UA", flight_number: "837", dep_airport: "SFO", arr_airport: "NRT", name: "United",
                 start_at: "2027-03-10T11:05:00-08:00", end_at: "2027-03-11T15:00:00+09:00", dep_terminal: "I", seat: "34K", confirmation: "KOS837" };
  const feature = (k, title, line) => `<li><span class="w-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[k]}</svg></span><b>${title}</b><span>${line}</span></li>`;
  const step = (n, id, label) => `<button type="button" role="tab" class="w-tab" data-wstep="${id}" aria-selected="${n === 1}"><i>${n}</i>${label}</button>`;
  return `<section class="welcome">
    <header class="w-hero">
      <p class="w-kicker">Trips <i></i> Flights <i></i> Journal</p>
      <h1>Every trip,<br />in one calm place.</h1>
      <p class="w-lede">Flights like Flighty, days like Wanderlog, and a journal written for you when you're home.
        Kept in this browser: no account, and your trips go nowhere you don't send them.</p>
      <div class="w-cta"><button type="button" class="w-primary" data-sample>Try a sample trip</button>
        <a class="w-pill" href="#/new"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>New trip</a>
        <a class="w-pill" href="#/add"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH.flight}</svg>Add a booking</a></div>
      <span class="err" id="sampleErr"></span>
    </header>
    <div class="w-visual" aria-hidden="true"><div class="w-card">${flightCard(demo, { compact: true })}</div>
      <div class="w-day"><span class="w-dot"></span><b>Day 2</b><span>Dinner at Sushi Mitsuba · 19:30</span></div></div>
    <ul class="w-features">
      ${feature("flight", "Flights", "Big codes, terminals, seats and their arcs on a map.")}
      ${feature("lodging", "Every day", "Each booking on its day, numbered like the map's pins.")}
      ${feature("event", "A journal", "Written from your trip, with a satellite map and your notes.")}
    </ul>
    <section class="w-setup" aria-label="Set Kos up">
      <h2>Set it up in four steps</h2>
      <div class="w-tabs" role="tablist"><span class="w-thumb" aria-hidden="true"></span>${step(1, "add", "Add")}${step(2, "email", "Email")}${step(3, "home", "Install")}${step(4, "lock", "Lock")}</div>
      <div class="w-panel" data-wpanel="add"><b>Add a trip, or a booking.</b> Type it in, paste a confirmation, or read a PDF or an email file. Bookings without a trip wait until you make one.</div>
      <div class="w-panel" data-wpanel="email" hidden><b>Bookings from your email.</b> Forward confirmations to your Gmail with <b>+kos</b> in the address, and Kos reads them, on your phone too: <a href="#/gmail">set up Gmail</a>. Once Kos is installed on Android, you can also share a PDF or a screenshot to it.</div>
      <div class="w-panel" data-wpanel="home" hidden><b>Put Kos on your home screen.</b> iPhone: Safari's Share button → <b>Add to Home Screen</b>. Android: Chrome's ⋮ menu → <b>Install app</b>.
        <div class="actions" id="installRow" hidden><button type="button" class="w-pill" data-install>Install Kos</button></div></div>
      <div class="w-panel" data-wpanel="lock" hidden><div id="lockStep"><b>Last: lock Kos on this device.</b> <span class="muted">Checking what this device can do…</span></div></div>
    </section>
    <footer class="w-foot">
      <p>Free, with no ads. Trips stay in this browser only, so export a copy now and then (<a href="#/data">Your data</a>). The maps' tiles come from OpenFreeMap and EOX.</p>
      <p>Also from rg-code: <a href="https://milesmaximizer.com/?utm_source=kos" target="_blank" rel="noopener">Miles Maximizer</a>, for point transfers;
        <a href="https://milesmaximizer.com/inkling/?utm_source=kos" target="_blank" rel="noopener">Inkling</a>, for inKind restaurants;
        the <a href="https://milesmaximizer.com/museum_problem/?utm_source=kos" target="_blank" rel="noopener">museum finder</a>, for free museum entry;
        <a href="https://graze.milesmaximizer.com/?utm_source=kos" target="_blank" rel="noopener">GRAZE</a>, for free EV charging;
        and <a href="https://minty.milesmaximizer.com/?utm_source=kos" target="_blank" rel="noopener">Minty</a>, for private money tracking, where Kos also shows what each trip cost.</p>
    </footer></section>`;
}
/** The set-up's pill navigation (after EasyUI's Pill navigation, MIT, as Minty's header and GRAZE's
 * theme switch): one track, a thumb that slides to the step chosen, its panel under it. */
function setupTabs(pick) {
  const tabs = app.querySelector(".w-tabs");
  if (!tabs) return;
  const on = tabs.querySelector(`[data-wstep="${pick}"]`) ?? tabs.querySelector("[aria-selected=true]");
  for (const b of tabs.querySelectorAll("[data-wstep]")) b.setAttribute("aria-selected", String(b === on));
  for (const p of app.querySelectorAll("[data-wpanel]")) p.hidden = p.dataset.wpanel !== on.dataset.wstep;
  const thumb = tabs.querySelector(".w-thumb");
  thumb.style.width = `${on.offsetWidth}px`;
  thumb.style.transform = `translateX(${on.offsetLeft - 4}px)`;
  requestAnimationFrame(() => thumb.setAttribute("data-ready", ""));
}
addEventListener("resize", () => setupTabs());
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; const r = document.getElementById("installRow"); if (r) r.hidden = false; });
/** The lock's step in the set-up, or its card on the home screen once there are trips: what this
 * device can do, and Turn on / Not on this device (public/lock.js, MintyLock). */
async function lockOffer() {
  const step = document.getElementById("lockStep"), later = document.getElementById("lockLater");
  if (!(step || later) || !window.MintyLock) return;
  const st = await window.MintyLock.status();
  const buttons = `<div class="actions"><button type="button" class="btn primary" data-lock-on>Turn on</button><button type="button" class="btn ghost" data-lock-off>Not on this device</button><span class="err" id="lockErr"></span></div>`;
  const why = "Face ID, your fingerprint or this device's screen lock before Kos shows your trips here. Nothing leaves the device.";
  if (step) step.innerHTML = `<b>Last: lock Kos on this device.</b> ${st === "unavailable" ? `<span class="muted">This browser can't use Face ID, a fingerprint or a screen lock here, so there's nothing to turn on.</span>`
    : st === "on" ? `<span class="muted">On: Kos asks before it shows your trips.</span>` : st === "off" ? `<span class="muted">Off on this device.</span><div class="actions"><button type="button" class="btn" data-lock-on>Turn on</button></div>`
    : `Ask for ${why}${buttons}`}`;
  if (later) later.innerHTML = st === "unset" ? `<div class="card lock-later"><b>Last step: lock Kos on this device?</b> <span class="muted">Ask for ${why}</span>${buttons}</div>` : "";
}
const itemTitle = (i) => i.kind === "flight" ? [[i.airline, i.flight_number].filter(Boolean).join(" "), [i.dep_airport, i.arr_airport].filter(Boolean).join(" → ")].filter(Boolean).join(" · ") || "Flight" : i.name || KIND[i.kind];

// --- Wanderlog: the trip ----------------------------------------------------------------------
/** The trip's plan by day: each booking on its day (a stay's check-in and check-out both), numbered
 * per day like Wanderlog, and the same numbers on the map's pins. */
function plan(t) {
  const days = [];
  for (let d = t.start_date; d <= t.end_date; d = addDays(d, 1)) days.push({ date: d, entries: [] });
  const before = [], after = [], unscheduled = [];
  const put = (date, entry) => {
    const day = days.find((x) => x.date === date);
    if (day) day.entries.push(entry); else if (!date) unscheduled.push(entry); else (date < t.start_date ? before : after).push(entry);
  };
  for (const i of t.items) {
    put(dateOf(i.start_at), { item: i, at: timeOf(i.start_at), role: i.kind === "lodging" ? "Check in" : "" });
    if (i.kind === "lodging" && dateOf(i.end_at) && dateOf(i.end_at) !== dateOf(i.start_at)) put(dateOf(i.end_at), { item: i, at: timeOf(i.end_at), role: "Check out", repeat: true });
  }
  for (const d of days) d.entries.sort((a, b) => (a.at || "99") < (b.at || "99") ? -1 : 1);
  days.forEach((d, n) => { d.color = DAY_COLORS[n % DAY_COLORS.length]; let k = 0; for (const e of d.entries) e.n = ++k; });
  return { days, before, after, unscheduled };
}
function entryHtml(e) {
  const i = e.item;
  if (i.kind === "flight" && !e.repeat) return `<div class="stop"><span class="marker">${e.n ?? "·"}</span>${flightCard(i, { compact: true })}</div>`;
  const where = [i.place, i.confirmation ? `Conf. ${i.confirmation}` : ""].filter(Boolean).join(" · ");
  return `<div class="stop"><span class="marker">${e.n ?? "·"}</span><button type="button" class="item" data-item="${i.id}">
    <div class="row1"><span class="what"><span class="kind">${esc(e.role || KIND[i.kind])}</span> ${esc(i.name || KIND[i.kind])}</span><span class="at">${esc(e.at)}</span></div>
    ${where ? `<div class="sub">${esc(where)}</div>` : ""}${!e.repeat && (i.price_cents || i.points) ? `<div class="sub">${i.points ? `${i.points.toLocaleString()} pts` : money(i.price_cents, i.currency)}</div>` : ""}</button></div>`;
}
// --- the trip's summary strip (Wanderlog's "Reservations" and "Budgeting"): a count per kind of
// booking, each a way to add one, and what the trip cost. Icons: Material Icons (Apache 2.0).
const GLYPH = {
  flight: `<path transform="rotate(90 12 12)" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>`,
  lodging: `<path d="M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4z"/>`,
  car: `<path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/>`,
  train: `<path d="M12 2c-4 0-8 .5-8 4v9.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h2.23l2-2H14l2 2h2v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-3.58-4-8-4zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm3.5-7H6V6h5v4zm2 0V6h5v4h-5zm3.5 7c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>`,
  restaurant: `<path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/>`,
  event: `<path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2zm-4.42 4.8L12 14.5l-3.58 2.3 1.08-4.12-3.29-2.69 4.24-.25L12 5.8l1.54 3.95 4.24.25-3.29 2.69 1.09 4.11z"/>`,
  other: `<path d="M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>`,
};
function summaryHtml(t) {
  const { count, money: m } = tripSummary(t, store.spending);
  const kinds = SUM_KINDS.map(([k, label]) => `<a class="sum-kind" href="#/add?trip=${t.id}&kind=${k}" title="Add a ${label.toLowerCase()} booking">
      <span class="sum-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[k]}</svg>${count[k] ? `<b class="sum-n">${count[k]}</b>` : ""}</span><span class="sum-label">${label}</span></a>`).join("");
  const off = tripTags(t).filter(leftOutTag);
  const budget = m.spent !== undefined
    ? `<div class="sum-amt num">${money(m.spent)}</div><div class="muted sum-sub">${m.transactions ? `${m.transactions} transaction${m.transactions === 1 ? "" : "s"}${off.length ? ", left out of CFA" : ""}` : "no transactions linked yet"}</div>
       <a class="sum-more" href="#/trip/${t.id}/spending">View details</a>`
    : (() => { const cur = Object.entries(m.booked); return cur.length
        ? `<div class="sum-amt num">${money(cur[0][1], cur[0][0])}</div><div class="muted sum-sub">booked${cur.length > 1 ? `, plus ${cur.slice(1).map(([c, v]) => money(v, c)).join(", ")}` : ""}, from the bookings' prices</div>`
        : `<div class="sum-amt num muted">—</div><div class="muted sum-sub">add prices to the bookings to see what it costs</div>`; })();
  return `<div class="summary"><section class="card sum-res"><h3>Reservations</h3><div class="sum-kinds">${kinds}</div></section>
    <section class="card sum-budget"><h3>Budgeting</h3>${budget}</section></div>`;
}

/** Trip tags (docs/trips.md §18): whether a tag is one CFA leaves out of the numbers. */
const leftOutTag = (tag) => (data?.left_out_tags ?? []).some((x) => x.toLowerCase() === tag.toLowerCase());
const tripTags = (t) => (store.spending ? t.tags ?? [] : []);
const tagChips = (tags) => tags.length ? `<div class="trip-tags">${tags.map((g) => `<span class="pill ${leftOutTag(g) ? "warn" : "dim"}" title="${leftOutTag(g) ? "Left out of CFA and the dashboard's totals" : "Its transactions have this tag"}">${esc(g)}${leftOutTag(g) ? " · left out" : ""}</span>`).join("")}</div>` : "";
function tripView(t, tab) {
  const p = plan(t);
  const tabs = [["", "Itinerary"], ["flights", "Flights"], ...(store.spending ? [["spending", "Spending"]] : [])];
  const flights = t.items.filter((i) => i.kind === "flight").sort((a, b) => ((a.start_at ?? "") < (b.start_at ?? "") ? -1 : 1));
  let body;
  if (tab === "flights") body = flights.length ? flights.map((f) => flightCard(f)).join("") : `<div class="card muted">No flights in this trip yet.</div>`;
  else if (tab === "spending") body = `<div id="spending"><p class="muted">Loading the trip's spending…</p></div>`;
  else body = `${p.before.length ? dayHtml({ label: "Before the trip", entries: p.before, color: "#8c96ad" }) : ""}
    ${p.days.map((d, n) => dayHtml({ label: `Day ${n + 1}`, sub: fmtDay(d.date), entries: d.entries, color: d.color })).join("")}
    ${p.after.length ? dayHtml({ label: "After the trip", entries: p.after, color: "#8c96ad" }) : ""}
    ${p.unscheduled.length ? dayHtml({ label: "No date yet", entries: p.unscheduled, color: "#8c96ad" }) : ""}`;
  return `<section class="trip-head"><div class="cover" style="--h:${hue(t.name)}">
      <div class="cover-actions"><a class="btn small" href="#/trip/${t.id}/journal">Journal</a><a class="btn small" href="#/trip/${t.id}/edit">Edit</a><a class="btn small" href="#/add?trip=${t.id}">Add booking</a></div>
      <h1>${esc(t.name)}</h1><div class="when">${esc(fmtDay(t.start_date))} – ${esc(fmtDay(t.end_date))}, ${t.end_date.slice(0, 4)}${t.place ? ` · ${esc(t.place)}` : ""}</div>
      ${t.travellers.length ? `<div class="avatars">${t.travellers.map((k) => `<span title="${esc(label(k))}">${esc(label(k).slice(0, 1).toUpperCase())}</span>`).join("")}</div>` : ""}
      ${tagChips(tripTags(t))}</div></section>
    ${summaryHtml(t)}
    <div class="trip"><div class="plan">
      <div class="tabs"><div class="seg" role="group">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${(tab || "") === k}">${l}</button>`).join("")}</div></div>
      ${body}</div>
      <div class="mapwrap"><div class="map" id="map"></div><div class="map-note" id="mapNote" hidden></div></div></div>
    <a class="fab" href="#/add?trip=${t.id}" aria-label="Add a booking" title="Add a booking">+</a>`;
}
function dayHtml({ label: l, sub, entries, color }) {
  return `<section class="day" style="--day:${color}"><div class="day-head"><span class="day-dot"></span><h3>${esc(l)}</h3>${sub ? `<span class="muted">${esc(sub)}</span>` : ""}</div>
    <div class="stops">${entries.length ? entries.map(entryHtml).join("") : `<div class="empty-day">Nothing planned yet.</div>`}</div></section>`;
}
/** What the map draws for a trip: each flight's arc, and numbered pins in their day's colour. */
function mapData(t) {
  const p = plan(t), arcs = [], pins = [];
  p.days.forEach((d) => {
    for (const e of d.entries) {
      const i = e.item;
      if (i.kind === "flight") {
        const a = airport(i.dep_airport), b = airport(i.arr_airport);
        if (a && b && !e.repeat) arcs.push({ from: [a.lon, a.lat], to: [b.lon, b.lat], id: String(i.id), label: `${i.dep_airport}→${i.arr_airport}` });
        if (a && !e.repeat) pins.push({ lon: a.lon, lat: a.lat, kind: "flight", label: `${e.n} ${i.dep_airport}`, id: String(i.id), color: d.color });
      } else if (Number.isFinite(i.lat) && Number.isFinite(i.lon) && !e.repeat) pins.push({ lon: i.lon, lat: i.lat, kind: i.kind, label: `${e.n} ${i.name ?? ""}`.trim(), id: String(i.id), color: d.color });
    }
  });
  // flights outside the trip's days (the flight home after the last day, say) still draw
  for (const e of [...p.before, ...p.after]) {
    const i = e.item, a = airport(i.dep_airport), b = airport(i.arr_airport);
    if (i.kind === "flight" && a && b) arcs.push({ from: [a.lon, a.lat], to: [b.lon, b.lat], id: String(i.id) });
  }
  if (!arcs.length && !pins.length && Number.isFinite(t.lat) && Number.isFinite(t.lon)) pins.push({ lon: t.lon, lat: t.lat, kind: "other", label: t.place ?? t.name });
  return { arcs, pins };
}
async function showMap(t, tab = "") {
  const el = document.getElementById("map"), note = document.getElementById("mapNote");
  if (!el) return;
  const dark = document.documentElement.dataset.theme !== "light";
  const key = `${t.id}:${dark}`;
  if (map && mapKey === key && map.getContainer() === el) return;
  if (map) { map.remove(); map = null; }
  map = await createMap(el, { dark });
  mapKey = key;
  if (!map) { note.hidden = false; note.textContent = "The map couldn't load here (it needs WebGL and OpenFreeMap's tiles). The plan is all here."; return; }
  const d = mapData(t);
  // pins take their day's colour (Wanderlog), flights the accent (Flighty)
  drawTrip(map, d, (id) => {
    const card = app.querySelector(`[data-item="${CSS.escape(id)}"]`);
    if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); card.animate?.([{ outline: "2px solid var(--accent)" }, { outline: "2px solid transparent" }], 1200); }
  }, tab === "flights" ? "all" : "pins", dark);
}

// --- the trip's spending ----------------------------------------------------------------------
async function spending(t) {
  const box = document.getElementById("spending");
  try {
    const [s, rows] = await Promise.all([store.suggestions(t.id), store.transactions(t.id)]);
    const out = rows.filter((r) => r.amount > 0), total = Math.round(out.reduce((a, r) => a + r.amount, 0) * 100);
    const byCat = {};
    for (const r of out) byCat[r.category ?? "OTHER"] = (byCat[r.category ?? "OTHER"] ?? 0) + Math.round(r.amount * 100);
    const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]), top = cats[0]?.[1] ?? 1;
    const days = Math.max(1, Math.round((asDay(t.end_date) - asDay(t.start_date)) / 864e5) + 1);
    const sug = (list, title, why) => list.length ? `<div class="section-title"><h2>${title}</h2><span class="muted">${why}</span></div>
      <div class="list">${list.map((r) => `<label class="row"><input type="checkbox" data-sug="${r.id}" checked /><span class="grow"><b>${esc(r.name)}</b><span class="muted">${esc(fmtDay(r.date))} · ${esc(r.account_name ?? "")}${r.account_mask ? ` ••${esc(r.account_mask)}` : ""}</span></span><span class="amt">${money(r.amount_cents, r.currency)}</span></label>`).join("")}</div>` : "";
    const booked = s.booked.flatMap((b) => b.matches.map((m) => ({ ...m, name: `${m.name} (for ${b.item})` })));
    const any = s.during.length + s.also.length + booked.length;
    box.innerHTML = `<div class="card"><div class="muted">Spent on this trip</div><div class="total num">${money(total)}</div>
        <div class="muted">${out.length} transactions · ${money(Math.round(total / days))} a day</div>
        ${(() => { const off = tripTags(t).filter(leftOutTag); return off.length ? `<p class="pill warn" style="white-space:normal;display:inline-block;margin:10px 0 0">Tagged ${off.map((g) => `“${esc(g)}”`).join(", ")}: these are left out of CFA and the dashboard's totals.</p>` : ""; })()}
        ${cats.length ? `<div class="bars" style="margin-top:14px">${cats.map(([c, v]) => `<div class="b"><span>${esc(CAT[c] ?? c.replace(/_/g, " ").toLowerCase())}</span><i style="width:${Math.max(4, Math.round((v / top) * 100))}%"></i><span class="num">${money(v)}</span></div>`).join("")}</div>` : ""}
        <div class="actions"><a class="btn small" href="/?trip=${t.id}">Open in Minty</a></div></div>
      ${any ? `${sug(s.during, "Suggested", "travel, food, transport and activities during the trip")}${sug(booked, "Booked before", "charges matching a booking's price")}${sug(s.also, "Also during the trip", "everything else on those days")}
        <div class="actions"><button type="button" class="btn primary" data-sug-add>Add the ticked ones</button><button type="button" class="btn" data-sug-dismiss>Not this trip</button><span class="err" id="sugErr"></span></div>` : `<p class="muted">Nothing more to suggest from ${esc(fmtShort(s.from))} to ${esc(fmtShort(s.to))}.</p>`}
      ${out.length ? `<div class="section-title"><h2>In this trip</h2></div><div class="list">${rows.map((r) => `<div class="row"><span class="grow"><b>${esc(r.merchant_name || r.name)}</b><span class="muted">${esc(fmtDay(r.date))} · ${esc(CAT[r.category] ?? "")}</span></span><span class="amt">${money(Math.round(r.amount * 100), r.currency)}</span><button type="button" class="btn small ghost" data-unlink="${r.id}">Remove</button></div>`).join("")}</div>` : ""}`;
  } catch (e) { box.innerHTML = `<p class="err">Couldn't load the spending: ${esc(e.message)}</p>`; }
}

// --- the trip journal (docs/trips.md §20): written from the bookings, with the household's notes --
function journalView(t) {
  const st = tripStats(t, airports), p = plan(t);
  const stat = (n, l) => `<div class="j-stat"><b class="num">${n}</b><span>${l}</span></div>`;
  const note = (day, hint) => `<div class="j-note"><textarea class="j-text" data-note="${day}" rows="2" maxlength="5000" placeholder="${esc(hint)}"></textarea><span class="j-saved muted" data-saved="${day}"></span></div>`;
  const day = (title, date, entries, color) => {
    const lines = entries.map((e) => `<li>${esc(lineFor(e, airports))}${e.at ? `<span class="muted"> · ${esc(e.at)}</span>` : ""}</li>`).join("");
    return `<section class="j-day" style="--day:${color}"><div class="day-head"><span class="day-dot"></span><h3>${esc(title)}</h3>${date ? `<span class="muted">${esc(fmtDay(date))}</span>` : ""}</div>
      ${lines ? `<ul class="j-lines">${lines}</ul>` : `<p class="muted j-free">Nothing booked: a free day.</p>`}
      ${date ? `<div class="j-spend muted" data-spend="${date}"></div>${note(date, "What happened today?")}` : ""}</section>`;
  };
  return `<article class="journal">
    <header class="j-hero" style="--h:${hue(t.name)}"><div class="j-kicker">Trip journal</div><h1>${esc(t.name)}</h1>
      <div class="when">${esc(fmtDay(t.start_date))} – ${esc(fmtDay(t.end_date))}, ${t.end_date.slice(0, 4)}${t.place ? ` · ${esc(t.place)}` : ""}</div>
      <div class="j-stats">${stat(st.days, st.days === 1 ? "day" : "days")}${st.flights ? stat(st.flights, st.flights === 1 ? "flight" : "flights") : ""}${st.km ? stat(st.km.toLocaleString(), "km flown") : ""}${st.countries > 1 ? stat(st.countries, "countries") : ""}${st.places ? stat(st.places, st.places === 1 ? "place" : "places") : ""}<span id="jSpent"></span></div>
      <div class="j-actions"><a class="btn small" href="#/trip/${t.id}">Back to the trip</a><button type="button" class="btn small" data-print>Print or save as PDF</button></div></header>
    ${note("trip", "How was it? A few lines to remember it by.")}
    <div class="j-map"><div id="jmap" class="map"></div><div class="map-note" id="jmapNote" hidden></div></div>
    <p class="j-credit muted">Satellite: <a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024). Names: OpenFreeMap, OpenMapTiles, OpenStreetMap.</p>
    ${p.before.length ? day("Getting there", null, p.before, "#8c96ad") : ""}
    ${p.days.map((d, n) => day(`Day ${n + 1}`, d.date, d.entries, d.color)).join("")}
    ${p.after.length ? day("Getting home", null, p.after, "#8c96ad") : ""}
    ${p.unscheduled.length ? day("Also booked", null, p.unscheduled, "#8c96ad") : ""}
  </article>`;
}
const grow = (el) => { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; };
async function journalLoad(t) {
  // the notes, and the journal marked opened
  try {
    const j = await store.journal(t.id);
    for (const el of app.querySelectorAll("[data-note]")) { el.value = j.notes[el.dataset.note] ?? ""; grow(el); }
    if (!j.seen_at) { store.saveJournal(t.id, { seen: true }).catch(() => {}); t.journal_seen_at = "now"; }
  } catch (e) { app.querySelector(".j-hero").insertAdjacentHTML("beforeend", `<p class="err">Couldn't load the notes: ${esc(e.message)}</p>`); }
  // on a Minty, what each day cost
  if (store.spending && t.transactions) {
    store.transactions(t.id).then((rows) => {
      const total = rows.filter((r) => r.amount > 0).reduce((a, r) => a + Math.round(r.amount * 100), 0);
      const off = tripTags(t).filter(leftOutTag);
      document.getElementById("jSpent").outerHTML = `<div class="j-stat"><b class="num">${money(total)}</b><span>spent${off.length ? ", left out of CFA" : ""}</span></div>`;
      for (const el of app.querySelectorAll("[data-spend]")) {
        const d = daySpend(rows, el.dataset.spend);
        if (d.cents) el.textContent = `Spent ${money(d.cents)}${d.top.length ? `: ${d.top.join(", ")}` : ""}`;
      }
    }).catch(() => {});
  }
  // the map: satellite, the flights, and each day's stops joined in its colour
  const el = document.getElementById("jmap");
  map = await createMap(el, { dark: true, satellite: true });
  if (!document.body.contains(el)) { map?.remove(); map = null; return; }
  if (!map) { const n = document.getElementById("jmapNote"); n.hidden = false; n.textContent = "The map couldn't load here (it needs WebGL, and the satellite and map tiles)."; return; }
  const d = mapData(t), paths = [];
  for (const dd of plan(t).days) {
    const pts = dd.entries.filter((e) => e.item.kind !== "flight" && !e.repeat && Number.isFinite(e.item.lat) && Number.isFinite(e.item.lon)).map((e) => [e.item.lon, e.item.lat]);
    if (pts.length > 1) paths.push({ coords: pts, color: dd.color });
  }
  drawTrip(map, { ...d, paths }, null, d.pins.length ? "pins" : "all", true);    // the places, like the itinerary; flights only when there are none
  el.querySelector(".maplibregl-compact-show")?.classList.remove("maplibregl-compact-show");   // the credits fold behind ⓘ; EOX's is also under the map
  mapKey = `journal:${t.id}`;
}
let noteTimers = {};
app.addEventListener("input", (ev) => {
  const el = ev.target.closest?.("[data-note]");
  if (!el) return;
  grow(el);
  const tid = Number(route().parts[1]), day = el.dataset.note, saved = app.querySelector(`[data-saved="${day}"]`);
  clearTimeout(noteTimers[day]);
  if (saved) saved.textContent = "";
  noteTimers[day] = setTimeout(async () => {
    try { await store.saveJournal(tid, { day, text: el.value }); if (saved) saved.textContent = "Saved"; }
    catch (e) { if (saved) saved.textContent = `Not saved: ${e.message}`; }
  }, 700);
});

// --- forms --------------------------------------------------------------------------------------
/** The trip form's tag suggestions: the household's tags (left-out ones first), a tap adds one. */
async function tagPicker() {
  const box = document.getElementById("tagPick");
  if (!box) return;
  const all = await store.tags();
  const list = [...new Set([...(data?.left_out_tags ?? []), ...all])].slice(0, 30);
  box.innerHTML = list.map((g) => `<button type="button" class="pill ${leftOutTag(g) ? "warn" : "dim"}" data-add-tag="${esc(g)}">+ ${esc(g)}${leftOutTag(g) ? " · left out" : ""}</button>`).join("");
}
const splitTags = (v) => [...new Map(String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => [x.toLowerCase(), x])).values()];
function tripForm(t, picked = []) {
  return `<div class="section-title"><h2>${t ? "Edit trip" : "New trip"}</h2></div>
    <form class="card" id="tripForm" data-id="${t?.id ?? ""}" data-items="${picked.join(",")}"><div class="form">
      <label class="wide">Name<input name="name" required maxlength="100" value="${esc(t?.name ?? "")}" placeholder="Tokyo, spring 2027" /></label>
      <label>First day<input name="start_date" type="date" required value="${esc(t?.start_date ?? "")}" /></label>
      <label>Last day<input name="end_date" type="date" required value="${esc(t?.end_date ?? "")}" /></label>
      <label class="wide">Where<input name="place" maxlength="150" value="${esc(t?.place ?? "")}" placeholder="Tokyo, Japan" /></label>
      ${users.length ? `<div class="wide"><div class="muted" style="font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Who's going</div>${users.map((u) => `<label class="check"><input type="checkbox" name="trav" value="${esc(u.key)}"${(t?.travellers ?? users.map((x) => x.key)).includes(u.key) ? " checked" : ""} /> ${esc(u.label)}</label>`).join("")}</div>` : ""}
      ${store.spending ? `<div class="wide"><label>Tags<input name="tags" maxlength="400" value="${esc((t?.tags ?? []).join(", "))}" placeholder="reimbursed, work" autocomplete="off" /></label>
        <p class="muted" style="margin:6px 0 0;font-size:13px">The trip's transactions get these tags too, and new ones as you add them. A tag CFA leaves out of the numbers (like “reimbursed”) leaves the trip's spending out of CFA and the dashboard's totals. Taking a tag off takes it off what the trip tagged; a tag you added yourself stays.</p>
        <div class="trip-tags" id="tagPick"></div></div>` : ""}
      <label class="wide">Notes<textarea name="notes" rows="3" maxlength="2000">${esc(t?.notes ?? "")}</textarea></label>
    </div><div class="actions"><button class="btn primary" type="submit">${t ? "Save" : "Make the trip"}</button><a class="btn ghost" href="${t ? `#/trip/${t.id}` : "#/"}">Cancel</a>
      ${t ? `<button type="button" class="btn danger" data-del-trip="${t.id}">Delete trip</button>` : ""}<span class="err" id="formErr"></span></div></form>`;
}

let draft = null;   // a booking being added: fields suggested from an email, paste, PDF or screenshot
function itemForm(i, tripId) {
  const v = (k) => esc(i?.[k] ?? "");
  const kind = i?.kind ?? "flight";
  const trips = data.trips.filter((t) => t.end_date >= addDays(localDay(), -365));
  return `<form class="card" id="itemForm" data-id="${i?.id ?? ""}" data-source="${esc(i?.source ?? "typed")}" data-sha="${esc(i?.source_sha256 ?? "")}" data-lat="${i?.lat ?? ""}" data-lon="${i?.lon ?? ""}"
      data-start-off="${esc(offsetOf(i?.start_at))}" data-end-off="${esc(offsetOf(i?.end_at))}"><div class="form">
    <label>Kind<select name="kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}"${kind === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
    <label>Trip<select name="trip_id"><option value="">No trip yet</option>${trips.map((t) => `<option value="${t.id}"${(i?.trip_id ?? tripId) === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
    <label class="wide"><span data-name-label>${NAME_LABEL[kind]}</span><input name="name" maxlength="150" value="${v("name")}" /></label>
    <div class="wide form" data-flight ${kind === "flight" ? "" : "hidden"}>
      <label>Airline code<input name="airline" maxlength="3" value="${v("airline")}" placeholder="UA" /></label>
      <label>Flight number<input name="flight_number" maxlength="5" inputmode="numeric" value="${v("flight_number")}" placeholder="837" /></label>
      <label>From<input name="dep_airport" maxlength="3" value="${v("dep_airport")}" placeholder="SFO" /></label>
      <label>To<input name="arr_airport" maxlength="3" value="${v("arr_airport")}" placeholder="NRT" /></label>
      <label>Terminal<input name="dep_terminal" maxlength="10" value="${v("dep_terminal")}" /></label>
      <label>Gate<input name="dep_gate" maxlength="10" value="${v("dep_gate")}" /></label>
      <label>Seat<input name="seat" maxlength="10" value="${v("seat")}" /></label>
    </div>
    <label><span data-start-label>${kind === "lodging" ? "Check in" : kind === "flight" ? "Departs" : "Starts"}</span><input name="start_date" type="date" value="${esc(dateOf(i?.start_at) ?? "")}" /></label>
    <label>Time<input name="start_time" type="time" value="${esc(timeOf(i?.start_at))}" /></label>
    <label><span data-end-label>${kind === "lodging" ? "Check out" : kind === "flight" ? "Arrives" : "Ends"}</span><input name="end_date" type="date" value="${esc(dateOf(i?.end_at) ?? "")}" /></label>
    <label>Time<input name="end_time" type="time" value="${esc(timeOf(i?.end_at))}" /></label>
    <label class="wide">Address or place<input name="place" maxlength="200" value="${v("place")}" /></label>
    <label>Confirmation<input name="confirmation" maxlength="40" value="${v("confirmation")}" /></label>
    <label>Price<input name="price" inputmode="decimal" value="${i?.price_cents ? i.price_cents / 100 : ""}" /></label>
    <label>Currency<input name="currency" maxlength="3" value="${esc(i?.currency ?? "USD")}" /></label>
    <label>Or points<input name="points" inputmode="numeric" value="${v("points")}" /></label>
    <label>Program<select name="points_program" data-programs><option value="">—</option>${(programs ?? (i?.points_program ? [{ id: i.points_program, name: i.points_program }] : [])).map((p) => `<option value="${esc(p.id)}"${i?.points_program === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
    <label class="wide">Notes<textarea name="notes" rows="2" maxlength="2000">${v("notes")}</textarea></label>
  </div><div class="actions"><button class="btn primary" type="submit">${i?.id ? "Save" : "Add booking"}</button>
    <a class="btn ghost" href="${tripId || i?.trip_id ? `#/trip/${i?.trip_id ?? tripId}` : "#/"}">Cancel</a>
    ${i?.id ? `<button type="button" class="btn danger" data-del-item="${i.id}">Delete</button>` : ""}<span class="err" id="formErr"></span></div></form>`;
}
const offsetOf = (s) => (s ? (/(Z|[+-]\d{2}:?\d{2})$/.exec(s)?.[1] ?? "") : "");

function addView(tripId, source) {
  const sources = [["type", "Type it"], ["gmail", "Gmail"], ["paste", "Paste"], ["pdf", "PDF"], ["shot", "Screenshot"], ["email", "Email file"]];
  return `<div class="section-title"><h2>Add a booking</h2><span class="muted">${tripId ? esc(tripById(tripId)?.name ?? "") : ""}</span></div>
    <div class="seg" role="group" style="margin-bottom:14px">${sources.map(([k, l]) => `<button type="button" data-source="${k}" aria-pressed="${source === k}">${l}</button>`).join("")}</div>
    <div id="sourceBox">${sourceBox(source)}</div>
    <div id="suggestBox"></div>
    <div id="formBox">${itemForm(draft, tripId)}</div>`;
}
function sourceBox(source) {
  if (source === "gmail") return gmail.config()
    ? `<div class="card"><p class="muted" style="margin-top:0">Bookings you've forwarded to your Gmail's <b>Kos</b> label, read with your Gmail script (<a href="#/gmail">set-up</a>).</p>
        <div class="actions"><button type="button" class="btn primary" data-gmail-pull>Check Gmail</button></div></div>`
    : `<div class="card"><p style="margin-top:0"><b>Read bookings from your Gmail.</b> Forward confirmations to your Gmail with <b>+kos</b> in the address, and Kos reads them from there, from any device, with no server.</p>
        <div class="actions"><a class="btn primary" href="#/gmail">Set it up (about 5 minutes)</a></div></div>`;
  if (source === "paste") return `<div class="card"><textarea class="paste" id="pasteText" placeholder="Paste a confirmation: the flight's number, airports, dates and times, or a stay's check-in and check-out"></textarea>
    <div class="actions"><button type="button" class="btn primary" data-read-paste>Find the booking</button></div></div>`;
  if (source === "pdf") return `<div class="card"><p class="muted" style="margin-top:0">The PDF is read here, on this device; nothing is uploaded.</p><input type="file" accept="application/pdf,.pdf" id="pdfFile" /></div>`;
  if (source === "shot") return `<div class="card"><p class="muted" style="margin-top:0">A screenshot is read on this device too. On a phone, copying the text out of it (Live Text, Lens) and pasting is quickest.</p>
    <div class="actions"><button type="button" class="btn primary" data-scan>Read a screenshot</button></div></div>`;
  if (source === "email") return `<div class="card"><p class="muted" style="margin-top:0">An email file (in Gmail: open the email → ⋮ → Download message). ${MODE === "device" ? "It's read here, on this device" : "Minty reads its booking details"}, and nothing is kept until you add them.</p><input type="file" accept=".eml,message/rfc822" id="emlFile" /></div>`;
  return "";
}
function suggestionsHtml(list, from) {
  if (!list.length) return `<div class="suggest muted">${from === "gmail" ? "No new bookings in your Kos label." : "Nothing recognisable there: fill the form in yourself."}</div>`;
  return `<div class="suggest"><b>Found ${list.length} booking${list.length === 1 ? "" : "s"}</b> (check each):<div class="list" style="margin-top:8px">${list.map((b, n) => `<div class="row"><span class="grow"><b>${esc(itemTitle(b))}</b>
      <span class="muted">${esc(KIND[b.kind] ?? "")} · ${esc(fmtDay(dateOf(b.start_at ?? b.start)) || "no date")}${b.confirmation ? ` · ${esc(b.confirmation)}` : ""}</span>${b.quote ? `<q>${esc(b.quote)}</q>` : ""}</span>
      <button type="button" class="btn small" data-use="${n}">Use</button>${from === "email" || from === "gmail" ? `<button type="button" class="btn small primary" data-add-now="${n}">Add</button>` : ""}</div>`).join("")}</div>
    ${(from === "email" || from === "gmail") && list.length > 1 ? `<div class="actions"><button type="button" class="btn primary" data-add-all>Add all ${list.length}</button></div>` : ""}</div>`;
}
let found = [], foundFrom = "", pulled = [], tabSwitch = false;
/** A suggestion (from the email reader or kos-parse.js) as the booking API's fields. */
function asItem(b, tripId) {
  const out = { kind: b.kind, trip_id: tripId ?? null, name: b.name ?? null, confirmation: b.confirmation ?? null, guest: b.guest ?? null,
    start_at: b.start ?? b.start_at ?? null, end_at: b.end ?? b.end_at ?? null, place: b.place ?? null, lat: b.lat ?? null, lon: b.lon ?? null,
    price_cents: b.price_cents ?? null, currency: b.currency ?? null, points: b.points ?? null };
  const f = b.flight ?? b;
  if (b.kind === "flight") Object.assign(out, { airline: f.airline ?? null, flight_number: f.number ?? f.flight_number ?? null, dep_airport: f.from ?? f.dep_airport ?? null,
    arr_airport: f.to ?? f.arr_airport ?? null, dep_terminal: f.terminal ?? f.dep_terminal ?? null, dep_gate: f.gate ?? f.dep_gate ?? null, seat: f.seat ?? null });
  for (const k of Object.keys(out)) if (out[k] === undefined) out[k] = null;
  // the API takes local times like 2027-03-10T11:05(:00)(+09:00); trim anything finer
  for (const k of ["start_at", "end_at"]) if (out[k]) out[k] = String(out[k]).replace(/(\.\d+)(?=Z|[+-]|$)/, "");
  if (out.airline && !/^[A-Z0-9]{2,3}$/i.test(out.airline)) { out.name ??= out.airline; out.airline = null; }
  return out;
}
async function readText(text, source) {
  const { parseBookings } = await import("./kos-parse.js");
  const year = new Date().getFullYear();
  found = parseBookings(text, { year, isAirport: (c) => Boolean(airports[c]) }).bookings.map((b) => ({ ...b, source }));
  foundFrom = source;
  document.getElementById("suggestBox").innerHTML = suggestionsHtml(found, source);
}

async function itemBody(f) {
  const e = f.elements;
  const when = (d, t, off) => (d ? (t ? `${d}T${t}${off}` : d) : null);
  const cents = (s) => { const t = String(s ?? "").replace(/[^\d.]/g, ""); return t ? Math.round(Number(t) * 100) : null; };
  const int = (s) => { const t = String(s ?? "").replace(/[^\d]/g, ""); return t ? Number(t) : null; };
  const flight = e.kind.value === "flight";
  const lat = f.dataset.lat === "" ? null : Number(f.dataset.lat), lon = f.dataset.lon === "" ? null : Number(f.dataset.lon);
  return {
    kind: e.kind.value, trip_id: e.trip_id.value ? Number(e.trip_id.value) : null, name: e.name.value, confirmation: e.confirmation.value,
    start_at: when(e.start_date.value, e.start_time.value, f.dataset.startOff), end_at: when(e.end_date.value, e.end_time.value, f.dataset.endOff),
    place: e.place.value, price_cents: cents(e.price.value), currency: e.currency.value || null, points: int(e.points.value), points_program: e.points_program.value || null,
    notes: e.notes.value, lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
    airline: flight ? e.airline.value : null, flight_number: flight ? e.flight_number.value : null, dep_airport: flight ? e.dep_airport.value : null, arr_airport: flight ? e.arr_airport.value : null,
    dep_terminal: flight ? e.dep_terminal.value : null, dep_gate: flight ? e.dep_gate.value : null, seat: flight ? e.seat.value : null,
    source: f.dataset.source || "typed", ...(f.dataset.sha ? { source_sha256: f.dataset.sha } : {}),
  };
}

/** A calendar file for a flight, made in the browser: an instant (UTC) when the booking had offsets,
 * else floating local time. */
function ics(f) {
  const stamp = (s) => { const t = instant(s); return t ? new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "") : (s ?? "").replace(/[-:]/g, "").slice(0, 15) + (s && s.length >= 16 ? "00" : ""); };
  const title = `${[f.airline, f.flight_number].filter(Boolean).join(" ")} ${f.dep_airport ?? ""} → ${f.arr_airport ?? ""}`.trim();
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Minty//Kos//EN", "BEGIN:VEVENT", `UID:kos-${f.id}@minty`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")}`,
    `DTSTART:${stamp(f.start_at)}`, ...(f.end_at ? [`DTEND:${stamp(f.end_at)}`] : []), `SUMMARY:${title.replace(/[,;]/g, " ")}`,
    `DESCRIPTION:${["Confirmation " + (f.confirmation ?? "—"), f.seat ? `Seat ${f.seat}` : ""].filter(Boolean).join(" · ")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([body], { type: "text/calendar" })), download: `${title.replace(/\W+/g, "-") || "flight"}.ics` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// --- your data: export and import (both modes; how device-only trips move into a Minty) --------
function dataView() {
  const n = data.trips.length, b = data.trips.reduce((s, t) => s + t.items.length, 0) + data.unassigned.length;
  return `<div class="section-title"><h2>Your data</h2></div>
    <div class="card">${MODE === "device"
      ? `<p style="margin-top:0"><b>Kos on its own.</b> Your trips are kept in this browser on this device, and nothing is sent anywhere. The map's tiles come from OpenFreeMap.</p>
         <p class="muted">Clearing this site's data, or a private window, loses them. Export a copy now and then. To use Kos on another device, export here and import there.</p>
         <p class="muted">With a <a href="https://minty.milesmaximizer.com/">Minty</a> of your own, Kos also shows each trip's spending, and an import brings these trips across.</p>`
      : `<p style="margin-top:0"><b>Kos on your Minty.</b> Trips are kept in your Minty's database. Import brings in trips exported from Kos on another device or from Kos on its own.</p>`}
      <p class="muted">${n} trip${n === 1 ? "" : "s"} and ${b} booking${b === 1 ? "" : "s"} here.</p>
      <div class="actions"><button type="button" class="btn primary" data-export>Export (a JSON file)</button>
        <label class="btn">Import…<input type="file" accept="application/json,.json" id="importFile" hidden /></label><span class="err" id="formErr"></span></div></div>`;
}
async function doImport(file) {
  const r = await importData(JSON.parse(await file.text()));
  return { trips: r.trips.length, items: r.items.length };
}
/** A Kos export's trips and bookings into this store, bookings re-tied to their trips; the new ids. */
async function importData(obj) {
  const parsed = importFile(obj);
  const ids = new Map(), items = [];
  for (const { old, trip } of parsed.trips) ids.set(old, (await store.saveTrip(null, trip)).id);
  for (const { oldTrip, item } of parsed.items) items.push((await store.saveItem(null, { ...item, trip_id: oldTrip !== null && ids.has(oldTrip) ? ids.get(oldTrip) : null })).id);
  for (const n of parsed.notes ?? []) if (ids.has(n.oldTrip)) await store.saveJournal(ids.get(n.oldTrip), { day: n.day, text: n.text }).catch(() => {});   // the journal's notes
  return { trips: [...ids.values()], items };
}

// --- Kos on its own: the sample trips (docs/trips.md §17.3) -----------------------------------
const SAMPLE = "kos-sample";
const sampleIds = () => { try { return JSON.parse(localStorage.getItem(SAMPLE) ?? "null"); } catch { return null; } };
async function loadSample() {
  const r = await fetch("/kos/sample.json");
  if (!r.ok) throw new Error("The sample trips couldn't load.");
  const ids = await importData(shiftSample(await r.json(), localDay()));
  try { localStorage.setItem(SAMPLE, JSON.stringify(ids)); } catch { /* they stay; removed by hand */ }
}
async function removeSample() {
  const ids = sampleIds();
  if (!ids) return;
  for (const id of ids.items ?? []) await store.deleteItem(id).catch(() => {});
  for (const id of ids.trips ?? []) await store.deleteTrip(id).catch(() => {});
  try { localStorage.removeItem(SAMPLE); } catch { /* none */ }
}

// --- Gmail pull: its set-up (docs/trips.md §17.1) ---------------------------------------------
function gmailView() {
  const c = gmail.config(), key = c?.key ?? gmail.pendingKey();
  const step = (n, title, body) => `<div class="card" style="margin-bottom:12px"><div class="muted" style="font-size:12px;font-weight:750;letter-spacing:.06em;text-transform:uppercase">Step ${n}</div><h3 style="margin:4px 0 8px">${title}</h3>${body}</div>`;
  const copy = (id, text, rows) => `<textarea class="paste" id="${id}" rows="${rows}" readonly>${esc(text)}</textarea><div class="actions"><button type="button" class="btn small" data-copy="${id}">Copy</button></div>`;
  const link = gmail.phoneLink();
  const phone = c ? `<div class="card" style="margin-bottom:12px"><h3 style="margin:0 0 8px">Connect your phone</h3>
      <div class="qr-row"><div id="gmailQr" class="qr" aria-label="QR code of the phone link"></div>
      <div class="grow"><p style="margin-top:0">Scan this with the phone's camera, or send yourself the link and open it in Kos on the phone. It connects the phone to the same script.</p>
      <p class="muted"><b>iPhone:</b> paste the link into the set-up page <i>inside the installed Kos app</i> (its storage is separate from Safari's).</p></div></div>
      <textarea class="paste" id="phoneLink" rows="3" readonly>${esc(link)}</textarea>
      <div class="actions"><button type="button" class="btn small" data-copy="phoneLink">Copy the link</button>${navigator.share ? `<button type="button" class="btn small" data-share-link>Send…</button>` : ""}</div>
      <p class="muted" style="margin-bottom:0">Anyone with this link can read your Kos label: send it only to yourself.</p></div>`
    : `<div class="card" style="margin-bottom:12px"><h3 style="margin:0 0 8px">Set up on another device already?</h3>
      <p style="margin-top:0">Open its set-up page, and scan the QR code with this phone, or paste its phone link here:</p>
      <form id="connectForm" class="form"><label class="wide">Phone link<input name="link" placeholder="…/kos/#/gmail?connect=…" autocomplete="off" /></label></form>
      <div class="actions"><button type="button" class="btn primary" data-gmail-connect>Connect</button><span class="err" id="connectErr"></span></div><div id="connectResult"></div></div>`;
  return `<div class="section-title"><h2>Read bookings from Gmail</h2><span class="muted">${c ? "connected on this device" : ""}</span></div>
    ${c ? `${phone}<div id="gmailResult"></div>` : ""}
    <p class="muted">Forward a booking to your Gmail with <b>+kos</b> before the @ (Gmail delivers <b>you+kos@gmail.com</b> to <b>you@gmail.com</b>), and Kos reads it with the same reader Minty uses. A small script in your own Gmail hands Kos the emails with one label; it only reads, and only for this device's key. No server is involved, yours or anyone's.</p>
    <p class="muted"><b>Recommended:</b> a Gmail account made just for this. Google's read-only permission covers a whole mailbox, so in an account that only gets what you forward, that's all the script can see.</p>
    ${c ? "" : phone}
    ${step(1, "A label and a filter, in Gmail (on a computer)", `<p>Make a label named <b>Kos</b>. Then Settings → <b>Filters and blocked addresses</b> → Create a new filter: in <b>To</b>, put your address with +kos (e.g. <b>you+kos@gmail.com</b>) → Create filter → <b>Apply the label: Kos</b> → Create filter. Anything you label Kos by hand counts too.</p>`)}
    ${step(2, "The script", `<p>Signed in to that Gmail, open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com → New project</a>. Replace what's there with this (your key is in it):</p>${copy("gsCode", gmail.script(key), 10)}
      <p>Project Settings (⚙) → tick <b>Show "appsscript.json"</b> → open it in the editor and replace it with:</p>${copy("gsManifest", gmail.MANIFEST, 6)}`)}
    ${step(3, "Deploy it as a web app", `<p><b>Deploy → New deployment</b> → type <b>Web app</b> → Execute as: <b>Me</b>, Who has access: <b>Anyone</b> → Deploy. Allow it: Google says it isn't verified, because it's your own script → Advanced → Go to the project → Allow (it asks only to read Gmail). Copy the <b>Web app URL</b>.</p>
      <p class="muted">"Anyone" lets Kos call it without your Google sign-in; the key in the script is what keeps others out. To stop it, archive the deployment (Deploy → Manage deployments).</p>`)}
    ${step(4, "Paste the web app's address here", `<form id="gmailForm" class="form"><label class="wide">Web app URL<input name="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c?.url ?? "")}" /></label></form>
      <div class="actions"><button type="button" class="btn primary" data-gmail-save>Save and check</button>${c ? `<button type="button" class="btn danger" data-gmail-forget>Forget on this device</button>` : ""}<span class="err" id="formErr"></span></div>${c ? "" : `<div id="gmailResult"></div>`}`)}`;
}
/** The phone link as a QR code (vendored qrcode-generator, drawn as SVG: dark on white, always). */
async function drawQr(el, text) {
  if (!el || !text) return;
  try {
    const { qrcode } = await import("/vendor/qrcode/qrcode.mjs");
    const qr = qrcode(0, "M"); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), q = 4;
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
    el.innerHTML = `<svg viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  } catch { el.hidden = true; }
}

/** New emails from the Kos label, each read with the email reader, as suggestions. quiet: the
 * Add page's own check when it opens; it shows only bookings, never "nothing new" or an error. */
let pullSeq = 0;
async function gmailPull(box, quiet = false) {
  const mine = ++pullSeq;
  if (!quiet) box.innerHTML = `<div class="suggest muted">Asking your Gmail…</div>`;
  const msgs = await gmail.pull();
  const got = [], empty = [];
  for (const m of msgs) {
    const r = await store.readEmail(gmail.rawBytes(m.raw).buffer);
    if (!r.bookings.length) empty.push(m);
    for (const b of r.bookings) got.push({ ...b, sha256: r.sha256, msgId: m.id, quote: m.subject });
  }
  // the page moved on, a newer check ran, or (quietly) something else is being suggested: leave it
  if (!box.isConnected || mine !== pullSeq || (quiet && (!got.length || (found.length && foundFrom !== "gmail")))) return;
  found = got; foundFrom = "gmail"; pulled = msgs.map((m) => m.id);
  box.innerHTML = (quiet ? `<div class="suggest-head muted">New in your Gmail</div>` : "") + suggestionsHtml(found, "gmail") + (empty.length ? `<div class="suggest muted">${empty.length} email${empty.length === 1 ? "" : "s"} with no booking details Kos can read (${empty.slice(0, 3).map((m) => `“${esc(m.subject)}”`).join(", ")}): paste their text instead.</div>` : "")
    + (msgs.length ? `<div class="actions"><button type="button" class="btn ghost" data-gmail-skip>Don't show these again</button></div>` : "");
}

/** After connecting (the URL, or a phone link): ask the script once, and show what it has. */
async function checkConnected(box, errSel = "#formErr") {
  const err = app.querySelector(errSel);
  try {
    await gmailPull(box);
    if (err) err.textContent = "";
    box.insertAdjacentHTML("afterbegin", `<p class="pill good" style="white-space:normal;display:inline-block">Connected. Kos checks Gmail when you open "Add a booking".</p>`);
    return true;
  } catch (e) {
    if (err) err.textContent = e.message;
    box.innerHTML = `<div class="suggest err">${esc(e.message)}</div>`;
    return false;
  }
}

/** What was shared to Kos (Android's share menu, the installed app): kept by sw.js in IndexedDB. */
function takeShared(key = "latest") {
  return new Promise((ok) => {
    const req = indexedDB.open("kos-share", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("shared");
    req.onerror = () => ok(null);
    req.onsuccess = () => {
      const t = req.result.transaction("shared", "readwrite"), st = t.objectStore("shared"), g = st.get(key);
      g.onsuccess = () => { st.delete(key); ok(g.result ?? null); };
      g.onerror = () => ok(null);
    };
  });
}
function putShared(key, value) {
  return new Promise((ok) => {
    const req = indexedDB.open("kos-share", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("shared");
    req.onerror = () => ok(false);
    req.onsuccess = () => { const t = req.result.transaction("shared", "readwrite"); t.objectStore("shared").put(value, key); t.oncomplete = () => ok(true); t.onerror = () => ok(false); };
  });
}
async function readShared() {
  const s = await takeShared();
  const box = document.getElementById("suggestBox");
  if (!s) { box.innerHTML = `<div class="suggest muted">Nothing was shared, or it was already read.</div>`; return; }
  const file = s.files?.[0];
  if (file && /^image\//.test(file.type)) {                         // a screenshot: read on /sub-scan
    await putShared("image", { at: Date.now(), files: [file] });
    location.href = "/sub-scan?for=kos&shared=1"; return;
  }
  if (file && (/pdf/.test(file.type) || /\.pdf$/i.test(file.name))) {
    const { readPdfs } = await import("/pdf-read.js");
    const { rows } = await readPdfs([new File([file.blob], file.name || "shared.pdf", { type: "application/pdf" })], { view: "kos", known: async () => [], parse: (text) => ({ text }), max: 1 });
    if (rows[0]?.text) { await readText(rows[0].text, "pdf"); found = found.map((b) => ({ ...b, sha256: rows[0].sha })); return; }
  }
  if (file && (/rfc822/.test(file.type) || /\.eml$/i.test(file.name))) {
    const r = await store.readEmail(await file.blob.arrayBuffer());
    found = r.bookings.map((b) => ({ ...b, sha256: r.sha256 })); foundFrom = "email";
    box.innerHTML = suggestionsHtml(found, "email"); return;
  }
  const text = [s.title, s.text, s.url, file && /^text\//.test(file.type) ? await file.blob.text() : ""].filter(Boolean).join("\n");
  if (text.trim()) { await readText(text, "paste"); return; }
  box.innerHTML = `<div class="suggest muted">Kos can't read that kind of file. Share a PDF, a screenshot, an email file or text.</div>`;
}

// --- routing ------------------------------------------------------------------------------------
function route() {
  const [path, query] = location.hash.replace(/^#/, "").split("?");
  return { parts: (path || "/").split("/").filter(Boolean), q: new URLSearchParams(query ?? "") };
}
let source = "type";
async function render() {
  if (!data) { try { await load(); } catch (e) { app.innerHTML = `<p class="err pad">Couldn't load Kos: ${esc(e.message)}</p>`; return; } }
  const { parts, q } = route();
  if (map && parts[0] !== "trip") { map.remove(); map = null; mapKey = ""; }
  if (parts[0] === "trip" && parts[1]) {
    const t = tripById(Number(parts[1]));
    if (!t) { app.innerHTML = `<p class="pad muted center">That trip isn't here any more. <a href="#/">All trips</a></p>`; return; }
    if (parts[2] === "edit") { app.innerHTML = tripForm(t); tagPicker(); return; }
    if (map) { map.remove(); map = null; mapKey = ""; }
    if (parts[2] === "journal") { app.innerHTML = journalView(t); window.scrollTo(0, 0); journalLoad(t); return; }
    app.innerHTML = tripView(t, parts[2] ?? "");
    showMap(t, parts[2] ?? "");
    if (parts[2] === "spending") spending(t);
    return;
  }
  if (parts[0] === "new") { app.innerHTML = tripForm(null, (q.get("items") ?? "").split(",").filter(Boolean)); tagPicker(); return; }
  if (parts[0] === "data") { app.innerHTML = dataView(); return; }
  if (parts[0] === "gmail") {
    const code = q.get("connect");
    if (code) {                                  // a phone link: keep it, and take it out of the address
      history.replaceState(null, "", "#/gmail");
      try { gmail.connect(code); } catch (e) { app.innerHTML = gmailView(); document.getElementById("connectErr").textContent = e.message; return; }
      app.innerHTML = gmailView();
      drawQr(document.getElementById("gmailQr"), gmail.phoneLink());
      await checkConnected(document.getElementById("gmailResult"));
      return;
    }
    app.innerHTML = gmailView();
    drawQr(document.getElementById("gmailQr"), gmail.phoneLink());
    return;
  }
  if (parts[0] === "item" && parts[1]) {
    const i = itemById(Number(parts[1]));
    app.innerHTML = i ? `<div class="section-title"><h2>${esc(itemTitle(i))}</h2></div>${i.kind === "flight" ? `<div style="margin-bottom:14px">${flightCard(i)}</div>` : ""}${itemForm(i, i.trip_id)}` : `<p class="pad muted center">That booking isn't here any more.</p>`;
    loadPrograms();
    return;
  }
  if (parts[0] === "add") {
    const tripId = q.get("trip") ? Number(q.get("trip")) : null;
    // back from /sub-scan with a screenshot's text
    let scan = null;
    try { scan = JSON.parse(sessionStorage.getItem("minty.kos.scan") ?? "null"); if (scan?.text !== undefined) sessionStorage.removeItem("minty.kos.scan"); } catch { /* none */ }
    const tid = scan?.trip ?? tripId;
    if (scan?.text !== undefined) source = "shot";
    if (q.get("shared") !== null) source = "type";
    if (KIND[q.get("kind")]) { draft = { ...(draft ?? {}), kind: q.get("kind") }; source = "type"; }   // from the trip's summary strip
    app.innerHTML = addView(tid, source);
    loadPrograms();
    if (scan?.text) await readText(scan.text, "screenshot");
    if (q.get("shared") === "1") await readShared();
    if (q.get("shared") === "0") document.getElementById("suggestBox").innerHTML = `<div class="suggest err">The shared file couldn't be kept on this device.</div>`;
    const box = document.getElementById("suggestBox"), plain = !scan?.text && q.get("shared") === null;
    if (tabSwitch) { if (foundFrom === "gmail" && found.length && plain) box.innerHTML = suggestionsHtml(found, "gmail"); }   // kept across the tabs
    // opening the page: Gmail is checked by itself
    else if (gmail.config() && plain) { if (foundFrom === "gmail") found = []; gmailPull(box, true).catch(() => { /* quiet: "Check Gmail" says why */ }); }
    return;
  }
  app.innerHTML = home();
  setupTabs();
  lockOffer();
}
async function loadPrograms() {
  if (!programs) programs = await store.programs();
  for (const sel of app.querySelectorAll("[data-programs]")) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">—</option>${programs.map((p) => `<option value="${esc(p.id)}"${cur === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}`;
  }
}
const refresh = async () => { data = null; await render(); };

// --- events -------------------------------------------------------------------------------------
app.addEventListener("click", async (ev) => {
  const t = ev.target, at = (s) => t.closest(s);
  const err = (m) => { const box = app.querySelector("#formErr, #sugErr"); if (box) box.textContent = m; else alert(m); };
  try {
    if (at("[data-tab]")) { const id = route().parts[1]; location.hash = `#/trip/${id}${at("[data-tab]").dataset.tab ? `/${at("[data-tab]").dataset.tab}` : ""}`; return; }
    if (at("[data-ics]")) { ics(itemById(Number(at("[data-ics]").dataset.ics))); return; }
    if (at("button.item[data-item]")) {
      // Wanderlog: the first tap shows it on the map, a second opens it; no place on the map opens it at once
      const id = Number(at("[data-item]").dataset.item), i = itemById(id);
      if (map && i && Number.isFinite(i.lat) && Number.isFinite(i.lon) && focused !== id) { focus(map, i.lon, i.lat); focused = id; return; }
      location.hash = `#/item/${id}`;
      return;
    }
    if (at(".flight[data-item]") && !at("button")) { location.hash = `#/item/${at(".flight[data-item]").dataset.item}`; return; }
    if (at("[data-wstep]")) { setupTabs(at("[data-wstep]").dataset.wstep); return; }
    if (at("[data-lock-on]")) {
      try { await window.MintyLock.turnOn(); } catch { const e2 = document.getElementById("lockErr"); if (e2) e2.textContent = "It wasn't turned on. Try again."; return; }
      lockOffer(); return;
    }
    if (at("[data-lock-off]")) { window.MintyLock.notHere(); lockOffer(); return; }
    if (at("[data-install]")) { if (installPrompt) { installPrompt.prompt(); installPrompt = null; document.getElementById("installRow").hidden = true; } return; }
    if (at("[data-print]")) { window.print(); return; }
    if (at("[data-sample]")) {
      at("[data-sample]").disabled = true;
      try { await loadSample(); data = null; await render(); } catch (e2) { at("[data-sample]").disabled = false; document.getElementById("sampleErr").textContent = e2.message; }
      return;
    }
    if (at("[data-sample-remove]")) {
      if (!confirm("Remove the sample trips and their bookings from this browser?")) return;
      await removeSample(); data = null; await render(); return;
    }
    if (at("[data-add-tag]")) {
      const input = app.querySelector("#tripForm [name=tags]"), tag = at("[data-add-tag]").dataset.addTag;
      input.value = splitTags(`${input.value},${tag}`).join(", ");
      return;
    }
    if (at("[data-gmail-pull]")) { await gmailPull(document.getElementById("suggestBox")); return; }
    if (at("[data-gmail-skip]")) { gmail.markSeen(pulled); document.getElementById("suggestBox").innerHTML = `<div class="suggest muted">Done: those won't show again on this device.</div>`; found = []; return; }
    if (at("[data-copy]")) {
      const el = document.getElementById(at("[data-copy]").dataset.copy);
      try { await navigator.clipboard.writeText(el.value); at("[data-copy]").textContent = "Copied"; } catch { el.select(); }
      return;
    }
    if (at("[data-gmail-save]")) {
      try { gmail.save(app.querySelector("#gmailForm [name=url]").value); } catch (e2) { app.querySelector("#formErr").textContent = e2.message; return; }
      app.innerHTML = gmailView();                 // now with "Connect your phone", at the top
      window.scrollTo(0, 0);
      drawQr(document.getElementById("gmailQr"), gmail.phoneLink());
      await checkConnected(document.getElementById("gmailResult"), "#formErr");
      return;
    }
    if (at("[data-gmail-connect]")) {
      try { gmail.connect(app.querySelector("#connectForm [name=link]").value); } catch (e2) { app.querySelector("#connectErr").textContent = e2.message; return; }
      app.innerHTML = gmailView();
      drawQr(document.getElementById("gmailQr"), gmail.phoneLink());
      await checkConnected(document.getElementById("gmailResult"));
      return;
    }
    if (at("[data-share-link]")) { try { await navigator.share({ title: "Kos: connect your phone", url: gmail.phoneLink() }); } catch { /* cancelled */ } return; }
    if (at("[data-gmail-forget]")) { if (confirm("Forget the Gmail script on this device? (Archive its deployment in Apps Script to stop it entirely.)")) { gmail.forget(); render(); } return; }
    if (at("[data-export]")) {
      const file = new Blob([JSON.stringify(exportFile(data, await store.allNotes().catch(() => [])), null, 1)], { type: "application/json" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: `kos-trips-${localDay()}.json` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return;
    }
    if (at("[data-make-trip]")) {
      const ids = [...app.querySelectorAll("[data-pick]:checked")].map((x) => x.dataset.pick);
      if (!ids.length) { alert("Tick the bookings to put in the trip first."); return; }
      location.hash = `#/new?items=${ids.join(",")}`; return;
    }
    if (at("button[data-source]")) { source = at("button[data-source]").dataset.source; draft = null; tabSwitch = true; await render(); tabSwitch = false; return; }   // the source tabs (the form has a data-source too)
    if (at("[data-read-paste]")) { await readText(document.getElementById("pasteText").value, "paste"); return; }
    if (at("[data-scan]")) {
      try { sessionStorage.setItem("minty.kos.scan", JSON.stringify({ trip: route().q.get("trip") ? Number(route().q.get("trip")) : null })); } catch { /* private window */ }
      location.href = "/sub-scan?for=kos"; return;
    }
    if (at("[data-use]")) {
      const b = found[Number(at("[data-use]").dataset.use)], tripId = Number(app.querySelector("[name=trip_id]")?.value) || null;
      draft = { ...asItem(b, tripId), source: foundFrom === "paste" ? "paste" : foundFrom, source_sha256: b.sha256 ?? null };
      document.getElementById("formBox").innerHTML = itemForm(draft, tripId);
      loadPrograms();
      document.getElementById("formBox").scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (at("[data-add-now]") || at("[data-add-all]")) {
      const tripId = route().q.get("trip") ? Number(route().q.get("trip")) : null;
      const list = at("[data-add-all]") ? found : [found[Number(at("[data-add-now]").dataset.addNow)]];
      for (const b of list) await store.saveItem(null, { ...asItem(b, tripId), source: "email", source_sha256: b.sha256 ?? null });
      if (foundFrom === "gmail") gmail.markSeen(list.map((b) => b.msgId).filter(Boolean));
      data = null; draft = null; found = [];
      location.hash = tripId ? `#/trip/${tripId}` : "#/";
      return;
    }
    if (at("[data-del-item]")) {
      if (!confirm("Delete this booking?")) return;
      const i = itemById(Number(at("[data-del-item]").dataset.delItem));
      await store.deleteItem(i.id); data = null; location.hash = i.trip_id ? `#/trip/${i.trip_id}` : "#/"; return;
    }
    if (at("[data-del-trip]")) {
      if (!confirm("Delete this trip? Its bookings stay, waiting for a trip.")) return;
      await store.deleteTrip(Number(at("[data-del-trip]").dataset.delTrip)); data = null; location.hash = "#/"; return;
    }
    const sugIds = () => [...app.querySelectorAll("[data-sug]:checked")].map((x) => Number(x.dataset.sug));
    if (at("[data-sug-add]") || at("[data-sug-dismiss]")) {
      const id = Number(route().parts[1]), ids = sugIds();
      if (!ids.length) return;
      await store.link(id, at("[data-sug-add]") ? { confirm: ids } : { dismiss: ids });
      data = null; await load(); spending(tripById(id)); return;
    }
    if (at("[data-unlink]")) {
      const id = Number(route().parts[1]);
      await store.link(id, { remove: [Number(at("[data-unlink]").dataset.unlink)] });
      data = null; await load(); spending(tripById(id)); return;
    }
  } catch (e) { err(e.message); }
});
app.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t.name === "kind" && t.form?.id === "itemForm") {
    const k = t.value, f = t.form;
    f.querySelector("[data-flight]").hidden = k !== "flight";
    f.querySelector("[data-name-label]").textContent = NAME_LABEL[k];
    f.querySelector("[data-start-label]").textContent = k === "lodging" ? "Check in" : k === "flight" ? "Departs" : "Starts";
    f.querySelector("[data-end-label]").textContent = k === "lodging" ? "Check out" : k === "flight" ? "Arrives" : "Ends";
  }
  if (t.id === "importFile" && t.files.length) {
    try {
      const n = await doImport(t.files[0]);
      data = null; await load(); app.innerHTML = dataView();
      app.querySelector("#formErr").textContent = "";
      app.querySelector(".card").insertAdjacentHTML("beforeend", `<p class="pill good" style="margin-top:12px">Imported ${n.trips} trip${n.trips === 1 ? "" : "s"} and ${n.items} booking${n.items === 1 ? "" : "s"}.</p>`);
    } catch (e) { app.querySelector("#formErr").textContent = e.message; }
    return;
  }
  if (t.id === "pdfFile" && t.files.length) {
    const { readPdfs } = await import("/pdf-read.js");
    const { rows } = await readPdfs(t.files, { view: "kos", known: async () => [], parse: (text) => ({ text }), max: 1 });
    if (!rows[0] || rows[0].error) { document.getElementById("suggestBox").innerHTML = `<div class="suggest err">${esc(rows[0]?.error ?? "Couldn't read this PDF")}</div>`; return; }
    await readText(rows[0].text, "pdf");
    found = found.map((b) => ({ ...b, sha256: rows[0].sha }));
  }
  if (t.id === "emlFile" && t.files.length) {
    const box = document.getElementById("suggestBox");
    box.innerHTML = `<div class="suggest muted">Reading…</div>`;
    try {
      const r = await store.readEmail(await t.files[0].arrayBuffer());
      found = r.bookings.map((b) => ({ ...b, sha256: r.sha256 }));
      foundFrom = "email";
      box.innerHTML = r.bookings.length ? suggestionsHtml(found, "email")
        : `<div class="suggest muted">No booking details in "${esc(r.subject ?? "this email")}". ${r.text ? "Its text is below to paste instead." : ""}</div>${r.text ? `<textarea class="paste" readonly>${esc(r.text)}</textarea>` : ""}`;
    } catch (e) { box.innerHTML = `<div class="suggest err">${esc(e.message)}</div>`; }
  }
});
app.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, err = (m) => { f.querySelector("#formErr").textContent = m; };
  try {
    if (f.id === "tripForm") {
      const e = f.elements;
      const body = { name: e.name.value, start_date: e.start_date.value, end_date: e.end_date.value, place: e.place.value, notes: e.notes.value,
                     travellers: [...f.querySelectorAll("[name=trav]:checked")].map((x) => x.value) };
      if (e.tags) body.tags = splitTags(e.tags.value);
      if (!f.dataset.id && f.dataset.items) body.items = f.dataset.items.split(",").map(Number);
      const r = await store.saveTrip(f.dataset.id ? Number(f.dataset.id) : null, body);
      data = null; location.hash = `#/trip/${r.id}`; return;
    }
    if (f.id === "itemForm") {
      const body = await itemBody(f);
      const r = await store.saveItem(f.dataset.id ? Number(f.dataset.id) : null, body);
      data = null; draft = null; found = [];
      location.hash = body.trip_id ? `#/trip/${body.trip_id}` : r.id ? "#/" : "#/";
    }
  } catch (e) { err(e.message); }
});
window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
document.getElementById("themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("kos-theme", next); } catch { /* not remembered */ }
  const { parts } = route();
  if (parts[0] === "trip" && parts[1] && parts[2] !== "edit" && parts[2] !== "journal") { mapKey = ""; showMap(tripById(Number(parts[1])), parts[2] ?? ""); }
});
if (MODE === "device") {
  document.getElementById("mintyLink").hidden = true;
  keepData();                                              // ask the browser to keep the trips when space runs low
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/kos/sw.js", { scope: "/kos/" }).catch(() => {});
// Kos was JET, at /jet/ (which now redirects here): its service worker and caches go.
navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.filter((r) => new URL(r.scope).pathname === "/jet/").forEach((r) => r.unregister())).catch(() => {});
globalThis.caches?.keys().then((ks) => ks.filter((k) => k.startsWith("jet-")).forEach((k) => caches.delete(k))).catch(() => {});
render();
