# Minty status and to-do

Handoff notes for continuing on another machine. Last updated 2026-09-28.
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
  - [x] Tidy-up (2026-09-27): Preview URLs off (dashboard, and enforced by `"preview_urls": false`
        in `wrangler.jsonc`; branch builds still pass as PR checks). Production branch confirmed
        as `main` under **Settings → Builds → Branch control**.
  - [x] Sandbox cleanup (2026-09-28): deleted both Sandbox Items (First Platypus Bank, Tartan
        Bank) and their 10 accounts, 200 transactions and 2 tags from remote D1 via the dashboard
        console, with the owner's go-ahead. Verified: every count is 0, and both migrations are still
        recorded. The Sandbox keys are still set, until the switch below.
  - Lesson from step 3: Access's policy (who can sign in) and the Worker's `ALLOWED_LOGINS`
    (who the Worker accepts) are separate lists; a login must be on both. A "forbidden" from the
    API was an address missing from `ALLOWED_LOGINS`. The API now says which check failed.
- **The Python/Docker app is retired (P4).** It was never deployed with real data, nothing was
  running on the Immich box, and there was nothing to migrate.

- **More Plaid accounts per person (2026-09-28):** `PLAID_SLOTS` makes the number of credential
  slots configurable (default `primary,backup`, up to 10). Routing skips slots without keys, and
  `/status` flags half-set keys and banks stranded on a removed slot. With the default, adding
  the `…_BACKUP` secrets gives each person 20 bank logins.

## To do, in order

1. **Switch to production** (Worker → Settings → Variables and secrets):
   - Edit `PLAID_SECRET_ME_PRIMARY` and `PLAID_SECRET_SPOUSE_PRIMARY` to the Plaid **Production**
     secrets. The client_id is shared across environments; change `PLAID_CLIENT_ID_*` only if they
     differ.
   - Add a Text variable `PLAID_ENV` = `production`, then **Deploy**.
   - Setup checks should show "Plaid: production (real banks)" ✓.
   - Then link real banks. **Each one uses a Plaid Trial slot for good** (10 per credential set),
     so link only banks you'll keep.
2. **Keep Cloudflare's "Update your Wrangler configuration" prompt unapplied.** `keep_vars` already
   preserves dashboard variables across deploys, and copying them into `wrangler.jsonc` would
   publish the household's emails and Access IDs in this public repo.
3. **Watch the free plan's CPU limit** during the first real syncs: **Worker → Metrics**, look for
   "Exceeded CPU" errors on cron invocations.
   - Measured before deploying: median 8 ms per run (4–16 ms), against a 10 ms limit.
   - An overrun is safe: each page commits with its cursor, and the run retries next hour.
   - If overruns are frequent, lower `SYNC_MAX_BYTES_PER_RUN`, or move to Workers Paid and
     raise it (e.g. 20000000 bytes and 50 pages).
4. **Plaid Sandbox end-to-end** (optional; the owner runs it because it reads `.dev.vars`):
   `node scripts/sandbox-e2e.ts` against `npm run dev`.
5. **Onboard friends** from SETUP.md (fork → import → …) and fix anything they trip on.
6. **Optional finance agent ("Ask Minty"):** proposal in [agent-plan.md](agent-plan.md).
   Nothing built; four decisions pending (§9) before phase A1.

## Picking up on a new machine

    git clone git@github.com:rg-code/minty.git && cd minty
    npm ci                       # Node 22+; if npm 10 errors resolving new deps, use npx npm@11
    npm test && npm run typecheck
    npm run db:migrate:local && npm run db:seed:local && npm run dev   # http://localhost:8787

- **Cloudflare CLI** (optional; the dashboard is enough): `npx wrangler login`.
- **Temporary QA accounts:** `npx wrangler deploy --temporary` works for Workers + D1. It can't
  run cron or migrations there. See serverless-plan.md §8.
