# Minty — a personal transaction aggregator

Minty pulls transactions from your household's banks and cards via Plaid into one private
dashboard, with tags, search and per-person totals. Each household runs its own copy on
Cloudflare: one Worker plus a D1 database, on free plans, with no server to look after.
Your data and keys stay in your own Cloudflare and Plaid accounts.

**Want your own?** Fork this repo and follow [SETUP.md](SETUP.md). Everything is done in a
web browser.

## How it works
- **Worker** (`src/`): serves the API behind Cloudflare Access, holds the Plaid keys, and is the
  only thing that talks to Plaid. Pages (dashboard, connect, add user) are static files in
  `public/`.
- **D1** (`d1/migrations/`): items (bank logins), accounts, transactions and tags. Migrations
  are tracked and applied automatically on every deploy.
- **Sync**: an hourly cron trigger pulls new transactions with Plaid's cursor-based
  `/transactions/sync`. Linking a bank starts its first sync right away. There is no sync HTTP
  endpoint and no webhooks.
- **Deploys**: Cloudflare Workers Builds runs `npm run deploy` on every push to `main`
  (apply D1 migrations, then deploy). GitHub Actions only runs tests.

## People and the trial overflow model
People come from the `MINTY_USERS` variable (default `me:Me,spouse:Spouse`). Each person has
two Plaid Trial credential sets, a **primary** and a **backup**:

    me_primary     → me_backup      (owner: me)
    spouse_primary → spouse_backup  (owner: spouse)

`owner` drives the dashboard's filtering and totals; `plaid_account` is the credential set a
bank login is bound to. New links land on the person's primary; when it reaches
`TRIAL_ITEM_CAP` (10) logins, the next link overflows to their backup. The connect page shows
how full each trial is. To add someone, open **+ Add user**: it lists the `MINTY_USERS` value and
the secret names to add in the Cloudflare dashboard.

> Note: multiple Trial accounts per person to extend the free item cap is ToS gray area.
> The clean alternative is one paid Plaid account per person (no cap). Your call.

## Security model
- **Cloudflare Access** decides who can sign in to the hostname at all.
- **The Worker re-checks the Access token** on every API request, and optionally an
  `ALLOWED_LOGINS` allow-list. If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing, every API
  request is refused. A refusal says which check failed. `/healthz` is the only open path.
- **Cross-site writes are refused**, so another site can't act through a signed-in browser.
- **Plaid access tokens are Fernet-encrypted** with `TOKEN_ENC_KEY` before they're stored.
  Plaid keys and `TOKEN_ENC_KEY` are Worker secrets; they never reach the browser or the database.
- **Setup checks** on the Add user page show what's configured, never the values.

## Endpoints
    GET  /                       dashboard
    GET  /connect                link a bank/card
    GET  /add-user               setup checks + the values to add a person
    POST /link/token             {owner} -> {link_token, plaid_account}   (overflow chosen here)
    POST /link/exchange          {owner, plaid_account, public_token}     (starts the first sync)
    POST /link/token/update      {item_id}  (reconnect a bank that needs a new login)
    GET  /items                  linked institutions + status
    GET  /accounts               accounts + balances   (?owner=)
    GET  /transactions           unified feed   (?owner= &tag= [repeatable] &tag_mode=any|all &q= &start= &end= &account_id=)
    GET  /tags                   distinct tags in use
    PUT  /transactions/{id}/tags {tags:[...]}  replace a transaction's tags
    GET  /capacity               per-person trial usage (used/cap)
    GET  /users                  people from MINTY_USERS + which key slots are set (no secrets)
    GET  /status                 setup checks (no values)
    GET  /healthz                liveness (ungated)

## Development
    npm ci                                              # Node 22+
    npm test                                            # workerd + local D1, no network
    npm run typecheck
    npm run db:migrate:local && npm run db:seed:local   # demo data
    npm run dev                                         # http://localhost:8787 (Access bypassed, localhost only)

Against Plaid Sandbox: put Sandbox keys and a `TOKEN_ENC_KEY` in `.dev.vars` (see
`.dev.vars.example`), start `npm run dev`, then run `node scripts/sandbox-e2e.ts`.
To run the cron sync by hand locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+*+*+*+*"`.

## Notes
- Plaid amount sign: POSITIVE = money out, stored as integer cents. The dashboard flips it.
- Plaid returns the account **mask** (last 4), never the full number.
- Tags are separate rows that sync never touches, so labels survive re-syncs.
- On the free plan a new bank's history backfills about 100 transactions per hourly run
  (10 ms CPU limit). Workers Paid can raise `SYNC_MAX_BYTES_PER_RUN`.
- Minty started as a Python/Docker app; its last version is tagged `python-app-final`.

Status and next steps: [docs/STATUS.md](docs/STATUS.md).

## License

MIT. See [LICENSE](LICENSE).
