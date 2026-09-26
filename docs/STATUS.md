# Minty status and to-do

Handoff notes for continuing on another machine. Last updated 2026-09-26.
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
  - [x] Step 3: Access variables `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_LOGINS`.
  - [x] Step 4: `TOKEN_ENC_KEY` set to a **new** key (2026-09-26). The owner keeps a copy in a
        password manager; losing it means re-linking every bank.
  - [ ] **In progress:** step 5 on **Plaid Sandbox** (fake banks), then step 6 and a test link.
- **The Python/Docker app was never deployed with real data**: no bank was ever linked and the
  Immich box has no `.env`. There is nothing to migrate; P4 is now just retiring the Python app.

## To do, in order

1. **Step 5 on Sandbox.** Plaid dashboard → **Developers → Keys**: copy the client_id and the
   **Sandbox** secret. In the Worker's **Variables and secrets**, add (Secret checked):
   - `PLAID_CLIENT_ID_ME_PRIMARY`, `PLAID_SECRET_ME_PRIMARY`
   - Optional, to test the second person: the same client_id and Sandbox secret as
     `PLAID_CLIENT_ID_SPOUSE_PRIMARY` / `PLAID_SECRET_SPOUSE_PRIMARY`. That's fine in Sandbox;
     in production each person needs their own Plaid account.
   - **Leave `PLAID_ENV` unset**: it defaults to `sandbox`.
   - Set `MINTY_USERS` only if the people aren't the default `me:Me,spouse:Spouse`.
   - Deploy so the new values take effect.
2. **Step 6:** open **+ Add user → Setup checks**. Everything should be ✓. In particular the
   database schema check confirms migrations 0001 and 0002 were applied by the first deploy.
   That can't be seen from outside while Access is on.
3. **Test link with a fake bank.** **+ Add account** → Me → **Connect with Plaid** → pick
   **First Platypus Bank** (a non-OAuth test bank; OAuth test banks need a redirect URI) →
   username `user_good`, password `pass_good`, and code `1234` if asked for one.
   - The first page of transactions syncs in the background right after linking; the rest
     arrives on the hourly cron (`:17`), about 100 transactions per run on the free plan.
   - If the dashboard says "forbidden" after signing in, the Worker-level Access tab isn't
     sending the `cf-access-jwt-assertion` header. Fix: have `src/access.ts` also read the
     `CF_Authorization` cookie (the same JWT, same validation).
4. **Before switching to production** (`PLAID_ENV=production` + Production secrets): the
   Sandbox Items stay in D1 and would fail against production. Remove them first (a remote D1
   delete, which needs the owner's go-ahead) so only real banks remain.
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
8. **P4, retire the Python app.** No data migration (see plan §8, 2026-09-26). Delete the
   Python/Docker app and Tailscale config, and rewrite CLAUDE.md and README for Workers (plan §5
   rule changes). A large deletion, so it needs the owner's go-ahead.
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
