import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Tests run inside workerd against a real local D1 with d1/migrations applied.
// Plaid is never called; Access JWTs are signed with a test key (see test/helpers.ts).
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./d1/migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ACCESS_TEAM_DOMAIN: "minty-test.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            // Dummy credentials only: me has both slots, spouse only primary.
            PLAID_CLIENT_ID_ME_PRIMARY: "cid_me_primary",
            PLAID_SECRET_ME_PRIMARY: "secret_me_primary",
            PLAID_CLIENT_ID_ME_BACKUP: "cid_me_backup",
            PLAID_SECRET_ME_BACKUP: "secret_me_backup",
            PLAID_CLIENT_ID_SPOUSE_PRIMARY: "cid_spouse_primary",
            PLAID_SECRET_SPOUSE_PRIMARY: "secret_spouse_primary",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
