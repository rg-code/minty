# Plan: MAP (Miles And Points)

**Status: proposed 2026-10-16, waiting for the owner's decisions (§5). No code yet.**

Your own award wallet: every miles and points balance in the household, in one view, grouped by
currency (Chase Ultimate Rewards, Amex Membership Rewards, United, Hyatt, …). Each balance
shows when it was last updated. Balances come from statement PDFs read on your device (exactly
like Bills) or are typed in by hand.

MAP never signs in to a loyalty program, never stores a loyalty login, and never scrapes a
website. Plaid doesn't report points, so the PDFs and your own numbers are the only sources. That
is on purpose: it avoids the credentials and the terms-of-service problems that scraping wallets
have.

## 1. The view

A header button **MAP**, next to ABC (and EGG), opens a popup like ABC and Bills.

- **One row per balance:**
  - the currency and its kind (bank points, airline, hotel);
  - the person, with the account's last 4 digits when there's more than one;
  - **the number of miles or points**;
  - **last updated**, as a date with "3 days ago". Balances not updated in 90 days are greyed,
    with "update?".
- **Grouped by currency,** with a total per currency across the household, because points in the
  same program often can be combined. The person switch filters, as everywhere.
- **Update a balance** by editing it in place (a new reading), or with **Add from PDFs** /
  **Add a folder**, like Bills.
- **History:** each reading is kept, so a balance's row can open its past values (when, how much,
  from which PDF). That's a small trend for free, with no extra fetching.

## 2. Reading statements (the Bills way, shared)

- **The same flow as Bills:** pick PDFs or a folder (remembered on Chrome and Edge). Each PDF is
  fingerprinted (SHA-256) and checked against the ones already added. Only new ones are read with
  pdf.js, on the device. A review table shows what was found, editable, before anything is saved.
  **The PDFs never leave the device**: only the program, balance, date, last 4 digits and the
  fingerprint are saved.
- **Shared code:** the PDF part of `public/bills.js` (fingerprint, pdf.js text, folder, the
  "already added" check, the skipped list) moves to `public/pdf-read.js`, used by both. Bills
  doesn't change for the user.
- **`public/points-parse.js`** works like `bill-parse.js`: a pure function, with its patterns in
  code and tests from made-up text. It reads:
  - **card statements** that print the rewards balance (the issuer's points currency, its
    balance, the statement date, the last 4 digits);
  - **loyalty programs' own statements** (an airline's or hotel's monthly email or PDF, saved as
    a PDF): the program, the balance, the "as of" date, the member number's last 4.
- A statement often carries both a bill and a points balance. With one remembered folder for
  both, each PDF can feed both views (§5).

## 3. Data and routes

- **The program catalog in code** (`src/points/programs.ts`): each currency's name, kind, unit
  (points or miles) and the patterns that recognise it, with a source and a `CHECKED` date, like
  ABC's catalog. Never fetched at runtime.
- **One table, added by a migration:** `point_balances (id, owner, program, account_hint,
  balance, as_of, source manual|pdf, file_sha256 UNIQUE, created_at)`.
  - Each row is one reading. The view shows the newest reading per (owner, program,
    account_hint).
  - Index on (owner, program, account_hint, as_of).
  - A program the catalog doesn't know can still be typed in by name (`program` is free text,
    capped at 40).
- **Routes:**
  - `GET /points`;
  - `POST /points` (a reading, by hand or from a PDF);
  - `PUT` and `DELETE /points/{id}`;
  - `POST /points/known` (which fingerprints are already added).
  - They're added to `run_worker_first`, with lines in `test/reads.test.ts` (tiny: one row per
    reading).
  - No Plaid, no cron, no new secret.
- **Demo:** made-up balances across a few currencies, so the demo shows MAP.

## 4. Phases

| Phase | What |
| --- | --- |
| **M1** | The view and typing balances in: catalog, table, routes, the MAP popup, history, "update?" |
| **M2** | PDFs: `pdf-read.js` shared with Bills, `points-parse.js` for card statements and the first loyalty programs, the review table |
| **M3** | Optional extras from §5, if wanted |

M1 is small and useful alone. M2 depends on real statement layouts: parser tests use made-up
text modelled on them, never a real statement.

**Possible extras (less is more, so each is optional):**
- **Which card earns into which currency:** ABC already knows the household's cards. MAP can list
  under each currency the cards that earn it.
- **Expiry reminder:** for programs whose points expire after inactivity, from a rule in the
  catalog (with source and `CHECKED`). Shown only when MAP knows the last activity date.
- **An estimated value** in dollars per currency, at a rate you set (values are opinions, so none
  are built in). Off by default.

## 5. Decisions for the owner

1. **The name:** MAP = **Miles And Points**? It's short, and it says what's inside. (Avoid naming
   it after AwardWallet, which is someone else's product.)
2. **One folder or two?** One remembered folder for Bills and MAP, with each PDF offered to both,
   or a separate statements folder for MAP. The suggestion is one folder: the same card statement
   often has both.
3. **Which programs first,** for M2's patterns: the currencies you hold, and whose statements you
   have as PDFs.
4. **The extras in §4:** none, some, or all.
