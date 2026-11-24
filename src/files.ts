// Kos: files attached to a booking (docs/trips.md §38). The bytes live in R2 (the FILES binding, bucket
// "minty-files"), private: they're read only through GET /trips/files/{id}, behind Access like every API path.
// D1 keeps a row per file (name, type, size, SHA-256, its R2 key). A file's type is read from its first bytes,
// never trusted from its name: PDF, PNG, JPEG, GIF, WebP, HEIC, an Apple Wallet pass or an email. Files go 30
// days after their trip ends (ATTACHMENTS_KEEP_DAYS; "0" keeps them), and with their booking. Without the FILES
// binding (R2 not switched on), the routes say so and Kos keeps files on the device instead.
import type { Env } from "./env";
import { HttpError, json, unprocessable } from "./http";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_BOOKING = 10;
export const filesOn = (env: Env) => Boolean(env.FILES);
export const keepDays = (env: Env) => { const n = Number((env.ATTACHMENTS_KEEP_DAYS ?? "").trim()); return Number.isInteger(n) && n >= 0 && (env.ATTACHMENTS_KEEP_DAYS ?? "").trim() !== "" ? n : 30; };

/** What a file is, by its first bytes (and, for an email or a Wallet pass, its name or declared type); null when
 * it's none of the kinds Kos keeps. */
export function sniff(bytes: Uint8Array, name: string, declared: string): string | null {
  const head = String.fromCharCode(...bytes.subarray(0, 16));
  if (head.startsWith("%PDF")) return "application/pdf";
  if (bytes[0] === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (head.slice(4, 8) === "ftyp" && /^(heic|heix|hevc|heif|mif1|msf1)$/.test(head.slice(8, 12))) return "image/heic";
  // a Wallet pass is a zip named .pkpass (or sent as one)
  if (head.startsWith("PK\x03\x04") && (/\.pkpass$/i.test(name) || /vnd\.apple\.pkpass/i.test(declared))) return "application/vnd.apple.pkpass";
  // an email: text with a mail header near the top
  if ((/\.eml$/i.test(name) || /message\/rfc822/i.test(declared)) && /^(?:[\x20-\x7e\t\r\n]{0,2000})(?:^|\n)(?:From|Received|Return-Path|MIME-Version|Delivered-To|Date|Subject):/im.test(String.fromCharCode(...bytes.subarray(0, 4000)))) return "message/rfc822";
  return null;
}
const cleanName = (s: string, type: string) => {
  const base = s.replace(/[\\/\x00-\x1f\x7f"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const ext: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "application/vnd.apple.pkpass": "pkpass", "message/rfc822": "eml" };
  return base || `attachment.${ext[type] ?? "bin"}`;
};
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** POST /trips/items/{id}/files?name=…: the file's bytes as the body (up to 10 MB; index.ts lets this route past
 * 16 KiB). Returns its row. */
export async function addFile(env: Env, request: Request, itemId: number, url: URL): Promise<Response> {
  if (!env.FILES) throw new HttpError(404, "attachments aren't set up on this Minty (R2 isn't switched on): Kos keeps them on the device");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) { await reader.cancel().catch(() => {}); throw new HttpError(413, "a file can be at most 10 MB"); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  if (!bytes.length) throw unprocessable("send the file's bytes");
  const given = url.searchParams.get("name") ?? "";
  const type = sniff(bytes, given, request.headers.get("content-type") ?? "");
  if (!type) throw unprocessable("Kos keeps PDFs, pictures (PNG, JPEG, GIF, WebP, HEIC), Wallet passes (.pkpass) and email files (.eml)");
  const row = await env.DB.prepare("SELECT (SELECT 1 FROM trip_items WHERE id = ?1) AS ok, (SELECT count(*) FROM trip_files WHERE item_id = ?1) AS n").bind(itemId).first<{ ok: number | null; n: number }>();
  if (!row?.ok) throw new HttpError(404, "booking not found");
  if (row.n >= MAX_FILES_PER_BOOKING) throw unprocessable(`a booking keeps at most ${MAX_FILES_PER_BOOKING} files`);
  const name = cleanName(given, type), sha = hex(await crypto.subtle.digest("SHA-256", bytes)), key = `kos/${itemId}/${crypto.randomUUID()}`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: type }, customMetadata: { item: String(itemId) } });
  try {
    const r = await env.DB.prepare(`INSERT INTO trip_files (item_id, name, content_type, size, sha256, r2_key) VALUES (?, ?, ?, ?, ?, ?)
                                    RETURNING id, item_id, name, content_type, size, created_at`).bind(itemId, name, type, size, sha, key).first();
    return json(r, 201);
  } catch (e) { await env.FILES.delete(key).catch(() => {}); throw e; }
}

