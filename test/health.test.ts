import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { loadConfig } from "../src/config";
import { type BankRow, ago, bankHealth, describeError, syncHealth } from "../src/health";
import type { Env } from "../src/env";

// The verdicts behind the dashboard's status strip and Setup checks, at a fixed "now".
const E = env as unknown as Env;
const config = loadConfig(E);
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3.6e6).toISOString();
const inDays = (d: number) => new Date(NOW + d * 8.64e7).toISOString();

const row = (o: Partial<BankRow> = {}): BankRow => ({
  id: 6, owner: "me", plaid_account: "me_primary", institution_name: "American Express", status: "good",
  updated_at: hoursAgo(0.5), last_error: null, last_error_message: null, downloading: 0, synced_once: 1,
  consent_expires_at: null, txns: 907, ...o,
});
const health = (o: Partial<BankRow> = {}, e: Env = E) => bankHealth(e, loadConfig(e), row(o), NOW);

describe("bankHealth", () => {
  it("is ok for a bank that synced recently, and for statuses sync doesn't touch", () => {
    expect(health()).toMatchObject({ state: "ok", level: null, message: null, action: null });
    expect(health({ status: "demo", updated_at: hoursAgo(1000) }).state).toBe("ok");
  });

  it("explains a stalled bank with its last error in plain words", () => {
    expect(health({ updated_at: "2026-10-07T13:17:15.149Z", last_error: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" })).toMatchObject({
      state: "stalled", level: "warn", action: null,
      message: "American Express hasn't synced for 3 days (last successful sync Oct 7).",
      detail: "Plaid's data changed during the download, so Minty restarts it automatically.",
      fix: expect.stringContaining("Minty keeps retrying"), error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
    });
  });

  it("flags a stalled bank with no error as sync perhaps not running", () => {
    expect(health({ updated_at: hoursAgo(5) })).toMatchObject({ state: "stalled", message: expect.stringContaining("hasn't synced for 5 hours"),
      detail: "No sync attempt has failed, so sync may not be running at all.", fix: expect.stringContaining("cron triggers") });
  });

  it("waits 3 hours before calling a transient error a problem", () => {
    expect(health({ updated_at: hoursAgo(2), last_error: "INSTITUTION_DOWN" }).state).toBe("ok");
    expect(health({ updated_at: hoursAgo(4), last_error: "INSTITUTION_DOWN" }).detail).toBe("The bank's systems are down. Minty keeps retrying.");
  });

  it("asks you to sign in again straight away, with Plaid's reason", () => {
    expect(health({ status: "login_required", last_error: "ITEM_LOGIN_REQUIRED", last_error_message: "the login details of this item have changed" })).toMatchObject({
      state: "reconnect", level: "error", action: "reconnect", message: "American Express needs you to sign in again.",
      detail: expect.stringContaining("password change"), plaid_message: "the login details of this item have changed",
    });
    expect(health({ status: "login_required", updated_at: hoursAgo(500) }).state).toBe("reconnect");   // not "stalled"
  });

  it("says a permanently broken bank must be linked again", () => {
    expect(health({ status: "error", last_error: "ITEM_NOT_FOUND" })).toMatchObject({ state: "broken", level: "error", action: "relink",
      detail: expect.stringContaining("Plaid no longer recognises"), fix: "Link it again from + Add account." });
    expect(health({ status: "error", last_error: "TOKEN_DOES_NOT_DECRYPT" }).detail).toContain("TOKEN_ENC_KEY");
  });

  it("names the missing slot, person or keys of a stranded bank", () => {
    expect(health({ plaid_account: "me_extra1" })).toMatchObject({ state: "stranded", level: "error",
      message: "American Express can't sync: its Plaid account (me_extra1) isn't in MINTY_USERS / PLAID_SLOTS any more." });
    expect(health({ plaid_account: "spouse_backup" }).message).toContain("has no Plaid keys");
  });

  it("warns a week before the bank's consent through Plaid ends, and after it has", () => {
    expect(health({ consent_expires_at: inDays(30) }).state).toBe("ok");
    expect(health({ consent_expires_at: "2026-10-15T00:00:00Z" })).toMatchObject({ state: "expiring", level: "warn", action: "reconnect",
      message: "American Express's access through Plaid ends on Oct 15." });
    expect(health({ consent_expires_at: "2026-10-01T00:00:00Z" })).toMatchObject({ state: "reconnect", level: "error", action: "reconnect",
      message: "American Express's access through Plaid ended on Oct 1." });
    expect(health({ consent_expires_at: inDays(3), updated_at: hoursAgo(10) }).state).toBe("stalled");   // the bigger problem first
  });

  it("shows a history download as progress, not a problem", () => {
    expect(health({ downloading: 1 })).toMatchObject({ state: "downloading", level: "info",
      message: "American Express: downloading its history (907 transactions so far)." });
    expect(health({ downloading: 1, updated_at: hoursAgo(6) }).state).toBe("stalled");
  });

  it("names a bank without an institution name by its number", () => {
    expect(health({ institution_name: null, status: "login_required" }).message).toBe("Bank #6 needs you to sign in again.");
  });
});

describe("describeError", () => {
  it("falls back to Plaid's own text, then the bare code", () => {
    expect(describeError("SOMETHING_NEW", "the bank is having a bad day")).toBe("Plaid says: the bank is having a bad day");
    expect(describeError("SOMETHING_NEW", null)).toBe("Plaid error SOMETHING_NEW.");
    expect(describeError(null, "x")).toBeNull();
  });
});

describe("syncHealth", () => {
  it("looks at the most recent sync of any bank that can sync", () => {
    expect(syncHealth(E, config, [], NOW)).toBeNull();
    expect(syncHealth(E, config, [row({ updated_at: hoursAgo(30) }), row({ updated_at: hoursAgo(0.2) })], NOW))
      .toEqual({ ok: true, message: "Last sync within the hour." });
    expect(syncHealth(E, config, [row({ updated_at: hoursAgo(30) }), row({ status: "error", updated_at: hoursAgo(0.2) }),
      row({ plaid_account: "me_extra1", updated_at: hoursAgo(0.2) }), row({ synced_once: 0, updated_at: hoursAgo(0.2) })], NOW))
      .toMatchObject({ ok: false, message: "No bank has synced for 30 hours.", fix: expect.stringContaining("cron triggers") });
  });
});

describe("ago", () => {
  it("reads naturally", () => {
    expect([0.5, 1, 5, 47, 72].map(ago)).toEqual(["under an hour", "1 hour", "5 hours", "47 hours", "3 days"]);
  });
});
