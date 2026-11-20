import type { Env } from "./env";
import { API_SECURITY_HEADERS, HttpError, json } from "./http";

/** Kos K2 (docs/trips.md §25): a trip's photos from the household's Immich, through its API.
 *
 * - **The cron only** makes and fills albums: one trip per quiet catch-up run (like statement details
 *   and investments), never on a request. "Make the album now" only records a request.
 * - **Which trips:** one someone asked for; one that ended in the last 7 days with no album yet; and a
 *   trip with an album, once a day for 7 days after it ends (photos uploaded late). Older trips get an
 *   album only when asked, so a first deploy never fills Immich with albums for every past trip.
 * - **Never:** an empty album, deleting or editing a photo, taking one out of an album, a shared link,
 *   or downloading an image into D1. An album deleted in Immich isn't made again unless asked.
 * - **CPU:** Immich's search pages (250 photos with their metadata) are bound once as text and SQLite
 *   unpacks them, as sync does with Plaid's pages: the Worker never parses one.
 * - **Failures** are kept on the trip (`immich_error`) and shown in its journal; the trip is tried again
 *   after an hour, and the oldest-checked trip goes first, so one trip can't starve the rest. Only a
 *   not-found answer from Immich itself means an album is gone: a redirect, a web page, a 5xx or a
 *   timeout is a passing failure.
 * - **Thumbnails** go through the Worker (`thumb`), only for a photo of that trip, so the page never
 *   talks to Immich and needs no new host in its policy. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const SINCE = (mod: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${mod}')`;
export const IMMICH_RECHECK_DAYS = 7;
const RETRY = "+1 hour";
// CPU (the free plan's 10 ms): each run reads at most about as much of Immich's answers as sync's
// measured budget for Plaid's pages (SYNC_MAX_BYTES_PER_RUN's default, ~8 ms), each bound once. A search
// page of 60 photos with their metadata is roughly 60-120 KB; a bigger trip carries on next run.
const BYTES_PER_RUN = 150_000;
const PAGE_SIZE = 60;
const ADD_BATCH = 500;                           // photos per album call (its answer: ~70 bytes each)
const MAX_RESPONSE_CHARS = 1_000_000;
const PICKS_PER_DAY = 6;
const KEY_CHECK_HOURS = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What Minty needs the key to have (`asset.view` is for the thumbnails). */
export const IMMICH_PERMISSIONS = ["asset.read", "asset.view", "album.read", "album.create", "albumAsset.create"];

/** The Immich address the Worker calls, or null when Immich isn't set up (then nothing here runs). */
export function immichBase(env: Env): string | null {
  const url = typeof env.IMMICH_URL === "string" ? env.IMMICH_URL.trim().replace(/\/+$/, "") : "";
  if (!url || !env.IMMICH_API_KEY || !/^https?:\/\/[^/\s]+/.test(url)) return null;
  return url;
}
/** Where people open Immich (IMMICH_LINK_URL, say the tailnet address), else IMMICH_URL. */
function linkBase(env: Env, base: string): string {
  const l = typeof env.IMMICH_LINK_URL === "string" ? env.IMMICH_LINK_URL.trim().replace(/\/+$/, "") : "";
  return /^https?:\/\/[^/\s]+/.test(l) ? l : base;
}

