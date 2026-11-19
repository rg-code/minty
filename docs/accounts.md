# Plan: manual accounts and an Accounts view

**Status: plan, for the owner's review (2026-11-19). Nothing is built.** Ideas from a fork
(Shayaeng/minty), used with its author's permission; the design here is Minty's own.

Two pieces that go together:

1. **Manual accounts:** accounts Plaid can't see, typed in. A house, a car, a loan from family,
   a pension statement, an account at a bank Plaid doesn't support. They count in net worth and
   show next to the linked accounts.
2. **An Accounts view:** every account in one place, grouped, with totals, per person.
3. **Holders and a beneficiary** on any account: who holds it (one person, or two for a joint
   account) and who it's for (a child's 529 or custodial account, a beneficiary named on an IRA).
   This is the useful part of the fork's "people in D1" change, **without moving people out of
   `MINTY_USERS`** (owner's decision, 2026-11-19).

## 1. Where a manual account lives

**In `accounts`, like a linked one.** Everything that reads accounts then works unchanged:
- balance snapshots and net worth (CFA);
- display names (`ACCOUNT_NAME`);
- "left out of the numbers";
- EGG's retirement split (`IN_RETIREMENT`) and the person filter.

A separate table would mean a `UNION` in each of those.

**Each account needs a bank row** (`accounts.item_id` is `NOT NULL`, and changing that means
rebuilding the table, which migrations here never do). So each person gets **one "manual" bank
row**:
- `products = 'manual'`, `status = 'manual'`, `plaid_account = ''`, `plaid_item_id = 'manual:<owner>'`,
  `access_token_enc = ''`;
- it's created the first time that person adds a manual account.

A manual account's own row:
- `plaid_account_id = 'manual:<uuid>'`, which stays unique, and sync only ever matches Plaid's ids;
- `is_manual = 1`.

**The guard.** Minty walks the banks in about 35 queries across 15 files: sync, health, Setup
checks, the Trial cap count, statements, investments, token-key rotation, the bank filter. Each
one must skip manual rows. The one that matters most is token-key rotation, which would count an
empty token as unreadable.
- One SQL fragment does it: `PLAID_ITEM("i")` is `i.products <> 'manual'`, in `src/accounts.ts`.
- **A test** reads every `FROM items` / `JOIN items` in `src/` and fails unless the query uses
  the fragment, or is on a short allow-list of queries that mean all rows (the bank filter, which
  shows "Entered by hand" as one choice).
- The Trial cap counts by `plaid_account`, so `''` never fills a slot. The test covers it anyway.

Sync never writes manual accounts: it upserts by Plaid's account ids, and manual rows have none.

## 2. Kinds of account

Plaid's own `type` and `subtype` where one exists, so the rest of Minty understands them:

| Group | Stored as | Examples |
|---|---|---|
| Cash | `depository` / checking, savings, cd, money market | an account at a bank Plaid doesn't support |
| Investments | `investment` / brokerage, 529, … | a brokerage that blocks aggregators |
| Retirement | `investment` / 401k, ira, roth, pension, … | a pension statement (goes to EGG, as linked ones do) |
| Card or loan | `credit` / credit card; `loan` / mortgage, auto, student, other | a family loan, a mortgage servicer Plaid lacks |
| **Other asset** (new) | `other` / real estate, vehicle, valuables, other | a house, a car |

**Net worth gains one rule:** `type = 'other'` on a manual account counts as an asset. CFA's net
worth SQL and its rebuild get that one `CASE` line. The monthly totals have no transactions from
manual accounts, so nothing else changes, and no `RULES_VERSION` bump is needed.

✋ **Decide:** the fork's catalog of 24 types is more detailed (education, custodial, HSA as its
own group). I'd start with the table above and add types when there's a real account for them.

## 3. Balances and their dates

- A manual balance has a date: "as of" the day you looked, defaulting to today, never in the
  future. New columns: `accounts.balance_as_of`, `accounts.is_manual`, `accounts.notes`.
