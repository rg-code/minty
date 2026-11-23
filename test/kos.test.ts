import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, getJson } from "./helpers";
import { refreshTotals } from "../src/audit/totals";
import { markJournalsReady } from "../src/routes/kos";

// Kos, trips (docs/trips.md): trips, bookings, reading an email file, and a trip's transactions.
const db = env.DB;
const send = (method: string, path: string, body?: unknown) =>
  getJson<any>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const rows = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<any>()).results;

let card = 0, checking = 0;
beforeEach(async () => {
  await db.batch(["trip_journal_notes", "trip_transactions", "trip_items", "trips", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  const item = (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name) VALUES ('me', 'me_primary', 'i-kos', 'x', 'Chase') RETURNING id`).first<{ id: number }>())!.id;
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
  it("POST /trips/read-email sends an attached PDF back for the page to read", async () => {
    const pdf = btoa("%PDF-1.4\n" + "x".repeat(200) + "\n%%EOF\n");
    const eml = ["From: Example Air <res@example.com>", "Subject: Your itinerary", "Date: Fri, 15 Jan 2027 09:12:00 -1000", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "",
      "--b", "Content-Type: text/plain", "", "Attached.", "--b", 'Content-Type: application/pdf; name="itinerary.pdf"', "Content-Transfer-Encoding: base64", "", pdf, "--b--", ""].join("\r\n");
    const r = await call("/trips/read-email", { method: "POST", body: eml, headers: { "content-type": "message/rfc822" } });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.pdfs).toEqual([{ filename: "itinerary.pdf", data: pdf }]);
    expect(body.bookings).toEqual([]);
  });

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

  it("a booking's charge: on the card it was paid with (last 4, network), else the same company; never a payment or another merchant (docs/trips.md §28)", async () => {
    const id = await trip();
    const bank = async (name: string) => (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name) VALUES ('me', 'me_primary', ?, 'x', ?) RETURNING id`).bind(`i-${name}`, name).first<{ id: number }>())!.id;
    const acct = async (item: number, pid: string, name: string, mask: string) => (await db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype, mask) VALUES ('me', ?, ?, ?, 'credit', 'credit card', ?) RETURNING id`).bind(item, pid, name, mask).first<{ id: number }>())!.id;
    const amex = await acct(await bank("American Express"), "p-amex", "Example Card", "52718");    // Amex: 5 digits
    const visa = await acct(await bank("Example Bank"), "p-visa", "Example Visa Signature", "2718");  // the same last 4, another network
    const other = await acct(await bank("Other Bank"), "p-other", "Other Card", "7777");
    const t = db.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, name, merchant_name, category, pending) VALUES ('me', ?, ?, ?, 'USD', ?, ?, ?, ?, 0)`);
    await db.batch([
      t.bind(amex, "stay", 123050, "2027-01-15", "EXAMPLE TRAVEL 800-555-0100", null, "TRAVEL"),          // the stay, on the Amex, booked Jan 15
      t.bind(visa, "visa-same", 123050, "2027-01-17", "BIG STORE", "Big Store", "GENERAL_MERCHANDISE"),  // same digits, a Visa: not it
      t.bind(other, "pymt", 123050, "2027-01-16", "CARDMEMBER SERV WEB PYMT", null, "LOAN_PAYMENTS"),     // a card payment: never
      t.bind(other, "market", 45000, "2027-01-05", "ONLINE MARKET", "Online Market", "GENERAL_MERCHANDISE"), // the car's price, another merchant: not it
      t.bind(other, "car", 45900, "2027-03-21", "EXAMPLE CAR RENTAL", "Example Car Rental", "TRAVEL"),  // the car, charged at return (2% more)
      t.bind(amex, "old", 123050, "2026-09-01", "EXAMPLE TRAVEL", null, "TRAVEL"),                      // before it was booked
    ]);
    const ids = Object.fromEntries((await rows("SELECT id, plaid_txn_id FROM transactions")).map((r: any) => [r.plaid_txn_id, r.id]));
    const item = async (b: Record<string, unknown>) => (await send("POST", "/trips/items", { trip_id: id, currency: "USD", ...b })).body.id;
    const stay = await item({ kind: "lodging", name: "Seaside Resort Kalani", price_cents: 123050, card_last4: "2718", card_network: "amex", booked_on: "2027-01-15", start_at: "2027-03-11", end_at: "2027-03-15" });
    const car = await item({ kind: "car", name: "Example Car Rental", price_cents: 45000, start_at: "2027-03-12", end_at: "2027-03-20" });
    await item({ kind: "restaurant", name: "The Table", price_cents: 12000, start_at: "2027-03-13T19:00" });   // nothing from it: nothing suggested
    const s = (await send("GET", `/trips/${id}/suggestions`)).body;
    expect(s.booked.map((b: any) => [b.item_id, b.item, b.how, b.card, b.matches.map((m: any) => m.id)])).toEqual([
      [stay, "the stay: Seaside Resort Kalani", "card", "2718", [ids.stay]],
      [car, "the car: Example Car Rental", "name", null, [ids.car]],
    ]);
    // a card no account has (an additional card's own number): the same company instead
    await send("PUT", `/trips/items/${stay}`, { kind: "lodging", trip_id: id, name: "Seaside Resort Kalani", price_cents: 123050, currency: "USD", card_last4: "4242", start_at: "2027-03-11", end_at: "2027-03-15" });
    expect((await send("GET", `/trips/${id}/suggestions`)).body.booked.map((b: any) => b.item_id)).toEqual([car]);   // "EXAMPLE TRAVEL" isn't the resort's name
    // its network unknown: any card with those digits, the nearest price first
    await send("PUT", `/trips/items/${stay}`, { kind: "lodging", trip_id: id, name: "Seaside Resort Kalani", price_cents: 123050, currency: "USD", card_last4: "2718", card_network: null, booked_on: "2027-01-15", start_at: "2027-03-11", end_at: "2027-03-15" });
    expect((await send("GET", `/trips/${id}/suggestions`)).body.booked[0].matches[0].id).toBe(ids.stay);
    expect((await send("POST", "/trips/items", { trip_id: id, kind: "other", card_last4: "12a4" })).status).toBe(422);
    expect((await send("POST", "/trips/items", { trip_id: id, kind: "other", card_network: "diners" })).status).toBe(422);
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

describe("trip tags (docs/trips.md §18)", () => {
  const tagsOf = async (plaid: string) => (await rows(
    "SELECT tt.tag, tt.trip_id FROM transaction_tags tt JOIN transactions t ON t.id = tt.transaction_id WHERE t.plaid_txn_id = ? ORDER BY tt.position", plaid))
    .map((r: any) => `${r.tag}${r.trip_id === null ? "" : "@trip"}`);
  const ids = async () => Object.fromEntries((await rows("SELECT id, plaid_txn_id FROM transactions")).map((r: any) => [r.plaid_txn_id, r.id]));
  const dirty = async () => (await rows("SELECT value FROM app_state WHERE key = 'audit_dirty'"))[0]?.value ?? null;
  beforeEach(async () => { await db.batch([db.prepare("DELETE FROM analytics_exclusions"), db.prepare("DELETE FROM app_state WHERE key = 'audit_dirty'")]); });

  it("a trip's tags go onto its confirmed transactions, and onto new ones as they're added; a tag already there stays the person's", async () => {
    const id = await trip(), x = await ids();
    await send("PUT", `/transactions/${x.sushi}/tags`, { tags: ["Reimbursed"] });            // tagged by hand first
    await send("POST", `/trips/${id}/transactions`, { confirm: [x.sushi, x.air], dismiss: [x.home] });
    expect((await send("PUT", `/trips/${id}`, { tags: ["reimbursed", "work", "Work"] })).status).toBe(200);
    expect(await tagsOf("sushi")).toEqual(["Reimbursed", "work@trip"]);
    expect(await tagsOf("air")).toEqual(["reimbursed@trip", "work@trip"]);
    expect(await tagsOf("home")).toEqual([]);                                                  // dismissed: not in the trip
    await send("POST", `/trips/${id}/transactions`, { confirm: [x.suica] });
    expect(await tagsOf("suica")).toEqual(["reimbursed@trip", "work@trip"]);
    const g = (await send("GET", "/trips")).body;
    expect(g.trips[0].tags).toEqual(["reimbursed", "work"]);
    expect((await send("GET", `/transactions?trip_id=${id}`)).body.find((t: any) => t.plaid_txn_id === "air").tags).toEqual(["reimbursed", "work"]);
  });

  it("taking a tag off the trip, or a transaction out of it, removes only what the trip added; deleting the trip keeps its tags", async () => {
    const id = await trip(), x = await ids();
    await send("PUT", `/transactions/${x.sushi}/tags`, { tags: ["reimbursed"] });
    await send("POST", `/trips/${id}/transactions`, { confirm: [x.sushi, x.air, x.suica] });
    await send("PUT", `/trips/${id}`, { tags: ["reimbursed", "work"] });
    await send("PUT", `/trips/${id}`, { tags: ["work"] });
    expect(await tagsOf("sushi")).toEqual(["reimbursed", "work@trip"]);                        // the person's stays
    expect(await tagsOf("air")).toEqual(["work@trip"]);
    await send("POST", `/trips/${id}/transactions`, { remove: [x.air], dismiss: [x.suica] });
    expect(await tagsOf("air")).toEqual([]);
    expect(await tagsOf("suica")).toEqual([]);
    // editing a row's tags on the dashboard keeps the trip's mark on the tags it keeps
    await send("PUT", `/transactions/${x.sushi}/tags`, { tags: ["work", "reimbursed", "dinner"] });
    expect(await tagsOf("sushi")).toEqual(["work@trip", "reimbursed", "dinner"]);
    await send("DELETE", `/trips/${id}`);
    expect(await tagsOf("sushi")).toEqual(["work", "reimbursed", "dinner"]);                   // an ordinary tag now
  });

  it("checks the tags; a left-out tag makes CFA rebuild, from a trip or the dashboard; GET /trips says which tags are left out", async () => {
    const id = await trip(), x = await ids();
    expect((await send("PUT", `/trips/${id}`, { tags: "reimbursed" })).status).toBe(422);
    expect((await send("PUT", `/trips/${id}`, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).status).toBe(422);
    expect((await send("PUT", `/trips/${id}`, { tags: ["x".repeat(65)] })).status).toBe(422);
    await db.prepare("INSERT INTO analytics_exclusions (kind, value) VALUES ('tag', 'Reimbursed')").run();
    await send("POST", `/trips/${id}/transactions`, { confirm: [x.sushi] });
    await send("PUT", `/trips/${id}`, { tags: ["work"] });
    expect(await dirty()).toBe(null);                                                          // not a left-out tag
    await send("PUT", `/trips/${id}`, { tags: ["work", "reimbursed"] });
    expect(await dirty()).toBe("1");
    expect((await send("GET", "/trips")).body.left_out_tags).toEqual(["Reimbursed"]);
    await db.prepare("DELETE FROM app_state WHERE key = 'audit_dirty'").run();
    await send("POST", "/transactions/tags", { ids: [x.shop], add: ["reimbursed"] });          // the dashboard's own tagging too
    expect(await dirty()).toBe("1");
  });

  it("end to end: a trip tagged with a left-out tag drops out of CFA's monthly totals at the next run", async () => {
    const id = await trip(), x = await ids();
    await db.prepare("INSERT INTO analytics_exclusions (kind, value) VALUES ('tag', 'reimbursed')").run();
    await send("POST", `/trips/${id}/transactions`, { confirm: [x.sushi, x.suica] });
    const march = async () => (await rows("SELECT sum(amount_cents) AS c FROM monthly_totals WHERE month = '2027-03' AND bucket = 'spend'"))[0].c;
    await refreshTotals(env as any);
    const before = await march();
    expect(before).toBe(8500 + 3000 + 4200 + 2000 + 9000);
    await send("PUT", `/trips/${id}`, { tags: ["Reimbursed"] });
    await refreshTotals(env as any);
    expect(await march()).toBe(before - 8500 - 3000);                                         // the trip's two are left out
    await send("PUT", `/trips/${id}`, { tags: [] });
    await refreshTotals(env as any);
    expect(await march()).toBe(before);                                                        // and back in
  });
});

describe("the trip journal (docs/trips.md §20)", () => {
  it("keeps a note per day and one for the trip; an empty one removes it; first opened is kept", async () => {
    const id = await trip();
    expect((await send("GET", `/trips/${id}/journal`)).body).toEqual({ id, ready_at: null, seen_at: null, notes: {} });
    expect((await send("PUT", `/trips/${id}/journal`, { day: "trip", text: "  The best one yet.  " })).status).toBe(200);
    await send("PUT", `/trips/${id}/journal`, { day: "2027-03-12", text: "Sushi, then the river." });
    await send("PUT", `/trips/${id}/journal`, { day: "2027-03-12", text: "Sushi, then the river at night." });
    await send("PUT", `/trips/${id}/journal`, { seen: true });
    let j = (await send("GET", `/trips/${id}/journal`)).body;
    expect(j.notes).toEqual({ trip: "The best one yet.", "2027-03-12": "Sushi, then the river at night." });
    expect(j.seen_at).toMatch(/^\d{4}-/);
    await send("PUT", `/trips/${id}/journal`, { day: "trip", text: "" });
    j = (await send("GET", `/trips/${id}/journal`)).body;
    expect(Object.keys(j.notes)).toEqual(["2027-03-12"]);
    await send("DELETE", `/trips/${id}`);
    expect(await rows("SELECT * FROM trip_journal_notes")).toEqual([]);                      // they go with the trip
  });
  it("checks the day, the text and the trip", async () => {
    const id = await trip();
    expect((await send("PUT", `/trips/${id}/journal`, { day: "tuesday", text: "x" })).status).toBe(422);
    expect((await send("PUT", `/trips/${id}/journal`, { day: "trip", text: 5 })).status).toBe(422);
    expect((await send("PUT", `/trips/${id}/journal`, { day: "trip", text: "x".repeat(5001) })).status).toBe(422);
    expect((await send("GET", "/trips/9999/journal")).status).toBe(404);
  });
  it("the hourly run marks an ended trip's journal ready, once", async () => {
    const past = await trip({ name: "Past", start_date: "2020-01-01", end_date: "2020-01-05" });
    const future = await trip();
    expect(await markJournalsReady(env as any)).toBe(1);
    expect(await markJournalsReady(env as any)).toBe(0);
    const t = (await send("GET", "/trips")).body.trips;
    expect(t.find((x: any) => x.id === past).journal_ready_at).toMatch(/^\d{4}-/);
    expect(t.find((x: any) => x.id === future).journal_ready_at).toBe(null);
  });
});

describe("trip codes (docs/trips.md §21)", () => {
  it("each new trip gets its own 10-character code, kept when it's edited; an import's code is kept when it's free", async () => {
    const a = await trip(), b = await trip({ name: "Kyoto" });
    const list = (await send("GET", "/trips")).body.trips;
    const code = (id: number) => list.find((t: any) => t.id === id).code;
    expect(code(a)).toMatch(/^[2-9a-hjkmnp-z]{10}$/);
    expect(code(a)).not.toBe(code(b));
    await send("PUT", `/trips/${a}`, { name: "Tokyo, again", start_date: "2027-03-10", end_date: "2027-03-20", code: "zzzzzzzzzz" });
    expect((await send("GET", "/trips")).body.trips.find((t: any) => t.id === a).code).toBe(code(a));     // never changes
    const c = await trip({ name: "Imported", code: "k7f3x9p2ad" });
    const d = await trip({ name: "Imported again", code: "k7f3x9p2ad" });                                 // taken: a new one
    const after = (await send("GET", "/trips")).body.trips;
    expect(after.find((t: any) => t.id === c).code).toBe("k7f3x9p2ad");
    expect(after.find((t: any) => t.id === d).code).toMatch(/^[2-9a-hjkmnp-z]{10}$/);
    expect(after.find((t: any) => t.id === d).code).not.toBe("k7f3x9p2ad");
    await trip({ name: "Bad code", code: "NOT-A-CODE" });                                                  // ignored, a new one made
  });
});

