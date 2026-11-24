import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, getJson } from "./helpers";
import { cleanupFiles, sniff } from "../src/files";
import type { Env } from "../src/env";

// Kos: files attached to a booking (docs/trips.md §38), in R2 (the test runner's local R2), rows in D1.
const db = env.DB;
const enc = (s: string) => new TextEncoder().encode(s);
const PDF = enc("%PDF-1.4\n" + "x".repeat(300) + "\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(1)]);
const upload = (item: number, bytes: Uint8Array, name: string, type = "application/octet-stream", e: Partial<Env> = {}) =>
  call(`/trips/items/${item}/files?name=${encodeURIComponent(name)}`, { method: "POST", body: bytes, headers: { "content-type": type }, envOverrides: e });

describe("what a file is, by its bytes", () => {
  it("knows PDFs, pictures, Wallet passes and emails; nothing else", () => {
    expect(sniff(PDF, "x.bin", "")).toBe("application/pdf");
    expect(sniff(PNG, "photo", "")).toBe("image/png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "a.jpg", "")).toBe("image/jpeg");
    expect(sniff(enc("\0\0\0\x18ftypheic\0\0\0\0"), "IMG_1.HEIC", "")).toBe("image/heic");
    expect(sniff(enc("PK\x03\x04rest of a zip"), "Boarding.pkpass", "")).toBe("application/vnd.apple.pkpass");
    expect(sniff(enc("PK\x03\x04rest of a zip"), "archive.zip", "")).toBeNull();                  // a zip isn't a pass
    expect(sniff(enc("From: a@example.com\r\nSubject: Your trip\r\n\r\nHello"), "trip.eml", "")).toBe("message/rfc822");
    expect(sniff(enc("<html><script>alert(1)</script></html>"), "page.pdf", "application/pdf")).toBeNull();   // a name or a type isn't trusted
  });
});

describe("a booking's files", () => {
  let item = 0, trip = 0;
  beforeEach(async () => {
    await db.batch(["trip_files", "trip_items", "trips"].map((t) => db.prepare(`DELETE FROM ${t}`)));
    const left = (await env.FILES!.list()).objects.map((o) => o.key);                    // a clean bucket each test
    if (left.length) await env.FILES!.delete(left);
    trip = (await db.prepare("INSERT INTO trips (name, start_date, end_date) VALUES ('Example Trip', '2027-04-05', '2027-04-08') RETURNING id").first<{ id: number }>())!.id;
    item = (await db.prepare("INSERT INTO trip_items (trip_id, kind, airline, flight_number, start_at) VALUES (?, 'flight', 'UA', '1234', '2027-04-05T08:00') RETURNING id").bind(trip).first<{ id: number }>())!.id;
  });
  const keys = async () => (await env.FILES!.list({ prefix: `kos/${item}/` })).objects.map((o) => o.key);

  it("keeps one, lists it with its booking, opens it, and deletes it from R2 and D1", async () => {
    const r = await upload(item, PDF, "Boarding pass.pdf");
    expect(r.status).toBe(201);
    const f = await r.json() as any;
    expect(f).toMatchObject({ item_id: item, name: "Boarding pass.pdf", content_type: "application/pdf", size: PDF.length });
    expect(await keys()).toHaveLength(1);
    const list = (await getJson<any>("/trips")).body;
    expect(list.files_on).toBe(true);
    expect(list.files_keep_days).toBe(30);
    expect(list.trips[0].items[0].files.map((x: any) => x.name)).toEqual(["Boarding pass.pdf"]);
    const got = await call(`/trips/files/${f.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("cache-control")).toBe("private, no-store");
    expect(got.headers.get("content-disposition")).toContain("inline");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PDF);
    expect((await call(`/trips/files/${f.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await keys()).toEqual([]);
    expect((await call(`/trips/files/${f.id}`)).status).toBe(404);
  });

  it("refuses what it doesn't keep, past 10 a booking, and on a booking that isn't there", async () => {
    expect((await upload(item, enc("<html>hi</html>"), "page.html", "text/html")).status).toBe(422);
    for (let n = 0; n < 10; n++) expect((await upload(item, PNG, `p${n}.png`)).status).toBe(201);
    expect((await upload(item, PNG, "eleventh.png")).status).toBe(422);
    expect((await upload(99999, PDF, "x.pdf")).status).toBe(404);
    expect((await call(`/trips/items/${item}/files?name=x.pdf`, { method: "POST", body: new Uint8Array(0) })).status).toBe(422);
  });

  it("an email file is saved, not opened; a Wallet pass opens as one", async () => {
    const eml = await (await upload(item, enc("From: a@example.com\r\nSubject: Your tickets\r\n\r\nSee attached."), "tickets.eml", "message/rfc822")).json() as any;
    expect((await call(`/trips/files/${eml.id}`)).headers.get("content-disposition")).toMatch(/^attachment;/);
    const pass = await (await upload(item, enc("PK\x03\x04" + "z".repeat(100)), "Boarding.pkpass", "application/vnd.apple.pkpass")).json() as any;
    expect((await call(`/trips/files/${pass.id}`)).headers.get("content-type")).toBe("application/vnd.apple.pkpass");
  });

  it("go with their booking, and 30 days after their trip ends (or never, with 0)", async () => {
    await upload(item, PDF, "a.pdf");
    expect((await call(`/trips/items/${item}`, { method: "DELETE" })).status).toBe(200);
    expect(await keys()).toEqual([]);
    expect((await db.prepare("SELECT count(*) AS n FROM trip_files").first<{ n: number }>())!.n).toBe(0);
    // an old trip's files go; a recent one's stay
    const old = (await db.prepare("INSERT INTO trips (name, start_date, end_date) VALUES ('Old', '2020-01-01', '2020-01-05') RETURNING id").first<{ id: number }>())!.id;
    const oldItem = (await db.prepare("INSERT INTO trip_items (trip_id, kind, name) VALUES (?, 'lodging', 'Old Inn') RETURNING id").bind(old).first<{ id: number }>())!.id;
    item = (await db.prepare("INSERT INTO trip_items (trip_id, kind, name) VALUES (?, 'lodging', 'New Inn') RETURNING id").bind(trip).first<{ id: number }>())!.id;
    await upload(oldItem, PDF, "old.pdf"); await upload(item, PDF, "new.pdf");
    expect(await cleanupFiles({ ...env, ATTACHMENTS_KEEP_DAYS: "0" } as Env)).toBe(0);
    expect(await cleanupFiles({ ...env } as Env)).toBe(1);
    expect((await db.prepare("SELECT name FROM trip_files").all<{ name: string }>()).results.map((r) => r.name)).toEqual(["new.pdf"]);
    expect((await env.FILES!.list({ prefix: `kos/${oldItem}/` })).objects).toEqual([]);
  });

  it("without R2, the routes say so (Kos keeps files on the device)", async () => {
    expect((await upload(item, PDF, "a.pdf", "application/pdf", { FILES: undefined })).status).toBe(404);
    expect((await getJson<any>("/trips", { envOverrides: { FILES: undefined } })).body.files_on).toBe(false);
  });
});
