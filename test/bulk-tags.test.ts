import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, getJson } from "./helpers";

// Tagging many transactions at once (the dashboard's Select): POST /transactions/tags.
const db = env.DB;
const bulk = (body: unknown) => getJson<any>("/transactions/tags", { method: "POST", body: JSON.stringify(body) });
let ids: number[];
const tags = async (id: number) => (await db.prepare("SELECT tag FROM transaction_tags WHERE transaction_id = ? ORDER BY position").bind(id).all<{ tag: string }>()).results.map((r) => r.tag);

beforeEach(async () => {
  await db.batch(["transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  const item = (await db.prepare("INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES ('me', 'me_primary', 'i', 'x') RETURNING id").first<{ id: number }>())!.id;
  const acct = (await db.prepare("INSERT INTO accounts (owner, item_id, plaid_account_id, name, type) VALUES ('me', ?, 'a', 'Card', 'credit') RETURNING id").bind(item).first<{ id: number }>())!.id;
  ids = [];
  for (let i = 0; i < 4; i++) {
    ids.push((await db.prepare("INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name) VALUES ('me', ?, ?, 100, '2026-10-01', 'AMEX') RETURNING id")
      .bind(acct, `t${i}`).first<{ id: number }>())!.id);
  }
  await db.prepare("INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, 'travel', 0)").bind(ids[0]).run();
});

describe("POST /transactions/tags", () => {
  it("is behind Access like every API route", async () => {
    expect((await call("/transactions/tags", { token: null, method: "POST", body: "{}" })).status).toBe(403);
  });

  it("adds a tag to every transaction given, after their own tags, once each (case-insensitive)", async () => {
    const { status, body } = await bulk({ ids, add: ["Reimbursable"] });
    expect(status).toBe(200);
    expect(body.changed).toBe(4);
    expect(await tags(ids[0])).toEqual(["travel", "Reimbursable"]);
    expect(await tags(ids[3])).toEqual(["Reimbursable"]);
    expect((await bulk({ ids, add: ["reimbursable"] })).body.changed).toBe(0);   // already there
    expect(body.transactions.find((t: any) => t.id === ids[0]).tags).toEqual(["travel", "Reimbursable"]);
    expect((await getJson<string[]>("/tags")).body).toEqual(expect.arrayContaining(["Reimbursable", "travel"]));
  });

  it("removes a tag from every transaction given, and only those", async () => {
    await bulk({ ids, add: ["work"] });
    expect((await bulk({ ids: ids.slice(0, 2), remove: ["WORK"] })).body.changed).toBe(2);
    expect(await tags(ids[0])).toEqual(["travel"]);
    expect(await tags(ids[2])).toEqual(["work"]);
  });

  it("skips ids that don't exist, and a transaction already at the 50-tag limit", async () => {
    const ins = db.prepare("INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, ?, ?)");
    await db.batch(Array.from({ length: 49 }, (_, i) => ins.bind(ids[0], `t${i}`, i + 1)));   // 50 with "travel"
    const { body } = await bulk({ ids: [...ids, 999999], add: ["new"] });
    expect(body.changed).toBe(3);
    expect(await tags(ids[0])).not.toContain("new");
    expect(body.transactions.map((t: any) => t.id).sort()).toEqual([...ids].sort());
  });

  it.each([
    [{ add: ["x"] }], [{ ids: [], add: ["x"] }], [{ ids: [1.5], add: ["x"] }], [{ ids: Array(1001).fill(1), add: ["x"] }],
    [{ ids: [1] }], [{ ids: [1], add: "x" }], [{ ids: [1], add: ["y".repeat(65)] }],
  ])("refuses %j", async (b) => {
    expect((await bulk(b)).status).toBe(422);
  });
});