class ImmichError extends Error {
  constructor(message: string, public gone = false) { super(message); }
}
function headers(env: Env): Record<string, string> {
  const h: Record<string, string> = { "x-api-key": String(env.IMMICH_API_KEY), accept: "application/json" };
  if (env.IMMICH_ACCESS_CLIENT_ID && env.IMMICH_ACCESS_CLIENT_SECRET) {
    h["CF-Access-Client-Id"] = String(env.IMMICH_ACCESS_CLIENT_ID);
    h["CF-Access-Client-Secret"] = String(env.IMMICH_ACCESS_CLIENT_SECRET);
  }
  return h;
}
/** One API call; the answer's text (never parsed here). Throws ImmichError in plain words. */
async function call(env: Env, base: string, method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
  let r: Response;
  try {
    r = await fetch(`${base}/api${path}`, { method, redirect: "manual", body,
      headers: { ...headers(env), ...(body ? { "content-type": "application/json" } : {}) } });
  } catch (e) {
    throw new ImmichError(`Immich didn't answer (${e instanceof Error ? e.message : e}): is the address reachable from Cloudflare?`);
  }
  if (r.status >= 300 && r.status < 400) { await r.body?.cancel(); throw new ImmichError("Immich's address redirected (a sign-in page?): if it's behind Cloudflare Access, check the service token and its Service Auth policy."); }
  const text = await r.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new ImmichError("Immich's answer was too big to handle.");
  if (/^\s*</.test(text)) throw new ImmichError(`Immich's address answered with a web page (HTTP ${r.status}), not Immich's API: check IMMICH_URL.`);
  if (r.status === 401) throw new ImmichError("Immich refused the API key (HTTP 401): make a new one and save it as IMMICH_API_KEY.");
  if (r.status === 403) throw new ImmichError(`The API key is missing a permission Minty needs (HTTP 403 on ${path.split("?")[0].replace(UUID, "…")}): it needs ${IMMICH_PERMISSIONS.join(", ")}.`);
  if (r.status >= 500) throw new ImmichError(`Immich had a problem (HTTP ${r.status}); Minty tries again in an hour.`);
  return { status: r.status, text };
}
/** Immich's own "not found" (an album deleted, or no longer the key's user's): JSON, 400 or 404. */
const notFound = (r: { status: number; text: string }) => (r.status === 400 || r.status === 404) && /not found|no album\.read access|does not exist/i.test(r.text);
const albumName = (t: TripRow) => {
  const d = new Date(`${t.start_date}T00:00:00Z`);
  return `${t.name}, ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
};

interface TripRow { id: number; name: string; start_date: string; end_date: string; immich_album_id: string | null; immich_state: string | null; immich_page: number | null }

/** The search's photos, inside the trip's local days (Immich's localDateTime: the camera's local
 * time; fileCreatedAt if a version lacks it), into trip_photos, from the page held in app_state
 * (bound once). ?1 trip, ?2/?3 its first and last day. */
const LOCAL = "coalesce(a.value ->> 'localDateTime', a.value ->> 'fileCreatedAt')";
const SAVE_PAGE = `INSERT INTO trip_photos (trip_id, asset_id, taken, day, lat, lon, city, video)
  SELECT ?1, a.value ->> 'id', substr(${LOCAL}, 1, 19), substr(${LOCAL}, 1, 10),
         a.value -> 'exifInfo' ->> 'latitude', a.value -> 'exifInfo' ->> 'longitude', a.value -> 'exifInfo' ->> 'city',
         (a.value ->> 'type') = 'VIDEO'
  FROM app_state s, json_each(s.value, '$.assets.items') a
  WHERE s.key = 'immich_search_page' AND a.value ->> 'id' IS NOT NULL AND substr(${LOCAL}, 1, 10) BETWEEN ?2 AND ?3
  ON CONFLICT (trip_id, asset_id) DO NOTHING`;
/** After the photos change: the day counts, the total, and up to 6 a day spread through the day. */
const AFTER_PHOTOS = [
  `UPDATE trip_photos SET pick = 0 WHERE trip_id = ?1 AND pick = 1`,
  `UPDATE trip_photos SET pick = 1 WHERE trip_id = ?1 AND asset_id IN (
     SELECT asset_id FROM (SELECT asset_id, row_number() OVER (PARTITION BY day ORDER BY taken, asset_id) AS rn, count(*) OVER (PARTITION BY day) AS n
                           FROM trip_photos WHERE trip_id = ?1)
     WHERE rn = 1 OR ((rn - 1) * ${PICKS_PER_DAY}) / n <> ((rn - 2) * ${PICKS_PER_DAY}) / n)`,
  `UPDATE trips SET immich_count = (SELECT count(*) FROM trip_photos WHERE trip_id = ?1),
     immich_days = (SELECT json_group_object(day, n) FROM (SELECT day, count(*) AS n FROM trip_photos WHERE trip_id = ?1 GROUP BY day ORDER BY day))
   WHERE id = ?1`,
];
const DUE = `SELECT id, name, start_date, end_date, immich_album_id, immich_state, immich_page FROM trips
  WHERE (immich_next_at IS NULL OR immich_next_at <= ${NOW})
    AND (immich_requested_at IS NOT NULL
         OR immich_page IS NOT NULL
         OR (immich_state IS NULL AND end_date < date('now') AND end_date >= date('now', '-${IMMICH_RECHECK_DAYS} days'))
         OR (immich_state IN ('ready', 'empty') AND end_date >= date('now', '-${IMMICH_RECHECK_DAYS + 1} days')
             AND (immich_checked_at IS NULL OR immich_checked_at < ${SINCE("-1 day")})))
  ORDER BY coalesce(immich_checked_at, '') LIMIT 1`;

/** The cron's step: the key's check (once a day, for Setup), then one due trip. Returns what it did
 * (no photo data), or {} when Immich isn't set up or nothing is due. */
export async function runImmichSync(env: Env): Promise<Record<string, string>> {
  const base = immichBase(env);
  if (!base) return {};                                        // a fork without Immich: no reads at all
  const out: Record<string, string> = {};
  // the key, for Setup: once a day, or on every run while the last check failed (setting it up)
  const key = await env.DB.prepare("SELECT value, updated_at FROM app_state WHERE key = 'immich_key'").first<{ value: string; updated_at: string }>();
  if (!key || !(JSON.parse(key.value) as { ok?: boolean }).ok || Date.parse(key.updated_at) < Date.now() - KEY_CHECK_HOURS * 36e5) out.key = await checkKey(env, base);
  const t = await env.DB.prepare(DUE).first<TripRow>();
  if (!t) return out;
  // If this run is cut off part-way (CPU, a timeout), the trip says so and waits an hour, rather than
  // failing silently every ten minutes. A run that finishes, or stops at its budget, clears it.
  await env.DB.prepare(`UPDATE trips SET immich_next_at = ${SINCE(RETRY)}, immich_error = 'The last run that looked at this trip didn''t finish.' WHERE id = ?`).bind(t.id).run();
  try {
    out[`trip ${t.id}`] = await syncTrip(env, base, t);
  } catch (e) {
    const gone = e instanceof ImmichError && e.gone;
    const msg = e instanceof Error ? e.message : String(e);
    await (gone
      ? env.DB.prepare(`UPDATE trips SET immich_state = 'gone', immich_requested_at = NULL, immich_page = NULL, immich_error = NULL, immich_checked_at = ${NOW}, immich_next_at = NULL WHERE id = ?1`).bind(t.id)
      : env.DB.prepare(`UPDATE trips SET immich_error = ?2, immich_checked_at = ${NOW}, immich_next_at = ${SINCE(RETRY)} WHERE id = ?1`).bind(t.id, msg.slice(0, 300))).run();
    out[`trip ${t.id}`] = gone ? "album gone" : `failed: ${msg}`;
  }
  return out;
}

async function syncTrip(env: Env, base: string, t: TripRow): Promise<string> {
  let bytes = 0;
  const more = async (what: string) => {                        // the run's budget is spent: carry on next run
    await env.DB.prepare(`UPDATE trips SET immich_requested_at = coalesce(immich_requested_at, ${NOW}), immich_error = NULL, immich_next_at = NULL WHERE id = ?`).bind(t.id).run();
    return what;
  };
  // An album that's there: still there? (A deleted one isn't made again unless someone asks.)
  if (t.immich_album_id && t.immich_page === null) {
    const r = await call(env, base, "GET", `/albums/${t.immich_album_id}?withoutAssets=true`);
    if (notFound(r)) throw new ImmichError("album gone", true);
    if (r.status !== 200) throw new ImmichError(`Immich answered HTTP ${r.status} for the trip's album.`);
    bytes += r.text.length;
  }
  // The photos taken during the trip: a day either side in UTC, then only those on the trip's own
  // days in local time (no time zone needed for the trip).
  const after = new Date(Date.parse(`${t.start_date}T00:00:00Z`) - 864e5).toISOString();
  const before = new Date(Date.parse(`${t.end_date}T00:00:00Z`) + 2 * 864e5).toISOString();
  let page: number | null = t.immich_page ?? 1;
  while (page && bytes < BYTES_PER_RUN) {
    const r = await call(env, base, "POST", "/search/metadata", JSON.stringify({ takenAfter: after, takenBefore: before, size: PAGE_SIZE, page, withExif: true }));
    if (r.status !== 200) throw new ImmichError(`Immich's search answered HTTP ${r.status}.`);
    bytes += r.text.length;
    // the page's text is bound once, into a holding row that the next statements read
    const [, , next] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('immich_search_page', ?1, ${NOW})
                      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(r.text),
      env.DB.prepare(SAVE_PAGE).bind(t.id, t.start_date, t.end_date),
      env.DB.prepare("SELECT value ->> '$.assets.nextPage' AS next FROM app_state WHERE key = 'immich_search_page'"),
      env.DB.prepare("DELETE FROM app_state WHERE key = 'immich_search_page'"),
    ]);
    const np = (next.results[0] as { next: string | number | null } | undefined)?.next;
    page = np === null || np === undefined || np === "" ? null : Number(np) || null;
  }
  if (page) {
    await env.DB.prepare("UPDATE trips SET immich_page = ?2 WHERE id = ?1").bind(t.id, page).run();
    return more(`searched, more from page ${page}`);
  }
  await env.DB.prepare("UPDATE trips SET immich_page = NULL WHERE id = ?").bind(t.id).run();
  // Into the album: made with its first photo (never empty; Immich's answer stays small), then the
  // rest added in batches, while the run's budget lasts.
  let album = t.immich_album_id, added = 0, left = false;
  for (;;) {
    const ids = await env.DB.prepare(`SELECT json_group_array(asset_id) AS ids, count(*) AS n FROM
      (SELECT asset_id FROM trip_photos WHERE trip_id = ? AND added = 0 ORDER BY taken LIMIT ${album ? ADD_BATCH : 1})`).bind(t.id).first<{ ids: string; n: number }>();
    if (!ids?.n) break;
    if (bytes >= BYTES_PER_RUN) { left = true; break; }
    if (!album) {
      const r = await call(env, base, "POST", "/albums", `{"albumName":${JSON.stringify(albumName(t))},"assetIds":${ids.ids}}`);
      if (r.status !== 200 && r.status !== 201) throw new ImmichError(`Immich couldn't make the album (HTTP ${r.status}).`);
      bytes += r.text.length;
      const made = await env.DB.prepare("SELECT ?1 ->> '$.id' AS id").bind(r.text).first<{ id: string | null }>();
      if (!made?.id || !UUID.test(made.id)) throw new ImmichError("Immich made an album but didn't say its id.");
      album = made.id;
      await env.DB.batch([
        env.DB.prepare("UPDATE trips SET immich_album_id = ?2 WHERE id = ?1").bind(t.id, album),
        env.DB.prepare("UPDATE trip_photos SET added = 1 WHERE trip_id = ?1 AND asset_id IN (SELECT value FROM json_each(?2))").bind(t.id, ids.ids),
      ]);
    } else {
      const r = await call(env, base, "PUT", `/albums/${album}/assets`, `{"ids":${ids.ids}}`);
      if (notFound(r)) throw new ImmichError("album gone", true);
      if (r.status !== 200) throw new ImmichError(`Immich couldn't add photos to the album (HTTP ${r.status}).`);
      bytes += r.text.length;
      // added now, or already there ("duplicate"); anything else stays to try again next time
      const marked = await env.DB.prepare(`UPDATE trip_photos SET added = 1 WHERE trip_id = ?1 AND asset_id IN
        (SELECT x.value ->> 'id' FROM json_each(?2) x WHERE json_extract(x.value, '$.success') = 1 OR x.value ->> 'error' = 'duplicate')`).bind(t.id, r.text).run();
      if (!marked.meta.changes) break;                          // Immich took none of them: don't loop
    }
    added += ids.n;
  }
  await env.DB.batch([
    ...AFTER_PHOTOS.map((q) => env.DB.prepare(q).bind(t.id)),
    // photos left to add: due again next run (and with no album yet, not "empty": it's next run's)
    env.DB.prepare(`UPDATE trips SET immich_state = coalesce(?2, immich_state), immich_error = NULL, immich_checked_at = ${NOW}, immich_next_at = NULL,
                      immich_requested_at = CASE WHEN ?3 THEN coalesce(immich_requested_at, ${NOW}) END WHERE id = ?1`)
      .bind(t.id, album ? "ready" : left ? null : "empty", left ? 1 : 0),
  ]);
  return album ? `album ready, ${added} added${left ? ", more next run" : ""}` : left ? "searched, the album next run" : "no photos those days";
}

