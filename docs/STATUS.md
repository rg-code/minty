# Minty status and to-do

Handoff notes for continuing on another machine. Last updated 2026-10-12.
Household-specific values (the workers.dev address, Access team and AUD, email addresses)
are deliberately **not** in this public repo. They're in the owner's Cloudflare dashboard.

## Where things stand

- **Code:** Minty is Cloudflare-only: phases P0–P4 are on `main`. P4 removed the Python/Docker
  app (its last version is tagged `python-app-final`) and moved the pages to `public/`.
  CI (vitest in workerd + typecheck) runs on every PR.
  - Tests: 219 Worker.
  - Since then: filter by bank (#18) and by card/account (#19), and one person by default with
    the person switch only for two or more (#20). Card members on multi-card accounts (#23–#25).
    The sync-stall fix and 10-minute catch-up (#27). Bank problems on the dashboard and a daily
    Plaid connection check (#28).
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
        and linked real banks, all under Me (none under Spouse): **8 banks, 28 accounts**.
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

## Recently done

- **Sync stall fixed (#27, migration 0004; deployed 2026-10-10).** Wells Fargo and Citibank had
  stopped after their first page at link time (Sep 30), and Amex on Oct 7 partway through its
  history. All three were still `good`, so nothing warned. Cause:
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` was retried from the run's cursor instead of the
  update's first cursor, which fails forever. They also slowed the other five banks to about
  one sync every 5 hours. Now `items.sync_start_cursor` remembers where an update began, and a
  10-minute catch-up trigger continues unfinished downloads. **All 8 banks were caught up by
  2026-10-11 03:17 UTC** (Amex 907 → 2,333 transactions, newest Oct 9). Details: serverless-plan.md
  §8, 2026-10-10.
- **Bank problems are never silent (#28, migration 0005; deployed 2026-10-11).** A status strip
  under the dashboard header lists every bank that needs attention: what went wrong in plain
  words, Plaid's own message, and a Reconnect / Link-again button. It stays until the problem is
  fixed, and Setup checks show the same lines (`src/health.ts`). A daily `/item/get` check per
  bank catches broken connections early and records consent end dates. Citibank, Navy Federal
  and Amex end on **2027-09-30**, so the strip warns from about 2027-09-23. Reconnecting renews
  them.
- **Amex card members (#23–#25):** Amex sends the card member (15 of them), and each is listed
  under its Amex card in **Cards & accounts**, with `/transactions` taking
  `card=<account_id>:<member>`.

## To do, in order

1. **Quick checks after the Oct 10–11 deploys:**
   - Look at the dashboard's status strip in light, dark and phone views (not checked visually
     yet: no screenshots were possible). It's empty while every bank is healthy.
   - **Barclays and Taekus:** their newest transactions are Jun 5 and Sep 23 although both sync
     hourly, and Barclays has exactly 100 transactions. If those cards are still in use,
     something is off; if not, nothing to do.
   - **CPU** (**Worker → Metrics**, "Exceeded CPU"), especially around the Oct 10–11 catch-up.
   - **Amex card members:** if some of the 15 are one person in different formats, a later change
     could merge or rename them.
2. **ABC ("All but coupon clipping"): track card credits.** A page listing every monthly,
   quarterly, semi-annual and annual credit on the household's cards, with what's been used and
   what's still open, checked against the statement credits in the transactions. **Built in
   #30** (design agreed 2026-10-12; [abc.md](abc.md)); after merging, look at `/abc` and check
   CPU on the Worker's Metrics for `/benefits`. Refresh the benefit list when issuers change
   credits (`src/benefits/catalog.ts`, `CHECKED`).
3. **The finance agent ("Ask Minty").** Plan: [agent-plan.md](agent-plan.md); its to-do list is
   §11 there. Decisions are made (2026-10-06): household secret; OpenRouter free models, Workers AI,
   and the household's own OpenAI/Anthropic keys; tagging with Confirm from the start; free plan
   only; automations with a **dashboard inbox**. **Next: A0** (§8.1), which needs the owner's
   go-ahead and a few keys in `.dev.vars`.
4. **Optional tidy-up:**
   - Delete the unused `PLAID_*_SPOUSE_*` secrets (Setup checks flag them), and set `MINTY_USERS` =
     `me:<Your name>` to show your name. Keep the key `me`: your banks are stored under it.
   - `npx wrangler logout` on machines that don't need Cloudflare access.
   - Plaid Sandbox end-to-end (the owner runs it because it reads `.dev.vars`):
     `node scripts/sandbox-e2e.ts` against `npm run dev`.
5. **Ongoing:**
   - **Keep Cloudflare's "Update your Wrangler configuration" prompt unapplied.** `keep_vars`
     already preserves dashboard variables across deploys, and copying them into `wrangler.jsonc`
     would publish the household's emails and Access IDs in this public repo.
   - **Each new bank uses a Plaid Trial slot for good** (10 per credential set), so link only
     banks you'll keep.
   - **Deploys:** if a merge doesn't show up live, check **Workers & Pages → minty → Builds** for
     a missing or failed build of that commit, and retry it (#25's merge didn't start one).
   - **CPU now and then**, especially after linking a bank with a long history. An overrun is
     safe (each page commits with its cursor). If they become frequent, lower
     `SYNC_MAX_BYTES_PER_RUN`, or move to Workers Paid and raise it (e.g. 20000000 bytes / 50 pages).
6. **Later:**
   - Onboard friends from SETUP.md (fork → import → …) and fix anything they trip on.
   - Email or push alerts for bank problems (they'd need an outbound mail setup).
   - Several Plaid Trial accounts per person is a Plaid ToS gray area; one paid Plaid account per
     person is the cleaner long-term option. Deferred, not forgotten.

## Picking up on a new machine

    git clone git@github.com:rg-code/minty.git && cd minty
    npm ci                       # Node 22+; if npm 10 errors resolving new deps, use npx npm@11
    npm test && npm run typecheck
    npm run db:migrate:local && npm run db:seed:local && npm run dev:demo   # http://localhost:8787, two demo people

- **Cloudflare CLI** (optional; the dashboard is enough): `npx wrangler login`.
- **Temporary QA accounts:** `npx wrangler deploy --temporary` works for Workers + D1. It can't
  run cron or migrations there. See serverless-plan.md §8.
