// Kos (docs/trips.md): the household's trips, as an app of its own at /kos/. Served by Minty's
// Worker, behind Minty's sign-in, on Minty's data: trips and bookings (GET /trips…), the trip's
// transactions (GET /transactions?trip_id=, suggestions to confirm), BAM's programs for award
// bookings. Bookings come typed, pasted, from a PDF (pdf.js, read on the device), a screenshot
// (/sub-scan?for=kos, read on the device) or an email file (POST /trips/read-email, read on the
// server and not stored). The look: flights, the theme and the map after Flighty; trips after
// Wanderlog. Hash routes: #/ · #/trip/ID[/flights|/spending] · #/trip/ID/edit · #/new · #/add[?trip=ID] · #/item/ID.
import { createMap, drawTrip, focus, loadAirports } from "./map.js";
import { MODE, SHARE_BASE, SUM_KINDS, backupDue, cityNames, exportFile, importFile, isTripCode, isWikimediaImage, keepData, readShare, reportMail, shareLink, shareString, shiftSample, store, tripAddress, tripFor, tripSummary } from "./store.js";
import * as gmail from "./gmail.js";
import { daySpend, lineFor, tripStats } from "./journal.js";
import { parseWhere } from "./where.js";

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
/** The trip a found booking goes in by its dates, when it wasn't sent to a trip's address (store.tripFor). */
const tripGuess = (b) => tripFor(dateOf(b.start_at ?? b.start), data.trips)?.id ?? null;
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
    <div class="cover" style="--h:${hue(t.name)}" data-photo="${t.id}"><h3>${esc(t.name)}</h3><div class="when">${esc(fmtShort(t.start_date))} – ${esc(fmtShort(t.end_date))}, ${t.end_date.slice(0, 4)}${t.place ? ` · ${esc(t.place)}` : ""}</div></div>
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
  const ownTrips = data.trips.filter((t) => !(sample?.trips ?? []).includes(t.id));
  return `${backupReminder(ownTrips.length ? ownTrips : null)}${ready.map((t) => `<a class="card j-ready" href="#/trip/${t.id}/journal"><span class="grow"><b>Your ${esc(t.name)} journal is ready.</b> <span class="muted">Its days, its map and room for your notes.</span></span><span class="btn small primary">Open</span></a>`).join("")}
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
    ${MODE === "device" ? `<div class="kos-foot">${supportHtml()}<footer class="w-foot">${alsoFromHtml()}</footer>${copyHtml()}</div>` : ""}
    <a class="fab" href="#/add" aria-label="Add a booking" title="Add a booking">+</a>`;
}

// --- Kos on its own: the first screen, and the device lock as the last step (docs/trips.md §17.4) ----
// The first screen's support pills, other projects and © line; standalone Kos's trip list ends with them too.
const supportHtml = () => `<section class="w-support" aria-label="Support Kos">
      <p><b>Support Kos.</b> It's free, with no ads. If it helps:</p>
      <div class="w-cta"><a class="w-pill" href="https://ko-fi.com/mintyme" target="_blank" rel="noopener" data-goatcounter-click="kos-kofi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>Support on Ko-fi</a>
        <a class="w-pill" href="https://github.com/rg-code/minty" target="_blank" rel="noopener" data-goatcounter-click="kos-star"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>Star Minty on GitHub</a></div>
    </section>`;
const alsoFromHtml = () => `<p>Also from rg-code: <a href="https://milesmaximizer.com/?utm_source=kos" target="_blank" rel="noopener" data-goatcounter-click="kos-to-miles">Miles Maximizer</a>, for point transfers;
        <a href="https://milesmaximizer.com/inkling/?utm_source=kos" target="_blank" rel="noopener" data-goatcounter-click="kos-to-inkling">Inkling</a>, for inKind restaurants;
        the <a href="https://milesmaximizer.com/museum_problem/?utm_source=kos" target="_blank" rel="noopener" data-goatcounter-click="kos-to-museums">museum finder</a>, for free museum entry;
        <a href="https://graze.milesmaximizer.com/?utm_source=kos" target="_blank" rel="noopener" data-goatcounter-click="kos-to-graze">GRAZE</a>, for free EV charging;
        and <a href="https://minty.milesmaximizer.com/?utm_source=kos" target="_blank" rel="noopener" data-goatcounter-click="kos-to-minty">Minty</a>, for private money tracking.
        On a Minty, Kos also shows what each trip cost, and live flight tracking like Flighty's, with gate, delay and landing updates, is on its way.</p>`;
const copyHtml = () => `<p class="w-copy">© rg-code, ${new Date().getFullYear()}</p>`;

