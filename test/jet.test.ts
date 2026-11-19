import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, getJson } from "./helpers";

// JET, trips (docs/trips.md): trips, bookings, reading an email file, and a trip's transactions.
const db = env.DB;
const send = (method: string, path: string, body?: unknown) =>
  getJson<any>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const rows = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<any>()).results;

let card = 0, checking = 0;
beforeEach(async () => {
  await db.batch(["trip_transactions", "trip_items", "trips", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  const item = (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name) VALUES ('me', 'me_primary', 'i-jet', 'x', 'Chase') RETURNING id`).first<{ id: number }>())!.id;
  const acct = (pid: string, name: string, type: string) => db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype, mask) VALUES ('me', ?, ?, ?, ?, ?, '1234') RETURNING id`)
    .bind(item, pid, name, type, type === "credit" ? "credit card" : "checking").first<{ id: number }>();
  card = (await acct("p-card", "Sapphire", "credit"))!.id;
  checking = (await acct("p-chk", "Checking", "depository"))!.id;
  const t = db.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, name, merchant_name, category, pending) VALUES ('me', ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  await db.batch([
    t.bind(card, "air", 124060, "USD", "2026-12-02", "UNITED 0162345", "United", "TRAVEL"),             // the flight, booked months before
    t.bind(card, "sushi", 8500, "USD", "2027-03-12", "SUSHI EXAMPLE", "Sushi Example", "FOOD_AND_DRINK"),
    t.bind(card, "suica", 3000, "USD", "2027-03-11", "SUICA", null, "TRANSPORTATION"),
    t.bind(card, "shop", 4200, "USD", "2027-03-13", "UNIQLO", "Uniqlo", "GENERAL_MERCHANDISE"),          // "also during the trip"
    t.bind(card, "pay", -50000, "USD", "2027-03-14", "PAYMENT", null, "LOAN_PAYMENTS"),                   // not a trip charge
    t.bind(card, "before", 2000, "USD", "2027-03-01", "LOCAL CAFE", null, "FOOD_AND_DRINK"),            // before the window
    t.bind(checking, "home", 9000, "USD", "2027-03-12", "UTILITY", null, "RENT_AND_UTILITIES"),          // also during
  ]);
});

const trip = async (b: Record<string, unknown> = {}) => {
  const r = await send("POST", "/trips", { name: "Tokyo", start_date: "2027-03-10", end_date: "2027-03-20", place: "Tokyo, Japan", travellers: ["me", "spouse"], ...b });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as number;
};

describe("trips and bookings", () => {
  it("a trip with a flight and a hotel; a booking can wait outside a trip; GET /trips has both", async () => {
    const id = await trip();
    expect((await send("POST", "/trips/items", { trip_id: id, kind: "flight", airline: "ua", flight_number: "837", dep_airport: "sfo", arr_airport: "NRT",
      start_at: "2027-03-10T11:05:00-08:00", end_at: "2027-03-11T15:00:00+09:00", price_cents: 124060, currency: "usd", confirmation: "ABC123", seat: "34K" })).status).toBe(201);
    await send("POST", "/trips/items", { trip_id: id, kind: "lodging", name: "Hotel Example", start_at: "2027-03-11", end_at: "2027-03-15", lat: 35.68, lon: 139.76 });
    await send("POST", "/trips/items", { kind: "restaurant", name: "Later", start_at: "2027-05-01T19:00" });
    const r = (await send("GET", "/trips")).body;
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0]).toMatchObject({ name: "Tokyo", travellers: ["me", "spouse"], transactions: 0 });
    expect(r.trips[0].items.map((i: any) => [i.kind, i.airline, i.dep_airport, i.currency])).toEqual([["flight", "UA", "SFO", "USD"], ["lodging", null, null, null]]);
    expect(r.unassigned.map((i: any) => i.name)).toEqual(["Later"]);
  });

  it("validates", async () => {
    const id = await trip();
    const bad = async (b: Record<string, unknown>) => (await send("POST", "/trips/items", { trip_id: id, kind: "flight", ...b })).status;
    expect(await bad({ kind: "boat" })).toBe(422);
    expect(await bad({ dep_airport: "SF" })).toBe(422);
    expect(await bad({ flight_number: "abc" })).toBe(422);
    expect(await bad({ start_at: "next tuesday" })).toBe(422);
    expect(await bad({ start_at: "2027-03-10", end_at: "2027-03-09" })).toBe(422);
    expect(await bad({ points_program: "nope" })).toBe(422);
    expect(await bad({ trip_id: 99999 })).toBe(422);
    expect((await send("POST", "/trips", { name: "x", start_date: "2027-03-10", end_date: "2027-03-01" })).status).toBe(422);
    expect((await send("POST", "/trips", { name: "x", start_date: "2027-03-10", end_date: "2027-03-11", travellers: ["nobody"] })).status).toBe(422);
  });

  it("making a trip from waiting bookings; removing a trip keeps its bookings and drops its links", async () => {
    const a = (await send("POST", "/trips/items", { kind: "event", name: "Concert", start_at: "2027-03-12T19:00" })).body.id;
    const id = await trip({ items: [a] });
    expect((await rows("SELECT trip_id FROM trip_items WHERE id = ?", a))[0].trip_id).toBe(id);
    const [{ id: tx }] = await rows("SELECT id FROM transactions WHERE plaid_txn_id = 'sushi'");
    await send("POST", `/trips/${id}/transactions`, { confirm: [tx] });
    expect((await send("DELETE", `/trips/${id}`)).body).toEqual({ id, removed: true });
    expect((await rows("SELECT trip_id FROM trip_items WHERE id = ?", a))[0].trip_id).toBe(null);
    expect(await rows("SELECT * FROM trip_transactions")).toEqual([]);
  });
});

