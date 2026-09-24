# Finance Aggregator — Project Context

Self-hosted personal finance aggregator that consolidates bank and credit card
transactions for two people (me + spouse) into one private dashboard.
Goals: full data ownership, no subscription fees, no public endpoints.

## Stack
- Backend: Python FastAPI + PostgreSQL
- Financial data: Plaid (Trial plan)
- Runtime: Docker Compose on an always-on Linux box (also hosts Immich)
- Access: Tailscale Serve (private HTTPS). NEVER Tailscale Funnel.

## Architecture invariants (do not change without asking)
- `owner` (me | spouse) and `plaid_account` (which Plaid credential set) are
  DISTINCT concepts. Never collapse or infer one from the other.
- Four Plaid credential sets: `me_primary`, `me_backup`, `spouse_primary`,
  `spouse_backup`. Routing of new institutions goes through
  `choose_account_for()`.
- A Plaid Item = one institution login (not one account). The Trial cap is
  10 Items per credential set; routing logic depends on this.
- Plaid access tokens are stored Fernet-encrypted. Never log, print, or return
  decrypted tokens.
- Transaction sync is cursor-based and incremental.
- There is NO HTTP sync endpoint, by design. Sync runs via the in-process
  scheduler or manually via the CLI. Do not add one.
- Auth is the Tailscale identity gate middleware: reads `Tailscale-User-Login`
  and checks it against `ALLOWED_LOGINS`. Every route must stay behind it.
- Migrations are idempotent and tracked in `schema_migrations`. New schema
  changes go in a new migration, never by editing an applied one.

## Commands
- Start: `docker compose up -d`
- Manual sync: `docker compose exec api python -m app.sync_cli`
- Setup / validation / health checks: `./setup.sh`
  (keep it in sync when adding services, env vars, or migration steps)

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
