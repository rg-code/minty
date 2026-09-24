# Plan: Minty on Cloudflare Workers (one deployment per household)

Status: **proposal, waiting for go-ahead.** No code has been written.

Decisions already made:
- Option C: each household runs its own Worker plus D1 database.
- The repo will be public.
- The server will be rewritten in TypeScript.

Facts were checked against the Plaid, GitHub and Cloudflare docs on 2026-09-24. Items marked **(verify)** get confirmed in the phase where they come up.

## 1. Goal

Anyone (you, friends, family) can copy this repo and run Minty for their own household:
- no Docker, no always-on machine, no Tailscale
- about $0 a month
- they only ever hold their own data and keys

Your household moves over without re-linking banks. Re-linking would use up Trial slots, because `/item/remove` does not free one.

## 2. Architecture

```
 Household's copy of the repo (public code, no secrets)
        │  push to main → Cloudflare Workers Builds: apply D1 migrations, then deploy
        ▼
┌──────────────────────── Household's Cloudflare account (free) ───────────────────────┐
│  Cloudflare Access (Zero Trust, free up to 50 users): emailed one-time-code login     │
│        │   protects the whole workers.dev address: pages AND API                     │
│        ▼                                                                              │
│  Worker "minty" (TypeScript)                                                          │
│   • static pages: app/static/*.html (same pages as today, same API paths)            │
│   • API (the Worker handles these paths first): /users /items /accounts /capacity    │
│       /transactions /tags /transactions/:id/tags /link/token /link/exchange         │
│       /link/token/update /healthz                                                    │
│   • checks the Access login token on every API call; if Access isn't configured,     │
│       it refuses every request                                                       │
│   • scheduled(): cron sync, resumable, with a fixed budget per run                   │
│   • secrets: PLAID_CLIENT_ID_*/PLAID_SECRET_*, TOKEN_ENC_KEY                         │
│   • plain settings: MINTY_USERS, PLAID_ENV, TRIAL_ITEM_CAP, ACCESS_TEAM_DOMAIN,      │
│       ACCESS_AUD                                                                     │
│        │                                                                              │
│        ▼                                                                              │
│  D1 (SQLite): items, accounts, transactions, transaction_tags, d1_migrations          │
└───────────────────────────────────────────────────────────────────────────────────────┘
        │  fetch() to Plaid's REST API (no Plaid SDK)
        ▼
      Plaid (each household's own Trial team)
```

GitHub Actions runs **only tests** on pull requests. That's a normal CI use, allowed by GitHub's Actions terms. Deploys happen on Cloudflare's side (Workers Builds), so no Cloudflare token is stored in GitHub.

## 3. Key design points

**Same frontend, same API.** The Worker serves the existing pages from `app/static` and keeps today's API paths and response shapes. So `index.html` and `connect.html` work on both backends while we transition. The multi-tag filter (`?tag=a&tag=b&tag_mode=any|all`) comes along.

**Auth replaces the Tailscale gate:**
- Access protects the whole `workers.dev` address and its preview addresses, pages included.
- Because static assets sit behind Cloudflare's internal router, the Worker doesn't receive the logged-in identity. So on every API call it validates the `cf-access-jwt-assertion` header itself. It uses `jose`, the team's public keys at `<team>.cloudflareaccess.com/cdn-cgi/access/certs`, and the app's `ACCESS_AUD` tag.
- **It fails closed.** If the Access settings are missing, every API call returns 403. (Today, an empty `ALLOWED_LOGINS` silently turns the gate off.) `/healthz` stays open.
- Local development uses wrangler's built-in stand-in for an Access identity.

**Bank tokens use a Fernet-compatible format:**
- Plaid access tokens stay encrypted with Fernet (AES-128-CBC plus HMAC-SHA256, both in WebCrypto) under the same `TOKEN_ENC_KEY`.
- Tokens the Python app wrote decrypt as they are, so migrating needs no plaintext step.
- Cross-compatibility tests use test values produced by Python's `cryptography` library.
- Tokens are never logged or returned (unchanged rule).

**Data model in D1 (new `d1/migrations/`, tracked in `d1_migrations`):**
- The `items` and `accounts` tables are the same as today. The `owner` / `plaid_account` distinction and `choose_account_for()` routing (primary, then backup) are unchanged.
- **Amounts are stored as whole cents** (`amount_cents INTEGER`) so totals are exact. The API still returns `amount` in dollars, and Plaid's sign convention (positive = money out) is unchanged.
- Tags move from `text[]` into `transaction_tags(transaction_id, tag COLLATE NOCASE)`:
  - Primary key on the pair, an index on `tag`, and rows deleted along with their transaction.
  - Sync never writes this table, so the rule that re-syncs keep user tags holds by construction.
  - "Any" filtering uses `EXISTS … tag IN (…)`. "All" uses `GROUP BY … HAVING count(DISTINCT tag) = n`.
- Dates are ISO strings.

**Sync fits the free-plan limits:**
- The free plan allows 10 ms of CPU and 50 outbound calls per run. Waiting on Plaid doesn't count as CPU.
- Each Plaid page (`count` 100–500), its account and transaction upserts, removals, and the cursor advance are written in **one D1 `batch()`**. D1 applies a batch as a single transaction, so the cursor still only moves after the page is saved.
- Each run has a budget (about 40 outbound calls plus a time check). When it's used up, the run stops and the next one resumes from the saved cursor.
- **Link exchange:** stores the item, then starts the first pages in the background (`ctx.waitUntil`). The rest follow on the next cron. The dashboard shows "syncing…" until the item has a cursor.
- **Cron:** hourly by default (Plaid itself refreshes each bank 1–4 times a day). The final cursor stays valid for at least a year.
- Plaid webhooks are **not** used in v1. Plaid can't get past Access, and polling is enough.
- `ITEM_LOGIN_REQUIRED` sets the item to `login_required`, and the dashboard offers "Reconnect" (update mode already exists).
- Fallback if 10 ms isn't enough: smaller pages. Otherwise Workers Paid ($5/month) gives 30 s of CPU per cron run. **(verify in P2 with a full 24-month pull)**

