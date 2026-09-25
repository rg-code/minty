import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { EXPECTED_MIGRATIONS } from "../src/routes/status";
import { call, getJson } from "./helpers";

const byId = (checks: any[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

beforeEach(async () => {
  await env.DB.batch(["transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("GET /status", () => {
  it("lists every migration file", () => {
    expect(EXPECTED_MIGRATIONS).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
  });

  it("is behind Access like every API route", async () => {
    expect((await call("/status", { token: null })).status).toBe(403);
  });

  it("reports a healthy setup without revealing any values", async () => {
    const r = await call("/status");
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body.backend).toBe("workers");
    const c = byId(body.checks);
    expect(c.access).toMatchObject({ ok: true, message: expect.stringContaining("me@example.com") });
    expect(c.token_key.ok).toBe(true);
    expect(c.migrations.ok).toBe(true);
    expect(c.plaid_keys_me).toMatchObject({ ok: true, message: "Me: Plaid keys set (primary + backup)." });
    expect(c.plaid_keys_spouse).toMatchObject({ ok: true, message: "Spouse: Plaid keys set (primary)." });
    expect(c.plaid_env).toMatchObject({ ok: false, level: "warn" });            // tests run on sandbox
    expect(text).not.toMatch(/secret_|cid_|uJ2Cr7/);                             // never values
  });

  it("explains a missing or invalid TOKEN_ENC_KEY with how to make one", async () => {
    for (const TOKEN_ENC_KEY of ["", "not-a-key"]) {
      const c = byId((await getJson("/status", { envOverrides: { TOKEN_ENC_KEY } })).body.checks);
      expect(c.token_key).toMatchObject({ ok: false, level: "error", fix: expect.stringContaining("openssl rand -base64 32") });
    }
  });

  it("flags people without Plaid keys, naming the secrets", async () => {
    const c = byId((await getJson("/status", { envOverrides: { MINTY_USERS: "me:Me,alex:Alex" } })).body.checks);
    expect(c.plaid_keys_alex).toMatchObject({ ok: false, fix: expect.stringContaining("PLAID_CLIENT_ID_ALEX_PRIMARY") });
  });

  it("reports production Plaid and rejects a bad PLAID_ENV", async () => {
    expect(byId((await getJson("/status", { envOverrides: { PLAID_ENV: "production" } })).body.checks).plaid_env.ok).toBe(true);
    const bad = byId((await getJson("/status", { envOverrides: { PLAID_ENV: "development" } })).body.checks).plaid_env;
    expect(bad).toMatchObject({ ok: false, level: "error" });
  });

  it("counts banks needing attention and warns when sync is stale", async () => {
    await env.DB.prepare(
      `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, txn_cursor, status, updated_at) VALUES
       ('me', 'me_primary', 'a', 'x', 'c', 'good', '2026-01-01T00:00:00.000Z'),
       ('me', 'me_primary', 'b', 'x', 'c', 'login_required', '2026-01-01T00:00:00.000Z'),
       ('me', 'me_primary', 'c', 'x', 'c', 'error', '2026-01-01T00:00:00.000Z')`).run();
    const body = (await getJson("/status")).body;
    const c = byId(body.checks);
    expect(body.items).toEqual({ good: 1, login_required: 1, error: 1 });
    expect(c.items_login.message).toMatch(/1 bank\(s\) need you to sign in again/);
    expect(c.items_error.ok).toBe(false);
    expect(c.sync).toMatchObject({ ok: false, message: expect.stringMatching(/No successful sync for \d+ hours/) });
  });

  it("shows a recent sync as healthy", async () => {
    await env.DB.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, txn_cursor) VALUES ('me', 'me_primary', 'a', 'x', 'c')`).run();
    expect(byId((await getJson("/status")).body.checks).sync).toMatchObject({ ok: true, message: "Last sync within the hour." });
  });

  it("flags the local dev Access bypass", async () => {
    const c = byId((await getJson("/status", { token: null, host: "http://localhost:8787",
      envOverrides: { MINTY_DEV_NO_AUTH: "1", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } })).body.checks);
    expect(c.access).toMatchObject({ ok: false, level: "warn" });
  });
});