/** GET /trips/files/{id}: the file, to open (a PDF or a picture in the browser, a Wallet pass in Wallet) or, for
 * an email, to save. Never cached. */
export async function getFile(env: Env, id: number): Promise<Response> {
  if (!env.FILES) throw new HttpError(404, "attachments aren't set up on this Minty");
  const f = await env.DB.prepare("SELECT name, content_type, r2_key FROM trip_files WHERE id = ?").bind(id).first<{ name: string; content_type: string; r2_key: string }>();
  if (!f) throw new HttpError(404, "file not found");
  const obj = await env.FILES.get(f.r2_key);
  if (!obj) throw new HttpError(404, "file not found");
  const inline = f.content_type !== "message/rfc822";
  return new Response(obj.body, { headers: {
    "content-type": f.content_type, "content-length": String(obj.size),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
  } });
}

/** DELETE /trips/files/{id}. */
export async function deleteFile(env: Env, id: number): Promise<Response> {
  const f = await env.DB.prepare("SELECT r2_key FROM trip_files WHERE id = ?").bind(id).first<{ r2_key: string }>();
  if (!f) throw new HttpError(404, "file not found");
  if (env.FILES) await env.FILES.delete(f.r2_key);
  await env.DB.prepare("DELETE FROM trip_files WHERE id = ?").bind(id).run();
  return json({ id, removed: true });
}

/** A booking's files, from R2, before the booking goes (its rows go with it, ON DELETE CASCADE). */
export async function deleteBookingFiles(env: Env, itemId: number): Promise<void> {
  const keys = (await env.DB.prepare("SELECT r2_key FROM trip_files WHERE item_id = ?").bind(itemId).all<{ r2_key: string }>()).results.map((r) => r.r2_key);
  if (keys.length && env.FILES) await env.FILES.delete(keys);
}

/** The hourly run: files whose trip ended more than ATTACHMENTS_KEEP_DAYS ago (a booking with no trip: its own
 * end), from R2 and D1, up to 200 a run. Returns how many went. */
export async function cleanupFiles(env: Env): Promise<number> {
  const days = keepDays(env);
  if (!days || !env.FILES) return 0;
  const old = (await env.DB.prepare(
    `SELECT f.id, f.r2_key FROM trip_files f JOIN trip_items i ON i.id = f.item_id LEFT JOIN trips t ON t.id = i.trip_id
     WHERE coalesce(t.end_date, substr(coalesce(i.end_at, i.start_at), 1, 10)) < date('now', ?) LIMIT 200`).bind(`-${days} days`).all<{ id: number; r2_key: string }>()).results;
  if (!old.length) return 0;
  await env.FILES.delete(old.map((f) => f.r2_key));
  await env.DB.prepare("DELETE FROM trip_files WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(old.map((f) => f.id))).run();
  return old.length;
}

/** Every file's row, for GET /trips (a household's trips have a handful). */
export async function fileRows(env: Env): Promise<{ id: number; item_id: number; name: string; content_type: string; size: number; created_at: string }[]> {
  return (await env.DB.prepare("SELECT id, item_id, name, content_type, size, created_at FROM trip_files ORDER BY id").all<any>()).results;
}
