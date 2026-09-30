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
    expect(c.plaid_keys_me).toMatchObject({ ok: true, message: "Me: Plaid keys set for primary, backup (2 of 2 slots, up to 20 bank logins)." });
    expect(c.plaid_keys_spouse).toMatchObject({ ok: true, message: "Spouse: Plaid keys set for primary (1 of 2 slots, up to 10 bank logins); backup unused." });
    expect(c.plaid_env).toMatchObject({ ok: false, level: "warn" });            // tests run on sandbox
    expect(text).not.toMatch(/secret_|cid_|uJ2Cr7/);                             // never values
  });

  it("explains a missing or invalid TOKEN_ENC_KEY with how to make one", async () => {
    for (const TOKEN_ENC_KEY of ["", "not-a-key"]) {
      const c = byId((await getJson("/status", { envOverrides: { TOKEN_ENC_KEY } })).body.checks);
      expect(c.token_key).toMatchObject({ ok: false, level: "error", fix: expect.stringContaining("openssl rand -base64 32") });
    }
  });

  it("describes three slots and flags half-set keys as an error", async () => {
    const c = byId((await getJson("/status", { envOverrides: { PLAID_SLOTS: "primary,backup,extra1",
      PLAID_CLIENT_ID_ME_EXTRA1: "c", PLAID_SECRET_ME_EXTRA1: "s", PLAID_SECRET_SPOUSE_BACKUP: "secret-without-id" } })).body.checks);
    expect(c.plaid_keys_me.message).toBe("Me: Plaid keys set for primary, backup, extra1 (3 of 3 slots, up to 30 bank logins).");
    expect(c.plaid_keys_partial_spouse_backup).toMatchObject({ ok: false, level: "error",
      fix: expect.stringContaining("PLAID_CLIENT_ID_SPOUSE_BACKUP") });
    expect(c.plaid_keys_partial_me_primary).toBeUndefined();
  });

  it("flags banks that can't sync because their slot, person or keys are gone", async () => {
    await env.DB.prepare(
      `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES
       ('me', 'me_primary', 'ok', 'x'),
       ('me', 'me_extra1', 'slot-removed', 'x'),
       ('alex', 'alex_primary', 'person-removed', 'x'),
       ('spouse', 'spouse_backup', 'no-keys', 'x')`).run();
    const c = byId((await getJson("/status")).body.checks);
    expect(c.items_stranded).toMatchObject({ ok: false, level: "error" });
    expect(c.items_stranded.message).toMatch(/^3 bank\(s\) can't sync/);
    expect(c.items_stranded.message).toContain("me_extra1 (not in MINTY_USERS / PLAID_SLOTS)");
    expect(c.items_stranded.message).toContain("spouse_backup (no keys)");
    expect(c.items_stranded.message).not.toContain("me_primary");
  });

  it("flags people without Plaid keys, naming the secrets", async () => {
    const c = byId((await getJson("/status", { envOverrides: { MINTY_USERS: "me:Me,alex:Alex" } })).body.checks);
    expect(c.plaid_keys_alex).toMatchObject({ ok: false, fix: expect.stringContaining("PLAID_CLIENT_ID_ALEX_PRIMARY") });
  });

  it("flags Plaid keys set for someone who isn't in MINTY_USERS, never showing values", async () => {
    // the test env has SPOUSE keys; with only one person configured they'd be silently unused
    const r = await getJson("/status", { envOverrides: { MINTY_USERS: "me:Alex" } });
    const c = byId(r.body.checks);
    expect(c.keys_unused).toMatchObject({ ok: false, level: "warn",
      message: "Plaid keys are set for SPOUSE, who isn't in MINTY_USERS, so they aren't used.",
      fix: expect.stringContaining("me:Alex,spouse:Name") });
    expect(JSON.stringify(r.body)).not.toMatch(/secret_|cid_/);
    // everyone with keys is configured: no warning (the default test setup)
    expect(byId((await getJson("/status")).body.checks).keys_unused).toBeUndefined();
    // blank secrets don't count as set
    const blank = await getJson("/status", { envOverrides: { MINTY_USERS: "me:Alex", PLAID_CLIENT_ID_SPOUSE_PRIMARY: "", PLAID_SECRET_SPOUSE_PRIMARY: "" } });
    expect(byId(blank.body.checks).keys_unused).toBeUndefined();
  });

  it("with one person (the default) there are no checks for anyone else", async () => {
    const c = byId((await getJson("/status", { envOverrides: { MINTY_USERS: "" } })).body.checks);
    expect(c.plaid_keys_me).toMatchObject({ ok: true });
    expect(c.plaid_keys_spouse).toBeUndefined();
    const users = (await getJson("/users", { envOverrides: { MINTY_USERS: "" } })).body;
    expect(users.map((u: any) => [u.key, u.label])).toEqual([["me", "Me"]]);
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
