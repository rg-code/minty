import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { call, getJson } from "./helpers";
import { immichCheck, requestAlbum, runImmichSync, thumb, tripPhotos } from "../src/immich";
import type { Env } from "../src/env";

// Kos K2 (docs/trips.md §25): trip albums in the household's Immich, from the cron. A fake Immich
// answers here; nothing leaves the test.
const db = env.DB;
const IMMICH = { ...env, IMMICH_URL: "https://immich-api.example.com/", IMMICH_API_KEY: "immich-key", IMMICH_LINK_URL: "http://photos.example:2283" } as Env;
const rows = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<any>()).results;
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asset = (n: number, local: string, extra: Record<string, unknown> = {}) =>
  ({ id: uuid(n), type: "IMAGE", localDateTime: `${local}.000Z`, fileCreatedAt: `${local}.000Z`, exifInfo: { latitude: null, longitude: null, city: null, timeZone: "Asia/Tokyo" }, ...extra });

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
class FakeImmich {
  calls: { method: string; path: string; body: any; headers: Headers }[] = [];
  pages: Reply[] = [];                                       // /search/metadata, in order
  hangSearch = false;                                        // never answer the search (a run cut off there)
  replies: Record<string, Reply> = {
    "GET /api/api-keys/me": { body: { id: "k", name: "Minty", permissions: ["asset.read", "asset.view", "album.read", "album.create", "albumAsset.create"] } },
    "POST /api/albums": { status: 201, body: { id: uuid(9000), albumName: "x", assets: [] } },
  };
  install(): this {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.hostname !== "immich-api.example.com") throw new Error(`unexpected fetch to ${url.hostname}`);
      const text = await req.text();
      this.calls.push({ method: req.method, path: url.pathname, body: text ? JSON.parse(text) : null, headers: req.headers });
      const key = `${req.method} ${url.pathname.replace(/[0-9a-f-]{36}/g, ":id")}`;
      if (key === "POST /api/search/metadata" && this.hangSearch) return new Promise<Response>(() => {});
      // adding to an album: each id added, unless a reply was set for the test
      if (key === "PUT /api/albums/:id/assets" && !this.replies[key]) return new Response(JSON.stringify(JSON.parse(text).ids.map((id: string) => ({ id, success: true }))), { headers: { "content-type": "application/json" } });
      const r = key === "POST /api/search/metadata" ? this.pages.shift() : this.replies[key];
      if (!r) throw new Error(`no fake reply for ${key}`);
      return new Response(r.text ?? JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers ?? { "content-type": "application/json" } });
    });
    return this;
  }
  page(items: unknown[], nextPage: string | null = null, pad = 0): this { this.pages.push({ body: { albums: { items: [] }, assets: { total: items.length, count: items.length, items, nextPage }, pad: "x".repeat(pad) } }); return this; }
  paths(): string[] { return this.calls.map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}/g, ":id")}`); }
}

let fake: FakeImmich;
let trip = 0;
beforeEach(async () => {
  await db.batch(["trip_photos", "trip_journal_notes", "trip_transactions", "trip_items", "trips"].map((t) => db.prepare(`DELETE FROM ${t}`))
    .concat(db.prepare("DELETE FROM app_state WHERE key = 'immich_key'")));
  // a trip that ended 3 days ago: four days, in Tokyo
  trip = (await db.prepare("INSERT INTO trips (name, start_date, end_date, code) VALUES ('Tokyo', ?, ?, 'k7f3x9p2ad') RETURNING id").bind(day(-6), day(-3)).first<{ id: number }>())!.id;
  fake = new FakeImmich().install();
});
afterEach(() => vi.restoreAllMocks());

describe("the cron's album (docs/trips.md §25)", () => {
  it("does nothing at all on a Minty without Immich", async () => {
    expect(await runImmichSync({ ...env } as Env)).toEqual({});
    expect(fake.calls).toEqual([]);
    expect((await immichCheck({ ...env } as Env)).set_up).toBe(false);
  });

  it("makes the album of a trip that just ended, with the photos taken on its own days (local time)", async () => {
    fake.page([
      asset(1, `${day(-7)}T23:10:00`),                        // the evening before (local): not the trip's
      asset(2, `${day(-6)}T09:00:00`), asset(3, `${day(-6)}T12:30:00`, { type: "VIDEO" }),
      asset(4, `${day(-4)}T18:00:00`, { exifInfo: { latitude: 35.6586, longitude: 139.7454, city: "Tokyo" } }),
      asset(5, `${day(-3)}T23:59:00`),
      asset(6, `${day(-2)}T00:05:00`),                        // the day after: not the trip's
    ]);
    const out = await runImmichSync(IMMICH);
    expect(out).toEqual({ key: "key ok", [`trip ${trip}`]: "album ready, 4 added" });
    expect(fake.paths()).toEqual(["GET /api/api-keys/me", "POST /api/search/metadata", "POST /api/albums", "PUT /api/albums/:id/assets"]);
    const search = fake.calls[1].body;
    expect(search).toMatchObject({ size: 60, page: 1, withExif: true });
    expect(search.takenAfter < `${day(-6)}T00:00:00`).toBe(true);           // a day either side, then local days
    const made = fake.calls[2].body;
    const month = new Date(`${day(-6)}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    expect(made.albumName).toBe(`Tokyo, ${month} ${day(-6).slice(0, 4)}`);
    expect(made.assetIds).toEqual([uuid(2)]);                                // made with its first photo (Immich's answer stays small)
    expect(fake.calls[3].body).toEqual({ ids: [uuid(3), uuid(4), uuid(5)] });
    expect(await rows("SELECT key FROM app_state WHERE key = 'immich_search_page'")).toEqual([]);   // the holding row is gone
    expect(fake.calls[1].headers.get("x-api-key")).toBe("immich-key");
    expect(fake.calls[1].headers.get("cf-access-client-id")).toBeNull();
    const t = (await rows("SELECT * FROM trips WHERE id = ?", trip))[0];
    expect(t).toMatchObject({ immich_album_id: uuid(9000), immich_state: "ready", immich_count: 4, immich_error: null, immich_requested_at: null, immich_page: null });
    expect(JSON.parse(t.immich_days)).toEqual({ [day(-6)]: 2, [day(-4)]: 1, [day(-3)]: 1 });
    expect(await rows("SELECT asset_id, day, video, added, lat, city FROM trip_photos WHERE trip_id = ? ORDER BY taken", trip)).toEqual([
      { asset_id: uuid(2), day: day(-6), video: 0, added: 1, lat: null, city: null },
      { asset_id: uuid(3), day: day(-6), video: 1, added: 1, lat: null, city: null },
      { asset_id: uuid(4), day: day(-4), video: 0, added: 1, lat: 35.6586, city: "Tokyo" },
      { asset_id: uuid(5), day: day(-3), video: 0, added: 1, lat: null, city: null },
    ]);
    // the next run: nothing due (checked today), and the key isn't asked again today
    fake.calls = [];
    expect(await runImmichSync(IMMICH)).toEqual({});
    expect(fake.calls).toEqual([]);
  });

  it("never makes an empty album", async () => {
    fake.page([asset(1, `${day(-10)}T10:00:00`)]);
    expect((await runImmichSync(IMMICH))[`trip ${trip}`]).toBe("no photos those days");
    expect(fake.paths()).not.toContain("POST /api/albums");
    expect((await rows("SELECT immich_state, immich_album_id FROM trips WHERE id = ?", trip))[0]).toEqual({ immich_state: "empty", immich_album_id: null });
  });

  it("leaves older trips alone until someone asks, then the next run makes it", async () => {
    await db.prepare("UPDATE trips SET start_date = ?, end_date = ? WHERE id = ?").bind(day(-40), day(-35), trip).run();
    expect(await runImmichSync(IMMICH)).toEqual({ key: "key ok" });          // a first deploy fills nothing
    expect(fake.paths()).toEqual(["GET /api/api-keys/me"]);
    const r = await requestAlbum(IMMICH, trip);
    expect(await r.json()).toEqual({ id: trip, requested: true });
    fake.page([asset(1, `${day(-38)}T10:00:00`)]);
    expect((await runImmichSync(IMMICH))[`trip ${trip}`]).toBe("album ready, 1 added");
    expect((await rows("SELECT immich_requested_at FROM trips WHERE id = ?", trip))[0].immich_requested_at).toBeNull();
  });

  it("checks for late photos once a day for a week, adding only the new ones", async () => {
    fake.page([asset(2, `${day(-6)}T09:00:00`)]);
    await runImmichSync(IMMICH);
    await db.prepare("UPDATE trips SET immich_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE id = ?").bind(trip).run();
    fake.calls = [];
    fake.replies["GET /api/albums/:id"] = { body: { id: uuid(9000), assetCount: 1 } };
    fake.replies["PUT /api/albums/:id/assets"] = { body: [{ id: uuid(7), success: true }] };
    fake.page([asset(2, `${day(-6)}T09:00:00`), asset(7, `${day(-5)}T15:00:00`)]);
    expect((await runImmichSync(IMMICH))[`trip ${trip}`]).toBe("album ready, 1 added");
    expect(fake.paths()).toEqual(["GET /api/albums/:id", "POST /api/search/metadata", "PUT /api/albums/:id/assets"]);
    expect(fake.calls[2].body).toEqual({ ids: [uuid(7)] });
    expect(fake.calls[0].path).toBe(`/api/albums/${uuid(9000)}`);
  });

  it("an album deleted in Immich isn't made again, unless someone asks", async () => {
    fake.page([asset(2, `${day(-6)}T09:00:00`)]);
    await runImmichSync(IMMICH);
    await db.prepare("UPDATE trips SET immich_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE id = ?").bind(trip).run();
    fake.replies["GET /api/albums/:id"] = { status: 400, body: { message: "Not found or no album.read access", error: "Bad Request", statusCode: 400 } };
    expect((await runImmichSync(IMMICH))[`trip ${trip}`]).toBe("album gone");
    expect((await rows("SELECT immich_state FROM trips WHERE id = ?", trip))[0].immich_state).toBe("gone");
    await db.prepare("UPDATE trips SET immich_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE id = ?").bind(trip).run();
    fake.calls = [];
    expect(await runImmichSync(IMMICH)).toEqual({});                         // gone: not due
    const photos = await (await tripPhotos(IMMICH, trip)).json<any>();
    expect(photos).toMatchObject({ state: "gone", album_url: null });
    await requestAlbum(IMMICH, trip);                                        // "Make it again"
    fake.page([asset(2, `${day(-6)}T09:00:00`)]);
    expect((await runImmichSync(IMMICH))[`trip ${trip}`]).toBe("album ready, 1 added");
    expect(fake.paths()).toEqual(["POST /api/search/metadata", "POST /api/albums"]);   // one photo: made with it, nothing more to add
    expect(fake.calls[1].body.assetIds).toEqual([uuid(2)]);
  });

  it("a passing failure is kept on the trip, never taken for a deleted album, and tried again in an hour", async () => {
    fake.pages.push({ status: 502, text: "<html>Bad gateway</html>", headers: { "content-type": "text/html" } });
    const out = await runImmichSync(IMMICH);
    expect(out[`trip ${trip}`]).toMatch(/^failed: Immich's address answered with a web page \(HTTP 502\)/);
    const t = (await rows("SELECT immich_state, immich_error, immich_next_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+50 minutes') AS later FROM trips WHERE id = ?", trip))[0];
    expect(t).toMatchObject({ immich_state: null, later: 1 });
    expect(t.immich_error).toMatch(/web page/);
    expect(await runImmichSync(IMMICH)).toEqual({});                         // backing off
    const photos = await (await tripPhotos(IMMICH, trip)).json<any>();
    expect(photos.error).toMatch(/web page/);
  });

  it("a redirect (Cloudflare Access's sign-in) says to check the service token, and sends it when set", async () => {
    vi.restoreAllMocks();
    fake = new FakeImmich().install();
    fake.replies["GET /api/api-keys/me"] = { status: 302, text: "", headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } };
    const withToken = { ...IMMICH, IMMICH_ACCESS_CLIENT_ID: "id.access", IMMICH_ACCESS_CLIENT_SECRET: "shh" } as Env;
    fake.pages.push({ status: 302, text: "", headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
    const out = await runImmichSync(withToken);
    expect(out.key).toMatch(/redirected.*service token/);
    expect(fake.calls[0].headers.get("cf-access-client-id")).toBe("id.access");
    expect(fake.calls[0].headers.get("cf-access-client-secret")).toBe("shh");
    expect((await immichCheck(withToken)).error).toMatch(/service token/);
    expect((await rows("SELECT immich_state FROM trips WHERE id = ?", trip))[0].immich_state).toBeNull();
    // fixed in Cloudflare: the next run checks the key again (not a day later)
    fake.replies["GET /api/api-keys/me"] = { body: { permissions: ["all"] } };
    await db.prepare("UPDATE trips SET immich_next_at = NULL").run();
    fake.page([]);
    expect((await runImmichSync(withToken)).key).toBe("key ok");
  });

  it("a big trip carries on over several runs, within each run's byte budget", async () => {
    // three search pages of about 80 KB each: two fit a run's ~150 KB, the third waits for the next run
    fake.page([asset(1, `${day(-5)}T08:00:00`)], "2", 80_000).page([asset(2, `${day(-5)}T09:00:00`)], "3", 80_000).page([asset(3, `${day(-5)}T10:00:00`)], null, 150_000);
    expect((await runImmichSync(IMMICH))[`trip ${trip}`]).toBe("searched, more from page 3");
    expect(fake.paths().filter((p) => p === "POST /api/search/metadata")).toHaveLength(2);
    expect((await rows("SELECT immich_page, immich_error, immich_next_at, immich_requested_at IS NOT NULL AS due FROM trips WHERE id = ?", trip))[0])
      .toEqual({ immich_page: 3, immich_error: null, immich_next_at: null, due: 1 });
    fake.calls = [];
    expect((await runImmichSync(IMMICH))[`trip ${trip}`]).toBe("searched, the album next run");          // page 3 spends the budget
    expect(fake.paths()).toEqual(["POST /api/search/metadata"]);
    expect(fake.calls[0].body.page).toBe(3);
    expect((await rows("SELECT immich_state, immich_page FROM trips WHERE id = ?", trip))[0]).toEqual({ immich_state: null, immich_page: null });   // not "empty"
    fake.calls = [];
    fake.page([asset(1, `${day(-5)}T08:00:00`), asset(2, `${day(-5)}T09:00:00`), asset(3, `${day(-5)}T10:00:00`)]);
    expect((await runImmichSync(IMMICH))[`trip ${trip}`]).toBe("album ready, 3 added");
    expect(fake.calls.find((c) => c.method === "PUT")!.body).toEqual({ ids: [uuid(2), uuid(3)] });
  });

  it("a run that's cut off part-way leaves the trip saying so, and waiting an hour", async () => {
    // Immich never answers the search: what's on the trip while the run hangs is what a run killed there leaves
    fake.hangSearch = true;
    void runImmichSync(IMMICH);
    for (let i = 0; i < 40 && !(await rows("SELECT immich_error FROM trips WHERE id = ?", trip))[0].immich_error; i++) await new Promise((r) => setTimeout(r, 25));
    const t = (await rows("SELECT immich_error, immich_next_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+50 minutes') AS later FROM trips WHERE id = ?", trip))[0];
    expect(t).toEqual({ immich_error: "The last run that looked at this trip didn't finish.", later: 1 });
    const again = await runImmichSync(IMMICH);
    expect(again).toEqual({});                                               // it waits, rather than retrying every ten minutes
  });

  it("says which permissions the key is missing", async () => {
    fake.replies["GET /api/api-keys/me"] = { body: { permissions: ["asset.read", "album.read"] } };
    fake.page([]);
    await runImmichSync(IMMICH);
    expect(await immichCheck(IMMICH)).toMatchObject({ set_up: true, ok: false, missing: ["asset.view", "album.create", "albumAsset.create"] });
    const ov = { IMMICH_URL: IMMICH.IMMICH_URL, IMMICH_API_KEY: "immich-key" } as Partial<Env>;
    const s = (await getJson<any>("/status", { envOverrides: ov })).body;
    expect(s.checks.find((c: any) => c.id === "immich")).toMatchObject({ ok: false, message: "Immich's API key is missing asset.view, album.create, albumAsset.create." });
    expect((await getJson<any>("/status")).body.checks.find((c: any) => c.id === "immich")).toBeUndefined();   // no Immich: no check
  });
});

