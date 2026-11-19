# SUB: sign-up bonuses (plan)

**Status: plan, for the owner's review (2026-11-19). Nothing is built.** Ideas from a fork
(Shayaeng/minty), used with its author's permission; the design here is Minty's own.

SUB keeps track of account-opening bonuses: a card's "spend $4,000 in 3 months, get 60,000
points", or a bank's "two direct deposits of $500 within 90 days, get $300, keep it open 6
months". For each offer it shows:
- what's left to do, and by when;
- whether it paid out;
- how long the account has to stay open.

It sits in the ⋯ menu next to Bills and CFA, as a popup. Its name follows ABC, BAM and EGG.

## 1. What Minty adds over a spreadsheet: progress from the transactions

**Spend toward a card's minimum.** Estimated from the card's own transactions:
- in the window from the opening date to the deadline;
- purchases, less refunds;
- not payments, fees, interest or transfers.
- Pending charges are shown apart.
- It's labelled an **estimate**, like Bills' "paid". Issuers decide what counts, and some exclude
  things such as gift cards.
- A bank whose feed isn't current says "can't tell yet", never "not met".

**Deposits for a bank bonus.** Money in on that account in the window, with direct deposits
(Plaid's income categories) counted apart, matched against a requirement such as "2 direct
deposits of at least $500".

**The payout.** A credit on that account after the requirements that looks like a bonus (a credit
with "bonus" or "reward" in its name, near the expected amount) is **offered** as the payout. It's
recorded only when you confirm. Points bonuses aren't in the bank feed, so you mark them received.
Their program comes from BAM's list, so the points can be checked against BAM's next reading.

**Queries:** one per offer, by account and date (`idx_txn_account_date`), bounding both ends of
the window. That's Bills' rule after the 85,000-row lesson. Every query gets a line in
`test/reads.test.ts`.

## 2. What it stores

A migration (the next free number after accounts.md's): three tables. Sync never writes them, and none of them changes a balance,
net worth or a transaction.

- **`sub_offers`**, one row per bonus pursued:
  - **who and where:** owner, `account_id` (nullable: an offer can be tracked from the day you
    apply, before Plaid shows the account; you link it later), the institution and product as
    typed, and kind (card, bank, brokerage);
  - **the reward:** cash in cents, or points and a BAM program id;
  - **dates:** opened, expected payout;
  - **holding rule:** a trigger (opened, paid, or a date you give) and a length in days or
    months, plus the rule in your own words;
  - **closing:** a manual "keep open until" that overrides the rule, and needs a reason;
  - **costs:** annual fee and its date;
  - **status:** planned, applied, open, met, paid, closed, or lost;
  - **source:** a link to the terms, the terms text (up to 8,000 characters, to fit the existing
    16 KiB body limit), and notes.
- **`sub_requirements`**, one or more per offer:
  - kind (spend, deposits, direct deposits, keep a balance, a number of transactions, other);
  - a target amount and/or count, a deadline;
  - completed: computed from the transactions, or ticked by hand, which wins.
- **`sub_payouts`**, one or more per offer (installments, corrections):
  - a date and an amount or points, either one can be unknown but not both;
  - the matched transaction id, if any.

## 3. Rules it keeps (from the fork's careful version)

- **It never says an account is safe to close.** The labels are:
  - "Keep open until 12 Jun 2027";
  - "Holding date reached: check the terms";
  - "Holding terms unknown".
- With several offers on one account, the latest known date governs. An unknown one keeps the
  account at "unknown".
- **A holding date is calculated only from an explicit rule.** "Keep open 6 months after the
  payout" needs the payout date; with no payout recorded, it stays unknown, never guessed.
  Months end on the last day of a shorter month (31 Jan + 1 month = 28 or 29 Feb). Dates are plain
  days, with no time of day.
- **Meeting the requirements doesn't mark it paid**, and being paid doesn't mark the requirements
  met. Each is its own fact.
- **Deadlines are plain dates:** overdue the day after, never on the day. The browser's date is
  used.
- In-app only: no email or push reminders. The dashboard's status strip could show "a SUB
  deadline in 7 days" later, as a separate decision.

## 4. The view

- **Open offers first:** what's left (a progress bar for spend and deposits), the deadline, and
  days left.
- **Then waiting for payout, then holding** (with the keep-open date), then closed and lost.
- **Person switch** as elsewhere.
- **Each offer opens to** its requirements, payouts, terms and notes, with edit.
- **Link an account:** offers with no account yet show the accounts linked since they were
  added, to pick from.

**API:** `GET /sub` (all offers, with computed progress), `POST /sub/offers`,
`PUT /sub/offers/{id}`, `DELETE /sub/offers/{id}`, and the same for `requirements` and
`payouts`. `jsonBody` with the 16 KiB cap throughout. `GET /sub` gets a read budget and goes in
`isHeavyRead` only if its reads grow with the transactions (they're bounded by window, so
probably not).

## 5. Decisions

✋ = the owner's.

1. ✋ The name **SUB**, in the ⋯ menu.
2. ✋ **Terms text up to 8,000 characters**, inside the existing 16 KiB limit. The fork allows
   48,000 and raises the limit for that route to 64 KiB; I'd rather keep one limit and link to
   the terms.
3. ✋ **What counts as spend** (§1): purchases less refunds on the card in the window, excluding
   payments, fees, interest and transfers. Shown as an estimate.
4. ✋ **No cash value for points** at first: SUB shows "60,000 Amex MR", not dollars. A value per
   point could come with BAM later.

## 6. To-do

- [ ] ✋ Approve this plan and §5.
- [ ] Its migration, added to `EXPECTED_MIGRATIONS`.
- [ ] `src/sub/` with pure functions:
  - holding dates (month ends, unknowns, several offers);
  - progress from rows;
  - payout matching.
  - Unit tests like `src/audit/rules.ts`'s, with a `CHECKED` date on the spend rule.
- [ ] The routes, the progress queries with read budgets, and a test that sync never writes
      `sub_*`.
- [ ] The popup (`public/sub.js`, `sub.css`, in `sw.js`'s shell, with its cache name bumped),
      light and dark, phone.
- [ ] The demo: two made-up offers, one open and one holding.
- [ ] ✋ Try it on a real offer.
