// JET T0 (docs/trips.md §11): how well Minty reads your own booking emails, and how long it takes.
// Export ~20 confirmation emails as .eml files (Gmail: open the email → ⋮ → Download message) into a
// folder OUTSIDE this repo, then run:
//
//   node scripts/jet-t0/parse.ts ~/jet-emails
//
// It prints, for each file, what was found (kinds, which fields) and the time to read it, then a
// summary. Nothing is saved or sent anywhere; paste the summary (not the emails) back to Claude.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readMessage, viewOf } from "../../src/jet/mime.ts";
import { reservations } from "../../src/jet/reservations.ts";

const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/jet-t0/parse.ts <folder of .eml files>"); process.exit(1); }
const files = readdirSync(dir).filter((f) => /\.eml$/i.test(f)).sort();
if (!files.length) { console.error(`no .eml files in ${dir}`); process.exit(1); }

const times: number[] = [], kinds: Record<string, number> = {}, missing: Record<string, number> = {};
let withMarkup = 0;
for (const f of files) {
  const raw = readFileSync(join(dir, f), "latin1");                 // one char per byte, as Gmail and Cloudflare deliver it
  reservations(readMessage(raw).html);                               // once to warm up, then timed
  const t0 = performance.now();
  const m = readMessage(raw);
  const r = reservations(m.html);
  const ms = performance.now() - t0;
  times.push(ms);
  if (r.length) withMarkup++;
  for (const b of r) {
    kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
    for (const k of ["confirmation", "start", "end", "place", "price_cents"] as const) if (b[k] === null) missing[`${b.kind}.${k}`] = (missing[`${b.kind}.${k}`] ?? 0) + 1;
  }
  const kb = Math.round(statSync(join(dir, f)).size / 1024);
  console.log(`${f}: ${kb} KB, ${ms.toFixed(1)} ms, view ${viewOf(m) ?? "-"}, ${r.length ? r.map((b) => b.kind + (b.flight ? ` ${b.flight.airline ?? ""}${b.flight.number ?? ""} ${b.flight.from ?? "?"}→${b.flight.to ?? "?"}` : "")).join(", ") : "no schema.org markup"}${m.attachments.length ? `, ${m.attachments.length} attachment(s)` : ""}`);
}
times.sort((a, b) => a - b);
console.log("\n--- summary (paste this back) ---");
console.log(`files: ${files.length}, with booking markup: ${withMarkup}`);
console.log(`bookings: ${JSON.stringify(kinds)}`);
console.log(`fields missing: ${JSON.stringify(missing)}`);
console.log(`read time: median ${times[Math.floor(times.length / 2)].toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms (Node on this machine; the Worker's 10 ms CPU limit is the bar)`);
