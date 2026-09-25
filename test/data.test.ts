import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { normaliseTags } from "../src/routes/data";
import { call, getJson, loadFixture } from "./helpers";

// Port of tests/test_data.py, run against a real (local) D1 instead of SQL-string fakes.
beforeEach(loadFixture);

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

describe("GET /transactions", () => {
  it("returns every row newest first, in the Python API's shape", async () => {
    const { status, body } = await getJson("/transactions");
    expect(status).toBe(200);
    expect(ids(body)).toEqual([100, 101, 102, 200, 201]);
    expect(body[0]).toEqual({
      id: 100, owner: "me", account_id: 10, plaid_txn_id: "txn-100", amount: 84.12, currency: "USD",
      date: "2026-09-20", datetime: null, name: "WHOLE FOODS", merchant_name: "Whole Foods Market",
      category: "FOOD_AND_DRINK", pending: false, pending_txn_id: null, tags: ["groceries"],
      account_name: "Sapphire", account_mask: "9912", account_type: "credit", account_subtype: "credit card",
    });
    expect(body.find((t: any) => t.id === 102).amount).toBe(-2450);      // cents -> dollars, sign kept
    expect(body.find((t: any) => t.id === 101).pending).toBe(true);
    expect(body.find((t: any) => t.id === 201).tags).toEqual(["travel", "reimbursable"]);  // user order
  });

  it("filters by owner, account, dates and search", async () => {
    expect(ids((await getJson("/transactions?owner=spouse")).body)).toEqual([200, 201]);
    expect(ids((await getJson("/transactions?account_id=11")).body)).toEqual([102]);
    expect(ids((await getJson("/transactions?start=2026-09-17&end=2026-09-19")).body)).toEqual([101, 102, 200]);
    expect(ids((await getJson("/transactions?q=whole")).body)).toEqual([100]);           // case-insensitive
    expect(ids((await getJson("/transactions?q=airlines")).body)).toEqual([201]);        // merchant_name too
  });

  it("treats user input as data, never SQL", async () => {
    const { status, body } = await getJson(`/transactions?q=${encodeURIComponent("50%'; DROP TABLE transactions; --")}`);
    expect(status).toBe(200);
    expect(body).toEqual([]);
    expect((await getJson("/transactions")).body).toHaveLength(5);
  });

  it("matches ANY of several tags by default", async () => {
    expect(ids((await getJson("/transactions?tag=groceries&tag=travel")).body)).toEqual([100, 201]);
    expect(ids((await getJson("/transactions?tag=TRAVEL")).body)).toEqual([201]);          // tags are case-insensitive
  });

  it("matches ALL tags with tag_mode=all", async () => {
    expect(ids((await getJson("/transactions?tag=travel&tag=reimbursable&tag_mode=all")).body)).toEqual([201]);
    expect(ids((await getJson("/transactions?tag=travel&tag=groceries&tag_mode=all")).body)).toEqual([]);
    expect(ids((await getJson("/transactions?tag=travel&tag=Travel&tag_mode=all")).body)).toEqual([201]);  // deduped
  });

  it("ignores blank tags", async () => {
    expect((await getJson("/transactions?tag=&tag=%20&tag_mode=all")).body).toHaveLength(5);
  });

  it.each([
    "tag_mode=some", "limit=1001", "limit=0", "limit=abc", "account_id=x", "start=2026-13-45", "start=yesterday",
    Array.from({ length: 21 }, (_, i) => `tag=t${i}`).join("&"),
  ])("rejects %s with 422", async (qs) => {
    expect((await call(`/transactions?${qs}`)).status).toBe(422);
  });

  it("honours limit", async () => {
    expect(ids((await getJson("/transactions?limit=2")).body)).toEqual([100, 101]);
  });
});

