# Minty status and to-do

Handoff notes for continuing on another machine. Last updated 2026-09-26.
Household-specific values (the workers.dev address, Access team and AUD, email addresses)
are deliberately **not** in this public repo. They're in the owner's Cloudflare dashboard.

## Where things stand

- **Code:** Minty is Cloudflare-only: phases P0–P4 are on `main`. P4 removed the Python/Docker
  app (its last version is tagged `python-app-final`) and moved the pages to `public/`.
  CI (vitest in workerd + typecheck) runs on every PR.
  - Tests: 144 Worker.
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
  - [x] Step 3: Access variables `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_LOGINS`.
  - [x] Step 4: `TOKEN_ENC_KEY` set to a **new** key (2026-09-26). The owner keeps a copy in a
        password manager; losing it means re-linking every bank.
  - [x] Step 5 on **Plaid Sandbox**: `PLAID_*_ME_PRIMARY` and `PLAID_*_SPOUSE_PRIMARY` set to
        Sandbox keys, `PLAID_ENV` unset (2026-09-26).
  - [x] Step 6: Setup checks all ✓ (the only "!" is the expected "Plaid: sandbox").
  - [x] Step 7 (test): linked **First Platypus Bank** with `user_good` / `pass_good`.
  - Lesson from step 3: Access's policy (who can sign in) and the Worker's `ALLOWED_LOGINS`
    (who the Worker accepts) are separate lists; a login must be on both. A "forbidden" from the
    API was an address missing from `ALLOWED_LOGINS`. The API now says which check failed.
- **The Python/Docker app is retired (P4).** It was never deployed with real data, nothing was
  running on the Immich box, and there was nothing to migrate.

## To do, in order

1. **Try the dashboard on Sandbox data.** Test banks are **First Platypus Bank** (non-OAuth; OAuth
   test banks need a redirect URI) with `user_good` / `pass_good`, code `1234` if asked. The first
   page of transactions syncs right after linking; the rest arrives on the hourly cron (`:17`),
   about 100 transactions per run on the free plan.
2. **Keep Cloudflare's "Update your Wrangler configuration" prompt unapplied.** `keep_vars` already
   preserves dashboard variables across deploys, and copying them into `wrangler.jsonc` would
   publish the household's emails and Access IDs in this public repo.
3. **Before switching to production** (`PLAID_ENV=production` + Production secrets): the
   Sandbox Items stay in D1 and would fail against production. Remove them first (a remote D1
   delete, which needs the owner's go-ahead) so only real banks remain.
4. **Tidy-up:**
   - Worker → **Domains**: switch the Preview URL off.
   - **Settings → Builds → Branch control**: confirm the production branch is `main`. Optionally
     turn off builds for non-production branches, to save build minutes.
5. **Watch the free plan's CPU limit** during the first real syncs: **Worker → Metrics**, look for
   "Exceeded CPU" errors on cron invocations.
   - Measured before deploying: median 8 ms per run (4–16 ms), against a 10 ms limit.
   - An overrun is safe: each page commits with its cursor, and the run retries next hour.
   - If overruns are frequent, lower `SYNC_MAX_BYTES_PER_RUN`, or move to Workers Paid and
     raise it (e.g. 20000000 bytes and 50 pages).
6. **Plaid Sandbox end-to-end** (optional; the owner runs it because it reads `.dev.vars`):
   `node scripts/sandbox-e2e.ts` against `npm run dev`.
7. **Onboard friends** from SETUP.md (fork → import → …) and fix anything they trip on.

## Picking up on a new machine

    git clone git@github.com:rg-code/minty.git && cd minty
    npm ci                       # Node 22+; if npm 10 errors resolving new deps, use npx npm@11
    npm test && npm run typecheck
    npm run db:migrate:local && npm run db:seed:local && npm run dev   # http://localhost:8787

- **Cloudflare CLI** (optional; the dashboard is enough): `npx wrangler login`.
- **Temporary QA accounts:** `npx wrangler deploy --temporary` works for Workers + D1. It can't
  run cron or migrations there. See serverless-plan.md §8.
