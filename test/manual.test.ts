/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { getJson } from "./helpers";
import { loadConfig } from "../src/config";
import { fernetEncrypt } from "../src/fernet";
import { syncItem, type ItemRow } from "../src/sync";
import { refreshTotals, snapshotBalances } from "../src/audit/totals";
import { MANUAL_KINDS } from "../src/routes/manual";
import type { Env } from "../src/env";
import { FakePlaid, account, page } from "./fake-plaid";

// Manual accounts, holders and a beneficiary (docs/accounts.md), against a real local D1.
const E = env as unknown as Env;
const db = env.DB;
const send = (method: string, path: string, body?: unknown) =>
  getJson<any>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const rows = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<any>()).results;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const midday = new Date(`${today()}T12:00:00Z`);    // not the first hour after midnight (THIN)

async function wipe() {
  await db.batch(["transaction_tags", "transactions", "balance_snapshots", "net_worth", "analytics_exclusions", "accounts", "items"]
    .map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.prepare("DELETE FROM app_state WHERE key = 'networth_dirty'").run();
}
const add = async (b: Record<string, unknown>) => {
  const r = await send("POST", "/accounts/manual", { owner: "me", name: "House", type: "other", subtype: "home", balance_cents: 50000000, ...b });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as number;
};
const dirty = async () => (await rows("SELECT value FROM app_state WHERE key = 'networth_dirty'"))[0]?.value ?? null;

beforeEach(wipe);
afterEach(() => { vi.restoreAllMocks(); });

describe("the guard: Plaid's bank queries skip the manual bank rows", () => {
  // Every SQL string over items, in src/. A query either says PLAID_ITEM(...) (or a manual-only
  // condition), or is listed here as meaning every bank row, manual ones included, on purpose.
  const MEANS_EVERY_ROW = [
    "LEFT JOIN items i ON i.id = accounts.item_id",                   // /accounts: a manual account's bank name
    "JOIN items i ON i.id = a.item_id\n                    WHERE (a.type = 'investment'",   // EGG: manual retirement accounts belong there
    "FROM investment_sync s JOIN items i ON i.id = s.item_id`",        // EGG's sync list: a manual bank has no investment_sync row
    "LEFT JOIN items i ON x.kind = 'bank'",                          // what's left out, by name
    "LEFT JOIN items ai ON ai.id = a.item_id",
    `"SELECT id, owner, institution_name AS name FROM items"`,          // CFA: a person's manual accounts can be left out as a bank
    "FROM accounts a JOIN items i ON i.id = a.item_id`),",            // CFA: each account can be left out
    "JOIN accounts a ON a.id = t.account_id JOIN items i ON i.id = a.item_id", // transactions (manual accounts have none)
    "JOIN accounts a ON a.id = t.account_id\n    JOIN items i ON i.id = a.item_id",
    "FROM statement_sync ss JOIN items i ON i.id = ss.item_id",         // a manual bank has no statement_sync row
    "FROM accounts a JOIN items i ON i.id = a.item_id WHERE a.type = 'credit'`;", // BAM: any card can earn points
    "item_id = (SELECT id FROM items WHERE plaid_item_id = ?)",       // by Plaid's own id, just linked
    "SELECT id, 'pending', ${NOW} FROM items WHERE plaid_item_id = ?",
    "FROM items WHERE plaid_item_id = 'manual:'",                    // the manual routes themselves
    "(SELECT id FROM items WHERE plaid_item_id = 'manual:'",
    "DELETE FROM items WHERE id = ? AND products = 'manual'",
  ];
  const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  it("finds the sources", () => { expect(Object.keys(sources).length).toBeGreaterThan(20); });

  it("every query over items says PLAID_ITEM, or is listed as meaning every row", () => {
    const unguarded: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/(?:FROM|JOIN)\s+items\b/g)) {
        const at = m.index!;
        // the SQL string around it: back to its opening quote, on to its closing one
        const start = Math.max(src.lastIndexOf("`", at), src.lastIndexOf('"', at));
        const quote = src[start];
        const end = src.indexOf(quote, at);
        const sql = src.slice(start, end + 1);
        if (/PLAID_ITEM\(|products = 'manual'|products <> 'manual'/.test(sql)) continue;
        if (MEANS_EVERY_ROW.some((s) => src.slice(Math.max(0, at - 300), at + 300).includes(s))) continue;
        unguarded.push(`${file}: ${sql.slice(0, 120).replace(/\s+/g, " ")}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it("a manual bank row isn't a bank: not in /items, the Trial capacity or Setup's counts", async () => {
    await add({});
    expect((await rows("SELECT products, status, plaid_account, access_token_enc FROM items"))).toEqual(
      [{ products: "manual", status: "manual", plaid_account: "", access_token_enc: "" }]);
    expect((await send("GET", "/items")).body).toEqual([]);
    const cap = (await send("GET", "/capacity")).body;
    expect(JSON.stringify(cap)).not.toContain('""');
    const st = (await send("GET", "/status")).body;
    expect(JSON.stringify(st)).not.toContain("manual:");
    // reconnecting it would call Plaid with no token
    const id = (await rows("SELECT id FROM items"))[0].id;
    expect((await send("POST", "/link/reconnected", { item_id: id })).status).toBe(404);
  });
});

describe("manual accounts", () => {
  it("one manual bank row per person; /accounts leaves them out unless ?manual=1", async () => {
    const house = await add({ institution: "County records", notes: "Zillow estimate" });
    await add({ name: "Car", subtype: "vehicle", balance_cents: 1500000 });
    await add({ owner: "spouse", name: "Pension", type: "investment", subtype: "pension", balance_cents: 9000000 });
    expect((await rows("SELECT owner FROM items ORDER BY owner")).map((r) => r.owner)).toEqual(["me", "spouse"]);
    expect((await send("GET", "/accounts")).body).toEqual([]);
    const all = (await send("GET", "/accounts?view=all&manual=1&members=0")).body;
    expect(all.map((a: any) => [a.name, a.is_manual, a.in_retirement, a.in_net_worth])).toEqual(
      [["Car", 1, 0, 0], ["House", 1, 0, 1], ["Pension", 1, 1, 1]]);
    const h = all.find((a: any) => a.id === house);
    expect(h).toMatchObject({ bank: "County records", notes: "Zillow estimate", balance_current: 500000, balance_as_of: today(), holders: [], beneficiary: null });
    expect(h.card_members).toBeUndefined();
  });

  it("validates: the kinds, a 4-digit mask, a currency, a date that isn't in the future", async () => {
    const bad = async (b: Record<string, unknown>) => (await send("POST", "/accounts/manual", { owner: "me", name: "X", type: "other", subtype: "home", balance_cents: 1, ...b })).status;
    expect(await bad({ subtype: "boat" })).toBe(422);
    expect(await bad({ type: "depository", subtype: "home" })).toBe(422);
    expect(await bad({ mask: "12" })).toBe(422);
    expect(await bad({ currency: "dollars" })).toBe(422);
    expect(await bad({ balance_cents: 1.5 })).toBe(422);
    expect(await bad({ balance_as_of: "2999-01-01" })).toBe(422);
    expect(await bad({ owner: "nobody" })).toBe(422);
    expect(await bad({ name: "" })).toBe(422);
    expect(await bad({ currency: "eur" })).toBe(201);
  });

  it("an update moves the as-of date forward only; linked accounts can't be changed here", async () => {
    const id = await add({ balance_as_of: daysAgo(10) });
    expect((await send("PUT", `/accounts/${id}/manual`, { balance_cents: 51000000, balance_as_of: daysAgo(20) })).status).toBe(422);
    expect((await send("PUT", `/accounts/${id}/manual`, { notes: "re-checked" })).status).toBe(200);
    expect((await send("PUT", `/accounts/${id}/manual`, { balance_cents: 51000000, balance_as_of: daysAgo(2) })).status).toBe(200);
    expect((await rows("SELECT balance_current_cents, balance_as_of, notes FROM accounts WHERE id = ?", id))[0])
      .toEqual({ balance_current_cents: 51000000, balance_as_of: daysAgo(2), notes: "re-checked" });
    const item = (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES ('me', 'me_primary', 'i-real', 'x') RETURNING id`).first<{ id: number }>())!.id;
    const linked = (await db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype) VALUES ('me', ?, 'p-1', 'Checking', 'depository', 'checking') RETURNING id`).bind(item).first<{ id: number }>())!.id;
    expect((await send("PUT", `/accounts/${linked}/manual`, { notes: "x" })).status).toBe(404);
    expect((await send("DELETE", `/accounts/${linked}/manual`)).status).toBe(404);
  });

  it("moving to another person moves it to their manual bank row, and drops the empty one", async () => {
    const id = await add({});
    await send("PUT", `/accounts/${id}/manual`, { owner: "spouse" });
    expect(await rows("SELECT owner FROM items")).toEqual([{ owner: "spouse" }]);
    expect((await rows("SELECT a.owner, i.owner AS bank_owner FROM accounts a JOIN items i ON i.id = a.item_id"))[0]).toEqual({ owner: "spouse", bank_owner: "spouse" });
    expect(await dirty()).toBe("1");
  });

  it("removing one deletes its snapshots and its left-out entry, and rebuilds net worth", async () => {
    const id = await add({});
    await snapshotBalances(E, midday);
    await db.prepare("INSERT INTO analytics_exclusions (kind, value) VALUES ('account', ?)").bind(String(id)).run();
    await db.prepare("DELETE FROM app_state WHERE key = 'networth_dirty'").run();
    expect((await send("DELETE", `/accounts/${id}/manual`)).body).toEqual({ id, removed: true });
    expect(await rows("SELECT * FROM balance_snapshots")).toEqual([]);
    expect(await rows("SELECT * FROM analytics_exclusions")).toEqual([]);
    expect(await rows("SELECT * FROM items")).toEqual([]);
    expect(await dirty()).toBe("1");
  });
});

describe("net worth: only a home among other assets, US dollars only, and without the home", () => {
  it("today's row", async () => {
    await add({});                                                                      // home 500,000
    await add({ name: "Car", subtype: "vehicle", balance_cents: 1500000 });             // not counted
    await add({ name: "Mortgage", type: "loan", subtype: "mortgage", balance_cents: 30000000 });
    await add({ name: "Car loan", type: "loan", subtype: "auto", balance_cents: 1000000 });   // still a debt
    await add({ name: "Savings", type: "depository", subtype: "savings", balance_cents: 2000000 });
    await add({ name: "Euro savings", type: "depository", subtype: "savings", balance_cents: 999900, currency: "EUR" });  // not added
    await snapshotBalances(E, midday);
    expect(await rows("SELECT owner, assets_cents, debts_cents, home_cents, home_debt_cents FROM net_worth")).toEqual(
      [{ owner: "me", assets_cents: 52000000, debts_cents: 31000000, home_cents: 50000000, home_debt_cents: 30000000 }]);
  });

  it("a manual snapshot is dated by its as-of day, and a back-dated one rebuilds the history", async () => {
    const id = await add({ balance_as_of: daysAgo(30) });
    await snapshotBalances(E, midday);
    expect(await rows("SELECT date, current_cents FROM balance_snapshots")).toEqual([{ date: daysAgo(30), current_cents: 50000000 }]);
    expect(await dirty()).toBe("1");
    await refreshTotals(E);
    expect(await dirty()).toBe(null);
    expect((await rows("SELECT date, assets_cents, home_cents FROM net_worth ORDER BY date"))[0])
      .toEqual({ date: daysAgo(30), assets_cents: 50000000, home_cents: 50000000 });
    // a balance as of today is the ordinary case: no rebuild
    await send("PUT", `/accounts/${id}/manual`, { balance_cents: 52000000, balance_as_of: today() });
    await snapshotBalances(E, midday);
    expect(await dirty()).toBe(null);
    expect(await rows("SELECT date, current_cents FROM balance_snapshots ORDER BY date")).toEqual(
      [{ date: daysAgo(30), current_cents: 50000000 }, { date: today(), current_cents: 52000000 }]);
  });

  it("/audit returns the home figures with net worth", async () => {
    await add({});
    await add({ name: "Mortgage", type: "loan", subtype: "mortgage", balance_cents: 30000000 });
    await snapshotBalances(E, midday);
    const nw = (await send("GET", "/audit")).body.net_worth;
    expect(nw.at(-1)).toMatchObject({ assets: 50000000, debts: 30000000, home: 50000000, home_debt: 30000000 });
  });
});

describe("holders and a beneficiary", () => {
  it("on any account; keys must be people, a beneficiary may be a name", async () => {
    const id = await add({ holders: ["me", "spouse"], beneficiary: { name: "Ava" } });
    expect((await rows("SELECT holders, beneficiary FROM accounts"))[0]).toEqual({ holders: '["me","spouse"]', beneficiary: '{"name":"Ava"}' });
    expect((await send("PUT", `/accounts/${id}/holders`, { holders: ["nobody"] })).status).toBe(422);
    expect((await send("PUT", `/accounts/${id}/holders`, { beneficiary: { key: "nobody" } })).status).toBe(422);
    expect((await send("PUT", `/accounts/${id}/holders`, { holders: ["me", "me", "spouse"], beneficiary: { key: "spouse" } })).body)
      .toEqual({ id, holders: ["me", "spouse"], beneficiary: { key: "spouse" } });
    expect((await send("PUT", `/accounts/${id}/holders`, { beneficiary: null })).body.beneficiary).toBe(null);
  });

  it("sync never writes them on a linked account", async () => {
    const plaid = new FakePlaid().install();
    const config = loadConfig(E);
    const item = (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES ('me', 'me_primary', 'i-sync', ?) RETURNING *`)
      .bind(await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!)).first<ItemRow>())!;
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")], added: [] }));
    await syncItem(E, config, item, { pages: 1 });
    const [{ id }] = await rows("SELECT id FROM accounts");
    await send("PUT", `/accounts/${id}/holders`, { holders: ["me", "spouse"], beneficiary: { name: "Ava" } });
    plaid.syncPages.push(page("c2", false, { accounts: [account("a1", { name: "Renamed by the bank" })], added: [] }));
    await syncItem(E, config, (await db.prepare("SELECT * FROM items WHERE id = ?").bind(item.id).first<ItemRow>())!, { pages: 1 });
    expect((await rows("SELECT name, holders, beneficiary FROM accounts"))[0]).toEqual(
      { name: "Renamed by the bank", holders: '["me","spouse"]', beneficiary: '{"name":"Ava"}' });
  });
});

describe("the Accounts popup", () => {
  it("is in the ⋯ menu, loads its script and styles, and is in the service worker's shell", async () => {
    const { call } = await import("./helpers");
    const html = await (await call("/")).text();
    expect(html).toContain('data-open-accounts');
    expect(html).toContain('<dialog id="accounts" class="abc accounts"');
    expect(html).toContain('<script src="/accounts.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="/accounts.css" />');
    const sw = await (await call("/sw.js")).text();
    for (const f of ['"/accounts.js"', '"/accounts.css"']) expect(sw).toContain(f);
    const cfa = await (await call("/cfa.js")).text();
    expect(cfa).toContain('localStorage.getItem("minty.accounts.nohome")');            // Without home, shared with Accounts
  });
});

describe("the kinds", () => {
  it("public/accounts.js offers exactly the server's kinds", async () => {
    const page = await (await (await import("./helpers")).call("/accounts.js")).text();
    for (const [type, subs] of Object.entries(MANUAL_KINDS)) for (const s of subs) expect(page, `${type}/${s}`).toContain(`["${type}", "${s}"`);
  });
});
