# Bills

Open **⋯ → Bills** on the dashboard (or `/?bills`). It's a calendar, from this week's Sunday through 7, 14, 30 or 90 days ahead (30 by default):

- **Statements** (purple): each card's estimated next statement date, the same day of the month as its last one.
- **Payments & bills** (green): each card's payment due date as the bank reports it, and the household's own bills. A ✓ means paid, ◐ partly paid, ! overdue; red means **Needs attention** (not paid, due within 5 days or overdue), which is also listed above the calendar.

The two toggles show or hide each kind. Select a day for its details: a card's statement (amount, minimum, closing date, balance now, paid since, past statements) or a bill (amount, bill date, how it was paid), with **Mark paid**, **Edit** and **Delete** for bills, and **+ Add a bill due this day**. On phones each day shows dots and the details list the names.

## Card statements (part 1)

- **Turning them on, per bank:** + Add account → **Statement details** → **Turn on**. Plaid Link opens in update mode and asks the bank for Liabilities consent. It reuses the bank's connection, so it doesn't take a Plaid Trial slot (Liabilities is in the Trial plan; on a paid Plaid plan it's billed per bank it's turned on for). Minty turns them on only after Plaid's `/item/get` lists `liabilities` among the bank's consented products (`POST /link/statements/complete`). **Turn off** stops fetching and keeps the statements already saved.
- **Fetching:** only the cron, never a page request (there's still no HTTP sync endpoint). A 10-minute catch-up run that had nothing to download fetches `/liabilities/get` for one due bank (`src/statements.ts`), so it never competes with transaction sync for the free plan's CPU or subrequests. Each bank is refreshed about once a day, an hour after an error. Plaid's response text goes straight to SQLite, as sync's pages do.
- **Failures** are recorded on `statement_sync` (status, Plaid's error code) and never change `items.status` or the transaction sync. Bills and Setup checks name the bank: consent needed again, not supported by the bank, or retrying.
- **What's stored** (`card_statements`, migration 0010): one row per card per statement date, with its amount, minimum, due date, the bank's last payment, and its overdue flag. Liabilities reports only the latest statement, so history builds up from the day statement details are turned on. A later fetch of the same statement updates it; a missing field never erases one seen before. The balance is the one transaction sync already keeps.

## Your own bills (part 2)

PG&E, water, trash and the like, one entry per bill (a quarterly bill is one entry a quarter), in `bills` (migration 0011).

- **By hand:** **+ Add a bill** (or **+ Add a bill due this day** on a selected day): biller, amount, due date (picked on the calendar), bill date, person, and the name its payment goes by in transactions (by default the biller's first word, e.g. PG&E).
- **From PDFs:** **Add from PDFs** (several files) or **Add a folder** (desktop browsers; phones can't pick a folder). The browser reads each PDF with pdf.js 4.10.38, stored in `public/vendor/pdfjs/` (never a CDN, so the CSP stays `'self'`, and only loaded when used), and `public/bill-parse.js` finds the biller, amount due, due date, bill date and the account's last 4 digits. A review table shows them, editable, with date pickers; a PDF already added is recognised by its SHA-256 (`POST /bills/known`) and skipped. **The PDFs never leave the device**: only those fields and the fingerprint are saved.
  - pdf.js asks once whether `eval` is allowed (`new Function("")` inside a try/catch). Under the report-only CSP that shows as three `script-src eval` reports while importing; when the CSP is enforced the answer is just "no" and pdf.js works without it (text only, `isEvalSupported: false`). Expected, not a problem.
- **Paid:** marked by hand, or matched automatically: a posted payment out, named like the bill (its `match_name`, in the description or merchant), within $1 of the amount, from the bill date (or 40 days before the due date) to 15 days after it. Bills marked paid, and bills more than 90 days past due, aren't searched.

## "Paid" (Minty's estimate)

A statement is **Paid** when the payments posted to that card after it closed (up to the next statement) add up to its amount, or when the bank's own last payment, made after the statement, covers it. A payment is a posted negative amount categorised as a loan payment or transfer in, or named "payment"; refunds and rewards don't count. Otherwise it's **Partly paid** (with how much), **Not paid yet**, or **Overdue** (past its due date, or the bank's flag). A statement of zero or less is **Nothing due**.

If the bank's transactions aren't current (downloading, stalled, needing a reconnect), an unpaid-looking statement says **Can't tell yet**, with the reason, rather than "Not paid". The fork this feature came from goes further, establishing whether the whole statement period's history has been downloaded. Bills only needs the weeks since the latest statement closed, which the hourly sync has covered, and the bank's own last-payment figure cross-checks it.

## Reads

`GET /bills` reads each card's latest statement and the card's transactions inside each statement window, both ends of each window bounded so `idx_txn_account_date` reads only that range, and each open bill's date window through the date index. On the household in `test/reads.test.ts` (28 cards with 12 statements each, and 40 bills) that's about 7,500 rows; an unbounded upper end read 85,000. `/bills` counts toward the daily read budget, like `/transactions`.