- **Snapshots stay cron-only** (CFA's rule). Saving a balance writes the account row, nothing else.
  The hourly snapshot dates a manual account's snapshot by its `balance_as_of`, not today. If
  that date is earlier than the newest snapshot, it sets `networth_dirty`, so net worth's history
  is rebuilt on that run. An old valuation never looks new, and a back-dated one lands on its day.
- **Stale balances:** a manual balance older than 90 days shows "updated 4 months ago" in
  Accounts. It's a reminder, never an automatic change.
- **Currency:** the account's currency is stored as entered. Today net worth adds up balances
  whatever their currency. ✋ **Decide:** the proposal is that Accounts shows each account's
  currency, and totals and net worth leave a non-USD account out, with a note. That also changes
  net worth for any linked non-USD account, so it's a CFA change too.

## 4. The Accounts view

In the ⋯ menu next to Bills and CFA, as a popup like CFA (`public/accounts.js`, `accounts.css`).

- **Groups:** Cash, Cards, Loans, Investments, Retirement, Other assets. Each group has its total,
  then net worth (assets less debts) at the top. The numbers are CFA's: what's left out of the
  numbers is shown greyed with "left out", not counted.
- **Person switch:** the dashboard's (Combined, then each person). It's a filter, as everywhere;
  §5 adds holders and beneficiaries to it.
- **Each row:** display name, bank (or "Entered by hand"), ••mask, balance, and its date. Linked:
  when the bank last reported it; manual: its as-of date, flagged when stale.
- **Actions:** rename (the existing `PUT /accounts/{id}/name`), "update balance" and edit or
  remove for manual accounts, and "Add an account by hand" at the bottom.
- **Removing** a manual account deletes it and its snapshots (`ON DELETE CASCADE`) after a
  confirm. Linked accounts can't be removed here; that's security step 5b.

**API:**
- `GET /accounts?view=all` already returns every account with `in_retirement`. It gains
  `is_manual`, `balance_as_of` and `notes`.
- New: `POST /accounts/manual`, `PUT /accounts/{id}/manual` (name, type, subtype, owner, mask,
  currency, balance, as-of, notes) and `DELETE /accounts/{id}/manual`. They refuse a linked
  account, and they're validated like the other routes (`jsonBody`, lengths, a 4-digit mask, the
  type from the list).
- `GET /accounts` reads card members from the transactions. For this view, `?members=0` skips
  them, so it reads one row per account. It gets a budget line in `test/reads.test.ts`.

## 5. Holders and a beneficiary

The fork moved people into a D1 table to get these. Minty keeps `MINTY_USERS` as the one list of
people (CLAUDE.md), and adds only the relationships:

| Column (on `accounts`) | Holds | Example |
|---|---|---|
| `holders` | a JSON array of `MINTY_USERS` keys, at most 4; empty means "the owner" | `["me","sam"]` for a joint checking account |
| `beneficiary` | a `MINTY_USERS` key, or a name for someone who isn't a Minty person (up to 100 characters) | `"kim"`, or `"Ava"` for a child with no Minty login or banks |

**What doesn't change:**
- `owner` is still the account's one person: the person switch filters by it, totals count by it,
  and Plaid credentials are still chosen by it. Holders and beneficiary are **labels and an extra
  filter**, never an access boundary (the trust model is unchanged), and never a way to pick
  Plaid keys.
- **Sync never writes them**, like `display_name`, so they survive re-syncs and reconnects. They
  work on linked accounts too, not only manual ones: a 529 at a linked brokerage needs a
  beneficiary just as much.
- A key later removed from `MINTY_USERS` still shows, as the key itself, with "(not in
  MINTY_USERS)". Setup checks list accounts whose holders or beneficiary name an unknown key, the
  way they flag stranded banks.

**Where they show:**
- **Accounts view:** under the name, "Held by Alex & Sam" and "For Ava". The person switch gains
  a choice: **Owned** (the default, what totals count) or **Owned, held or for** (adds the
  accounts where that person is a holder or the beneficiary, marked, and not added to that
  person's totals, so nothing is counted twice).
- **EGG:** a retirement account's beneficiary shows on its card. A 529 or custodial account in
  the Investments group shows who it's for.
- **The dashboard's account filter:** unchanged.

**Editing:** `PUT /accounts/{id}/holders` takes `{ holders: [keys], beneficiary: key or name or
null }`. It works for every account; keys must be in `MINTY_USERS`; at most 4 holders. Manual
accounts set them in the same form as the rest of their fields. A test checks that sync leaves
both columns alone.

Not taken from the fork: a "responsible adult" field (for a custodial account, the custodian is
the holder), archiving people, and adding or renaming people in Minty (that stays in
`MINTY_USERS`).

## 6. To-do

✋ = needs the owner.

- [ ] ✋ Approve this plan, and the decisions in §2 and §3.
- [ ] A migration (the next free number, 0023 today): `accounts.is_manual`, `balance_as_of`, `notes`,
      `holders` (default `'[]'`), `beneficiary`. Added to `EXPECTED_MIGRATIONS`.
- [ ] `PLAID_ITEM()` in every bank-walking query, and the test that enforces it.
- [ ] The manual routes, the snapshot dating, and net worth's `other` assets, with tests on local D1.
- [ ] `PUT /accounts/{id}/holders`, the Setup check for unknown keys, and a test that sync never
      writes `holders` or `beneficiary`.
- [ ] The Accounts popup (with `sw.js`'s shell updated and its cache name bumped), light and dark, phone.
- [ ] The demo: a manual house and car in the made-up household (`test/demo.test.ts`).
- [ ] ✋ Try it on the live deployment: add one manual account, check net worth the next hour.
