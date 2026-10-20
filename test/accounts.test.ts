import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { loadConfig } from "../src/config";
import { fernetEncrypt } from "../src/fernet";
import { syncItem, type ItemRow } from "../src/sync";
import type { Env } from "../src/env";
import { getJson } from "./helpers";
import { FakePlaid, account, page } from "./fake-plaid";

// Account names (src/accounts.ts): the household's own name for an account, shown everywhere and
// kept through syncs; otherwise Plaid's, tidied. Card recognition keeps using Plaid's name.
const E = env as unknown as Env;
const db = env.DB;
let plaid: FakePlaid;
const rename = (id: number, name: unknown) => getJson<any>(`/accounts/${id}/name`, { method: "PUT", body: JSON.stringify({ name }) });

async function card(name: string, mask = "6323", bank = "Wells Fargo") {
  const enc = await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!);
  const item = (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, txn_cursor, status)
    VALUES ('me', 'me_primary', ?, ?, ?, 'c1', 'good') RETURNING *`).bind(`item-${crypto.randomUUID()}`, enc, bank).first<ItemRow>())!;
  const id = (await db.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype, balance_current_cents)
    VALUES ('me', ?, ?, ?, ?, 'credit', 'credit card', 12000) RETURNING id`).bind(item.id, `acc-${crypto.randomUUID()}`, name, mask).first<{ id: number }>())!.id;
  return { item, id };
}
const shown = async (id: number) => (await getJson<any[]>("/accounts?view=all")).body.find((a) => a.id === id);

beforeEach(async () => {
  await db.batch(["card_products", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  plaid = new FakePlaid().install();
});
afterEach(() => vi.restoreAllMocks());

describe("Plaid's name, tidied", () => {
  it("drops garbled characters and a trailing '...6323' that's the account's own last 4", async () => {
    const { id } = await card("WELLS FARGO AUTOGRAPH VISA�� CARD ...6323");
    expect(await shown(id)).toMatchObject({ name: "WELLS FARGO AUTOGRAPH VISA CARD", plaid_name: "WELLS FARGO AUTOGRAPH VISA�� CARD ...6323", display_name: null });
    const other = await card("Sapphire ...1111", "2222");                  // not its own last 4: kept
    expect((await shown(other.id)).name).toBe("Sapphire ...1111");
  });
});

describe("renaming an account", () => {
  it("shows the new name everywhere: accounts, the feed, Bills", async () => {
    const { id } = await card("WELLS FARGO AUTOGRAPH VISA�� CARD ...6323");
    await db.prepare("INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name) VALUES ('me', ?, 't1', 500, '2026-10-01', 'Coffee')").bind(id).run();
    expect((await rename(id, "  Autograph   Visa ")).body).toMatchObject({ id, name: "Autograph Visa", renamed: true });
    expect((await shown(id)).name).toBe("Autograph Visa");
    expect((await getJson<any[]>("/transactions")).body[0].account_name).toBe("Autograph Visa");
    expect((await getJson<any>("/bills")).body.cards.find((c: any) => c.account_id === id).name).toBe("Autograph Visa");
  });

  it("a sync updates Plaid's name, never the household's", async () => {
    const { item, id } = await card("Old Plaid Name");
    await rename(id, "Our Visa");
    const plaidId = (await db.prepare("SELECT plaid_account_id FROM accounts WHERE id = ?").bind(id).first<{ plaid_account_id: string }>())!.plaid_account_id;
    plaid.syncPages.push(page("c2", false, { accounts: [account(plaidId, { name: "New Plaid Name", type: "credit", subtype: "credit card", mask: "6323" })] }));
    expect(await syncItem(E, loadConfig(E), item, { pages: 1 })).toBe("good");
    expect(await shown(id)).toMatchObject({ name: "Our Visa", plaid_name: "New Plaid Name" });
  });

  it("null or an empty name goes back to Plaid's", async () => {
    const { id } = await card("Platinum Card®", "1004", "American Express");
    await rename(id, "Plat");
    expect((await rename(id, null)).body).toMatchObject({ name: "Platinum Card®", renamed: false });
    await rename(id, "Plat");
    expect((await rename(id, "   ")).body.name).toBe("Platinum Card®");
  });

  it("ABC still recognises a renamed card by Plaid's name", async () => {
    const { id } = await card("Platinum Card®", "1004", "American Express");
    await rename(id, "Amex Plat");
    const c = (await getJson<any>("/benefits")).body.cards.find((x: any) => x.account_id === id);
    expect(c).toMatchObject({ name: "Amex Plat", product: { id: "amex_platinum" }, product_source: "name" });
  });

  it("refuses a name too long, not text, or an account that doesn't exist", async () => {
    const { id } = await card("Visa");
    expect((await rename(id, "x".repeat(61))).status).toBe(422);
    expect((await rename(id, 42)).status).toBe(422);
    expect((await rename(999999, "Visa")).status).toBe(404);
  });
});
