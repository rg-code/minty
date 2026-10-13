# Minty status and to-do

Handoff notes for continuing on another machine. Last updated 2026-10-13.
Household-specific values (the workers.dev address, Access team and AUD, email addresses)
are deliberately **not** in this public repo. They're in the owner's Cloudflare dashboard.

## Where things stand

- **Code:** Minty is Cloudflare-only (a Worker plus D1, on free plans); everything through #44 is
  on `main`. CI (vitest in workerd + typecheck) runs on every PR, and Workers Builds deploys
  `main`. **Tests: 281.** Migrations 0001–0008.
  - Plan and decision log: [serverless-plan.md](serverless-plan.md) §8. ABC: [abc.md](abc.md).
    Finance agent: [agent-plan.md](agent-plan.md). Live demo: [demo.md](demo.md).
- **Licence:** PolyForm Strict 1.0.0 since #39 (source-available: use unmodified, noncommercial;
  no changes or redistribution). Copies taken before #39 keep MIT. The old Python/Docker app is
  the `tailscale-selfhosted` branch and the `python-app-final` tag, both moved to PolyForm Strict
  on 2026-10-13. Untested, and linked from GET-STARTED for people with a home server.
- **The owner's household deployment:** live on **Plaid production** since 2026-09-30, with
  **8 banks and 28 accounts**, all under `me`.
  - **Access:** the policies, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ALLOWED_LOGINS` are set.
    A login must be on both Access's policy and `ALLOWED_LOGINS`.
  - **`TOKEN_ENC_KEY`:** set 2026-09-26 and kept in a password manager. Losing it means
    re-linking every bank.
  - **Builds:** preview URLs are off, and the production branch is `main`.
  - **Sync:** the cron runs hourly (`17 * * * *`), plus a 10-minute catch-up. All 8 banks were
    caught up by 2026-10-11 after the stall fix (#27).
  - **D1 rows read:** the free quota ran out once, on 2026-10-12, because ABC read 463,000 rows a
    request. Fixed in #32 with indexes and a per-route read budget (`test/reads.test.ts`).
  - **Spouse slot:** unused. Its `PLAID_*_SPOUSE_*` secrets are leftover Sandbox keys, and Setup
    checks flag them.
- **For friends:**
  - **Landing page:** https://minty.milesmaximizer.com, also reached via
    `milesmaximizer.com/minty/`. Code: rg-code/point-xfer `minty-site/`, a Cloudflare Pages
    project published with `node deploy.mjs`.
  - **On the landing page:** Get started opens [GET-STARTED.md](../GET-STARTED.md) in a side
    panel; Try the live demo runs the demo; plus fork, ZIP and clone links, share buttons and
    GoatCounter.
  - **Forks:** they update themselves every Monday (#41), after the one-time "enable workflows"
    click in each fork.

## Recently done (2026-10-10 to 10-13)

- **Sync (#27):**
  - Stalled downloads restart from where the update began (`items.sync_start_cursor`).
  - A 10-minute catch-up trigger continues unfinished downloads.
- **Bank problems are never silent (#28):** a status strip on the dashboard and the same lines in
  Setup checks (`src/health.ts`), plus a daily `/item/get` check. Citibank, Navy Federal and Amex
  consent ends **2027-09-30**, so the strip warns from about 2027-09-23.
- **ABC, "All but coupon clipping" (#30–#33):**
  - A popup listing every card credit, used and still open, checked against statement credits.
  - Covers Amex Platinum, Business Platinum and Business Gold, Citi Strata Premier and U.S. Bank
    Altitude Reserve.
  - #32 fixed the read quota; #33 counts Walmart+ credits that post as a "Walmart" refund.
- **Dashboard:**
  - **Look:** a Dates menu and a tidier ABC (#34), a mint background (#35), the coin logo (#36).
  - **The coin (#37):** click it to refresh and request a sync (recorded only; the next cron run
    syncs). Also Show more past 500, and "Last synced".
  - **Install as an app (#40):** Chrome, Safari and Edge, with GRAZE's Samsung Internet handling.
- **Onboarding:** GET-STARTED.md, a one-page guide for anyone (#38, #42, #43). The licence change
  (#39). Weekly fork sync (#41).
- **Live demo (#44):**
  - **What it is:** the real dashboard and Worker in the browser over sql.js. About 500 made-up
    transactions, a working ABC, and a coming-soon "AI connector" dialog.
  - **Speed:** about 0.8 s from click to transactions.
  - **Upkeep:** rebuilt and published with the landing page (`node deploy.mjs` in point-xfer
    `minty-site/`).

## To do, in order

1. **Quick checks on the live deployment** (the owner, in the dashboard):
   - **CPU:** **Worker → Metrics** for "Exceeded CPU", especially `/benefits` and the catch-up
     runs.
   - **D1 rows read:** **D1 → minty → Metrics** after a day of normal use with ABC. The budget
     is 5,000,000 a day.
   - **Barclays and Taekus:** their newest transactions are Jun 5 and Sep 23 although both sync
     hourly, and Barclays has exactly 100 transactions. If those cards are still in use,
     something is off.
   - **Amex card members (15):** if some are one person in different formats, a later change
     could merge or rename them.
2. **ABC coverage for the household's other cards.** Cards ABC doesn't know show as untracked;
   add the ones the household holds to `src/benefits/catalog.ts`, with sources and `CHECKED`.
   Re-check the existing benefits when issuers change them; the last check was 2026-10-12.
3. **Decide where MCP goes.** The live demo shows an "AI connector (MCP), coming soon" button, but
   [agent-plan.md](agent-plan.md) has the MCP server as optional phase **A7**. The options:
   - move MCP earlier, as a read-only server built on A1's query tools, so Claude Desktop and
     similar apps can use it before the chat panel exists; or
   - relabel the demo's button "Ask Minty (coming soon)".
4. **The finance agent ("Ask Minty").** Its to-do is §11 of [agent-plan.md](agent-plan.md), and
   its decisions were made 2026-10-06. **Next: A0** (§8.1). It needs the owner's go-ahead plus an
   OpenRouter key (training off) and a Workers AI token in `.dev.vars`.
5. **Landing page and demo upkeep:**
   - After dashboard changes, run `node deploy.mjs` from `point-xfer/minty-site/` so the demo
     follows. A dashboard change the demo can't follow stops the build, by design.
   - Check that the first Monday run of **Stay up to date** on a friend's fork (2026-10-19)
     passes.
6. **Owner housekeeping:**
   - **Leaked commit in point-xfer:** commit `14df20b` (a wrangler cache, with account and
     location details) is still reachable through closed PR #26. Ask GitHub Support to purge it.
   - **Spouse secrets:** delete the unused `PLAID_*_SPOUSE_*` secrets, and set `MINTY_USERS` to
     `me:<Your name>` to show your name. Keep the key `me`: your banks are stored under it.
   - **Wrangler logins:** `npx wrangler logout` on machines that don't need Cloudflare access.
   - **Plaid Sandbox end-to-end:** the owner runs `node scripts/sandbox-e2e.ts` against
     `npm run dev`, because it reads `.dev.vars`.
7. **Ongoing:**
   - **Keep Cloudflare's "Update your Wrangler configuration" prompt unapplied:** `keep_vars`
     already preserves dashboard variables, and copying them into `wrangler.jsonc` would publish
     the household's emails and Access IDs.
   - **Each new bank uses a Plaid Trial slot for good** (10 per credential set), so link only
     banks you'll keep.
   - **Workflows:** a change under `.github/workflows/` breaks every fork's next automatic sync
     until its owner clicks Sync fork, so only make one when it's worth that, and say so in the
     PR.
   - **Deploys:** if a merge doesn't show up live, check **Workers & Pages → minty → Builds** and
     retry the build.
   - **CPU after linking a bank with a long history:** an overrun is safe, because each page
     commits with its cursor. If overruns become frequent, lower `SYNC_MAX_BYTES_PER_RUN`, or move
     to Workers Paid and raise it.
8. **Later:**
   - Onboard friends with GET-STARTED.md, and fix anything they trip on.
   - Email or push alerts for bank problems (they'd need an outbound mail setup).
   - Several Plaid Trial accounts per person is a Plaid ToS gray area. One paid Plaid account per
     person is the cleaner long-term option. Deferred, not forgotten.

## Picking up on a new machine

    git clone git@github.com:rg-code/minty.git && cd minty
    npm ci                       # Node 22+; if npm 10 errors resolving new deps, use npx npm@11
    npm test && npm run typecheck
    npm run db:migrate:local && npm run db:seed:local && npm run dev:demo   # http://localhost:8787, two demo people
    npm run build:demo           # the live demo, in dist/demo (serve that folder at /demo/)

- **Cloudflare CLI** (optional; the dashboard is enough): `npx wrangler login`.
- **Temporary QA accounts:** `npx wrangler deploy --temporary` works for Workers + D1. It can't
  run cron or migrations there. See serverless-plan.md §8.
- **The landing page** needs point-xfer next to this repo: `cd ../point-xfer/minty-site && node deploy.mjs`.