function welcome() {
  // a made-up flight, drawn by the real flight card (decorative: the page's own look, not a screenshot)
  const out = addDays(localDay(), 23);                      // always about three weeks away, so it always reads "Scheduled"
  const demo = { id: 0, kind: "flight", airline: "UA", flight_number: "837", dep_airport: "SFO", arr_airport: "NRT", name: "United",
                 start_at: `${out}T11:05:00-08:00`, end_at: `${addDays(out, 1)}T15:00:00+09:00`, dep_terminal: "I", seat: "34K", confirmation: "KOS837" };
  const step = (n, id, label) => `<button type="button" role="tab" class="w-tab" data-wstep="${id}" data-goatcounter-click="kos-setup-${id}" aria-selected="${n === 1}"><i>${n}</i>${label}</button>`;
  return `<section class="welcome">
    <header class="w-hero">
      <p class="w-kicker">Kos <span>by</span> <a href="https://minty.milesmaximizer.com/?utm_source=kos" target="_blank" rel="noopener" data-goatcounter-click="kos-by-minty">Minty</a></p>
      <h1>Every trip,<br />in one place.</h1>
      <p class="w-lede">Flights like Flighty, days like Wanderlog, and a journal written for you when you're home.
        <b>Forward your booking emails and Kos reads them for you</b>: no typing them in.
        No account: your trips stay in this browser.</p>
      <div class="w-cta"><button type="button" class="w-primary" data-sample data-goatcounter-click="kos-sample">Try a sample trip</button>
        <a class="w-pill" href="#/new" data-goatcounter-click="kos-new-trip"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>New trip</a>
        <a class="w-pill" href="#/add" data-goatcounter-click="kos-add-booking"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH.flight}</svg>Add a booking</a></div>
      <span class="err" id="sampleErr"></span>
    </header>
    <div class="w-visual" aria-hidden="true"><div class="w-card">${flightCard(demo, { compact: true })}</div>
      <div class="w-day"><span class="w-dot"></span><b>Day 2</b><span>Dinner at Sushi Mitsuba · 19:30</span></div></div>
    <section class="w-setup" aria-label="Set Kos up">
      <h2>Set it up in three steps</h2>
      <div class="w-tabs" role="tablist"><span class="w-thumb" aria-hidden="true"></span>${step(1, "add", "Add trips")}${step(2, "home", "Install")}${step(3, "lock", "Lock")}</div>
      <div class="w-panel" role="tabpanel" data-wpanel="add"><b>Add trips: automatically, or by hand.</b>
        <div class="w-ways"><div><span class="w-way">Automatically</span> Forward booking emails to your Gmail with <b>+kos</b> in the address, and Kos reads them, on your phone too. <a href="#/gmail" data-goatcounter-click="kos-setup-gmail">Set up Gmail</a> (about 5 minutes, once).</div>
        <div><span class="w-way">By hand</span> Paste a confirmation, read a PDF, an email file or a screenshot, or type it in. Once Kos is installed on Android, share a booking to it.</div></div></div>
      <div class="w-panel" role="tabpanel" data-wpanel="home" hidden><b>Put Kos on your home screen.</b> iPhone: Safari's Share button → <b>Add to Home Screen</b>. Android: Chrome's ⋮ menu → <b>Install app</b>.
        <div class="actions" id="installRow" hidden><button type="button" class="w-pill" data-install data-goatcounter-click="kos-install">Install Kos</button></div></div>
      <div class="w-panel" role="tabpanel" data-wpanel="lock" hidden><div id="lockStep"><b>Last: lock Kos on this device.</b> <span class="muted">Checking what this device can do…</span></div></div>
    </section>
    ${supportHtml()}
    <footer class="w-foot">
      <p>Trips stay in this browser only, so export a copy now and then (<a href="#/data" data-goatcounter-click="kos-your-data">Your data</a>). Maps come from OpenFreeMap, and each trip's city photo from Wikipedia, which is asked for it by the city's name.</p>
      ${alsoFromHtml()}
    </footer>
    ${copyHtml()}</section>`;
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
// Taps on what Kos draws (data-goatcounter-click), counted when GoatCounter is on the page: only Kos
// on its own, on the landing site (scripts/build-kos.mjs --goatcounter). Never on a Minty.
document.addEventListener("click", (e) => {
  const el = e.target.closest?.("[data-goatcounter-click]");
  if (el && window.goatcounter?.count) window.goatcounter.count({ path: el.dataset.goatcounterClick, title: el.textContent.trim().slice(0, 80), event: true });
}, true);
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
  // numbered across the whole trip, 1, 2, 3… (the map's dots carry the same numbers); a stay's
  // check-out keeps its check-in's number
  const num = new Map();
  days.forEach((d, n) => { d.color = DAY_COLORS[n % DAY_COLORS.length]; for (const e of d.entries) { if (!e.repeat) num.set(e.item.id, num.size + 1); e.n = num.get(e.item.id); } });
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
  const addr = isTripCode(t.code) ? tripAddress(t.code, gmail.gmailAddress()) : "";
  const mail = addr ? `<div class="sum-mail"><span class="muted">This trip's own address:</span> <code id="tripAddr">${esc(addr)}</code>
      <button type="button" class="btn small ghost" data-copy-text="${esc(addr)}" data-goatcounter-click="kos-copy-trip-address">Copy</button>
      ${addr.startsWith("+") ? `<a href="#/gmail">${gmail.config() ? "Add your Gmail address" : "Set up Gmail"}</a>` : ""}
      <p class="sum-mail-note muted">Kos works out which trip a booking belongs to from its dates, so forwarding it to Kos is enough. To file one here for certain (booked for overlapping trips, or with dates Kos can't read), send it to this address.</p></div>` : "";
  return `<div class="summary"><section class="card sum-res"><h3>Reservations</h3><div class="sum-kinds">${kinds}</div>${mail}</section>
    <section class="card sum-budget"><h3>Budgeting</h3>${budget}</section></div>`;
}

