# Minty — a personal transaction aggregator

A tiny self-hosted service that pulls transactions from your (and your spouse's) banks
and cards via Plaid into one Postgres database, and shows them in a single web dashboard.
Designed to run beside Immich in Docker and be reached privately over Tailscale.

## What it is
- **api** — FastAPI service. Holds all Plaid secrets, serves the dashboard + connect page,
  and runs the sync on a background thread. The only thing that talks to Plaid.
- **db** — Postgres. Stores items (linked institutions), accounts, transactions, tags.

Syncing runs **in-process** (a background scheduler thread), so there is no separate
container and no `/internal/sync` HTTP endpoint. No public endpoints. No webhooks.
Polling only. Reach it via Tailscale.

## People and the trial overflow model
People are listed in `.env` as `MINTY_USERS=me:Me,spouse:Spouse` (the default). Each person
has two Plaid Trial accounts, a **primary** and a **backup**:

    me_primary  → me_backup        (owner: me)
    spouse_primary → spouse_backup (owner: spouse)

To add someone, open **+ Add user** on the dashboard: it writes the `MINTY_USERS` line and the
`PLAID_*_<KEY>_PRIMARY/BACKUP` lines to paste into `.env`, then
`docker compose up -d --force-recreate api`. Keys stay in `.env`; `GET /users` only reports
whether each person's keys are set.

`owner` (a `MINTY_USERS` key) drives the dashboard's filtering and totals.
`plaid_account` (me_primary, …) is the credential set an Item is bound to.
New links land on the person's primary; when it reaches `TRIAL_ITEM_CAP` (10) Items,
`/link/token` automatically overflows the next link to their backup. The `/capacity`
endpoint (shown on the connect page) tells you how full each trial is.

> Note: multiple Trial accounts per person to extend the free item cap is ToS gray area.
> The clean alternative is one paid Plaid account per person (no cap). Your call.

## Security model
Two layers, both optional but recommended:

1. **App identity gate** — `ALLOWED_LOGINS` in `.env` lists the Tailscale logins allowed
   to reach the app. Tailscale Serve injects a `Tailscale-User-Login` header it controls,
   and the app binds to `127.0.0.1`, so requests can't reach it without going through
   Serve. Unknown identities get 403. Empty `ALLOWED_LOGINS` disables the gate (a startup
   warning is logged). `/healthz` stays open for local liveness checks.
2. **Tailscale ACL** (network layer) — see `deploy/tailscale-acl.hujson` for an example
   that restricts port 443 on the host to just your two logins. Optional; merge carefully
   into your global tailnet policy so you don't disturb Immich.

Use Tailscale **Serve** (private), never **Funnel** (public). Tokens are encrypted at rest
with `TOKEN_ENC_KEY`; keep `.env` at `chmod 600` and back up the `agg-db` volume securely.

## First run
1. `cp .env.example .env` and fill in:
   - the 8 Plaid credentials (client_id + secret for each of the 4 trial accounts),
   - `TOKEN_ENC_KEY` (`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`),
   - `DB_PASSWORD` and the matching password inside `DATABASE_URL`,
   - `ALLOWED_LOGINS` = your and your spouse's Tailscale logins,
   - leave `PLAID_REDIRECT_URI` blank (browser OAuth uses a pop-up; no redirect URI needed).
2. `docker compose up -d --build`
3. Run migrations once, in order:
   ```
   for f in migrations/001_init.sql migrations/002_tags.sql migrations/003_plaid_accounts.sql; do
     docker compose exec -T db psql -U aggregator -d aggregator < "$f"
   done
   ```
4. Expose to your tailnet (host already on Tailscale; HTTPS certs enabled):
   `tailscale serve --bg 8080`  → open `https://<host>.<tailnet>.ts.net/`
5. Visit `/connect`, link each bank/card. The initial backfill runs on link.

Manual sync anytime (no HTTP surface):
   `docker compose exec api python -m app.sync_cli`

## Tests
Unit tests use dummy credentials and fakes for Plaid and Postgres — no network, no `.env`.
```
uv venv .venv && uv pip install -p .venv/bin/python -r requirements-dev.txt
.venv/bin/python -m pytest                                   # whole suite
.venv/bin/python -m pytest tests/test_link.py -k overflow    # a single test
```

## Endpoints
    GET  /                       dashboard
    GET  /connect                link a bank/card
    GET  /add-user               generate the .env lines to add a person
    POST /link/token             {owner} -> {link_token, plaid_account}   (overflow chosen here)
    POST /link/exchange          {owner, plaid_account, public_token}
    POST /link/token/update      {item_id}  (re-auth an item)
    GET  /items                  linked institutions + status
    GET  /accounts               accounts + balances   (?owner=)
    GET  /transactions           unified feed   (?owner= &tag= &q= &start= &end= &account_id=)
    GET  /tags                   distinct tags in use
    PUT  /transactions/{id}/tags {tags:[...]}  replace a transaction's tags
    GET  /capacity               per-person trial usage (used/cap)
    GET  /users                  people from MINTY_USERS + which key slots are set (no secrets)
    GET  /healthz                liveness (ungated)
(Sync is in-process; there is no sync HTTP endpoint.)

## Notes
- Plaid amount sign: POSITIVE = money out. The dashboard flips it for display.
- Plaid returns the account **mask** (last 4), never the full number — same for every aggregator.
- Tags live in a `text[]` column; the sync upsert never touches it, so labels survive re-syncs.
- Verified for syntax; not run against a live Plaid/Postgres. Sanity-check the `plaid-python`
  model imports against your installed version on first boot.

## License

MIT. See [LICENSE](LICENSE).