/** The key's own permissions (GET /api-keys/me needs none), kept for Setup's check. */
async function checkKey(env: Env, base: string): Promise<string> {
  let value: { ok: boolean; missing?: string[]; error?: string };
  try {
    const r = await call(env, base, "GET", "/api-keys/me");
    if (r.status !== 200) throw new ImmichError(`Immich answered HTTP ${r.status} for the key's permissions.`);
    const have = await env.DB.prepare("SELECT ?1 -> '$.permissions' AS p").bind(r.text).first<{ p: string | null }>();
    const perms: string[] = have?.p ? JSON.parse(have.p) : [];                 // a short list
    const missing = perms.includes("all") ? [] : IMMICH_PERMISSIONS.filter((p) => !perms.includes(p));
    value = { ok: !missing.length, missing };
  } catch (e) {
    value = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('immich_key', ?, ${NOW})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(JSON.stringify(value)).run();
  return value.ok ? "key ok" : value.error ?? `key missing ${value.missing?.join(", ")}`;
}

/** For Setup (/status): whether Immich is set up, and the cron's last check of the key. */
export async function immichCheck(env: Env): Promise<{ set_up: boolean; checked_at?: string; ok?: boolean; missing?: string[]; error?: string }> {
  if (!immichBase(env)) return { set_up: false };
  const row = await env.DB.prepare("SELECT value, updated_at FROM app_state WHERE key = 'immich_key'").first<{ value: string; updated_at: string }>();
  if (!row) return { set_up: true };
  return { set_up: true, checked_at: row.updated_at, ...JSON.parse(row.value) };
}

// --- the page's side ---------------------------------------------------------------------------

/** GET /trips/{id}/photos: the trip's album and the photos the journal shows (the cron's picks, up to
 * 6 a day), read by index: the trip by its key, the picks by (trip, pick). */
export async function tripPhotos(env: Env, id: number): Promise<Response> {
  const base = immichBase(env);
  const [trip, picks] = await env.DB.batch([
    env.DB.prepare(`SELECT immich_album_id, immich_state, immich_requested_at, immich_checked_at, immich_error, immich_count, immich_days, immich_page
                    FROM trips WHERE id = ?`).bind(id),
    env.DB.prepare("SELECT asset_id, day, taken, lat, lon, video FROM trip_photos WHERE trip_id = ? AND pick = 1 ORDER BY taken").bind(id),
  ]);
  const t = trip.results[0] as Record<string, string | number | null> | undefined;
  if (!t) throw new HttpError(404, "trip not found");
  return json({
    id, set_up: Boolean(base),
    state: t.immich_state, requested: Boolean(t.immich_requested_at) || t.immich_page !== null, checked_at: t.immich_checked_at, error: t.immich_error,
    count: t.immich_count ?? 0, days: t.immich_days ? JSON.parse(String(t.immich_days)) : {},
    album_url: base && t.immich_album_id && t.immich_state !== "gone" ? `${linkBase(env, base)}/albums/${t.immich_album_id}` : null,
    photos: (picks.results as { asset_id: string; day: string; taken: string; lat: number | null; lon: number | null; video: number }[])
      .map((p) => ({ id: p.asset_id, day: p.day, taken: p.taken, lat: p.lat, lon: p.lon, video: Boolean(p.video) })),
  });
}

/** POST /trips/{id}/photos {make: true}: "Make the album now" (or again, after it was deleted in
 * Immich). It only records the request; the next quiet run (within about 10 minutes) does it. */
export async function requestAlbum(env: Env, id: number): Promise<Response> {
  if (!immichBase(env)) throw new HttpError(409, "Immich isn't set up on this Minty (IMMICH_URL and IMMICH_API_KEY).");
  const r = await env.DB.batch([
    env.DB.prepare(`UPDATE trips SET immich_requested_at = ${NOW}, immich_next_at = NULL, immich_error = NULL,
                      immich_album_id = CASE WHEN immich_state = 'gone' THEN NULL ELSE immich_album_id END,
                      immich_state = CASE WHEN immich_state = 'gone' THEN NULL ELSE immich_state END
                    WHERE id = ?1`).bind(id),
    env.DB.prepare("UPDATE trip_photos SET added = 0 WHERE trip_id = ?1 AND (SELECT immich_album_id FROM trips WHERE id = ?1) IS NULL").bind(id),
  ]);
  if (!r[0].meta.changes) throw new HttpError(404, "trip not found");
  return json({ id, requested: true });
}

/** GET /trips/{id}/photos/{asset}: one photo's thumbnail, from Immich through the Worker, only for a
 * photo of that trip. Immich's headers aren't passed on; only an image is. */
export async function thumb(env: Env, id: number, asset: string): Promise<Response> {
  const base = immichBase(env);
  if (!base) throw new HttpError(404, "Immich isn't set up");
  if (!UUID.test(asset)) throw new HttpError(404, "not a photo of this trip");
  if (!(await env.DB.prepare("SELECT 1 FROM trip_photos WHERE trip_id = ? AND asset_id = ?").bind(id, asset).first())) throw new HttpError(404, "not a photo of this trip");
  let r: Response;
  try {
    r = await fetch(`${base}/api/assets/${asset}/thumbnail?size=thumbnail`, { headers: { ...headers(env), accept: "image/*" }, redirect: "manual" });
  } catch {
    throw new HttpError(502, "Immich didn't answer");
  }
  const type = r.headers.get("content-type") ?? "";
  if (r.status !== 200 || !/^image\/(jpeg|webp|png|avif)$/i.test(type.split(";")[0].trim())) {
    await r.body?.cancel();
    throw new HttpError(502, `Immich didn't send the thumbnail (HTTP ${r.status})`);
  }
  return new Response(r.body, { headers: { ...API_SECURITY_HEADERS, "content-type": type.split(";")[0].trim(), "cache-control": "private, max-age=86400" } });
}
