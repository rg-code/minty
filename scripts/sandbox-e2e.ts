// End-to-end check of bank linking + sync against PLAID SANDBOX and a local `wrangler dev`.
// Run it yourself (it reads your local secrets):
//
//   1. .dev.vars (from .dev.vars.example) with Sandbox keys for PLAID_*_ME_PRIMARY and a TOKEN_ENC_KEY
//   2. npm run db:migrate:local
//   3. npm run dev                                  (in another terminal; local-only Access bypass + cron trigger)
//   4. node scripts/sandbox-e2e.ts
//
// What it does: creates a Sandbox Item (no Link UI needed), exchanges it through the Worker's
// /link/exchange, runs the cron sync until transactions land, then forces ITEM_LOGIN_REQUIRED and
// checks the item flips to login_required and /link/token/update works. Prints no secrets.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fernetDecrypt } from "../src/fernet.ts";

const W = process.env.MINTY_URL ?? "http://127.0.0.1:8787";
const PLAID = "https://sandbox.plaid.com";

function localVars(): Record<string, string> {
  const path = new URL("../.dev.vars", import.meta.url);
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const vars = { ...localVars(), ...process.env } as Record<string, string | undefined>;
const clientId = vars.PLAID_CLIENT_ID_ME_PRIMARY, secret = vars.PLAID_SECRET_ME_PRIMARY, key = vars.TOKEN_ENC_KEY;
if (!clientId || !secret || !key) {
  console.error("Need PLAID_CLIENT_ID_ME_PRIMARY, PLAID_SECRET_ME_PRIMARY (Sandbox) and TOKEN_ENC_KEY in .dev.vars or the environment.");
  process.exit(2);
}

let failures = 0;
const check = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function plaid(path: string, body: unknown) {
  const r = await fetch(PLAID + path, {
    method: "POST",
    headers: { "content-type": "application/json", "PLAID-CLIENT-ID": clientId!, "PLAID-SECRET": secret! },
    body: JSON.stringify(body),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Plaid ${path}: ${j.error_code}`);
  return j;
}
async function worker(path: string, init?: RequestInit) {
  const r = await fetch(W + path, { ...init, headers: { "content-type": "application/json" } });
  return { status: r.status, body: await r.json().catch(() => null) as any };
}
const cron = () => fetch(`${W}/cdn-cgi/handler/scheduled?cron=17+*+*+*+*`).then((r) => r.status);

// 0. Preconditions
check((await worker("/healthz")).status === 200, `Worker is up at ${W}`);
const me = (await worker("/users")).body?.find((u: any) => u.key === "me");
check(!!me?.slots?.find((s: any) => s.account === "me_primary")?.configured, "Worker sees Sandbox keys for me_primary");
check((await cron()) === 200, "cron trigger reachable (npm run dev)");
if (failures) process.exit(1);

// 1. Link: Sandbox public token -> Worker /link/exchange
const { public_token } = await plaid("/sandbox/public_token/create", {
  institution_id: "ins_109508", initial_products: ["transactions"], options: { transactions: { days_requested: 730 } },
});
const t0 = Date.now();
const ex = await worker("/link/exchange", { method: "POST", body: JSON.stringify({
  owner: "me", plaid_account: "me_primary", public_token, institution_name: "First Platypus Bank" }) });
check(ex.status === 200 && Number.isInteger(ex.body?.item_id), `exchange -> item ${ex.body?.item_id} (${Date.now() - t0} ms)`);
check(!JSON.stringify(ex.body).includes("access-sandbox"), "exchange response carries no access token");
const itemId = ex.body.item_id;

// 2. Backfill via cron (Plaid may answer PRODUCT_NOT_READY at first; that's a retry, not an error)
let txns = 0, runs = 0;
for (; runs < 24 && txns === 0; runs++) {
  await cron();
  await sleep(5000);
  const accts = (await worker("/accounts?owner=me")).body.filter((a: any) => a.item_id === itemId);
  for (const a of accts) txns += (await worker(`/transactions?account_id=${a.id}&limit=1000`)).body.length;
}
const item = (await worker("/items")).body.find((i: any) => i.id === itemId);
check(txns > 0, `backfill: ${txns} transactions after ${runs} cron run(s)`);
check(item?.status === "good", `item status after sync: ${item?.status}`);
check(item?.institution_name === "First Platypus Bank", "institution name stored");

// 3. Idempotent re-sync: another run adds nothing new
await cron(); await sleep(3000);
const accts = (await worker("/accounts?owner=me")).body.filter((a: any) => a.item_id === itemId);
let again = 0;
for (const a of accts) again += (await worker(`/transactions?account_id=${a.id}&limit=1000`)).body.length;
check(again === txns, `re-sync is idempotent (${again} transactions)`);

// 4. Force a re-login: item -> login_required, and update mode can start
const row = JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command",
  `SELECT access_token_enc FROM items WHERE id = ${Number(itemId)}`], { encoding: "utf8" }))[0].results[0];
await plaid("/sandbox/item/reset_login", { access_token: await fernetDecrypt(row.access_token_enc, key) });
await cron(); await sleep(4000);
check((await worker("/items")).body.find((i: any) => i.id === itemId)?.status === "login_required", "ITEM_LOGIN_REQUIRED -> status login_required");
const upd = await worker("/link/token/update", { method: "POST", body: JSON.stringify({ item_id: itemId }) });
check(upd.status === 200 && String(upd.body?.link_token).startsWith("link-sandbox-"), "update-mode link token created for Reconnect");

console.log(failures ? `\n${failures} check(s) failed` : "\nall Sandbox checks passed");
process.exit(failures ? 1 : 0);
