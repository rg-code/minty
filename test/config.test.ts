import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { ConfigError, credsFor, isConfigured, loadConfig, parseUsers } from "../src/config";
import type { Env } from "../src/env";
import { call, getJson } from "./helpers";

// MINTY_USERS parsing, credential slots and settings validation.
const E = env as unknown as Env;

describe("MINTY_USERS", () => {
  it("defaults to me + spouse, in order", () => {
    expect([...parseUsers("me:Me,spouse:Spouse")]).toEqual([["me", "Me"], ["spouse", "Spouse"]]);
    expect([...loadConfig({ ...E, MINTY_USERS: "" }).users]).toEqual([["me", "Me"], ["spouse", "Spouse"]]);
  });

  it("trims and defaults labels", () => {
    expect([...parseUsers(" me : Me , alex ,, kid2:Sam Lee ")]).toEqual([["me", "Me"], ["alex", "Alex"], ["kid2", "Sam Lee"]]);
  });

  it.each(["Me:Me", "a_b:X", "1x:Y", "", " , ", "x".repeat(25)])("rejects %j", (raw) => {
    expect(() => parseUsers(raw)).toThrow(ConfigError);
  });

  it("rejects duplicates", () => {
    expect(() => parseUsers("me:Me,me:Again")).toThrow(/duplicate/);
  });
});

describe("credential sets", () => {
  const config = loadConfig(E);

  it("gives each person primary then backup", () => {
    expect([...config.ownerAccounts]).toEqual([["me", ["me_primary", "me_backup"]], ["spouse", ["spouse_primary", "spouse_backup"]]]);
    expect(config.accountOwner.get("spouse_backup")).toBe("spouse");
    expect(config.itemCap).toBe(10);
  });

  it("reads only that set's secrets", () => {
    expect(credsFor(E, config, "me_backup")).toEqual({ clientId: "cid_me_backup", secret: "secret_me_backup" });
    expect(credsFor(E, config, "spouse_backup")).toEqual({ clientId: "", secret: "" });
    expect(isConfigured(E, config, "spouse_primary")).toBe(true);
    expect(isConfigured(E, config, "spouse_backup")).toBe(false);
    expect(() => credsFor(E, config, "nobody_primary")).toThrow(/unknown plaid_account/);
  });

  it("reads per-user secrets for users added via MINTY_USERS", () => {
    const e = { ...E, MINTY_USERS: "me:Me,alex:Alex", PLAID_CLIENT_ID_ALEX_PRIMARY: "cid_alex", PLAID_SECRET_ALEX_PRIMARY: "secret_alex" };
    const c = loadConfig(e);
    expect(credsFor(e, c, "alex_primary")).toEqual({ clientId: "cid_alex", secret: "secret_alex" });
    expect(isConfigured(e, c, "alex_backup")).toBe(false);
  });

  it("rejects a bad TRIAL_ITEM_CAP", () => {
    expect(() => loadConfig({ ...E, TRIAL_ITEM_CAP: "ten" })).toThrow(ConfigError);
  });
});

describe("GET /users", () => {
  it("reports slots without secrets", async () => {
    const r = await call("/users");
    const text = await r.text();
    expect(JSON.parse(text)).toEqual([
      { key: "me", label: "Me", slots: [
        { account: "me_primary", slot: "primary", configured: true },
        { account: "me_backup", slot: "backup", configured: true }] },
      { key: "spouse", label: "Spouse", slots: [
        { account: "spouse_primary", slot: "primary", configured: true },
        { account: "spouse_backup", slot: "backup", configured: false }] },
    ]);
    expect(text).not.toMatch(/secret_|cid_/);
  });

  it("surfaces a MINTY_USERS mistake as a readable 500", async () => {
    const { status, body } = await getJson("/users", { envOverrides: { MINTY_USERS: "Bad Key" } });
    expect(status).toBe(500);
    expect(body.detail).toMatch(/MINTY_USERS: invalid user key/);
  });
});
