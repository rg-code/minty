import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { billStatus, defaultMatchName } from "../src/routes/household-bills";
import { call, getJson } from "./helpers";

// Bills, part 2 (docs/bills.md): the bills a household adds itself, by hand or from a PDF, and
// whether each is paid (marked, or matched to a posted payment).

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const SHA = "a".repeat(64);
const send = (method: string, path: string, body?: unknown) => getJson<any>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const pge = (extra: Record<string, unknown> = {}) => ({ biller: "PG&E", amount_cents: 14327, due_date: day(10), statement_date: day(-15), ...extra });

beforeEach(async () => {
  await env.DB.batch(["bills", "transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

async function checking() {
  const item = (await env.DB.prepare(
    `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, txn_cursor, status, updated_at)
     VALUES ('me', 'me_primary', 'item-b', 'x', 'Bank', 'c', 'good', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING id`).first<{ id: number }>())!.id;
  return (await env.DB.prepare(
    `INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype) VALUES ('me', ?, 'chk', 'Checking', 'depository', 'checking') RETURNING id`)
    .bind(item).first<{ id: number }>())!.id;
}
async function txn(account: number, date: string, cents: number, name: string, merchant: string | null = null, pending = 0) {
  await env.DB.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, name, merchant_name, pending)
    VALUES ('me', ?, ?, ?, 'USD', ?, ?, ?, ?)`).bind(account, crypto.randomUUID(), cents, date, name, merchant, pending).run();
}

describe("adding bills", () => {
  it("adds one by hand, defaulting the person and the name its payment goes by", async () => {
    const { status, body } = await send("POST", "/bills", pge());
    expect(status).toBe(201);
    const row = await env.DB.prepare("SELECT owner, biller, match_name, amount_cents, source, file_sha256 FROM bills WHERE id = ?").bind(body.id).first();
    expect(row).toEqual({ owner: "me", biller: "PG&E", match_name: "PG&E", amount_cents: 14327, source: "manual", file_sha256: null });
  });

  it("adds one read from a PDF, and refuses the same PDF twice", async () => {
    expect((await send("POST", "/bills", pge({ source: "pdf", file_sha256: SHA }))).status).toBe(201);
    const again = await send("POST", "/bills", pge({ source: "pdf", file_sha256: SHA }));
    expect(again.status).toBe(409);
    expect(again.body.detail).toMatch(/already added/);
    expect((await send("POST", "/bills/known", { sha256: [SHA, "b".repeat(64)] })).body).toEqual({ known: [SHA] });
  });

  it("refuses what isn't a bill", async () => {
    for (const bad of [pge({ biller: "" }), pge({ amount_cents: -1 }), pge({ amount_cents: 12.5 }), pge({ due_date: "2026-02-30" }),
                       pge({ statement_date: "soon" }), pge({ account_hint: "12345" }), pge({ owner: "nobody" }), pge({ source: "pdf" }),
                       pge({ match_name: "X".repeat(41) })]) {
      expect((await send("POST", "/bills", bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await env.DB.prepare("SELECT count(*) AS n FROM bills").first<{ n: number }>())!.n).toBe(0);
  });

  it("guesses the payment's name from the biller's first word", () => {
    expect(defaultMatchName("PG&E")).toBe("PG&E");
    expect(defaultMatchName("Coastside County Water District")).toBe("COASTSIDE");
    expect(defaultMatchName("AT&T")).toBe("AT&T");
  });
});

describe("changing bills", () => {
  it("edits only what's sent, marks paid and unpaid, and deletes", async () => {
    const { body: { id } } = await send("POST", "/bills", pge({ match_name: "PGANDE" }));
    expect((await send("PUT", `/bills/${id}`, { amount_cents: 15000, biller: "PG&E (home)" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT biller, amount_cents, match_name, due_date FROM bills").first())
      .toEqual({ biller: "PG&E (home)", amount_cents: 15000, match_name: "PGANDE", due_date: day(10) });   // match name kept
    expect((await send("POST", `/bills/${id}/paid`, { paid: true })).body.paid_at).toEqual(expect.any(String));
    expect((await send("POST", `/bills/${id}/paid`, { paid: false })).body.paid_at).toBeNull();
    expect((await send("DELETE", `/bills/${id}`)).body).toEqual({ id, deleted: true });
    expect((await send("DELETE", `/bills/${id}`)).status).toBe(404);
    expect((await send("PUT", "/bills/999", { amount_cents: 1 })).status).toBe(404);
  });
});

describe("paid or not", () => {
  it("matches a posted payment named like the bill, within $1, inside its window", async () => {
    const acct = await checking();
    await send("POST", "/bills", pge());
    await txn(acct, day(-2), 14300, "PGANDE WEB ONLINE", "PG&E");          // within $1, matched by merchant name
    const { body } = await getJson<any>("/bills");
    expect(body.bills[0]).toMatchObject({ biller: "PG&E", status: "paid", paid_how: "matched", attention: false,
                                          matched: { date: day(-2), amount_cents: 14300 } });
  });

  it("doesn't match a different amount, another name, a pending one, or one before the statement", async () => {
    const acct = await checking();
    await send("POST", "/bills", pge({ due_date: day(3) }));
    await txn(acct, day(-2), 15000, "PG&E PAYMENT");                       // $6.73 off
    await txn(acct, day(-2), 14327, "WATER DISTRICT");                     // another biller
    await txn(acct, day(-1), 14327, "PG&E PAYMENT", null, 1);              // still pending
    await txn(acct, day(-30), 14327, "PG&E PAYMENT");                      // before this bill's statement
    const b = (await getJson<any>("/bills")).body.bills[0];
    expect(b).toMatchObject({ status: "unpaid", paid_how: null, matched: null, attention: true, days_left: 3 });
  });

  it("status: marked paid, overdue, due soon, nothing due", () => {
    const today = day(0);
    expect(billStatus({ amount_cents: 100, due_date: day(1), paid_at: "x", matched: null }, today, 5).status).toBe("paid");
    expect(billStatus({ amount_cents: 100, due_date: day(-1), paid_at: null, matched: null }, today, 5)).toMatchObject({ status: "overdue", attention: true });
    expect(billStatus({ amount_cents: 100, due_date: day(6), paid_at: null, matched: null }, today, 5).attention).toBe(false);
    expect(billStatus({ amount_cents: 0, due_date: day(1), paid_at: null, matched: null }, today, 5).status).toBe("nothing_due");
  });
});
