import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createScheduledController, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { fernetEncrypt } from "../src/fernet";
import { loadConfig } from "../src/config";
import { runStatementSync, saveStatements, statusForStatementError } from "../src/statements";
import { ATTENTION_DAYS, statementStatus } from "../src/routes/bills";
import type { Env } from "../src/env";
import { call, getJson } from "./helpers";
import { FakePlaid, plaidError } from "./fake-plaid";

// Bills, part 1 (docs/bills.md): card statements from Plaid Liabilities, turned on per bank, fetched
// by the quiet catch-up cron, and shown with a paid / unpaid estimate.

const E = env as unknown as Env;
let plaid: FakePlaid;
const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

async function wipe() {
  await env.DB.batch(["card_statements", "statement_sync", "transaction_tags", "transactions", "accounts", "items", "link_sessions"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

/** One bank (good, synced just now) with a credit card and a checking account. */
async function bank(opts: { status?: string; downloading?: boolean } = {}) {
  const enc = await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!);
  const item = (await env.DB.prepare(
    `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, txn_cursor, sync_start_cursor, status, updated_at)
     VALUES ('me', 'me_primary', 'item-1', ?, 'Chase', 'c1', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING id`)
    .bind(enc, opts.downloading ? "c0" : null, opts.status ?? "good").first<{ id: number }>())!.id;
  const card = (await env.DB.prepare(
    `INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype, balance_current_cents, currency)
     VALUES ('me', ?, 'acc-card', 'Sapphire', '1234', 'credit', 'credit card', 81234, 'USD') RETURNING id`).bind(item).first<{ id: number }>())!.id;
  await env.DB.prepare(
    `INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype, balance_current_cents, currency)
     VALUES ('me', ?, 'acc-chk', 'Checking', '9876', 'depository', 'checking', 500000, 'USD')`).bind(item).run();
  return { item, card };
}

const liabilities = (credit: Record<string, unknown>[]) => JSON.stringify({ accounts: [], liabilities: { credit, mortgage: null, student: null }, request_id: "r" });
const credit = (extra: Record<string, unknown> = {}) => ({
  account_id: "acc-card", last_statement_issue_date: day(-20), last_statement_balance: 412.5, minimum_payment_amount: 35,
  next_payment_due_date: day(5), last_payment_amount: 300, last_payment_date: day(-40), is_overdue: false, ...extra,
});

async function payment(account: number, date: string, dollars: number, name = "AUTOPAY PAYMENT - THANK YOU", category = "LOAN_PAYMENTS", pending = 0) {
  await env.DB.prepare(
    `INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, name, category, pending)
     VALUES ('me', ?, ?, ?, 'USD', ?, ?, ?, ?)`).bind(account, `t-${crypto.randomUUID()}`, Math.round(-dollars * 100), date, name, category, pending).run();
}

beforeEach(async () => { await wipe(); plaid = new FakePlaid().install(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("saving statements", () => {
  it("stores each card's latest statement, matched to Minty's own account on that bank", async () => {
    const { item, card } = await bank();
    await env.DB.prepare("INSERT INTO statement_sync (item_id, next_attempt_at) VALUES (?, '2000-01-01')").bind(item).run();
    await saveStatements(E, item, liabilities([credit(), credit({ account_id: "elsewhere" })]));
    const rows = (await env.DB.prepare("SELECT * FROM card_statements").all()).results;
    expect(rows).toEqual([expect.objectContaining({
      account_id: card, issue_date: day(-20), balance_cents: 41250, minimum_payment_cents: 3500, due_date: day(5),
      last_payment_cents: 30000, last_payment_date: day(-40), is_overdue: 0,
    })]);
    const s = await env.DB.prepare("SELECT status, last_error, next_attempt_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+23 hours') AS later FROM statement_sync").first();
    expect(s).toEqual({ status: "ready", last_error: null, later: 1 });
  });

  it("updates the same statement on a later fetch, and a missing field never erases a known one", async () => {
    const { item, card } = await bank();
    await saveStatements(E, item, liabilities([credit()]));
    await saveStatements(E, item, liabilities([credit({ last_statement_balance: 420, minimum_payment_amount: null, is_overdue: null })]));
    const row = await env.DB.prepare("SELECT balance_cents, minimum_payment_cents, is_overdue FROM card_statements WHERE account_id = ?").bind(card).first();
    expect(row).toEqual({ balance_cents: 42000, minimum_payment_cents: 3500, is_overdue: 0 });
    await saveStatements(E, item, liabilities([credit({ last_statement_issue_date: day(-1) })]));
    expect((await env.DB.prepare("SELECT count(*) AS n FROM card_statements").first<{ n: number }>())!.n).toBe(2);   // a new statement: history grows
  });

  it("skips a card with neither a statement date nor a due date, and a bank with no credit liabilities saves nothing", async () => {
    const { item } = await bank();
    await saveStatements(E, item, liabilities([credit({ last_statement_issue_date: null, next_payment_due_date: null })]));
    await saveStatements(E, item, JSON.stringify({ accounts: [], liabilities: { credit: null } }));
    expect((await env.DB.prepare("SELECT count(*) AS n FROM card_statements").first<{ n: number }>())!.n).toBe(0);
  });

  it("keeps a card the bank sends a due date for but no statement date, estimated, until a real date comes", async () => {
    const { item, card } = await bank();
    await saveStatements(E, item, liabilities([credit({ last_statement_issue_date: null })]));
    expect(await env.DB.prepare("SELECT issue_date, issue_estimated, due_date, balance_cents FROM card_statements").all().then((r) => r.results))
      .toEqual([{ issue_date: day(-20), issue_estimated: 1, due_date: day(5), balance_cents: 41250 }]);   // 25 days before the due date
    const { body } = await getJson<any>("/bills");
    expect(body.cards.find((c: any) => c.account_id === card).latest).toMatchObject({ issue_estimated: true, due_date: day(5) });
    await saveStatements(E, item, liabilities([credit({ last_statement_issue_date: day(-22) })]));
    expect(await env.DB.prepare("SELECT issue_date, issue_estimated FROM card_statements").all().then((r) => r.results))
      .toEqual([{ issue_date: day(-22), issue_estimated: 0 }]);                                          // the estimate gives way
  });

  it("maps Plaid errors: consent and unsupported wait for the household, the rest retry", () => {
    expect(statusForStatementError("ADDITIONAL_CONSENT_REQUIRED")).toBe("consent_required");
    expect(statusForStatementError("ITEM_LOGIN_REQUIRED")).toBe("consent_required");
    expect(statusForStatementError("PRODUCTS_NOT_SUPPORTED")).toBe("unsupported");
    expect(statusForStatementError("NO_LIABILITY_ACCOUNTS")).toBe("unsupported");
    expect(statusForStatementError("INTERNAL_SERVER_ERROR")).toBe("error");
  });
});

describe("the cron", () => {
  it("fetches one due bank, never touches its sync status, and records a failure on statement_sync only", async () => {
    const { item } = await bank();
    await env.DB.prepare("INSERT INTO statement_sync (item_id, next_attempt_at) VALUES (?, '2000-01-01')").bind(item).run();
    plaid.replies["/liabilities/get"] = { body: JSON.parse(liabilities([credit()])) };
    expect(await runStatementSync(E, loadConfig(E))).toEqual({ [item]: "ready" });
    expect(plaid.paths()).toEqual(["/liabilities/get"]);
    expect(plaid.calls[0].body.access_token).toBe("access-sandbox-secret");
    expect(await runStatementSync(E, loadConfig(E))).toEqual({});           // not due again for a day

    await env.DB.prepare("UPDATE statement_sync SET next_attempt_at = '2000-01-01'").run();
    plaid.replies["/liabilities/get"] = plaidError("ADDITIONAL_CONSENT_REQUIRED");
    expect(await runStatementSync(E, loadConfig(E))).toEqual({ [item]: "consent_required" });
    expect(await env.DB.prepare("SELECT status, last_error, next_attempt_at FROM statement_sync").first())
      .toEqual({ status: "consent_required", last_error: "ADDITIONAL_CONSENT_REQUIRED", next_attempt_at: null });   // waits for the household
    expect(await env.DB.prepare("SELECT status, last_error FROM items").first()).toEqual({ status: "good", last_error: null });
  });

  it("skips banks that need a reconnect, and banks with statement details off", async () => {
    const { item } = await bank({ status: "login_required" });
    await env.DB.prepare("INSERT INTO statement_sync (item_id, next_attempt_at) VALUES (?, '2000-01-01')").bind(item).run();
    expect(await runStatementSync(E, loadConfig(E))).toEqual({});
    expect(plaid.calls).toEqual([]);
  });

  it("runs only in a quiet catch-up run: not while a bank is downloading, and not in the hourly run", async () => {
    const { item } = await bank({ downloading: true });
    await env.DB.prepare("INSERT INTO statement_sync (item_id, next_attempt_at) VALUES (?, '2000-01-01')").bind(item).run();
    plaid.syncPages = [{ body: { accounts: [], added: [], modified: [], removed: [], next_cursor: "c2", has_more: false, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" } }];
    plaid.replies["/liabilities/get"] = { body: JSON.parse(liabilities([credit()])) };
    const run = async (cron: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), E, ctx);
      await waitOnExecutionContext(ctx);
    };
    await run("*/10 * * * *");                                              // the download continues; no statements
    expect(plaid.paths()).not.toContain("/liabilities/get");
    await run("*/10 * * * *");                                              // quiet now
    expect(plaid.paths().filter((p) => p === "/liabilities/get")).toHaveLength(1);
  });
});

describe("paid or not", () => {
  const base = { issue_date: day(-20), statement_cents: 41250, due_date: day(10), paid_cents: 0 };
  it("is paid once payments since the statement cover it, or the bank's last payment does", () => {
    expect(statementStatus({ ...base, paid_cents: 41250 }, day(0), true).status).toBe("paid");
    expect(statementStatus({ ...base, last_payment_cents: 41250, last_payment_date: day(-2) }, day(0), true).status).toBe("paid");
    expect(statementStatus({ ...base, last_payment_cents: 41250, last_payment_date: day(-30) }, day(0), true).status).toBe("unpaid");   // before the statement
  });
  it("partly paid, unpaid, nothing due", () => {
    expect(statementStatus({ ...base, paid_cents: 10000 }, day(0), true).status).toBe("partial");
    expect(statementStatus(base, day(0), true)).toEqual({ status: "unpaid", attention: false, days_left: 10 });
    expect(statementStatus({ ...base, statement_cents: 0 }, day(0), true).status).toBe("nothing_due");
  });
  it(`flags an unpaid statement ${ATTENTION_DAYS} days before it's due, and an overdue one`, () => {
    expect(statementStatus({ ...base, due_date: day(ATTENTION_DAYS) }, day(0), true).attention).toBe(true);
    expect(statementStatus({ ...base, due_date: day(ATTENTION_DAYS + 1) }, day(0), true).attention).toBe(false);
    expect(statementStatus({ ...base, due_date: day(-1) }, day(0), true)).toMatchObject({ status: "overdue", attention: true });
    expect(statementStatus({ ...base, is_overdue: 1 }, day(0), true).status).toBe("overdue");
  });
  it("can't tell when the bank's transactions aren't current, rather than saying unpaid", () => {
    expect(statementStatus(base, day(0), false).status).toBe("unknown");
    expect(statementStatus({ ...base, paid_cents: 41250 }, day(0), false).status).toBe("paid");      // a payment seen is still a payment
  });
});

describe("GET /bills", () => {
  it("lists every credit card with its balance, latest statement, payments since and status", async () => {
    const { item, card } = await bank();
    await env.DB.prepare("INSERT INTO statement_sync (item_id, status, synced_at) VALUES (?, 'ready', '2026-10-15T00:00:00Z')").bind(item).run();
    await saveStatements(E, item, liabilities([credit({ last_statement_issue_date: day(-50), next_payment_due_date: day(-25), last_statement_balance: 200 })]));
    await saveStatements(E, item, liabilities([credit()]));
    await payment(card, day(-40), 200);                                     // paid the older statement
    await payment(card, day(-10), 100);                                     // part of the latest
    await payment(card, day(-9), 50, "REFUND AMAZON", "GENERAL_MERCHANDISE"); // a refund isn't a payment
    await payment(card, day(-8), 60, "PAYMENT THANK YOU", "LOAN_PAYMENTS", 1);  // pending doesn't count
    const { status, body } = await getJson("/bills");
    expect(status).toBe(200);
    expect(body.attention_days).toBe(ATTENTION_DAYS);
    expect(body.cards).toHaveLength(1);                                     // the checking account isn't a card
    expect(body.cards[0]).toMatchObject({
      account_id: card, bank: "Chase", name: "Sapphire", mask: "1234", balance_cents: 81234,
      statements: { status: "ready" },
      latest: { issue_date: day(-20), statement_cents: 41250, minimum_payment_cents: 3500, due_date: day(5), paid_cents: 10000 },
      status: "partial", attention: true, days_left: 5,
    });
    expect(body.cards[0].history).toEqual([expect.objectContaining({ issue_date: day(-50), statement_cents: 20000, paid_cents: 20000, status: "paid" })]);
    expect(body.banks).toEqual([{ item_id: item, bank: "Chase", owner: "me", statements: "ready" }]);
  });

  it("shows cards from banks with statement details off, with just their balance", async () => {
    await bank();
    const { body } = await getJson("/bills");
    expect(body.cards[0]).toMatchObject({ statements: { status: "off" }, latest: null, status: "no_statement", attention: false });
  });
});

describe("turning statement details on and off", () => {
  async function session(itemId: number, purpose = "statements", email = "me@example.com") {
    const id = `s-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO link_sessions (id, email, operation, owner, plaid_account, item_id, expires_at, purpose)
       VALUES (?, ?, 'update', 'me', 'me_primary', ?, ?, ?)`).bind(id, email, itemId, new Date(Date.now() + 30 * 60_000).toISOString(), purpose).run();
    return id;
  }
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

  it("opens update-mode Link asking for Liabilities consent, on the bank's own credential set", async () => {
    const { item } = await bank();
    const { status, body } = await getJson("/link/token/statements", { method: "POST", body: JSON.stringify({ item_id: item }) });
    expect(status).toBe(200);
    expect(body.session_id).toEqual(expect.any(String));
    expect(plaid.calls[0].body).toMatchObject({ access_token: "access-sandbox-secret", additional_consented_products: ["liabilities"] });
    expect(plaid.calls[0].body).not.toHaveProperty("products");
    expect(await env.DB.prepare("SELECT purpose FROM link_sessions").first()).toEqual({ purpose: "statements" });
  });

  it("turns them on only after Plaid confirms the consent, and only once", async () => {
    const { item } = await bank();
    const id = await session(item);
    plaid.replies["/item/get"] = { body: { item: { item_id: "item-1", consented_products: ["transactions"] } } };
    expect((await post("/link/statements/complete", { session_id: id })).status).toBe(409);   // not consented
    expect(await env.DB.prepare("SELECT count(*) AS n FROM statement_sync").first()).toEqual({ n: 0 });
    plaid.replies["/item/get"] = { body: { item: { item_id: "item-1", consented_products: ["transactions", "liabilities"] } } };
    const { status, body } = await getJson("/link/statements/complete", { method: "POST", body: JSON.stringify({ session_id: id }) });
    expect(status).toBe(200);
    expect(body).toEqual({ item_id: item, statements: "pending" });
    expect(await env.DB.prepare("SELECT status, next_attempt_at IS NOT NULL AS due FROM statement_sync").first()).toEqual({ status: "pending", due: 1 });
    expect((await post("/link/statements/complete", { session_id: id })).status).toBe(409);   // used
  });

  it("refuses a reconnect session, or another login's", async () => {
    const { item } = await bank();
    plaid.replies["/item/get"] = { body: { item: { consented_products: ["liabilities"] } } };
    expect((await post("/link/statements/complete", { session_id: await session(item, "reconnect") })).status).toBe(409);
    expect((await post("/link/statements/complete", { session_id: await session(item, "statements", "other@example.com") })).status).toBe(409);
    expect(plaid.calls).toEqual([]);
  });

  it("turns them off and keeps the statements already saved", async () => {
    const { item } = await bank();
    await env.DB.prepare("INSERT INTO statement_sync (item_id) VALUES (?)").bind(item).run();
    await saveStatements(E, item, liabilities([credit()]));
    const { body } = await getJson("/statements/off", { method: "POST", body: JSON.stringify({ item_id: item }) });
    expect(body).toEqual({ item_id: item, statements: "off", changed: true });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM statement_sync").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM card_statements").first()).toEqual({ n: 1 });
  });
});

describe("GET /statements", () => {
  it("lists the banks with credit cards and whether statement details are on", async () => {
    const { item } = await bank();
    expect((await getJson("/statements")).body).toEqual([{ item_id: item, bank: "Chase", owner: "me", statements: "off", synced_at: null, last_error: null }]);
    await env.DB.prepare("INSERT INTO statement_sync (item_id, status) VALUES (?, 'consent_required')").bind(item).run();
    expect((await getJson("/statements")).body[0].statements).toBe("consent_required");
  });
});

describe("Setup checks", () => {
  it("name the banks whose statement details need something, and nothing for healthy ones", async () => {
    const { item } = await bank();
    await env.DB.prepare("INSERT INTO statement_sync (item_id, status) VALUES (?, 'ready')").bind(item).run();
    expect((await getJson("/status")).body.checks.filter((c: any) => c.id.startsWith("statements_"))).toEqual([]);
    await env.DB.prepare("UPDATE statement_sync SET status = 'consent_required', last_error = 'ADDITIONAL_CONSENT_REQUIRED'").run();
    expect((await getJson("/status")).body.checks.find((c: any) => c.id === `statements_${item}`))
      .toMatchObject({ ok: false, level: "warn", message: expect.stringContaining("Chase needs your consent again") });
  });
});

describe("marking a card statement paid by hand", () => {
  const post = (body: unknown) => getJson<any>("/statements/paid", { method: "POST", body: JSON.stringify(body) });

  it("a marked statement is paid, whatever the transactions say, and says so; unmarking undoes it", () => {
    const s = { statement_cents: 41250, due_date: day(5), paid_cents: 0, issue_date: day(-20) };
    expect(statementStatus(s, day(0), true)).toMatchObject({ status: "unpaid" });
    expect(statementStatus({ ...s, marked_paid_at: "2026-10-19T10:00:00.000Z" }, day(0), true)).toMatchObject({ status: "paid", paid_how: "marked", attention: false });
    expect(statementStatus({ ...s, marked_paid_at: "2026-10-19T10:00:00.000Z" }, day(0), false)).toMatchObject({ status: "paid", paid_how: "marked" });   // even with the feed behind
    expect(statementStatus({ ...s, paid_cents: 41250 }, day(0), true)).toMatchObject({ status: "paid", paid_how: "payments" });
  });

  it("POST /statements/paid marks one statement; GET /bills shows it paid, marked; a refresh keeps the mark", async () => {
    const { item, card } = await bank();
    await saveStatements(E, item, liabilities([credit({ last_payment_amount: 0, last_payment_date: null })]));
    expect((await getJson<any>("/bills")).body.cards[0]).toMatchObject({ status: "unpaid", paid_how: null });
    const { status, body } = await post({ account_id: card, issue_date: day(-20), paid: true });
    expect(status).toBe(200);
    expect(body.marked_paid_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await getJson<any>("/bills")).body.cards[0]).toMatchObject({ status: "paid", paid_how: "marked", attention: false });
    await saveStatements(E, item, liabilities([credit({ last_payment_amount: 0, last_payment_date: null, last_statement_balance: 412.5 })]));   // the daily refresh
    expect((await getJson<any>("/bills")).body.cards[0]).toMatchObject({ status: "paid", paid_how: "marked" });
    await post({ account_id: card, issue_date: day(-20), paid: false });
    expect((await getJson<any>("/bills")).body.cards[0]).toMatchObject({ status: "unpaid", paid_how: null });
  });

  it("past statements can be marked too", async () => {
    const { item, card } = await bank();
    await saveStatements(E, item, liabilities([credit({ last_statement_issue_date: day(-50), next_payment_due_date: day(-25), last_payment_amount: 0, last_payment_date: null })]));
    await saveStatements(E, item, liabilities([credit()]));
    await post({ account_id: card, issue_date: day(-50), paid: true });
    const past = (await getJson<any>("/bills")).body.cards[0].history[0];
    expect(past).toMatchObject({ issue_date: day(-50), status: "paid", paid_how: "marked" });
  });

  it.each([[{ account_id: "x", issue_date: "2026-01-01", paid: true }], [{ account_id: 1, issue_date: "Jan 1", paid: true }], [{ account_id: 1, issue_date: "2026-01-01", paid: "yes" }]])(
    "refuses %j", async (b) => {
      expect((await post(b)).status).toBe(422);
    });

  it("a statement that doesn't exist is a 404", async () => {
    expect((await post({ account_id: 999999, issue_date: "2026-01-01", paid: true })).status).toBe(404);
  });
});
