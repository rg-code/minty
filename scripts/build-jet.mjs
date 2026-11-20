#!/usr/bin/env node
// JET on its own (docs/trips.md §17): the same app as /jet/ on a Minty, keeping its trips in the
// browser (IndexedDB) instead of Minty's API. Builds it as static files for any host, laid out as
// served (the site's root holds /jet/ and the shared files JET loads by absolute path):
//
//   node scripts/build-jet.mjs --out ../minty-site/public
//
// Writes <out>/jet/ (with mode.js set to "device", and the email reader as plain JS in jet/mail/),
// <out>/vendor/{maplibre,pdfjs,tesseract}/, the screenshot reader (/sub-scan) and what it and JET
// share with Minty (pdf-read.js, lock.js, theme.js…), and <out>/_headers.jet: the pages' security
// policy, for a host that reads Cloudflare-style _headers (minty-site's deploy.mjs merges it).
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const out = arg("out") ? resolve(arg("out")) : join(root, "dist/jet-standalone");

async function copyDir(from, to, skip = () => false) {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    if (e.isDirectory()) await copyDir(join(from, e.name), join(to, e.name), skip);
    else await copyFile(join(from, e.name), join(to, e.name));
  }
}

// 1. JET itself, in device mode
await copyDir(join(root, "public/jet"), join(out, "jet"));
await writeFile(join(out, "jet/mode.js"), `// JET on its own: trips are kept in this browser (public/jet/store.js). Written by scripts/build-jet.mjs.\nwindow.JET_MODE = "device";\n`);
// the email reader (src/jet/), types stripped: the same code Minty runs on the server
await mkdir(join(out, "jet/mail"), { recursive: true });
for (const f of ["mime", "reservations"]) {
  const ts = await readFile(join(root, `src/jet/${f}.ts`), "utf8");
  if (/^\s*import\s(?!type\b)/m.test(ts)) throw new Error(`build-jet: src/jet/${f}.ts imports at runtime; the browser copy can't follow it`);
  await writeFile(join(out, `jet/mail/${f}.js`), `// Built from src/jet/${f}.ts by scripts/build-jet.mjs (types stripped).\n${stripTypeScriptTypes(ts)}`);
}
// the offline shell also holds the email reader
const sw = await readFile(join(out, "jet/sw.js"), "utf8");
if (!sw.includes(`"/jet/store.js",`)) throw new Error("build-jet: jet/sw.js's shell changed; update the edit here");
await writeFile(join(out, "jet/sw.js"), sw.replace(`"/jet/store.js",`, `"/jet/store.js", "/jet/mail/mime.js", "/jet/mail/reservations.js",`));
// the Minty link in the header goes; "Your data" says where the trips are
const html = await readFile(join(out, "jet/index.html"), "utf8");
if (!html.includes('id="mintyLink"')) throw new Error("build-jet: jet/index.html lost its Minty link; update the edit here");

// 2. What JET loads from the site's root, as on a Minty
for (const d of ["maplibre", "pdfjs", "tesseract"]) await copyDir(join(root, "public/vendor", d), join(out, "vendor", d));
for (const f of ["pdf-read.js", "lock.js", "lock.css", "theme.js", "sub-scan.html", "sub-scan.js", "sub.css"]) await copyFile(join(root, "public", f), join(out, f));

// 3. The security policy, as Minty's public/_headers gives these paths
const headers = await readFile(join(root, "public/_headers"), "utf8");
const block = (path) => {
  const m = new RegExp(`^${path.replace(/[*/]/g, (c) => `\\${c}`)}\\n((?:  .*\\n?)+)`, "m").exec(headers);
  if (!m) throw new Error(`build-jet: no ${path} block in public/_headers`);
  return m[1].split("\n").filter((l) => /Content-Security-Policy:/.test(l)).map((l) => l.replace(/^\s*/, "  ")).join("\n");
};
const base = /^\/\*\n((?:  .*\n?)+)/m.exec(headers)[1].split("\n").filter((l) => l.trim() && !/^\s*!/.test(l)).map((l) => l.replace(/^\s*/, "  "));
const others = base.filter((l) => !/Content-Security-Policy/.test(l)).join("\n");
await writeFile(join(out, "_headers.jet"), `# JET on its own (from rg-code/minty's public/_headers, by scripts/build-jet.mjs)
/jet/*
${block("/jet/*")}
${others}
/vendor/maplibre/*
${block("/vendor/maplibre/*")}
/sub-scan
${block("/sub-scan")}
${others}
/vendor/tesseract/*
${block("/vendor/tesseract/*")}
`);
console.log(`JET (on its own) built in ${out}: jet/, vendor/, the screenshot reader, _headers.jet`);
