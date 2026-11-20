#!/usr/bin/env node
// Kos on its own (docs/trips.md §17): the same app as /kos/ on a Minty, keeping its trips in the
// browser (IndexedDB) instead of Minty's API. Builds it as static files for any host, laid out as
// served (the site's root holds /kos/ and the shared files Kos loads by absolute path):
//
//   node scripts/build-kos.mjs --out ../minty-site/public
//
// Writes <out>/kos/ (with mode.js set to "device", and the email reader as plain JS in kos/mail/),
// <out>/vendor/{maplibre,pdfjs,tesseract,qrcode}/, the screenshot reader (/sub-scan) and what it and Kos
// share with Minty (pdf-read.js, lock.js, theme.js…), and <out>/_headers.kos: the pages' security
// policy, for a host that reads Cloudflare-style _headers (minty-site's deploy.mjs merges it).
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const out = arg("out") ? resolve(arg("out")) : join(root, "dist/kos-standalone");

async function copyDir(from, to, skip = () => false) {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    if (e.isDirectory()) await copyDir(join(from, e.name), join(to, e.name), skip);
    else await copyFile(join(from, e.name), join(to, e.name));
  }
}

// 1. Kos itself, in device mode
await copyDir(join(root, "public/kos"), join(out, "kos"));
await writeFile(join(out, "kos/mode.js"), `// Kos on its own: trips are kept in this browser (public/kos/store.js). Written by scripts/build-kos.mjs.\nwindow.KOS_MODE = "device";\n`);
// the email reader (src/kos/), types stripped: the same code Minty runs on the server
await mkdir(join(out, "kos/mail"), { recursive: true });
for (const f of ["mime", "reservations"]) {
  const ts = await readFile(join(root, `src/kos/${f}.ts`), "utf8");
  if (/^\s*import\s(?!type\b)/m.test(ts)) throw new Error(`build-kos: src/kos/${f}.ts imports at runtime; the browser copy can't follow it`);
  await writeFile(join(out, `kos/mail/${f}.js`), `// Built from src/kos/${f}.ts by scripts/build-kos.mjs (types stripped).\n${stripTypeScriptTypes(ts)}`);
}
// the offline shell also holds the email reader
const sw = await readFile(join(out, "kos/sw.js"), "utf8");
if (!sw.includes(`"/kos/store.js",`)) throw new Error("build-kos: kos/sw.js's shell changed; update the edit here");
await writeFile(join(out, "kos/sw.js"), sw.replace(`"/kos/store.js",`, `"/kos/store.js", "/kos/mail/mime.js", "/kos/mail/reservations.js",`));
// the Minty link in the header goes; "Your data" says where the trips are
const html = await readFile(join(out, "kos/index.html"), "utf8");
if (!html.includes('id="mintyLink"')) throw new Error("build-kos: kos/index.html lost its Minty link; update the edit here");

// the sample trips ("Try a sample trip" on an empty Kos): the live demo's made-up trips (demo/data.ts),
// as a Kos export dated from a fixed day; the page moves them to the visitor's today (shiftSample).
// Trips and bookings only: Kos on its own has no people, transactions or tags.
const SAMPLE_FROM = "2026-01-15";
const { generate } = await import(pathToFileURL(join(root, "demo/data.ts")).href);
const demo = generate(new Date(`${SAMPLE_FROM}T12:00:00Z`));
const sample = { app: "Kos", version: 1, sample_from: SAMPLE_FROM,
  trips: demo.trips.map(({ tags, travellers, ...t }) => ({ ...t, travellers: [] })),
  items: demo.tripItems };
if (!sample.trips.length || !sample.items.length) throw new Error("build-kos: the demo has no trips for the sample");
await writeFile(join(out, "kos/sample.json"), JSON.stringify(sample));

// 2. What Kos loads from the site's root, as on a Minty
for (const d of ["maplibre", "pdfjs", "tesseract", "qrcode"]) await copyDir(join(root, "public/vendor", d), join(out, "vendor", d));
for (const f of ["pdf-read.js", "lock.js", "lock.css", "theme.js", "sub-scan.html", "sub-scan.js", "sub.css"]) await copyFile(join(root, "public", f), join(out, f));

// 3. The security policy, as Minty's public/_headers gives these paths
const headers = await readFile(join(root, "public/_headers"), "utf8");
const block = (path) => {
  const m = new RegExp(`^${path.replace(/[*/]/g, (c) => `\\${c}`)}\\n((?:  .*\\n?)+)`, "m").exec(headers);
  if (!m) throw new Error(`build-kos: no ${path} block in public/_headers`);
  return m[1].split("\n").filter((l) => /Content-Security-Policy:/.test(l)).map((l) => l.replace(/^\s*/, "  ")).join("\n");
};
const base = /^\/\*\n((?:  .*\n?)+)/m.exec(headers)[1].split("\n").filter((l) => l.trim() && !/^\s*!/.test(l)).map((l) => l.replace(/^\s*/, "  "));
const others = base.filter((l) => !/Content-Security-Policy/.test(l)).join("\n");
await writeFile(join(out, "_headers.kos"), `# Kos on its own (from rg-code/minty's public/_headers, by scripts/build-kos.mjs)
/kos/*
${block("/kos/*")}
${others}
/vendor/maplibre/*
${block("/vendor/maplibre/*")}
/sub-scan
${block("/sub-scan")}
${others}
/vendor/tesseract/*
${block("/vendor/tesseract/*")}
`);
console.log(`Kos (on its own) built in ${out}: kos/, vendor/, the screenshot reader, _headers.kos`);
