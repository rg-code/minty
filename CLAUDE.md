# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Minty — Project Context

Self-hosted personal finance aggregator that consolidates bank and credit card
transactions for a household (default: me + spouse) into one private dashboard.
Anyone can fork it and run their own copy on Cloudflare's free plans.
Goals: full data ownership, no subscription fees, no public endpoints.

**Current status and to-do: `docs/STATUS.md`. Read it first when resuming work.**
Design history and decisions: `docs/serverless-plan.md`.

## Stack
- Cloudflare Worker (TypeScript, `src/`) + D1 (SQLite, `d1/migrations/`), one deployment
  per household. Pages are static files in `public/` (Workers assets); API paths are listed in
  `wrangler.jsonc` `assets.run_worker_first` and run through the Worker.
- Financial data: Plaid (Trial plan). Sync runs from an hourly cron trigger.
- Access: Cloudflare Access at the edge, plus a login-token check in the Worker.
- Each household deploys its own fork with Cloudflare Workers Builds (`npm run deploy`);
  onboarding is `SETUP.md`. Development with `wrangler dev` on any machine (Node 22+).

## Architecture invariants (do not change without asking)
- `owner` (a `MINTY_USERS` key; default me | spouse) and `plaid_account` (which
  Plaid credential set) are DISTINCT concepts. Never collapse or infer one from
  the other.
- People come from the `MINTY_USERS` Worker variable; each has two credential sets,
  `<key>_primary` and `<key>_backup` (`PLAID_CLIENT_ID_<KEY>_<SLOT>` /
  `PLAID_SECRET_<KEY>_<SLOT>` secrets). The `/add-user` page generates the values;
  Plaid secrets never go through the browser or the database. Routing of new
  institutions goes through `chooseAccountFor()` (`src/routes/link.ts`).
- A Plaid Item = one institution login (not one account). The Trial cap is
  10 Items per credential set (`TRIAL_ITEM_CAP`); routing logic depends on this.
- Plaid access tokens are stored Fernet-encrypted (`src/fernet.ts`, `TOKEN_ENC_KEY`).
  Never log, print, or return decrypted tokens.
- Transaction sync is cursor-based and incremental.
- There is NO HTTP sync endpoint, by design. Sync runs only from the cron trigger
  (`/link/exchange` starts the first sync of a new Item internally). Do not add one.
- Auth: Cloudflare Access guards the hostname; every API route also re-validates the
  Access JWT (`src/access.ts`) and applies the optional `ALLOWED_LOGINS` allow-list.
  **Missing `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` means everything is refused.** `/healthz`
  is the only ungated path. State-changing requests from another origin are refused.
- D1 migrations live in `d1/migrations/NNNN_*.sql`, are tracked in `d1_migrations`, and are
  applied automatically on deploy. New schema changes go in a new file, never an edited one;
  `src/routes/status.ts` lists every migration (a test checks this).

## Data conventions
- Plaid amount sign: POSITIVE = money out. Stored as integer cents (`amount_cents`); the
  dashboard flips the sign for display.
- Tags live in `transaction_tags` rows. Sync never writes them, so user labels survive
  re-syncs. Keep it that way.

## Commands
- Install: `npm ci` (Node 22+)
- Tests: `npm test` (vitest inside workerd, real local D1; Plaid never called)
- Single test file / name: `npx vitest run test/link.test.ts -t overflow`
- Types: `npm run typecheck`
- Local DB: `npm run db:migrate:local && npm run db:seed:local`
- Run locally: `npm run dev` then http://localhost:8787 (passes `--var MINTY_DEV_NO_AUTH:1`,
  which skips Cloudflare Access and is only honoured for localhost requests)
- Local cron sync (`npm run dev` enables the trigger):
  `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+*+*+*+*"`
- Deploy: `npm run deploy` (`scripts/deploy.mjs`, run by Workers Builds on push to `main`):
  migrate then deploy, or deploy first on the very first run (it creates D1).
- Plaid Sandbox end-to-end: `node scripts/sandbox-e2e.ts` against `npm run dev`. It reads
  `.dev.vars`, so the user runs it, not Claude.

## Rules for changes
- `wrangler.jsonc` is shared by every household's fork: never add per-household values to it
  (no `database_id`, no `vars`). Household settings are dashboard variables (kept by
  `keep_vars`) or secrets. That's what keeps "Sync fork" conflict-free. New settings need a
  code default, a line in the `wrangler.jsonc` header comment, and a `/status` check if required.
  Ignore Cloudflare's "Update your Wrangler configuration" prompt for the same reason.
- Never put `MINTY_DEV_NO_AUTH` in `.dev.vars.example`: the Deploy button turns that file into
  secret prompts. CI checks this.
- Worker sync (`src/sync.ts`): one D1 batch per Plaid page (the cursor advances with its page).
  The Worker never parses a page: the text is bound once into `sync_pages` and SQLite unpacks
  it. Each run has a byte and a page budget (`SYNC_MAX_BYTES_PER_RUN` / `SYNC_MAX_PAGES_PER_RUN`),
  sized from measurements against the free plan's 10 ms CPU limit (docs/serverless-plan.md §8).
  Don't add per-row work or JSON.parse on the page path, and never bind pages as bytes
  (18 ms per page). Transient Plaid errors retry next run; only item-level errors change
  `items.status`.
- Fernet reference vectors (`test/fixtures/fernet-vectors.json`, test key only) pin the
  encryption to the reference implementation. Don't regenerate them casually.

## Safety
- The live household deployment is the Cloudflare Worker. Ask before running remote D1
  migrations or commands (`wrangler … --remote`) against it, or before switching it from
  Plaid Sandbox to production.
- Never read or modify `.dev.vars` or any secrets file. Never commit secrets or
  household-specific values (emails, Access team/AUD, workers.dev address) to this public repo.
  If a new setting is needed, add a placeholder to `.dev.vars.example` (secrets) or the
  `wrangler.jsonc` header comment (variables) and tell me.
- Develop and test against Plaid Sandbox credentials, not live Items.

## Working style
- Architecture first: discuss design and trade-offs before writing code.
  For anything non-trivial, propose a plan and wait for my go-ahead.
- When implementing, deliver complete working code, not stubs or pseudocode.
- Validate before declaring done: `npm test` and `npm run typecheck`, and exercise
  config/routing logic against dummy credentials.

## Known open items
- Using multiple Plaid Trial accounts per person to exceed the 10-Item cap is a
  Plaid ToS gray area. Long-term cleaner option: one paid Plaid account per
  person. Deferred, not forgotten.
