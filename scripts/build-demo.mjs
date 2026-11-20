#!/usr/bin/env node
// Builds Minty's live demo: a static folder with the real dashboard (public/index.html, app.js,
// theme.js, abc.js, abc.css) and the real Worker (src/) bundled to run in the browser over sql.js, with a made-up
// household (demo/). No server, no Plaid, nothing leaves the browser. See docs/demo.md.
//
//   npm run build:demo -- [--out dist/demo] [--goatcounter https://<code>.goatcounter.com/count]
//                         [--og-image https://…/og.png --og-url https://…/demo/]   (link previews)
//
// Every change to the dashboard's files is checked: if index.html, app.js or theme.js changes so
// that one no longer applies, the build stops instead of shipping a demo that half works.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const out = arg("out", join(root, "dist/demo"));
const goatcounter = arg("goatcounter", "");
if (goatcounter && !/^https:\/\/[a-z0-9-]+\.goatcounter\.com\/count$/.test(goatcounter)) throw new Error(`--goatcounter: not a GoatCounter count URL: ${goatcounter}`);
// Link previews (Slack, iMessage…) for wherever the demo is published: an absolute PNG/JPEG URL
// (previews can't show SVG) and the demo's own address. Off unless both are given.
const ogImage = arg("og-image", ""), ogUrl = arg("og-url", "");
for (const [flag, v] of [["og-image", ogImage], ["og-url", ogUrl]]) if (v && !/^https:\/\/[^\s"<>]+$/.test(v)) throw new Error(`--${flag}: not an https URL: ${v}`);
if (!!ogImage !== !!ogUrl) throw new Error("--og-image and --og-url go together");
if (ogImage && !/\.(png|jpe?g)$/i.test(ogImage)) throw new Error(`--og-image: link previews need a PNG or JPEG: ${ogImage}`);

// sql.js from cdnjs, pinned: the script by its SRI hash, the WebAssembly by a hash checked by fetch().
const SQLJS = {
  js: "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.min.js",
  jsSri: "sha512-laAM/mJRoxfgUSDOnpAVE3GGgawvUZ8wQU79lX5sT55mdIKhmc5mOEIy5HcJSAy4K78sQs29wJAr+3GMQUAuMg==",
  wasm: "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.wasm",
  wasmSri: "sha512-Z/UYoXMYCkSl2TtNi599HFtI4qtPlrjriTZQf0zPJPn0baSi2F2KnK9LblvSw5ta0cuYl+Jr4N1dQdKgu+eEFA==",
};

const migrationsDir = join(root, "d1/migrations");
const migrations = await Promise.all((await readdir(migrationsDir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
  .map((f) => readFile(join(migrationsDir, f), "utf8")));
const wrangler = await readFile(join(root, "wrangler.jsonc"), "utf8");
const apiPaths = JSON.parse(wrangler.match(/"run_worker_first":\s*(\[[^\]]*\])/)[1]);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await build({
  entryPoints: [join(root, "demo/main.js")],
  bundle: true, minify: true, format: "iife", target: "es2022", platform: "browser", legalComments: "none",
  outfile: join(out, "demo.js"), metafile: true,
  // Access checks run with MINTY_DEV_NO_AUTH on a localhost request, so the JWT library is never used.
  alias: { jose: join(root, "demo/jose-stub.js") },
  define: { __MIGRATIONS__: JSON.stringify(migrations), __API_PATHS__: JSON.stringify(apiPaths), __SQLJS__: JSON.stringify(SQLJS) },
  logLevel: "warning",
});

// The dashboard page and its own scripts, changed only where listed.
const files = {};
for (const f of ["index.html", "app.js", "theme.js", "sub.js", "bills.js"]) files[f] = await readFile(join(root, "public", f), "utf8");
const editIn = (file, what, from, to, count = 1) => {
  const text = files[file];
  const n = typeof from === "string" ? text.split(from).length - 1 : (text.match(from) ?? []).length;
  if (count === "some" ? n < 1 : n !== count) throw new Error(`build-demo: "${what}" matched ${n} times in public/${file} (expected ${count})`);
  files[file] = typeof from === "string" ? text.replaceAll(from, to) : text.replace(from, to);
};
const edit = (what, from, to, count) => editIn("index.html", what, from, to, count);
edit("title", /<title>[^<]*<\/title>/, "<title>Minty demo</title>");
const DESCRIPTION = "Minty with made-up data, in your browser: transactions, card credits (ABC) and more.";
const og = ogImage ? `
<meta name="description" content="${DESCRIPTION}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Minty" />
<meta property="og:title" content="Minty live demo" />
<meta property="og:description" content="${DESCRIPTION}" />
<meta property="og:url" content="${ogUrl}" />
<meta property="og:image" content="${ogImage}" />
<meta property="og:image:alt" content="Minty: your own private home for all your bank and card transactions" />
<meta name="twitter:card" content="summary_large_image" />` : "";
edit("demo script first", /^<head>$/m, `<head>\n<meta name="robots" content="noindex" />${og}\n<script src="demo.js"></script>`);
edit("no manifest", /<link rel="manifest"[^>]*>\n?/, "");
edit("Kos in the demo", `<a href="/kos/" title=`, `<a href="kos/" data-goatcounter-click="minty-demo-kos" title=`);   // Kos runs on the demo's data too (below)
editIn("app.js", "a trip opens the demo's Kos", "/kos/#/trip/", "kos/#/trip/");
edit("no device lock", '<link rel="stylesheet" href="/lock.css" />\n<script src="/lock.js"></script>\n', "");   // demo visitors are never asked for Face ID
editIn("app.js", "no service worker", `if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});`, "// the demo registers no service worker");
// SUB's screenshot reader is its own page with Tesseract (7 MB), which the demo leaves out: paste and PDFs still work.
editIn("bills.js", "no Gmail (the demo has no Gmail script)", /\n\s*<a class="pill" href="\/kos\/#\/bills"[^\n]*<\/a>/, "");
editIn("sub.js", "no screenshot reader", `<button type="button" class="pill" data-scan>Read a screenshot</button>`, "");
editIn("theme.js", "light by default", `|| (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")`, `|| "light"`);
edit("relative asset paths", /(href|src)="\/(favicon\.svg|favicon-32\.png|apple-touch-icon\.png|abc\.css|abc\.js|bills\.css|bills\.js|bam\.css|bam\.js|cfa\.css|cfa\.js|charts\.js|charts\.css|egg\.css|egg\.js|accounts\.css|accounts\.js|sub\.css|sub\.js|swipe\.js|reconcile\.js|app\.js|theme\.js)"/g, (_, a, f) => `${a}="${f}"`, "some");
const html0 = files["index.html"];
if (/(href|src)="\/(?!connect|add-user)[a-z]/.test(html0)) throw new Error(`build-demo: an absolute asset path is left: ${html0.match(/(href|src)="\/(?!connect|add-user)[^"]*"/)[0]}`);
edit("demo styles", /^<\/head>$/m, `<link rel="stylesheet" href="demo.css" />\n</head>`);
edit("ABC click event", `id="abcOpen"`, `id="abcOpen" data-goatcounter-click="minty-demo-abc"`);
edit("BAM click event", `id="bamOpen"`, `id="bamOpen" data-goatcounter-click="minty-demo-bam"`);
edit("EGG click event", `id="eggOpen"`, `id="eggOpen" data-goatcounter-click="minty-demo-egg"`);
edit("needs JavaScript", /^<body>$/m, `<body>\n<noscript><p style="padding:16px;text-align:center">The demo runs in your browser, so it needs JavaScript.</p></noscript>`);
const GOATCOUNTER = `<!-- GoatCounter: no cookies, no personal data; the host goes in the path. allow_frame: the landing
     page shows the demo in a frame, which GoatCounter otherwise doesn't count. -->
<script>window.goatcounter = { path: (p) => location.host + p, allow_frame: true };</script>
<script data-goatcounter="${goatcounter}" async src="https://gc.zgo.at/count.js"></script>
</body>`;
if (goatcounter) edit("GoatCounter", /^<\/body>$/m, GOATCOUNTER);
for (const [f, text] of Object.entries(files)) await writeFile(join(out, f), text);
for (const f of ["abc.js", "abc.css", "bills.css", "bam.js", "bam.css", "pdf-read.js", "points-parse.js", "cfa.js", "cfa.css", "charts.js", "charts.css", "egg.js", "egg.css", "accounts.js", "accounts.css", "sub.css", "sub-parse.js", "swipe.js", "reconcile.js", "bill-parse.js", "favicon.svg", "favicon-32.png", "apple-touch-icon.png"]) await copyFile(join(root, "public", f), join(out, f));
await copyFile(join(root, "demo/demo.css"), join(out, "demo.css"));
// pdf.js for reading bill PDFs in the demo too (still only in the visitor's browser).
await mkdir(join(out, "vendor/pdfjs"), { recursive: true });
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs", "LICENSE"]) await copyFile(join(root, "public/vendor/pdfjs", f), join(out, "vendor/pdfjs", f));

// Kos (public/kos/, docs/trips.md) on the demo's data, at kos/: its pages from the demo's folder
// (relative paths, so the landing site's own /kos/, Kos on its own, is never what loads), its API
// calls to the Worker in the page (demo.js runs first), as on a Minty. A new page load starts the
// demo's data afresh, as the dashboard does. No service worker, install or device lock; Gmail pull
// and the screenshot reader need a real Kos, so their tabs go. Each edit is checked, as above.
const kosFiles = {};
for (const f of ["index.html", "kos.js", "map.js"]) kosFiles[f] = await readFile(join(root, "public/kos", f), "utf8");
const editKos = (file, what, from, to, count = 1) => {
  const text = kosFiles[file];
  const n = typeof from === "string" ? text.split(from).length - 1 : (text.match(from) ?? []).length;
  if (count === "some" ? n < 1 : n !== count) throw new Error(`build-demo: Kos "${what}" matched ${n} times in public/kos/${file} (expected ${count})`);
  kosFiles[file] = typeof from === "string" ? text.replaceAll(from, to) : text.replace(from, to);
};
editKos("index.html", "title", "<title>Kos</title>", "<title>Kos demo</title>");
editKos("index.html", "demo script first", /^<head>$/m, `<head>\n<meta name="robots" content="noindex" />\n<script src="../demo.js"></script>`);
editKos("index.html", "no manifest", /<link rel="manifest"[^>]*>\n/, "");
editKos("index.html", "no device lock", '<link rel="stylesheet" href="/lock.css" />\n<script src="/lock.js"></script>\n', "");
editKos("index.html", "the map library from the demo", /"\/vendor\/maplibre\//g, '"../vendor/maplibre/', 2);
editKos("index.html", "Kos's own files, relative", /"\/kos\//g, '"', "some");
editKos("index.html", "back to the demo's dashboard", 'id="mintyLink" href="/"', 'id="mintyLink" href="../" title="The demo\'s dashboard"');
editKos("index.html", "demo styles", /^<\/head>$/m, `<link rel="stylesheet" href="../demo.css" />\n</head>`);
if (goatcounter) editKos("index.html", "GoatCounter", /^<\/body>$/m, GOATCOUNTER);
if (/(href|src)="\/[a-z]/.test(kosFiles["index.html"])) throw new Error(`build-demo: an absolute path is left in Kos's page: ${kosFiles["index.html"].match(/(href|src)="\/[^"]*"/)[0]}`);
editKos("kos.js", "no service worker", `if ("serviceWorker" in navigator) navigator.serviceWorker.register("/kos/sw.js", { scope: "/kos/" }).catch(() => {});`, "// the demo registers no service worker");
editKos("kos.js", "no Gmail tab", `["gmail", "Gmail"], `, "");
editKos("kos.js", "no screenshot tab", `["shot", "Screenshot"], `, "");
editKos("kos.js", "pdf.js from the demo", `import("/pdf-read.js")`, `import("../pdf-read.js")`, 3);
editKos("kos.js", "the bill reader from the demo", `import("/bill-parse.js"), import("/points-parse.js")`, `import("../bill-parse.js"), import("../points-parse.js")`);
editKos("kos.js", "Open in Minty: the demo's dashboard", `href="/?trip=`, `href="../?trip=`);
editKos("map.js", "airports, relative", `"/kos/airports.json"`, `"airports.json"`);
editKos("map.js", "the map's worker from the demo", `"/vendor/maplibre/maplibre-gl-csp-worker.js"`, `"../vendor/maplibre/maplibre-gl-csp-worker.js"`);
await mkdir(join(out, "kos"), { recursive: true });
for (const f of await readdir(join(root, "public/kos"))) {
  if (["sw.js", "manifest.webmanifest"].includes(f)) continue;
  if (kosFiles[f] !== undefined) await writeFile(join(out, "kos", f), kosFiles[f]);
  else await copyFile(join(root, "public/kos", f), join(out, "kos", f));
}
await mkdir(join(out, "vendor/maplibre"), { recursive: true });
for (const f of await readdir(join(root, "public/vendor/maplibre"))) await copyFile(join(root, "public/vendor/maplibre", f), join(out, "vendor/maplibre", f));

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`demo built in ${out}: demo.js ${kb(Object.values(result.metafile.outputs)[0].bytes)}, ${migrations.length} migrations, ${apiPaths.length} API paths${goatcounter ? ", GoatCounter on" : ""}${ogImage ? ", link preview on" : ""}`);