describe("reading an email file", () => {
  it("POST /trips/read-email: bookings from its schema.org markup, nothing stored", async () => {
    const html = `<script type="application/ld+json">{"@type":"FoodEstablishmentReservation","reservationNumber":"R9","startTime":"2027-03-12T19:30:00+09:00","reservationFor":{"@type":"Restaurant","name":"Sushi Example","address":"2-2 Example, Tokyo"}}</script>`;
    const eml = ["From: Alex <alex@example.com>", "To: ourminty+mintytrips@gmail.com", "Subject: Your reservation", "Content-Type: text/html; charset=utf-8", "", html, ""].join("\r\n");
    const r = await call("/trips/read-email", { method: "POST", body: eml, headers: { "content-type": "message/rfc822" } });
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b).toMatchObject({ subject: "Your reservation", view: "trips", bookings: [{ kind: "restaurant", name: "Sushi Example", confirmation: "R9" }] });
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await rows("SELECT * FROM trip_items")).toEqual([]);
  });

  it("refuses an empty one, and one over 2 MB (that route only gets past 16 KiB)", async () => {
    expect((await call("/trips/read-email", { method: "POST", body: "" })).status).toBe(422);
    expect((await call("/trips/read-email", { method: "POST", body: "x".repeat(2 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await call("/trips/read-email", { method: "POST", body: "x".repeat(100 * 1024) })).status).toBe(200);
    expect((await call("/trips", { method: "POST", body: JSON.stringify({ name: "x".repeat(20000) }) })).status).toBe(413);
  });
});

describe("a trip's transactions", () => {
  it("suggestions: travel spending during it first, the rest apart, and the charge for a booking made before", async () => {
    const id = await trip();
    await send("POST", "/trips/items", { trip_id: id, kind: "flight", name: "United", price_cents: 124060, currency: "USD" });
    const s = (await send("GET", `/trips/${id}/suggestions`)).body;
    expect(s.from).toBe("2027-03-09");
    expect(s.during.map((t: any) => t.name)).toEqual(["SUICA", "Sushi Example"]);
    expect(s.also.map((t: any) => t.name).sort()).toEqual(["UTILITY", "Uniqlo"]);
    expect(s.booked).toHaveLength(1);
    expect(s.booked[0]).toMatchObject({ item: "United", matches: [{ name: "United", amount_cents: 124060 }] });
  });

  it("confirm, dismiss and remove; confirmed ones are in the dashboard's ?trip_id=, and aren't suggested again", async () => {
    const id = await trip();
    const ids = Object.fromEntries((await rows("SELECT id, plaid_txn_id FROM transactions")).map((r: any) => [r.plaid_txn_id, r.id]));
    expect((await send("POST", `/trips/${id}/transactions`, { confirm: [ids.sushi, ids.suica, ids.air], dismiss: [ids.home] })).body)
      .toMatchObject({ confirmed: 3, dismissed: 1 });
    const dash = (await send("GET", `/transactions?trip_id=${id}`)).body;
    expect(dash.map((t: any) => t.plaid_txn_id)).toEqual(["sushi", "suica", "air"]);
    const s = (await send("GET", `/trips/${id}/suggestions`)).body;
    expect([...s.during, ...s.also].map((t: any) => t.name)).toEqual(["Uniqlo"]);
    expect((await send("GET", "/trips")).body.trips[0]).toMatchObject({ transactions: 3, spent_cents: 124060 + 8500 + 3000 });
    await send("POST", `/trips/${id}/transactions`, { remove: [ids.air] });
    expect((await send("GET", `/transactions?trip_id=${id}`)).body).toHaveLength(2);
    expect((await send("POST", `/trips/${id}/transactions`, { confirm: ["x"] })).status).toBe(422);
    expect((await send("GET", "/transactions?trip_id=0")).status).toBe(422);
  });
});