/** Trip tags (docs/trips.md §18): whether a tag is one CFA leaves out of the numbers. */
const leftOutTag = (tag) => (data?.left_out_tags ?? []).some((x) => x.toLowerCase() === tag.toLowerCase());
const tripTags = (t) => (store.spending ? t.tags ?? [] : []);
const tagChips = (tags) => tags.length ? `<div class="trip-tags">${tags.map((g) => `<span class="pill ${leftOutTag(g) ? "warn" : "dim"}" title="${leftOutTag(g) ? "Left out of CFA and the dashboard's totals" : "Its transactions have this tag"}">${esc(g)}${leftOutTag(g) ? " · left out" : ""}</span>`).join("")}</div>` : "";
function tripView(t, tab) {
  const p = plan(t);
  const tabs = [["", "Itinerary"], ["flights", "Flights"], ["lodging", "Lodging"], ...(store.spending ? [["spending", "Spending"]] : [])];
  const stays = t.items.filter((i) => i.kind === "lodging").sort((a, b) => ((a.start_at ?? "") < (b.start_at ?? "") ? -1 : 1));
  const flights = t.items.filter((i) => i.kind === "flight").sort((a, b) => ((a.start_at ?? "") < (b.start_at ?? "") ? -1 : 1));
  let body;
  if (tab === "flights") body = flights.length ? flights.map((f) => flightCard(f)).join("") : `<div class="card muted">No flights in this trip yet.</div>`;
  else if (tab === "lodging") body = stays.length ? stays.map(stayCard).join("") : `<div class="card muted">No stays in this trip yet. <a href="#/add?trip=${t.id}&kind=lodging">Add one</a></div>`;
  else if (tab === "spending") body = `<div id="spending"><p class="muted">Loading the trip's spending…</p></div>`;
  else body = `${p.before.length ? dayHtml({ label: "Before the trip", entries: p.before, color: "#8c96ad" }) : ""}
    ${p.days.map((d, n) => dayHtml({ label: `Day ${n + 1}`, sub: fmtDay(d.date), entries: d.entries, color: d.color, add: `#/place?trip=${t.id}&day=${d.date}` })).join("")}
    ${p.after.length ? dayHtml({ label: "After the trip", entries: p.after, color: "#8c96ad" }) : ""}
    ${p.unscheduled.length ? dayHtml({ label: "No date yet", entries: p.unscheduled, color: "#8c96ad" }) : ""}`;
  return `<section class="trip-head"><div class="cover" style="--h:${hue(t.name)}" data-photo="${t.id}" data-photo-link>
      <div class="cover-actions"><a class="btn small" href="#/trip/${t.id}/share" data-goatcounter-click="kos-share-trip">Share</a><a class="btn small" href="#/trip/${t.id}/journal">Journal</a><a class="btn small" href="#/trip/${t.id}/edit">Edit</a><a class="btn small" href="#/add?trip=${t.id}">Add booking</a></div>
      <h1>${esc(t.name)}</h1><div class="when">${esc(fmtDay(t.start_date))} – ${esc(fmtDay(t.end_date))}, ${t.end_date.slice(0, 4)}${t.place ? ` · ${esc(t.place)}` : ""}</div>
      ${t.travellers.length ? `<div class="avatars">${t.travellers.map((k) => `<span title="${esc(label(k))}">${esc(label(k).slice(0, 1).toUpperCase())}</span>`).join("")}</div>` : ""}
      ${tagChips(tripTags(t))}</div></section>
    ${summaryHtml(t)}
    <div class="trip"><div class="plan">
      <div class="tabs"><div class="seg" role="group">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${(tab || "") === k}">${l}</button>`).join("")}</div></div>
      ${body}
      <p class="report-line muted">A trip worth featuring, or something Kos got wrong? <button type="button" class="linklike" data-report-trip data-goatcounter-click="kos-report-trip">Share it with the Kos team</button></p></div>
      <div class="mapwrap"><div class="map" id="map"></div><div class="map-note" id="mapNote" hidden></div></div></div>
    <a class="fab" href="#/add?trip=${t.id}" aria-label="Add a booking" title="Add a booking">+</a>`;
}
/** A stay, on the Lodging tab: its nights, check-in and check-out, where, and its booking. A tap
 * centres the map on it (the same [data-item] as the itinerary's). */
function stayCard(i) {
  const a = dateOf(i.start_at), b = dateOf(i.end_at);
  const nights = a && b ? Math.max(0, Math.round((asDay(b) - asDay(a)) / 864e5)) : null;
  const when = (d, at, word) => d ? `<div><span>${word}</span><b>${esc(fmtDay(d))}</b>${at ? `<small>${esc(at)}</small>` : ""}</div>` : "";
  return `<button type="button" class="item stay" data-item="${i.id}">
    <div class="row1"><span class="what">${esc(i.name || "A stay")}</span>${nights !== null ? `<span class="pill dim">${nights} night${nights === 1 ? "" : "s"}</span>` : ""}</div>
    ${i.place ? `<div class="sub">${esc(i.place)}</div>` : ""}
    <div class="stay-dates">${when(a, timeOf(i.start_at), "Check in")}${when(b, timeOf(i.end_at), "Check out")}</div>
    ${i.confirmation || i.price_cents || i.points ? `<div class="sub">${[i.confirmation ? `Conf. ${esc(i.confirmation)}` : "", i.points ? `${i.points.toLocaleString()} pts` : i.price_cents ? money(i.price_cents, i.currency) : ""].filter(Boolean).join(" · ")}</div>` : ""}
    ${Number.isFinite(i.lat) && Number.isFinite(i.lon) ? "" : `<div class="sub muted">No address on the map yet: edit the stay to add one.</div>`}</button>`;
}
function dayHtml({ label: l, sub, entries, color, add }) {
  const plus = add ? `<a class="add-place" href="${add}" data-goatcounter-click="kos-add-place">+ Add a place</a>` : "";
  return `<section class="day" style="--day:${color}"><div class="day-head"><span class="day-dot"></span><h3>${esc(l)}</h3>${sub ? `<span class="muted">${esc(sub)}</span>` : ""}</div>
    <div class="stops">${entries.length ? entries.map(entryHtml).join("") + plus : `<div class="empty-day">Nothing planned yet. ${plus}</div>`}</div></section>`;
}

// --- sharing one trip (docs/trips.md §23): a link with the trip in it, or a file -----------------------
function shareView(t) {
  return `<div class="section-title"><h2>Share ${esc(t.name)}</h2><span class="muted">${t.items.length} booking${t.items.length === 1 ? "" : "s"}</span></div>
    <div class="card"><p style="margin-top:0">A link with the trip in it: its days, bookings and places. Whoever opens it sees the trip in Kos and chooses whether to add it. Nothing is stored anywhere.</p>
      <label class="check"><input type="checkbox" id="sharePrivate" /> Include confirmation numbers, prices and guest names</label>
      <p class="muted" style="margin:6px 0 0;font-size:13px">Off unless you need it: a booking reference with a surname can be enough to change or cancel a booking, and the link stays in the chat.</p>
      <textarea class="paste" id="shareText" rows="3" readonly>Making the link…</textarea>
      <div class="actions">${navigator.share ? `<button type="button" class="btn primary" data-share-trip>Share…</button>` : ""}<button type="button" class="btn${navigator.share ? "" : " primary"}" data-copy="shareText">Copy link</button>
        <button type="button" class="btn ghost" data-share-file>Download file</button><a class="btn ghost" href="#/trip/${t.id}">Back</a></div>
      <p class="muted" id="shareNote" style="margin-bottom:0;font-size:13px"></p></div>
    <div class="card" style="margin-top:12px"><h3 style="margin:0 0 6px">Share it with the Kos team</h3><p class="muted" style="margin-top:0">To be featured as a sample trip or in a catalog, or because something's wrong. Your email app opens with the trip's link in it (never confirmation numbers, prices or guests), to the Kos team.</p>
      <button type="button" class="btn" data-report-trip data-goatcounter-click="kos-report-trip-share">Share it with the Kos team</button></div>`;
}
// --- "Share with the Kos team" (docs/trips.md §24): an email from the person's own mail app, to be
// featured (a sample trip, a catalog) or as a bug report ----------------------------------------------
// Only Kos on its own knows the address (the landing site's build), so from a Minty the report page
// opens there, with the trip in the link.
let pendingReport = null;
async function reportTrip(t) {
  const code = await shareString(t);                            // never confirmation numbers, prices or guests
  if (MODE === "device" && window.KOS_REPORT_TO) { location.hash = `#/report?t=${code}`; return; }
  window.open(`${SHARE_BASE}#/report?t=${code}`, "_blank", "noopener");
}
function reportView(f) {
  const to = window.KOS_REPORT_TO;
  if (!f || f.error) return `<div class="section-title"><h2>Share with the Kos team</h2></div><div class="card"><p class="err" style="margin-top:0">${esc(f?.error ?? "Open this from a trip's page.")}</p><a class="btn" href="#/">All trips</a></div>`;
  const t = f.trips[0];
  return `<div class="section-title"><h2>Share with the Kos team</h2></div>
    <div class="card"><p style="margin-top:0"><b>${esc(t.name)}</b> <span class="muted">${esc(fmtDay(t.start_date))} – ${esc(fmtDay(t.end_date))} · ${f.items.length} booking${f.items.length === 1 ? "" : "s"}</span></p>
      <form class="form" id="reportForm">
        <div class="wide report-why" role="radiogroup" aria-label="Why">
          <label class="check"><input type="radio" name="why" value="feature" checked /> <span><b>Feature it.</b> Kos may use this trip as a sample trip or in a catalog, with its dates moved and nothing personal.</span></label>
          <label class="check"><input type="radio" name="why" value="problem" /> <span><b>Something's wrong.</b> A booking read wrong, missing, or shown oddly.</span></label>
        </div>
        <label class="wide">A note <small class="muted">(optional)</small><textarea name="note" rows="4" maxlength="1200" placeholder="What makes it a good trip, or what went wrong?"></textarea></label></form>
      <p class="muted">What goes: the trip's days, bookings and places, as a link. Not its confirmation numbers, prices or guests. Your email app opens with it written in; nothing is sent until you send that email.</p>
      ${to ? `<div class="actions"><button type="button" class="btn primary" data-report-mail>Open email</button><button type="button" class="btn ghost" data-copy="reportLink">Copy the trip's link</button></div>
        <p class="muted" id="reportNote" style="font-size:13px;margin-bottom:0">To: ${esc(to)}</p>`
      : `<p class="muted">This Kos has no address for the Kos developers. Copy the trip's link and send it by any means you like.</p><div class="actions"><button type="button" class="btn" data-copy="reportLink">Copy the trip's link</button></div>`}
      <textarea id="reportLink" hidden readonly>${esc(f.link)}</textarea></div>`;
}
async function fillShare(t) {
  const box = document.getElementById("shareText");
  if (!box) return;
  const link = shareLink(await shareString(t, { withPrivate: document.getElementById("sharePrivate")?.checked }));
  box.value = link;
  document.getElementById("shareNote").textContent = link.length > 8000 ? "A long link: some chat apps may cut it short. Download file shares the same trip as a file." : MODE === "device" ? "" : "It opens Kos on its own (minty.milesmaximizer.com/kos/). Someone with a Minty can paste it on Your data instead.";
}
let pendingShare = null;
/** A shared trip as the trip page draws it, before it's added: its bookings get stand-in ids (below zero,
 * so they never match one of this device's) for the plan's numbers and the map's pins. */
