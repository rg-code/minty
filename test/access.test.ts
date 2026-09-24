import { describe, expect, it } from "vitest";
import { teamIssuer } from "../src/access";
import { AUD, accessToken, call, otherKey } from "./helpers";

// Port of tests/test_gate.py for the Cloudflare Access gate — plus fail-closed behaviour,
// which replaces "empty ALLOWED_LOGINS disables the gate".

const GATED: Array<[string, string]> = [
  ["GET", "/users"], ["GET", "/items"], ["GET", "/accounts"], ["GET", "/capacity"],
  ["GET", "/transactions"], ["GET", "/tags"], ["PUT", "/transactions/1/tags"],
  ["POST", "/link/token"], ["POST", "/link/exchange"], ["POST", "/link/token/update"],
];

describe("Access gate", () => {
  it("leaves /healthz open without identity", async () => {
    const r = await call("/healthz", { token: null });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it.each(GATED)("refuses %s %s without a token", async (method, path) => {
    expect((await call(path, { method, token: null })).status).toBe(403);
  });

  it("accepts a valid token", async () => {
    expect((await call("/users")).status).toBe(200);
  });

  it.each([
    ["wrong audience", { aud: "someone-else" }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["signed by another key", { key: otherKey }],
  ] as const)("refuses a token with %s", async (_, opts) => {
    const token = await accessToken({ email: "me@example.com" }, opts as any);
    expect((await call("/users", { token })).status).toBe(403);
  });

  it("refuses garbage and tokens without an email (e.g. service tokens)", async () => {
    expect((await call("/users", { token: "not.a.jwt" })).status).toBe(403);
    expect((await call("/users", { token: await accessToken({ common_name: "svc" }) })).status).toBe(403);
  });

  it("fails closed when Access isn't configured", async () => {
    for (const envOverrides of [{ ACCESS_TEAM_DOMAIN: "" }, { ACCESS_AUD: "" }, { ACCESS_TEAM_DOMAIN: " ", ACCESS_AUD: " " }]) {
      const r = await call("/users", { envOverrides });
      expect(r.status).toBe(403);
      expect((await r.json() as { detail: string }).detail).toMatch(/not configured/);
    }
  });

  it("applies the optional ALLOWED_LOGINS allow-list, case-insensitively", async () => {
    const envOverrides = { ALLOWED_LOGINS: " Me@Example.com , spouse@example.com " };
    expect((await call("/users", { envOverrides })).status).toBe(200);
    const stranger = await accessToken({ email: "stranger@example.com" });
    expect((await call("/users", { envOverrides, token: stranger })).status).toBe(403);
  });

  it("honours MINTY_DEV_NO_AUTH only on localhost", async () => {
    const envOverrides = { MINTY_DEV_NO_AUTH: "1", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
    expect((await call("/users", { envOverrides, token: null, host: "http://localhost:8787" })).status).toBe(200);
    expect((await call("/users", { envOverrides, token: null, host: "http://127.0.0.1:8787" })).status).toBe(200);
    expect((await call("/users", { envOverrides, token: null })).status).toBe(403);   // workers.dev host
  });

  it("normalises the team domain", () => {
    expect(teamIssuer("minty")).toBe("https://minty.cloudflareaccess.com");
    expect(teamIssuer("minty.cloudflareaccess.com")).toBe("https://minty.cloudflareaccess.com");
    expect(teamIssuer("https://minty.cloudflareaccess.com/")).toBe("https://minty.cloudflareaccess.com");
    expect(teamIssuer("")).toBeNull();
    expect(AUD).toBe("test-aud");
  });

  it("has no HTTP sync endpoint", async () => {
    for (const path of ["/sync", "/internal/sync", "/api/sync"]) {
      for (const method of ["GET", "POST"]) {
        const r = await call(path, { method });
        expect(r.status).not.toBe(200);
      }
    }
  });
});
