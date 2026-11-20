// Kos T0 (docs/trips.md §8, §15): what your Immich gives Minty, with the API key you'd use. Run it in
// YOUR terminal, with the values in the environment (never in a file in this repo):
//
//   IMMICH_URL=https://photos.example.com IMMICH_API_KEY=... \
//   IMMICH_ACCESS_CLIENT_ID=... IMMICH_ACCESS_CLIENT_SECRET=... \
//   node scripts/kos-t0/immich.ts 2026-10-01 2026-10-05 [--album-test] [--k2]
//
// The dates are a past trip's first and last day. It prints Immich's version, the key's permissions,
// how many photos those days have (with GPS, with a city, and how many are a partner's), and with
// --album-test makes an album "Minty T0 test" with one photo and deletes it again. It prints no
// keys, file names or coordinates: paste its output back to Claude.
// --k2 (docs/trips.md §25) also checks what K2 relies on that the first run didn't: whether assets carry
// localDateTime, that a thumbnail comes back as an image, and what Immich answers for an album that
// isn't there (asked for a made-up id: nothing is deleted).
const env = process.env;
const [from, to] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const albumTest = process.argv.includes("--album-test");
const k2 = process.argv.includes("--k2");
for (const k of ["IMMICH_URL", "IMMICH_API_KEY"]) if (!env[k]) { console.error(`set ${k}`); process.exit(1); }
if (!from || !to) { console.error("usage: node scripts/kos-t0/immich.ts <first day YYYY-MM-DD> <last day> [--album-test]"); process.exit(1); }
const base = env.IMMICH_URL!.replace(/\/+$/, "");
const headers: Record<string, string> = { "x-api-key": env.IMMICH_API_KEY!, accept: "application/json", "content-type": "application/json" };
if (env.IMMICH_ACCESS_CLIENT_ID) { headers["CF-Access-Client-Id"] = env.IMMICH_ACCESS_CLIENT_ID; headers["CF-Access-Client-Secret"] = env.IMMICH_ACCESS_CLIENT_SECRET ?? ""; }

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  if (r.status >= 300 && r.status < 400) throw new Error(`${path}: redirected to ${new URL(r.headers.get("location") ?? "", base).host} (Access didn't accept the service token)`);
  let data: any = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, data, html: /^\s*</.test(text), bytes: text.length };
}
const show = (label: string, v: unknown) => console.log(`${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

try {
  const v = await call("GET", "/server/version");
  if (v.html) throw new Error("got a web page, not Immich's API: is IMMICH_URL right, and does Access let the token through?");
  show("Immich version", v.data ? `${v.data.major}.${v.data.minor}.${v.data.patch}` : `HTTP ${v.status}`);
  const me = await call("GET", "/users/me");
  show("key's user", me.status === 200 ? "found" : `HTTP ${me.status} (the key may lack user.read; not needed by Minty)`);
  const key = await call("GET", "/api-keys/me");
  show("key's permissions", key.status === 200 ? key.data?.permissions : `HTTP ${key.status} (older Immich: no /api-keys/me)`);
  const want = ["asset.read", "album.read", "album.create", "albumAsset.create"];
  if (key.status === 200 && Array.isArray(key.data?.permissions) && !key.data.permissions.includes("all")) {
    show("missing for Minty", want.filter((p) => !key.data.permissions.includes(p)));
  }
  const partners = await call("GET", "/partners?direction=shared-with");
  show("partners sharing with this user", partners.status === 200 ? partners.data.length : `HTTP ${partners.status}`);

  // the trip's days, whole (Minty will use the trip's time zone; here, UTC with a day each side)
  const after = new Date(`${from}T00:00:00Z`).getTime() - 864e5, before = new Date(`${to}T23:59:59Z`).getTime() + 864e5;
  let page: number | null = 1, n = 0, gps = 0, city = 0, tz = 0, others = 0, pages = 0;
  const owner = me.data?.id;
  let first: string | null = null, local = 0, firstPage = 0;
  while (page && pages < 20) {
    const s = await call("POST", "/search/metadata", { takenAfter: new Date(after).toISOString(), takenBefore: new Date(before).toISOString(), size: 250, page, withExif: true });
    if (s.status !== 200) { show("metadata search", `HTTP ${s.status}: ${JSON.stringify(s.data)?.slice(0, 200)}`); break; }
    pages++;
    if (pages === 1) firstPage = s.bytes;
    for (const a of s.data?.assets?.items ?? []) {
      n++; first ??= a.id;
      if (typeof a.localDateTime === "string") local++;
      const e = a.exifInfo ?? {};
      if (e.latitude != null && e.longitude != null) gps++;
      if (e.city) city++;
      if (e.timeZone) tz++;
      if (owner && a.ownerId && a.ownerId !== owner) others++;
    }
    page = s.data?.assets?.nextPage ? Number(s.data.assets.nextPage) : null;
  }
  show("photos and videos in those days", n);
  show("with GPS / with a city / with a time zone", `${gps} / ${city} / ${tz}`);
  show("not the key's user's (a partner's)", owner ? others : "unknown (no user.read)");
  show("search pages read", pages);
  if (k2) {
    show("K2: with localDateTime (the camera's local time)", `${local} of ${n}`);
    show("K2: a search page's size", `${Math.round(firstPage / 1024)} KB for ${Math.min(n, 250)} photos (Kos asks 60 at a time and reads ~150 KB a run)`);
    if (first) {
      const t = await fetch(`${base}/api/assets/${first}/thumbnail?size=thumbnail`, { headers: { ...headers, accept: "image/*" }, redirect: "manual" });
      const bytes = (await t.arrayBuffer()).byteLength;
      show("K2: a thumbnail", `HTTP ${t.status}, ${t.headers.get("content-type")}, ${bytes} bytes`);
    }
    const missing = await call("GET", "/albums/00000000-0000-4000-8000-000000000000?withoutAssets=true");
    show("K2: an album that isn't there", `HTTP ${missing.status}: ${JSON.stringify(missing.data?.message ?? missing.data)?.slice(0, 120)}`);
  }

  if (albumTest && first) {
    const al = await call("POST", "/albums", { albumName: "Minty T0 test", assetIds: [first] });
    show("make an album", al.status === 201 || al.status === 200 ? "ok" : `HTTP ${al.status}: ${JSON.stringify(al.data)?.slice(0, 200)}`);
    if (al.data?.id) {
      const add = await call("PUT", `/albums/${al.data.id}/assets`, { ids: [first] });
      show("add a photo again (expect 'duplicate')", add.status === 200 ? JSON.stringify(add.data?.map?.((x: any) => x.error ?? "added")) : `HTTP ${add.status}`);
      const del = await call("DELETE", `/albums/${al.data.id}`);
      show("delete the test album (the photo stays)", del.status < 300 ? "ok" : `HTTP ${del.status}: the key may lack album.delete, so delete "Minty T0 test" in Immich yourself`);
    }
  }
} catch (e) {
  console.error(`stopped: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
