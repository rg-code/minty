# Minty status and to-do

Handoff notes for continuing on another machine. Last updated 2026-09-25.
Household-specific values (the workers.dev address, Access team and AUD, email addresses)
are deliberately **not** in this public repo. They're in the owner's Cloudflare dashboard.

## Where things stand

- **Code:** the Cloudflare Workers port, phases P0–P3 plus the pre-deploy QA fix (#10), is on
  `main`. CI (vitest in workerd, typecheck, pytest) runs on every PR.
  - Tests: 137 Worker, 63 Python.
  - Plan and decision log: [serverless-plan.md](serverless-plan.md) §8.
- **The owner's household deployment (in progress):**
  - [x] Imported `rg-code/minty` via Workers & Pages → Import a repository. Name `minty`, deploy
        command `npm run deploy`. The build succeeded.
  - [x] The first deploy created D1 `minty`, and the cron trigger is scheduled (`17 * * * *`).
  - [x] Live QA against the real deployment: 24/24 passed (pages load, API fails closed, no sync
        endpoint, forged tokens rejected).
  - [x] Access enabled from the Worker's **Access** tab. The policies are "Cloudflare Account" plus
        the owner's email domain (a catch-all to the owner's inbox). The edge now redirects to the
        team's sign-in page, and the team's signing keys are reachable (2 × RS256).
  - [ ] **Paused here:** add the Text variables `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and
        `ALLOWED_LOGINS` (Secret unchecked), deploy, then sign in from a private window and
        confirm the dashboard loads.
- **The Python/Docker app** on the Immich box is still the live system with real data. It's
  untouched, and it stays that way until the P4 cutover.

## To do, in order

1. **Finish SETUP.md step 3:** the three variables above, then the sign-in test. If the dashboard
   says "forbidden" after a successful sign-in, the Worker-level Access tab isn't sending the
   `cf-access-jwt-assertion` header. Fix: have `src/access.ts` also read the `CF_Authorization`
   cookie (the same JWT, same validation).
2. **Step 4, `TOKEN_ENC_KEY`: ⚠ use the Python app's existing key** from the Immich box's `.env`,
   not a new one.
   - The existing Items' access tokens are Fernet-encrypted with it. The P4 migration moves
     them without decrypting, which only works with the same key.
   - A new key would force re-linking every bank, and Plaid Trial slots aren't freed by
     `/item/remove`.
   - The owner copies the key by hand. Claude never reads `.env`.
3. **Step 5, Plaid keys:** use the same credential sets as the Python app (the `PLAID_*_ME_PRIMARY`,
   `…_BACKUP` and `…_SPOUSE_*` secrets) and `PLAID_ENV=production`.
   - Migrated tokens only work with the client_id/secret they were issued under.
   - Set `MINTY_USERS` too, if it isn't the default `me:Me,spouse:Spouse`.
4. **Step 6:** open **+ Add user → Setup checks**. Everything should be ✓. In particular the
   database schema check confirms migrations 0001 and 0002 were applied by the first deploy.
   That can't be seen from outside while Access is on.
5. **Tidy-up:**
   - Worker → **Domains**: switch the Preview URL off.
   - **Settings → Builds → Branch control**: confirm the production branch is `main`. Optionally
     turn off builds for non-production branches, to save build minutes.
6. **Watch the free plan's CPU limit** during the first real syncs: **Worker → Metrics**, look for
   "Exceeded CPU" errors on cron invocations.
   - Measured before deploying: median 8 ms per run (4–16 ms), against a 10 ms limit.
   - An overrun is safe: each page commits with its cursor, and the run retries next hour.
   - If overruns are frequent, lower `SYNC_MAX_BYTES_PER_RUN`, or move to Workers Paid and
     raise it (e.g. 20000000 bytes and 50 pages).
7. **Plaid Sandbox end-to-end** (optional; the owner runs it because it reads `.dev.vars`):
   `node scripts/sandbox-e2e.ts` against `npm run dev`.
8. **P4, migrate the household from the Immich box.** Not started; it touches production, so it
   needs the owner's go-ahead.
   - Export script: Postgres → D1 SQL. Tokens stay encrypted (`bytea` → the token text), and
     cursors, tags and `plaid_account` routing are kept. Amounts become cents, and `tags text[]`
     becomes `transaction_tags` rows.
   - Rehearse into a scratch D1, compare row counts, then import with
     `wrangler d1 execute DB --remote --file …`.
   - Run both systems side by side for about a week. Then retire Docker/Tailscale, delete the
     Python app, and rewrite CLAUDE.md and README (plan §5 rule changes).
9. **Onboard friends** from SETUP.md (fork → import → …) and fix anything they trip on.

## Picking up on a new machine

    git clone git@github.com:rg-code/minty.git && cd minty
    npm ci                       # Node 22+; if npm 10 errors resolving new deps, use npx npm@11
    npm test && npm run typecheck
    npm run db:migrate:local && npm run db:seed:local && npm run dev   # http://localhost:8787
    # Python app tests: python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest

- **Cloudflare CLI** (optional; the dashboard is enough): `npx wrangler login`.
- **Temporary QA accounts:** `npx wrangler deploy --temporary` works for Workers + D1. It can't
  run cron or migrations there. See serverless-plan.md §8.
