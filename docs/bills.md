# Bills

Open **⋯ → Bills** on the dashboard (or `/?bills`). It lists credit card statements by due date, oldest due first, with whether each looks paid, each card's balance, and its past statements. The 7 / 14 / 30 days / All buttons choose how far ahead to look. **Needs attention** lists anything not paid that's due within 5 days, or overdue. Your own bills (PG&E, water and so on), added by hand or from PDFs, join the same list in part 2.

## Card statements (part 1)

- **Turning them on, per bank:** + Add account → **Statement details** → **Turn on**. Plaid Link opens in update mode and asks the bank for Liabilities consent. It reuses the bank's connection, so it doesn't take a Plaid Trial slot (Liabilities is in the Trial plan; on a paid Plaid plan it's billed per bank it's turned on for). Minty turns them on only after Plaid's `/item/get` lists `liabilities` among the bank's consented products (`POST /link/statements/complete`). **Turn off** stops fetching and keeps the statements already saved.
- **Fetching:** only the cron, never a page request (there's still no HTTP sync endpoint). A 10-minute catch-up run that had nothing to download fetches `/liabilities/get` for one due bank (`src/statements.ts`), so it never competes with transaction sync for the free plan's CPU or subrequests. Each bank is refreshed about once a day, an hour after an error. Plaid's response text goes straight to SQLite, as sync's pages do.
- **Failures** are recorded on `statement_sync` (status, Plaid's error code) and never change `items.status` or the transaction sync. Bills and Setup checks name the bank: consent needed again, not supported by the bank, or retrying.
- **What's stored** (`card_statements`, migration 0010): one row per card per statement date, with its amount, minimum, due date, the bank's last payment, and its overdue flag. Liabilities reports only the latest statement, so history builds up from the day statement details are turned on. A later fetch of the same statement updates it; a missing field never erases one seen before. The balance is the one transaction sync already keeps.

## "Paid" (Minty's estimate)

A statement is **Paid** when the payments posted to that card after it closed (up to the next statement) add up to its amount, or when the bank's own last payment, made after the statement, covers it. A payment is a posted negative amount categorised as a loan payment or transfer in, or named "payment"; refunds and rewards don't count. Otherwise it's **Partly paid** (with how much), **Not paid yet**, or **Overdue** (past its due date, or the bank's flag). A statement of zero or less is **Nothing due**.

If the bank's transactions aren't current (downloading, stalled, needing a reconnect), an unpaid-looking statement says **Can't tell yet**, with the reason, rather than "Not paid". The fork this feature came from goes further, establishing whether the whole statement period's history has been downloaded. Bills only needs the weeks since the latest statement closed, which the hourly sync has covered, and the bank's own last-payment figure cross-checks it.

## Reads

`GET /bills` reads each card's latest statement and the card's transactions inside each statement window, both ends of each window bounded so `idx_txn_account_date` reads only that range. On the 28-card household in `test/reads.test.ts`, with 12 statements each, that's about 6,000 rows. An unbounded upper end read 85,000. `/bills` counts toward the daily read budget, like `/transactions`.
