# Minty status and to-do

Handoff notes for continuing on another machine. Last updated 2026-09-28.
Household-specific values (the workers.dev address, Access team and AUD, email addresses)
are deliberately **not** in this public repo. They're in the owner's Cloudflare dashboard.

## Where things stand

- **Code:** Minty is Cloudflare-only: phases P0–P4 are on `main`. P4 removed the Python/Docker
  app (its last version is tagged `python-app-final`) and moved the pages to `public/`.
  CI (vitest in workerd + typecheck) runs on every PR.
  - Tests: 170 Worker.
  - Since then: filter by bank (#18) and by card/account (#19), and one person by default with
    the person switch only for two or more (#20).
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
  - [x] **Production** (by 2026-09-30, as reported by the owner): switched to `PLAID_ENV=production`
        and linked **4 real banks, all under Me** (none under Spouse). The owner is now testing it.
  - [x] **CPU on the free plan:** the owner reports no "Exceeded CPU" on the Worker dashboard during
        the first real syncs (2026-09-30).
  - Spouse slot: nothing is linked under it. Its `PLAID_*_SPOUSE_*` secrets held the owner's
    Sandbox-era keys; Setup checks flag them as unused until they're deleted or a second person is
    added to `MINTY_USERS` with their own Plaid keys.
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

1. **Next: the finance agent ("Ask Minty").** Plan: [agent-plan.md](agent-plan.md).
   - Decisions made (2026-10-06): household secret, OpenRouter free models by default (own
     OpenAI/Anthropic API keys optional), tagging with Confirm from the start, free plan only.
   - Next: **A0** (agent-plan.md §8.1): a spike script the owner runs on synthetic data to pick a
     free model and check it works with "train on inputs" off, plus a CPU estimate per step.
   - Then A1 (the query layer, useful even without AI) and A2 (the agent, with tagging).
2. **Keep testing production:** new transactions arriving hourly, the Banks and Cards & accounts
   filters, tags, and Setup checks.
   - **Each new bank uses a Plaid Trial slot for good** (10 per credential set), so link only
     banks you'll keep.
   - Optional: delete the unused Spouse secrets, and set `MINTY_USERS` = `me:<Your name>` to show
     your name. Keep the key `me`: your banks are stored under it.
3. **Keep Cloudflare's "Update your Wrangler configuration" prompt unapplied.** `keep_vars` already
   preserves dashboard variables across deploys, and copying them into `wrangler.jsonc` would
   publish the household's emails and Access IDs in this public repo.
4. **Glance at CPU now and then** (**Worker → Metrics**, "Exceeded CPU" on cron runs), especially
   after linking a bank with a long history. An overrun is safe: each page commits with its cursor
   and the run retries next hour. If they become frequent, lower `SYNC_MAX_BYTES_PER_RUN`, or move
   to Workers Paid and raise it (e.g. 20000000 bytes and 50 pages).
5. **Plaid Sandbox end-to-end** (optional; the owner runs it because it reads `.dev.vars`):
   `node scripts/sandbox-e2e.ts` against `npm run dev`.
6. **Onboard friends** from SETUP.md (fork → import → …) and fix anything they trip on.

## Picking up on a new machine

    git clone git@github.com:rg-code/minty.git && cd minty
    npm ci                       # Node 22+; if npm 10 errors resolving new deps, use npx npm@11
    npm test && npm run typecheck
    npm run db:migrate:local && npm run db:seed:local && npm run dev:demo   # http://localhost:8787, two demo people

- **Cloudflare CLI** (optional; the dashboard is enough): `npx wrangler login`.
- **Temporary QA accounts:** `npx wrangler deploy --temporary` works for Workers + D1. It can't
  run cron or migrations there. See serverless-plan.md §8.
