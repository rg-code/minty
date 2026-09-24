# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Minty — Project Context

Self-hosted personal finance aggregator that consolidates bank and credit card
transactions for two people (me + spouse) into one private dashboard.
Goals: full data ownership, no subscription fees, no public endpoints.

## Stack
- Backend: Python FastAPI + PostgreSQL
- Financial data: Plaid (Trial plan)
- Runtime: Docker Compose on an always-on Linux box (also hosts Immich)
- Access: Tailscale Serve (private HTTPS). NEVER Tailscale Funnel.
- Development happens on a separate machine (WSL) with no Docker or Tailscale;
  `docker compose` / `tailscale` commands run only on the Immich box.

## Architecture invariants (do not change without asking)
- `owner` (a `MINTY_USERS` key; default me | spouse) and `plaid_account` (which
  Plaid credential set) are DISTINCT concepts. Never collapse or infer one from
  the other.
- People come from `MINTY_USERS` in `.env`; each has two credential sets,
  `<key>_primary` and `<key>_backup`, whose keys live only in `.env`. Adding a
  user is an `.env` edit + restart (the `/add-user` page generates the lines);
  Plaid secrets never go through the browser or the database. Routing of new
  institutions goes through `choose_account_for()`.
- A Plaid Item = one institution login (not one account). The Trial cap is
  10 Items per credential set; routing logic depends on this.
- Plaid access tokens are stored Fernet-encrypted. Never log, print, or return
  decrypted tokens.
- Transaction sync is cursor-based and incremental.
- There is NO HTTP sync endpoint, by design. Sync runs via the in-process
  scheduler or manually via the CLI. Do not add one.
- Auth is the Tailscale identity gate middleware: reads `Tailscale-User-Login`
  and checks it against `ALLOWED_LOGINS`. Every route must stay behind it.
  `/healthz` is the only ungated path (`OPEN_PATHS`). An empty `ALLOWED_LOGINS`
  disables the gate entirely, so it must be set in production.
- Migrations are applied manually, in order, via psql (see Commands). They are
  NOT idempotent and NOT tracked yet (no `schema_migrations` table), so
  re-running one errors. New schema changes go in a new numbered file in
  `migrations/`, never by editing an applied one.

## Data conventions
- Plaid amount sign: POSITIVE = money out. The dashboard flips it for display.
- Tags live in `transactions.tags` (`text[]`). The sync upsert never writes that
  column, so user labels survive re-syncs. Keep it that way.

## Commands
Local (dev machine):
- Test env: `uv venv .venv && uv pip install -p .venv/bin/python -r requirements-dev.txt`
- All tests: `.venv/bin/python -m pytest`
- Single test: `.venv/bin/python -m pytest tests/test_link.py -k overflow`
  (tests use dummy creds and fakes for Plaid/Postgres; no network, no `.env`)

Workers port (in progress, `docs/serverless-plan.md`; `src/`, `d1/migrations/`, `test/`):
- Install: `npm ci` (Node 22+)
- Tests: `npm test` (vitest inside workerd, real local D1; Plaid never called)
- Types: `npm run typecheck`
- Local DB: `npm run db:migrate:local && npm run db:seed:local`
- Run locally: `npx wrangler dev --var MINTY_DEV_NO_AUTH:1` then http://localhost:8787
  (the flag skips Cloudflare Access and is only honoured for localhost requests)
- The Python app and the Worker share `app/static` and the same API paths/shapes. Keep them
  in step until the P4 cutover. Schema changes for the Worker go in a new `d1/migrations/NNNN_*.sql`.

Deploy host (Immich box):
- Start / rebuild: `docker compose up -d --build`
- Migrations, once each, in order:
  `docker compose exec -T db psql -U aggregator -d aggregator < migrations/00N_name.sql`
- Expose on the tailnet: `tailscale serve --bg 8080`
- Manual sync: `docker compose exec api python -m app.sync_cli`
- `./setup.sh` (setup / validation / health checks) is planned, not yet written.
  Once it exists, keep it in sync when adding services, env vars, or migration steps.

## Safety
- The Linux box is production and holds real financial data. Prefer a separate
  dev database / compose project for experiments. Ask before running
  migrations or sync against the production stack.
- Never read or modify `.env` or any secrets file. Never commit secrets.
  If a new setting is needed, add a placeholder to `.env.example` and tell me.
- Develop and test against Plaid Sandbox credentials, not live Items.

## Working style
- Architecture first: discuss design and trade-offs before writing code.
  For anything non-trivial, propose a plan and wait for my go-ahead.
- When implementing, deliver complete working code, not stubs or pseudocode.
- Validate before declaring done: syntax check, and exercise config/routing
  logic against dummy credentials.

## Known open items
- Using multiple Plaid Trial accounts per person to exceed the 10-Item cap is a
  Plaid ToS gray area. Long-term cleaner option: one paid Plaid account per
  person. Deferred, not forgotten.