describe("the journal's photos and thumbnails", () => {
  it("returns up to 6 a day, spread through the day, and the album's link where people open Immich", async () => {
    fake.page([...Array(10).keys()].map((n) => asset(n + 1, `${day(-5)}T${String(8 + n).padStart(2, "0")}:00:00`)).concat(asset(50, `${day(-4)}T12:00:00`)));
    await runImmichSync(IMMICH);
    const p = await (await tripPhotos(IMMICH, trip)).json<any>();
    expect(p).toMatchObject({ set_up: true, state: "ready", count: 11, requested: false, album_url: `http://photos.example:2283/albums/${uuid(9000)}` });
    expect(p.days).toEqual({ [day(-5)]: 10, [day(-4)]: 1 });
    expect(p.photos.filter((x: any) => x.day === day(-5)).map((x: any) => x.id)).toEqual([1, 3, 5, 6, 8, 10].map(uuid));
    expect(p.photos.filter((x: any) => x.day === day(-4))).toHaveLength(1);
    // without Immich set up, the same answer says so (the journal shows nothing)
    expect((await (await tripPhotos({ ...env } as Env, trip)).json<any>()).set_up).toBe(false);
  });

  it("a thumbnail comes through the Worker only for a photo of that trip, and only as an image", async () => {
    fake.page([asset(2, `${day(-6)}T09:00:00`)]);
    await runImmichSync(IMMICH);
    fake.calls = [];
    fake.replies["GET /api/assets/:id/thumbnail"] = { text: "\xff\xd8jpeg", headers: { "content-type": "image/jpeg", "set-cookie": "immich=1", "x-immich": "v3" } };
    const r = await thumb(IMMICH, trip, uuid(2));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-immich")).toBeNull();
    expect(fake.calls[0].path).toBe(`/api/assets/${uuid(2)}/thumbnail`);
    expect(fake.calls[0].headers.get("x-api-key")).toBe("immich-key");
    fake.calls = [];
    await expect(thumb(IMMICH, trip, uuid(3))).rejects.toThrow(/not a photo of this trip/);        // not the trip's
    await expect(thumb(IMMICH, trip + 1, uuid(2))).rejects.toThrow(/not a photo of this trip/);    // another trip's
    await expect(thumb(IMMICH, trip, "../../server/version")).rejects.toThrow(/not a photo/);
    expect(fake.calls).toEqual([]);
    fake.replies["GET /api/assets/:id/thumbnail"] = { text: "<html>", headers: { "content-type": "text/html" } };
    await expect(thumb(IMMICH, trip, uuid(2))).rejects.toThrow(/didn't send the thumbnail/);
  });

  it("the routes answer through the Worker", async () => {
    const ov = { IMMICH_URL: IMMICH.IMMICH_URL, IMMICH_API_KEY: "immich-key" } as Partial<Env>;
    expect((await getJson<any>(`/trips/${trip}/photos`)).body).toMatchObject({ id: trip, set_up: false, photos: [] });
    expect((await getJson<any>(`/trips/${trip}/photos`, { method: "POST", body: "{}" })).status).toBe(409);         // no Immich here
    const made = await getJson<any>(`/trips/${trip}/photos`, { method: "POST", body: "{}", envOverrides: ov });
    expect(made).toEqual({ status: 200, body: { id: trip, requested: true } });
    expect((await getJson<any>(`/trips/${trip}/photos`, { envOverrides: ov })).body).toMatchObject({ set_up: true, requested: true });
    expect((await getJson<any>(`/trips/${trip + 99}/photos`, { method: "POST", body: "{}", envOverrides: ov })).status).toBe(404);
    // a thumbnail through the Worker: an image, privately cached
    fake.page([asset(2, `${day(-6)}T09:00:00`)]);
    await runImmichSync(IMMICH);
    fake.replies["GET /api/assets/:id/thumbnail"] = { text: "jpeg", headers: { "content-type": "image/webp" } };
    const r = await call(`/trips/${trip}/photos/${uuid(2)}`, { envOverrides: ov });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    expect(await r.text()).toBe("jpeg");
    expect((await call(`/trips/${trip}/photos/${uuid(3)}`, { envOverrides: ov })).status).toBe(404);
  });
});