function previewTrip(f) {
  if (!f?.trips?.[0]) return null;
  return { ...f.trips[0], id: "shared", code: null, tags: [], travellers: [], items: f.items.map((i, n) => ({ ...i, id: -(n + 1) })) };
}
function importView(f) {
  if (!f) return `<div class="section-title"><h2>Add a shared trip</h2></div><div class="card muted">Open a shared Kos trip link, or paste one on <a href="#/data">Your data</a>.</div>`;
  if (f.error) return `<div class="section-title"><h2>Add a shared trip</h2></div><div class="card"><p class="err" style="margin-top:0">${esc(f.error)}</p><a class="btn" href="#/">All trips</a></div>`;
  const t = previewTrip(f), kinds = {}, p = plan(t);
  for (const i of t.items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
  const days = `${p.before.length ? dayHtml({ label: "Before the trip", entries: p.before, color: "#8c96ad" }) : ""}
    ${p.days.map((d, n) => dayHtml({ label: `Day ${n + 1}`, sub: fmtDay(d.date), entries: d.entries, color: d.color })).join("")}
    ${p.after.length ? dayHtml({ label: "After the trip", entries: p.after, color: "#8c96ad" }) : ""}
    ${p.unscheduled.length ? dayHtml({ label: "No date yet", entries: p.unscheduled, color: "#8c96ad" }) : ""}`;
  return `<div class="card share-bar"><div class="grow"><b>Someone shared a trip with you.</b> <span class="muted">Look through it: nothing is added until you choose.</span></div>
      <div class="actions"><button type="button" class="btn primary" data-add-shared data-goatcounter-click="kos-add-shared-trip">Add this trip</button><a class="btn ghost" href="#/">Not now</a><span class="err" id="formErr"></span></div></div>
    <section class="trip-head"><div class="cover" style="--h:${hue(t.name)}" data-photo="shared">
      <h1>${esc(t.name)}</h1><div class="when">${esc(fmtDay(t.start_date))} – ${esc(fmtDay(t.end_date))}, ${esc(String(t.end_date).slice(0, 4))}${t.place ? ` · ${esc(t.place)}` : ""}</div></div></section>
    <p class="muted share-count">${t.items.length} booking${t.items.length === 1 ? "" : "s"}${Object.keys(kinds).length ? `: ${Object.entries(kinds).map(([k, n]) => `${n} ${esc((KIND[k] ?? k).toLowerCase())}`).join(", ")}` : ""}.</p>
    <div class="trip preview"><div class="plan">${days}</div>
      <div class="mapwrap"><div class="map" id="map"></div><div class="map-note" id="mapNote" hidden></div></div></div>`;
}

// --- a place to go on a day (docs/trips.md §22): one box takes an address, a plus code, coordinates
// or a Google Maps link, read with no lookup service (where.js); saved as an Activity on that day
/** Points a short plus code may be near: the trip's own place, then its bookings on the map. */
const whereRefs = (t) => [
  ...(Number.isFinite(t?.lat) && Number.isFinite(t?.lon) ? [{ lat: t.lat, lon: t.lon, name: t.place || t.name }] : []),
  ...(t?.items ?? []).filter((i) => i.kind !== "flight" && Number.isFinite(i.lat) && Number.isFinite(i.lon)).map((i) => ({ lat: i.lat, lon: i.lon, name: i.name || i.place || "a booking" })),
];
/** Where the text is: a short Google Maps link followed by a Minty's Worker first, when there is one. */
async function readWhere(text, t) {
  let w = parseWhere(text, { refs: whereRefs(t), airports });
  if (w.shortLink) {
    if (!store.placeLink) return { error: "A short maps.app.goo.gl link can't be read here: open it, then paste the long address from the browser's bar (or the place's plus code)." };
    try { w = parseWhere(await store.placeLink(w.shortLink), { refs: whereRefs(t), airports }); } catch (e) { return { error: e.message }; }
  }
  return w;
}
const mapsSearch = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
function whereHint(w) {
  if (w.error) return `<span class="err">${esc(w.error)}</span>`;
  if (w.address) return `<span class="muted">Kept as an address, not on the map (paste a plus code or a map link to place it). <a href="${mapsSearch(w.address)}" target="_blank" rel="noopener">Open in Maps ↗</a></span>`;
  return `<span class="good">On the map, from ${esc(w.how)}${w.label ? `: ${esc(w.label)}` : ""}${w.near ? ` (${esc(w.near)})` : ""}.</span> <a href="https://www.google.com/maps/search/?api=1&query=${w.lat},${w.lon}" target="_blank" rel="noopener">Check it ↗</a>`;
}
function placeView(t, day) {
  return `<div class="section-title"><h2>Add a place</h2><span class="muted">${esc(t.name)} · ${esc(fmtDay(day))}</span></div>
    <form class="card" id="placeForm" data-trip="${t.id}" data-day="${esc(day)}"><div class="form">
      <label class="wide">What <input name="name" maxlength="150" placeholder="Tokyo Skytree, a ramen place, a walk…" /></label>
      <label class="wide">Where <textarea name="where" rows="2" maxlength="600" placeholder="An address, a plus code (PRF9+WQ Sumida City, Tokyo), coordinates, or a Google Maps link"></textarea></label>
      <div class="wide where-hint" id="whereHint"><span class="muted">Easiest: in Google Maps, tap the place, then copy its plus code, or Share → Copy link.</span></div>
      <label>Time <small class="muted">(optional)</small><input name="time" type="time" /></label>
    </div><div class="actions"><button class="btn primary" type="submit">Add to ${esc(fmtShort(day))}</button><a class="btn ghost" href="#/trip/${t.id}">Cancel</a><span class="err" id="formErr"></span></div></form>`;
}
app.addEventListener("change", (ev) => { if (ev.target.id === "sharePrivate") fillShare(tripById(Number(route().parts[1]))); });
let whereTimer = null;
app.addEventListener("input", (ev) => {
  const f = ev.target.closest?.("#placeForm, #itemForm");
  if (!f || !(ev.target.name === "where" || (f.id === "itemForm" && ev.target.name === "place"))) return;
  clearTimeout(whereTimer);
  whereTimer = setTimeout(async () => {
    const text = ev.target.value, t = tripById(Number(f.dataset.trip || f.elements.trip_id?.value));
    if (f.id === "itemForm") {                                 // a booking's place: placed on the map when it can be
      if (!text.trim()) return;
      const w = await readWhere(text, t), hint = f.querySelector("#placeHint");
      if (Number.isFinite(w.lat)) { f.dataset.lat = w.lat; f.dataset.lon = w.lon; if (w.label && /\+|https?:|°|^\s*-?\d/.test(text)) ev.target.value = w.label; }
      if (hint) hint.innerHTML = w.address ? "" : whereHint(w);
      return;
    }
    document.getElementById("whereHint").innerHTML = text.trim() ? whereHint(await readWhere(text, t)) : "";
  }, 450);
});
/** What the map draws for a trip: each flight's arc, and numbered pins in their day's colour. */
function mapData(t) {
  const p = plan(t), arcs = [], pins = [];
  p.days.forEach((d) => {
    for (const e of d.entries) {
      const i = e.item;
      if (i.kind === "flight") {
        const a = airport(i.dep_airport), b = airport(i.arr_airport);
        if (a && b && !e.repeat) arcs.push({ from: [a.lon, a.lat], to: [b.lon, b.lat], id: String(i.id), label: `${i.dep_airport}→${i.arr_airport}` });
        if (a && !e.repeat) pins.push({ lon: a.lon, lat: a.lat, kind: "flight", num: String(e.n), label: i.dep_airport, id: String(i.id), color: d.color });
      } else if (Number.isFinite(i.lat) && Number.isFinite(i.lon) && !e.repeat) pins.push({ lon: i.lon, lat: i.lat, kind: i.kind, num: String(e.n), label: i.name ?? "", id: String(i.id), color: d.color });
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
  // the places joined in the trip's order (the numbers), as on the journal's map
  const seq = d.pins.filter((p) => p.num).sort((x, y) => Number(x.num) - Number(y.num));
  if (seq.length > 1) d.paths = [{ coords: seq.map((p) => [p.lon, p.lat]), color: dark ? "#ffffff" : "#11162a" }];
  // pins take their day's colour (Wanderlog), flights the accent (Flighty)
  drawTrip(map, d, (id) => {
    const card = app.querySelector(`[data-item="${CSS.escape(id)}"]`);
    if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); card.animate?.([{ outline: "2px solid var(--accent)" }, { outline: "2px solid transparent" }], 1200); }
  }, tab === "flights" ? "all" : tab === "lodging" ? "lodging" : "pins", dark);   // Lodging zooms in on the stays
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

// --- a city's photo on a trip's cover (docs/trips.md §19.1): Wikipedia's lead image for one of the
// trip's cities, hotlinked from Wikimedia (a 960 px thumbnail), with its photographer and licence.
// Each city's answer (or "none") is kept in localStorage, so a list of trips asks once per city.
const PHOTOS = "kos-photos";
const photoCache = () => { try { return JSON.parse(localStorage.getItem(PHOTOS) ?? "{}"); } catch { return {}; } };
const keepPhoto = (k, v) => { try { const c = photoCache(); c[k] = v; localStorage.setItem(PHOTOS, JSON.stringify(c)); } catch { /* not kept */ } };
const WIKI = "https://en.wikipedia.org/w/api.php?format=json&origin=*&action=query";
async function wikiPhoto(name) {
  const page = Object.values((await (await fetch(`${WIKI}&redirects=1&prop=pageimages|pageprops&piprop=name&ppprop=disambiguation&titles=${encodeURIComponent(name)}`)).json()).query?.pages ?? {})[0];
  if (!page?.pageimage || page.pageprops?.disambiguation !== undefined) return null;      // none, or "Portland" (which one?)
  const info = Object.values((await (await fetch(`${WIKI}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=960&iiextmetadatafilter=Artist|LicenseShortName&titles=${encodeURIComponent(`File:${page.pageimage}`)}`)).json()).query?.pages ?? {})[0]?.imageinfo?.[0];
  if (!info || !isWikimediaImage(info.thumburl)) return null;
  const text = (h) => new DOMParser().parseFromString(String(h ?? ""), "text/html").body.textContent.trim().slice(0, 80);
  const who = text(info.extmetadata?.Artist?.value), licence = text(info.extmetadata?.LicenseShortName?.value);
  return { src: info.thumburl, href: /^https:\/\/commons\.wikimedia\.org\//.test(info.descriptionurl) ? info.descriptionurl : "https://commons.wikimedia.org/",
           credit: `Photo: ${[who, licence].filter(Boolean).join(", ") || "Wikimedia Commons"}` };
}
async function cityPhoto(t) {
  const names = cityNames(t, airports), key = names[0];
  if (!key) return null;
  const cached = photoCache()[key];
  if (cached) return cached.none ? null : cached;
  for (const n of names) {
    try { const p = await wikiPhoto(n); if (p) { keepPhoto(key, p); return p; } } catch { return null; }   // offline: try again next time
  }
  keepPhoto(key, { none: 1 });
  return null;
}
/** After a page is drawn: each cover with data-photo gets its trip's city photo under its scrim. */
async function applyPhotos() {
  for (const el of app.querySelectorAll("[data-photo]")) {
    const t = el.dataset.photo === "shared" ? previewTrip(pendingShare) : tripById(Number(el.dataset.photo));
    const p = t && await cityPhoto(t);
    if (!p || !el.isConnected || !isWikimediaImage(p.src)) continue;
    el.style.backgroundImage = `linear-gradient(180deg, rgba(0, 0, 0, .18), rgba(0, 0, 0, .55)), url("${p.src}")`;
    el.classList.add("has-photo");
    const c = document.createElement(el.hasAttribute("data-photo-link") ? "a" : "span");
    c.className = "photo-credit"; c.textContent = p.credit;
    if (c.tagName === "A") Object.assign(c, { href: p.href, target: "_blank", rel: "noopener" });
    el.append(c);
  }
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
    <p class="j-credit muted">Map: <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · © OpenMapTiles · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</p>
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
  await journalMap(t);
}
/** The journal's map: minimal, in the page's theme; the trip's places numbered in order and joined. */
async function journalMap(t) {
  const el = document.getElementById("jmap");
  if (!el) return;
  if (map) { map.remove(); map = null; }
  const dark = document.documentElement.dataset.theme !== "light";
  map = await createMap(el, { dark, minimal: true });
  if (!document.body.contains(el)) { map?.remove(); map = null; return; }
  if (!map) { const n = document.getElementById("jmapNote"); n.hidden = false; n.textContent = "The map couldn't load here (it needs WebGL and OpenFreeMap's tiles)."; return; }
  // the places, in the order the trip went: numbered 1, 2, 3… across the whole trip, in their day's
  // colour, joined by one line; the map frames them (zoomed in), and the flights draw without widening it
  const stops = [];
  for (const dd of plan(t).days) for (const e of dd.entries) {
    const i = e.item;
    if (i.kind === "flight" || e.repeat || !Number.isFinite(i.lat) || !Number.isFinite(i.lon)) continue;
    stops.push({ lon: i.lon, lat: i.lat, kind: i.kind, num: String(stops.length + 1), label: i.name ?? "", id: String(i.id), color: dd.color });
  }
  const d = mapData(t);
  const paths = stops.length > 1 ? [{ coords: stops.map((p) => [p.lon, p.lat]), color: "#ffffff" }] : [];
  drawTrip(map, stops.length ? { arcs: d.arcs, pins: stops, paths: paths.map((x) => ({ ...x, color: dark ? "#ffffff" : "#11162a" })) } : d, null, stops.length ? "pins" : "all", dark);
  el.querySelector(".maplibregl-compact-show")?.classList.remove("maplibregl-compact-show");   // the credits fold behind ⓘ, and are also under the map
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
    ${t ? "" : `<div class="card shared-paste"><b>Someone shared a trip?</b> <span class="muted">Paste its Kos link and the whole trip comes in, bookings and all.</span>
      <div class="shared-row"><input id="sharedPaste" autocomplete="off" placeholder="https://minty.milesmaximizer.com/kos/#/import?t=1.…" />
        <button type="button" class="btn" data-paste-shared data-goatcounter-click="kos-new-trip-paste-link">Look at it</button></div><span class="err"></span></div>`}
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
    <label class="wide">Address or place<input name="place" maxlength="200" value="${v("place")}" placeholder="An address, a plus code, coordinates or a Google Maps link" /></label>
    <div class="wide where-hint" id="placeHint"></div>
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
      <span class="muted">${esc(KIND[b.kind] ?? "")} · ${esc(fmtDay(dateOf(b.start_at ?? b.start)) || "no date")}${b.confirmation ? ` · ${esc(b.confirmation)}` : ""}${suggestTrip(b) ? ` · <b>→ ${esc(suggestTrip(b).name)}</b>` : ""}</span>${b.quote ? `<q>${esc(b.quote)}</q>` : ""}</span>
      <button type="button" class="btn small" data-use="${n}">Use</button>${from === "email" || from === "gmail" ? `<button type="button" class="btn small primary" data-add-now="${n}">Add</button>` : ""}</div>`).join("")}</div>
    ${(from === "email" || from === "gmail") && list.length > 1 ? `<div class="actions"><button type="button" class="btn primary" data-add-all>Add all ${list.length}</button></div>` : ""}</div>`;
}
let found = [], foundFrom = "", pulled = [], tabSwitch = false;
/** Where a found booking will go: the trip it was sent to, else the trip being added to, else the trip its dates fall in. */
const pageTrip = () => (route().q.get("trip") ? Number(route().q.get("trip")) : null);
const intoTrip = (b) => b.tripId ?? pageTrip() ?? tripGuess(b);
const suggestTrip = (b) => { const id = b.tripId ?? (pageTrip() ? null : tripGuess(b)); return id ? tripById(id) : null; };
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
      ${MODE === "device" ? `<p class="muted">${lsNum(BACKED_UP) ? `Last backed up ${ago(lsNum(BACKED_UP))}.` : "Not backed up yet."} <b>Back up</b> saves a copy where you choose: Google Drive, an email to yourself, or your phone's files.</p>` : ""}
      <div class="actions">${MODE === "device" ? `<button type="button" class="btn primary" data-backup data-goatcounter-click="kos-backup-data">Back up</button>` : ""}<button type="button" class="btn${MODE === "device" ? "" : " primary"}" data-export>Export (a JSON file)</button>
        <label class="btn">Import…<input type="file" accept="application/json,.json" id="importFile" hidden /></label><span class="err" id="formErr"></span></div></div>
    <div class="card" style="margin-top:12px"><h3 style="margin:0 0 6px">Add a shared trip</h3><p class="muted" style="margin-top:0">Paste a Kos trip link someone sent you (or the trip file's contents).</p>
      <textarea class="paste" id="sharedPaste" rows="2" placeholder="https://minty.milesmaximizer.com/kos/#/import?t=1.…"></textarea>
      <div class="actions"><button type="button" class="btn" data-paste-shared>Look at it</button></div></div>`;
}
// --- backups (docs/trips.md §17.5): the phone's share sheet (Google Drive, email, Files…), else a download
const BACKED_UP = "kos-backup-at", SNOOZE = "kos-backup-snooze";
const lsNum = (k) => { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* not kept */ } };
async function backUp() {
  const json = JSON.stringify(exportFile(data, await store.allNotes().catch(() => [])), null, 1);
  const file = new File([json], `kos-backup-${localDay()}.json`, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Kos backup", text: "My Kos trips: import this file in Kos (Your data) to restore them." }); }
    catch (e) { if (e?.name === "AbortError") return false; throw e; }                  // closed the sheet: not backed up
  } else {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: file.name });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  lsSet(BACKED_UP, Date.now()); lsSet(SNOOZE, 0);
  return true;
}
const ago = (ms) => { const d = Math.floor((Date.now() - ms) / 864e5); return d < 1 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };
/** The reminder, on the home screen of Kos on its own: shown for a short while, then snoozed. */
function backupReminder(own) {
  if (MODE !== "device" || !own) return "";
  const created = own.map((t) => Date.parse(t.created_at ?? "")).filter(Number.isFinite);
  if (!backupDue({ now: Date.now(), backedUp: lsNum(BACKED_UP), oldestOwn: created.length ? Math.min(...created) : 0, snoozedUntil: lsNum(SNOOZE) })) return "";
  const last = lsNum(BACKED_UP);
  return `<div class="card backup-note" id="backupNote" role="status"><span class="grow"><b>Back up your trips?</b> <span class="muted">They live only in this browser. ${last ? `Last backup ${ago(last)}.` : "Never backed up."} Save a copy to Google Drive, email or your phone.</span></span>
    <button type="button" class="btn small primary" data-backup data-goatcounter-click="kos-backup-banner">Back up now</button><button type="button" class="btn small ghost" data-backup-later aria-label="Not now">Not now</button></div>`;
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
    ${step(4, "Paste the web app's address here", `<form id="gmailForm" class="form"><label class="wide">Web app URL<input name="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c?.url ?? "")}" /></label>
      <label class="wide">Your Gmail address <small class="muted">(optional: each trip then shows its own address, you+<i>its code</i>@gmail.com; kept on this device)</small><input name="address" type="email" autocomplete="email" placeholder="you@gmail.com" value="${esc(gmail.gmailAddress())}" /></label></form>
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
  // the codes of trips still worth mail (coming up, on now, or ended in the last 60 days)
  const since = addDays(localDay(), -60), byCode = new Map(data.trips.filter((t) => isTripCode(t.code) && t.end_date >= since).map((t) => [t.code, t]));
  const msgs = await gmail.pull([...byCode.keys()]);
  const got = [], empty = [];
  for (const m of msgs) {
    const r = await store.readEmail(gmail.rawBytes(m.raw).buffer);
    if (!r.bookings.length) empty.push(m);
    const trip = m.trip ? byCode.get(m.trip) : null;               // sent to a trip's own address: it goes in that trip
    for (const b of r.bookings) got.push({ ...b, sha256: r.sha256, msgId: m.id, quote: m.subject, tripId: trip?.id ?? null });
  }
  // the page moved on, a newer check ran, or (quietly) something else is being suggested: leave it
  if (!box.isConnected || mine !== pullSeq || (quiet && (!got.length || (found.length && foundFrom !== "gmail")))) return;
  found = got; foundFrom = "gmail"; pulled = msgs.map((m) => m.id);
  box.innerHTML = (quiet ? `<div class="suggest-head muted">New in your Gmail</div>` : "") + suggestionsHtml(found, "gmail") + (empty.length ? `<div class="suggest muted">${empty.length} email${empty.length === 1 ? "" : "s"} with no booking details Kos can read (${empty.slice(0, 3).map((m) => `“${esc(m.subject)}”`).join(", ")}): paste their text instead.</div>` : "")
    + (msgs.length ? `<div class="actions"><button type="button" class="btn ghost" data-gmail-skip>Don't show these again</button></div>` : "")
    + (gmail.oldScript ? `<div class="suggest muted">Your Gmail script reads only the Kos label. To use each trip's own address, copy the script from <a href="#/gmail">the set-up page</a> into Apps Script again and deploy a new version.</div>` : "");
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
  if (/[?&#]t=1\.[A-Za-z0-9_-]{8,}/.test(text)) { try { pendingShare = await readShare(text); } catch (e) { pendingShare = { error: e.message }; } location.hash = "#/import"; return; }
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
    if (parts[2] === "share") { app.innerHTML = shareView(t); fillShare(t); return; }
    app.innerHTML = tripView(t, parts[2] ?? "");
    applyPhotos();
    showMap(t, parts[2] ?? "");
    if (parts[2] === "spending") spending(t);
    return;
  }
  if (parts[0] === "report") {                                 // "Send to the Kos developers", with the trip in the link
    const code = (location.hash.match(/[?&]t=([^&]+)/) ?? [])[1];
    if (code) { history.replaceState(null, "", "#/report"); try { pendingReport = { ...(await readShare(`t=${code}`)), link: shareLink(code) }; } catch (e) { pendingReport = { error: e.message }; } }
    app.innerHTML = reportView(pendingReport); return;
  }
  if (parts[0] === "import") {                                 // a shared trip's link: a preview, then Add
    const code = (location.hash.match(/[?&]t=([^&]+)/) ?? [])[1];
    if (code) { history.replaceState(null, "", "#/import"); try { pendingShare = await readShare(`t=${code}`); } catch (e) { pendingShare = { error: e.message }; } }
    app.innerHTML = importView(pendingShare);
    const pt = previewTrip(pendingShare);
    if (pt) { mapKey = ""; showMap(pt); applyPhotos(); }
    return;
  }
  if (parts[0] === "place") {
    const t = tripById(Number(q.get("trip")));
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(q.get("day") ?? "")) { location.hash = "#/"; return; }
    app.innerHTML = placeView(t, q.get("day")); app.querySelector("[name=where]").focus(); return;
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
  applyPhotos();
  if (document.getElementById("backupNote")) setTimeout(() => { const n = document.getElementById("backupNote"); if (n) { n.classList.add("leaving"); setTimeout(() => n.remove(), 400); lsSet(SNOOZE, Date.now() + 3 * 864e5); } }, 15000);
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
    if (at("[data-ics]")) { const id = Number(at("[data-ics]").dataset.ics); ics(id < 0 ? previewTrip(pendingShare)?.items.find((x) => x.id === id) : itemById(id)); return; }
    if (at(".preview [data-item]")) {                               // a shared trip's preview: show it on the map, never open it
      const i = previewTrip(pendingShare)?.items.find((x) => x.id === Number(at("[data-item]").dataset.item));
      if (map && i && Number.isFinite(i.lat) && Number.isFinite(i.lon)) focus(map, i.lon, i.lat);
      return;
    }
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
    if (at("[data-copy-text]")) {
      const b = at("[data-copy-text]");
      try { await navigator.clipboard.writeText(b.dataset.copyText); b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1500); } catch { /* the address is shown to copy by hand */ }
      return;
    }
    if (at("[data-copy]")) {
      const el = document.getElementById(at("[data-copy]").dataset.copy);
      try { await navigator.clipboard.writeText(el.value); at("[data-copy]").textContent = "Copied"; } catch { el.select(); }
      return;
    }
    if (at("[data-gmail-save]")) {
      try { gmail.save(app.querySelector("#gmailForm [name=url]").value); gmail.saveAddress(app.querySelector("#gmailForm [name=address]").value); } catch (e2) { app.querySelector("#formErr").textContent = e2.message; return; }
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
      lsSet(BACKED_UP, Date.now());                              // an export is a backup too
      return;
    }
    if (at("[data-report-trip]")) { const t = tripById(Number(route().parts[1])); if (t) await reportTrip(t); return; }
    if (at("[data-report-mail]")) {
      const form = app.querySelector("#reportForm");
      const f = pendingReport, m = reportMail({ to: window.KOS_REPORT_TO, trip: f.trips[0], link: f.link, note: form.elements.note.value, why: form.elements.why.value });
      if (m.tooLong) {
        try { await navigator.clipboard.writeText(f.link); } catch { /* the Copy button is there */ }
        document.getElementById("reportNote").textContent = "The trip's link is long, so it's copied: paste it into the email.";
      }
      location.href = m.href; return;
    }
    if (at("[data-share-trip]")) { try { await navigator.share({ title: "A trip in Kos", url: document.getElementById("shareText").value }); } catch { /* closed */ } return; }
    if (at("[data-share-file]")) {
      const t = tripById(Number(route().parts[1]));
      const file = new Blob([JSON.stringify(await readShare(document.getElementById("shareText").value), null, 1)], { type: "application/json" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: `kos-trip-${(t?.name ?? "trip").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); return;
    }
    if (at("[data-add-shared]")) {
      try { const r = await importData(pendingShare); pendingShare = null; data = null; location.hash = r.trips[0] ? `#/trip/${r.trips[0]}` : "#/"; }
      catch (e2) { app.querySelector("#formErr").textContent = e2.message; }
      return;
    }
    if (at("[data-paste-shared]")) {
      const box = at("[data-paste-shared]").closest(".card");
      try { pendingShare = await readShare(box.querySelector("#sharedPaste").value); location.hash = "#/import"; render(); }
      catch (e2) { (box.querySelector(".err") ?? app.querySelector("#formErr")).textContent = e2.message; }
      return;
    }
    if (at("[data-backup]")) {
      try { if (await backUp()) { document.getElementById("backupNote")?.remove(); if (route().parts[0] === "data") render(); } }
      catch (e2) { alert(`Couldn't back up: ${e2.message}`); }
      return;
    }
    if (at("[data-backup-later]")) { lsSet(SNOOZE, Date.now() + 7 * 864e5); document.getElementById("backupNote")?.remove(); return; }
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
      const b = found[Number(at("[data-use]").dataset.use)], tripId = b.tripId ?? (Number(app.querySelector("[name=trip_id]")?.value) || tripGuess(b));
      draft = { ...asItem(b, tripId), source: foundFrom === "paste" ? "paste" : foundFrom, source_sha256: b.sha256 ?? null };
      document.getElementById("formBox").innerHTML = itemForm(draft, tripId);
      loadPrograms();
      document.getElementById("formBox").scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (at("[data-add-now]") || at("[data-add-all]")) {
      const list = at("[data-add-all]") ? found : [found[Number(at("[data-add-now]").dataset.addNow)]];
      // a booking sent to a trip's own address goes in that trip; the rest in the trip being added to, else the one its dates fall in
      for (const b of list) await store.saveItem(null, { ...asItem(b, intoTrip(b)), source: "email", source_sha256: b.sha256 ?? null });
      if (foundFrom === "gmail") gmail.markSeen(list.map((b) => b.msgId).filter(Boolean));
      const into = [...new Set(list.map(intoTrip))];
      data = null; draft = null; found = [];
      location.hash = into.length === 1 && into[0] ? `#/trip/${into[0]}` : "#/";
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
    if (f.id === "placeForm") {
      const t = tripById(Number(f.dataset.trip)), e = f.elements, text = e.where.value.trim();
      const w = text ? await readWhere(text, t) : { address: "" };
      if (w.error) { err(w.error); return; }
      const name = e.name.value.trim() || w.label || (w.address ? w.address.split(",")[0] : "") || "A place";
      await store.saveItem(null, { kind: "event", trip_id: t.id, name, start_at: e.time.value ? `${f.dataset.day}T${e.time.value}` : f.dataset.day,
        place: w.address || w.label || null, lat: Number.isFinite(w.lat) ? w.lat : null, lon: Number.isFinite(w.lon) ? w.lon : null, source: "typed" });
      data = null; location.hash = `#/trip/${t.id}`; return;
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
  if (parts[0] === "trip" && parts[1] && parts[2] === "journal") journalMap(tripById(Number(parts[1])));   // its light or dark map
  else if (parts[0] === "trip" && parts[1] && parts[2] !== "edit") { mapKey = ""; showMap(tripById(Number(parts[1])), parts[2] ?? ""); }
  else if (parts[0] === "import" && previewTrip(pendingShare)) { mapKey = ""; showMap(previewTrip(pendingShare)); }
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