describe("items, accounts, capacity", () => {
  it("lists items without token material", async () => {
    const r = await call("/items");
    const text = await r.text();
    expect(JSON.parse(text)).toEqual([
      { id: 1, owner: "me", plaid_account: "me_primary", institution_name: "Chase", status: "good", updated_at: "2026-09-01T00:00:00.000Z" },
      { id: 2, owner: "spouse", plaid_account: "spouse_primary", institution_name: "Ally", status: "good", updated_at: "2026-09-01T00:00:00.000Z" },
    ]);
    expect(text).not.toMatch(/gAAAA|access_token/);
  });

  it("lists accounts with dollar balances, optionally per owner", async () => {
    const all = (await getJson("/accounts")).body;
    expect(all.map((a: any) => a.id)).toEqual([11, 10, 20]);                       // owner, then name
    expect(all.find((a: any) => a.id === 10)).toMatchObject({ balance_current: 1284.55, balance_available: null });
    expect((await getJson("/accounts?owner=spouse")).body.map((a: any) => a.id)).toEqual([20]);
  });

  it("reports every slot's usage against the cap", async () => {
    expect((await getJson("/capacity")).body).toEqual({
      me: [{ account: "me_primary", slot: "primary", used: 1, cap: 10 },
           { account: "me_backup", slot: "backup", used: 0, cap: 10 }],
      spouse: [{ account: "spouse_primary", slot: "primary", used: 1, cap: 10 },
               { account: "spouse_backup", slot: "backup", used: 0, cap: 10 }],
    });
  });
});

describe("tags", () => {
  it("normalises: trims, drops blanks, dedupes case-insensitively keeping the first", () => {
    expect(normaliseTags(["  Travel", "travel", "", "  ", "Food", "TRAVEL"])).toEqual(["Travel", "Food"]);
  });

  it("lists distinct tags", async () => {
    expect((await getJson("/tags")).body).toEqual(["car", "groceries", "reimbursable", "subscription", "travel"]);
  });

  const put = (id: number | string, body: unknown) =>
    call(`/transactions/${id}/tags`, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) });

  it("replaces a transaction's tags, normalised and in order", async () => {
    const r = await put(100, { tags: ["Food", "food", " ", "costco-run"] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 100, tags: ["Food", "costco-run"] });
    const row = (await getJson("/transactions?tag=costco-run")).body[0];
    expect(row.id).toBe(100);
    expect(row.tags).toEqual(["Food", "costco-run"]);
    expect((await getJson("/tags")).body).toContain("costco-run");
    expect((await getJson("/tags")).body).not.toContain("groceries");                  // replaced, not appended
  });

  it("clears tags with an empty list", async () => {
    expect(await (await put(201, { tags: [] })).json()).toEqual({ id: 201, tags: [] });
    expect((await getJson("/transactions?tag=travel")).body).toEqual([]);
  });

  it("404s for an unknown transaction", async () => {
    expect((await put(999, { tags: ["x"] })).status).toBe(404);
  });

  it.each([
    ["non-integer id", "abc", { tags: [] }],
    ["not JSON", 100, "{nope"],
    ["tags missing", 100, {}],
    ["tags not strings", 100, { tags: [1, 2] }],
    ["too many tags", 100, { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }],
    ["tag too long", 100, { tags: ["x".repeat(65)] }],
  ] as const)("rejects %s with 422", async (_, id, body) => {
    expect((await put(id, body)).status).toBe(422);
  });

  it("drops a transaction's tags when the transaction is deleted (e.g. Plaid 'removed')", async () => {
    await env.DB.prepare("DELETE FROM transactions WHERE id = 201").run();
    const { results } = await env.DB.prepare("SELECT count(*) AS n FROM transaction_tags WHERE transaction_id = 201").all<{ n: number }>();
    expect(results[0].n).toBe(0);
  });
});

describe("routing", () => {
  it("405s a wrong method on an API path", async () => {
    expect((await call("/transactions", { method: "DELETE" })).status).toBe(405);
  });
});
