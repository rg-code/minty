// Kos's real-data check (docs/trips.md §27): your own booking emails through Kos's whole reader, on your
// machine. Save confirmations as .eml files (Gmail: open the email → ⋮ → Download message; for a test of
// "Forward as attachment", download the forward itself), or paste text into .txt files, in a folder
// OUTSIDE this repo, then run:
//
//   node scripts/kos-t0/parse.ts ~/kos-emails            (a folder, or any .eml / .txt files)
//   node scripts/kos-t0/parse.ts ~/kos-emails --codes    (show confirmation codes in full)
//
// For each file: how Kos read it (an attached original's markup, the email's own markup, or its text) and
// every booking it found, with its dates, times, flight, places, points and total; then the trips Kos would
// make from them all. Nothing is saved or sent anywhere. Confirmation codes are masked unless --codes, so the
// output is fit to paste back to Claude (it still names places and dates: paste only what you're happy to).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { attachedMessage, emailText, readMessage, viewOf } from "../../src/kos/mime.ts";
import { reservations } from "../../src/kos/reservations.ts";
// @ts-ignore: plain JS modules, shared with the browser
import { parseBookings, readEmailBookings } from "../../public/kos/kos-parse.js";
// @ts-ignore
import { journeys, planTrips } from "../../public/kos/store.js";

const args = process.argv.slice(2);
const showCodes = args.includes("--codes");
const paths = args.filter((a) => !a.startsWith("--"));
if (!paths.length) { console.error("usage: node scripts/kos-t0/parse.ts <folder or .eml/.txt files> [--codes]"); process.exit(1); }
const files: string[] = [];
for (const p of paths) {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) { if (/\.(eml|txt)$/i.test(f)) files.push(join(p, f)); }
  else files.push(p);
}
if (!files.length) { console.error("no .eml or .txt files there"); process.exit(1); }

const airports = JSON.parse(readFileSync(new URL("../../public/kos/airports.json", import.meta.url), "utf8"));
const mask = (c: string | null | undefined) => (!c ? "" : showCodes ? c : `${c.slice(0, 2)}${"•".repeat(Math.max(2, c.length - 2))}`);
// a markup booking in the shape Kos keeps (kos.js asItem, without the page)
const asItem = (b: any) => {
  const f = b.flight ?? b;
  const out: any = { kind: b.kind, name: b.name ?? null, confirmation: b.confirmation ?? null, start_at: b.start ?? b.start_at ?? null, end_at: b.end ?? b.end_at ?? null,
    place: b.place ?? null, price_cents: b.price_cents ?? null, currency: b.currency ?? null, points: b.points ?? null, points_program: b.points_program ?? null, status: b.status ?? null };
  if (b.kind === "flight") Object.assign(out, { airline: f.airline ?? null, flight_number: f.number ?? f.flight_number ?? null, dep_airport: f.from ?? f.dep_airport ?? null, arr_airport: f.to ?? f.arr_airport ?? null });
  if (out.airline && !/^[A-Z0-9]{2,3}$/i.test(out.airline)) { out.name ??= out.airline; out.airline = null; }
  return out;
};
const when = (s: string | null) => (s ? String(s).slice(0, 16).replace("T", " ") : "?");
const money = (b: any) => (b.price_cents != null ? `${(b.price_cents / 100).toFixed(2)} ${b.currency ?? ""}`.trim() : "");

const all: any[] = [], none: string[] = [], hows: Record<string, number> = {}, kinds: Record<string, number> = {};
let id = 0, ms = 0;
for (const file of files) {
  const t0 = performance.now();
  let how: string, bookings: any[], view: string | null = null, note = "";
  if (/\.eml$/i.test(file)) {
    const raw = readFileSync(file, "latin1");                         // one char per byte, as Gmail delivers it
    const outer = readMessage(raw), inner = attachedMessage(raw), m = inner ?? outer;
    view = viewOf(outer);
    const r = readEmailBookings({ markup: reservations(m.html), text: emailText(m), date: m.date, subject: m.subject }, { airports });
    how = (inner ? "attached original · " : "") + (r.how === "markup" ? "markup" : r.how === "text" ? (m.text && emailText(m) === m.text ? "text" : "html as text") : "nothing to read");
    bookings = r.bookings.map(asItem);
    if (r.cancelled) note = " · a cancellation";
    if (r.promotional) note = " · looks like marketing: skipped";
  } else {
    const r = parseBookings(readFileSync(file, "utf8"), { ref: Date.now(), airports });
    how = "pasted text";
    bookings = r.bookings.map(asItem);
    if (r.cancelled) note = " · a cancellation";
  }
  ms += performance.now() - t0;
  hows[how] = (hows[how] ?? 0) + 1;
  console.log(`\n${basename(file)}  [${how}${view ? ` · ${view}` : ""}${note}]  ${bookings.length} booking${bookings.length === 1 ? "" : "s"}`);
  if (!bookings.length) none.push(basename(file));
  for (const b of bookings) {
    kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
    const what = b.kind === "flight" ? `${[b.airline, b.flight_number].filter(Boolean).join(" ") || "flight ?"}  ${b.dep_airport ?? "?"}→${b.arr_airport ?? "?"}` : (b.name ?? "(no name)");
    const extras = [b.place && b.kind !== "flight" ? `at ${b.place}` : "", b.confirmation ? `conf ${mask(b.confirmation)}` : "no conf", money(b),
      b.points ? `${b.points.toLocaleString()} pts${b.points_program ? ` (${b.points_program})` : ""}` : "", b.status === "cancelled" ? "CANCELLED" : ""].filter(Boolean).join(" · ");
    console.log(`  ${b.kind.padEnd(10)} ${what}  ${when(b.start_at)} → ${when(b.end_at)}  ${extras}`);
    if (b.status !== "cancelled") all.push({ ...b, id: ++id, file: basename(file) });
  }
}

// the trips Kos would make from everything here (docs/trips.md §26)
const plan = planTrips(all, [], airports);
console.log("\n--- summary (paste this back) ---");
console.log(`files: ${files.length} (${Object.entries(hows).map(([k, v]) => `${v} ${k}`).join(", ")})`);
console.log(`bookings: ${all.length} (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}); as Kos shows them, connections joined: ${journeys(all).length}`);
console.log(`files with no booking found: ${none.length}${none.length ? ` (${none.join(", ")})` : ""}`);
console.log(`trips Kos would make: ${plan.make.length}`);
for (const t of plan.make) console.log(`  ${t.name}: ${t.start_date} to ${t.end_date}, ${t.items.length} booking${t.items.length === 1 ? "" : "s"}`);
const left = all.filter((i) => !plan.make.some((t: any) => t.items.includes(i.id)));
if (left.length) console.log(`  waiting for a trip: ${left.length} (${left.map((i) => `${i.kind} ${when(i.start_at)}`).join(", ")})`);
console.log(`time: ${(ms / files.length).toFixed(1)} ms a file`);