**Adding a person:** `MINTY_USERS` becomes a Worker setting. The `/add-user` page generates the setting value and the two Plaid key pairs to add as Worker secrets (the dashboard steps, or `wrangler secret put …` commands). Secrets still never pass through the browser or the database.

**Secrets hygiene in a public repo:**
- `.dev.vars` (local secrets) is gitignored and added to the Claude Code deny list alongside `.env`.
- `.dev.vars.example` holds placeholders only.
- Turn on GitHub secret scanning with push protection.
- A pre-publication scan of the full git history found no secrets. The only hits were test placeholders.

**Local development and tests:**
- `wrangler dev` with local D1 (Miniflare). No Postgres, conda or Docker needed.
- Vitest with Cloudflare's Workers test pool.
- Plaid is faked (as the pytest suite does today). The pytest cases for data, the gate, users, config, crypto, link and sync are ported one for one.
- A seed script provides demo data (the equivalent of `~/minty-local/seed.py`).

## 4. Phases (each ends with a PR you review)

| Phase | Scope | Done when |
|---|---|---|
| **P0 Prep** (small) | Enable secret-scan push protection, add a LICENSE, deny `.dev.vars` in Claude Code settings, **make the repo public** (with your OK), merge or close the multi-tag PR | Repo is public; nothing sensitive in it |
| **P1 Skeleton + read API** | `wrangler.jsonc` and `src/` at the repo root, next to the Python app (no clashing paths). Static pages, Access login check (fails closed), D1 schema, every read route plus tag editing and the multi-tag filter, seed script, ported tests | Dashboard works under `wrangler dev` on seeded data, identical to today |
| **P2 Plaid + sync** | Fernet module (cross-tested against Python), Plaid REST client, `/link/*`, sync engine, scheduled handler with budget | On a throwaway Cloudflare account with **Plaid Sandbox**: link, backfill, cron sync, reconnect. CPU and outbound calls measured |
| **P3 Deploy + onboarding** | `deploy` script (`d1 migrations apply --remote && wrangler deploy`), CI tests on PRs, `SETUP.md` checklist for friends, `/add-user` for Workers, update path. **Choose between** the Deploy button (one click, auto-creates D1, but makes a copy, so updates are manual) **and** fork + Cloudflare "Import repository" (GitHub's "Sync fork" then redeploys) by trying both on a throwaway account | A brand-new account goes from zero to a working Sandbox dashboard using only `SETUP.md` |
| **P4 Migrate your household** | Export script run on the Immich box: Postgres to D1 SQL, tokens **still encrypted**, cursors and tags kept. Rehearse into a dev D1, compare row counts. Then cut over **(needs your go-ahead: touches production)**. Run both side by side for about a week, then retire Docker/Tailscale, delete the Python app, rewrite CLAUDE.md and README | All existing banks sync on Cloudflare with no re-linking; old stack turned off |

## 5. Changes to CLAUDE.md rules (need your approval; applied in P4 docs, followed from P1)

| Current rule | New rule |
|---|---|
| Tailscale identity gate, `ALLOWED_LOGINS`; empty means gate off | Cloudflare Access plus a login-token check in the Worker on every API route; **missing settings mean everything is refused** |
| Postgres; migrations run by hand in `migrations/`, untracked | D1; `d1/migrations/`, tracked in `d1_migrations`, applied automatically on deploy; new schema changes go in a new file, never an edited one |
| Docker Compose on the Immich box; development on WSL | Cloudflare Workers per household; development with `wrangler dev` anywhere |
| Secrets in `.env` | Worker secrets; `.dev.vars` locally (never read or committed); `.dev.vars.example` placeholders |
| No HTTP sync endpoint | **Unchanged by default** (cron only; the link exchange starts the first sync internally). See decision 1 |
| Fernet tokens, owner/plaid_account distinct, tags never written by sync, cursor-based sync | Unchanged |

## 6. Risks and open questions

- **Free-plan CPU (10 ms):** the biggest technical risk. It's measured in P2, with smaller pages and Workers Paid as fallbacks.
- **Cloudflare Access on the free plan:** it may ask for a payment method even at $0 **(verify in P2)**.
- **Local cron testing with static assets:** there's a known wrangler bug (workers-sdk #9882). Workaround: test the sync function directly, and run cron in the deployed dev Worker.
- **Plaid for friends:** each household applies for its own Trial team (new teams get Trial, 10 banks, ID verification). That's their data under their own developer account, which is the intended use.
- **Access protects pages at the edge, but the Worker also checks the login token on API calls.** Static HTML itself carries no data.

## 7. Decisions needed before P1

1. **"Sync now" button?** It would be an Access-protected `POST /sync`, which changes the "no HTTP sync endpoint" rule. The default is **no** (hourly cron only).
2. **License for the public repo.** Suggest MIT.
3. **Default cron frequency.** Suggest hourly.
4. **Amounts as whole cents in D1** (API shape unchanged). OK?
5. **When to make the repo public:** now in P0 (suggested; the history scan is clean) or later, at P3.
