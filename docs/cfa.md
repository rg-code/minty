# Plan: CFA (Complete financial audit) and EGG (retirement accounts)

**Status: proposed 2026-10-16. Decided: the name stays CFA (Complete financial audit, its own meaning here), and the retirement button is EGG. Still open: §6 items 3–5. No code yet.**

Two features, planned together because they share their data and charts:

- **CFA, the Complete financial audit:** charts and trends for spending, saving, debt and
  retirement. It finds changes you can act on, and gives the recommendations a financial planner
  (CFP), an investment analyst (CFA) and a wealth advisor would usually make, each one showing its
  arithmetic.
- **EGG, the retirement view** (as in nest egg): retirement accounts (Schwab, Fidelity,
  Betterment, Vanguard, a workplace 401(k), …) in a view of their own. By default they're kept
  out of the dashboard (islanded). Less is more here: a trend, a forecast and very little else
  (§3).

Both are read-only. They never move money, and they never call Plaid on a request (§4).

## 1. What Minty has today, and what's missing

| Have | Missing |
| --- | --- |
| Transactions with Plaid's category (`personal_finance_category.primary`: `INCOME`, `TRANSFER_IN`/`_OUT`, `LOAN_PAYMENTS`, `FOOD_AND_DRINK`, …) | A spend / save / transfer classification that doesn't count a card payment twice, or a move between your own accounts as spending |
| Each account's type, subtype and **current** balance | Balance **history** (needed for every trend line, and for net worth) |
| Card statements, APRs and interest (Liabilities, Bills) | Investment holdings, securities and investment activity (Plaid **Investments**) |
| Bills, ABC credits | A way to link a brokerage: Link asks for `transactions` only today, so a bank that only supports Investments doesn't appear in Link |
| | Charts: the dashboard has none, and the CSP (`script-src 'self'`) rules out a chart CDN |

## 2. CFA, the Complete financial audit

A full page (`/audit`), opened from the dashboard's ⋯ menu, which is where new features go. It
has four sections, each a chart with one line of plain-words findings under it, then the
recommendations.

### 2.1 Charts and trends

1. **Cash flow:** income, spending and saving per month, 12 or 24 months, plus the
   **savings rate** trend.
2. **Spending by category:** each category's last 3 months against its own 12-month average.
   Rising ones are flagged.
3. **Recurring charges:** subscriptions and regular bills found from repeats (same merchant, a
   similar amount, a monthly, quarterly or yearly rhythm), with their yearly cost, price rises and
   likely duplicates.
4. **Net worth:** cash, plus investments, minus card and loan balances, over time. It starts the
   day balance history starts (§4), so it begins with one point.
5. **Debt:** card balances carried over, the interest paid per year, and the APR of each card
   (from Liabilities).
6. **Retirement** (once EGG exists): its total, how much was contributed this year, and the
   forecast summary.

### 2.2 Classification (the part everything else depends on)

Each transaction is put in one bucket, in SQL:

- **Income:** `INCOME`, and `TRANSFER_IN` from outside the household's own accounts.
- **Saving:** a move to your own savings, investment or retirement account (a transfer pair, or
  a contribution).
- **Transfer (ignored):** a move between your own accounts. A **transfer pair** is money out of
  one of your accounts and the same amount into another within 3 days. Card payments
  (`LOAN_PAYMENTS` to a linked card) go here too: the purchases on the card already count as
  spending, so the payment must not count again.
- **Debt payment:** a loan payment to an account that isn't linked (a mortgage or a car loan).
- **Spending:** everything else going out.

You can correct a bucket per merchant, the same way tags work: stored in a table that sync never
writes.

### 2.3 Findings and recommendations

The rules live in code (`src/audit/rules.ts`), like ABC's catalog, each with its threshold, a
source and a `CHECKED` date. Nothing is fetched at runtime. Each finding shows:
- **what** was found;
- **why** it matters, in one line;
- **the estimated effect** in dollars a year;
- **one action** to take;
- **the numbers it used**, so it can be checked.

They're ranked by dollars a year. Examples:

| Area | Finding | Action |
| --- | --- | --- |
| Spending | A category is up 20%+ (and $50+/month) on its 12-month average | Look at its top merchants (a link to the filtered dashboard) |
| Spending | Recurring charges: price rises, duplicates, ones not used lately | Cancel or renegotiate; the list with yearly costs |
| Spending | Fees: bank, ATM, foreign transaction, late fees, card interest | Which account and card, and the yearly total |
| Saving | Savings rate under 15–20% of income | The monthly amount that would reach the target |
| Saving | Emergency fund under 3–6 months of essential spending | The gap in dollars and months |
| Saving | Cash sitting in checking above about 2 months of spending | Move the extra to a high-yield savings account (at a rate you enter, never fetched) |
| Debt | A card balance carried over at a high APR | Pay it off first, highest APR first (avalanche); the interest saved |
| Retirement | Contributions behind the pace for this year's IRS limit | The amount per paycheck to reach it |
| Retirement | The employer match isn't fully captured (from the match you enter) | The contribution % that gets the whole match: "free money left: $X a year" |
| Retirement | High cash in a retirement account (cash drag), for a long horizon | Invest it according to your plan |
| Retirement | One holding over 10% of the total (concentration) | Consider spreading it |
| Retirement | Fees paid inside accounts (investment fee transactions) | The yearly total |

The **planner's checklist** covers things the data can't see, so you tick them. Minty stores the
date each was checked and asks again once a year:
- beneficiaries named on every retirement account;
- a will and other estate documents;
- term life insurance if anyone depends on you, and disability insurance;
- umbrella liability cover;
- a credit freeze at the three bureaus;
- your Social Security estimate (ssa.gov);
- insurance deductibles that fit the emergency fund;
- tax-loss harvesting in taxable accounts;
- RMDs from age 73;
- a Roth / traditional mix to talk over with a tax professional.

**The audit report:** a print stylesheet, so the browser's Print → Save as PDF gives a dated
yearly audit. No PDF library is needed.

Every page says it plainly: **educational, not financial advice. Minty isn't a CFP, CFA or
registered advisor.** The rules suggest; the arithmetic is shown; you decide.

## 3. EGG, the retirement view

A header button **EGG**, next to ABC, opens a popup like ABC and Bills. Its features, kept on
purpose to these:

1. **Trend:** the total, and each account, over time (1y / 5y / all), with contributions shown
   apart from growth. That's "what I put in" against "what it earned", the one split that matters.
2. **Forecast:** the value at your retirement age in today's dollars, as three lines (cautious,
   middle, hopeful real returns), from the current total and your contribution rate. It also
   shows what that supports at a 4% withdrawal rate, as a yearly income. It runs in the browser,
   so it costs the Worker no CPU.
3. **This year's contributions** against the IRS limit for each kind of account (401(k)/403(b)/457,
   IRA, HSA), with catch-up limits by age. The limits are in code with a source and a `CHECKED`
   date.
4. **Mix and cash:** a single bar of stocks, bonds and cash, with a cash-drag flag. Only from what
   Plaid reports; no fund analysis.

Suggested extras (each small, each optional):
- **A target:** "$X by age Y", with "on track / behind by $Z a month". It turns the forecast into
  one answer.
- **Fees paid this year**, from investment transactions, when there are any.
- **Beneficiary reminder:** the one checklist item that belongs here.

Deliberately left out: daily performance, individual stock charts, rebalancing advice, and
anything that moves money.

**Islanding:** accounts of a retirement subtype (401k, 403b, 457b, IRA, Roth, SEP, SIMPLE, and
HSA if you choose; §6) are kept out of the dashboard by default:
- out of the feed, the account filter, the person totals and the audit's spending;
- their contributions count as **saving** in CFA.

Each account has a "Show on the dashboard too" switch. Brokerage (taxable) accounts aren't
retirement accounts, so they stay on the dashboard unless you move them.

## 4. How it fits Minty's rules

- **Plaid Investments.** It needs checking first (R0) that the Trial plan includes it, and which
  of Schwab, Fidelity, Betterment and Vanguard (and your 401(k)'s recordkeeper) Plaid supports.
  - **New flow:** retirement accounts are linked through a separate "Link a retirement account"
    flow that asks for `investments` (most brokerages don't offer `transactions`).
  - **Each brokerage login uses a Trial slot for good**, like any bank. That counts against the
    10, so it's worth linking only the ones you'll keep.
  - **A bank you already have** gets Investments added through update-mode Link
    (`additional_consented_products`), the way statement details work, which uses no slot.
- **Never on a request.** Holdings and investment activity are fetched by the quiet catch-up cron
  run, one bank per run, like statement details. Results go to `investment_sync`, and a failure
  there never touches `items.status` or the transaction sync. Investments-only banks are skipped
  by the transaction sync, and get their health verdict from `investment_sync` (with `MEANING`
  entries).
- **CPU (10 ms).**
  - Plaid's holdings response is stored as text and unpacked by SQLite, the same as sync pages.
  - The audit's monthly totals are computed in SQL.
  - The forecast and the charts run in the browser.
- **D1 reads.**
  - A `monthly_totals` table (month × person × bucket × category), refreshed for the months each
    sync touched, makes opening the audit read hundreds of rows instead of every transaction.
  - Balance snapshots: one row per account per day, read by an index on (account, date), thinned
    to weekly after a year.
  - Every new route gets a line in `test/reads.test.ts`, and `/audit` goes in `isHeavyRead`.
- **Charts.** A small `public/charts.js` of our own (line, stacked bar, a single bar) drawing SVG
  with the dashboard's colour tokens: light and dark, and no CDN. That's simpler than vendoring a
  library, and the CSP stays `'self'`.
- **People.** Both views follow the person switch. `owner` stays separate from `plaid_account`.
- **Migrations only add:**
  - `items.products`;
  - `accounts.view` (null means the default for the account's type);
  - `balance_snapshots`, `holdings`, `securities`, `investment_txns`, `investment_sync`;
  - `monthly_totals`, `bucket_overrides`, `audit_checklist`;
  - a per-person profile (age or birth year, retirement age, employer match, target) in
    `app_state`.
- **Demo.** Made-up retirement accounts, holdings and a year of balance history, so the demo shows
  both views.
- **Ask Minty** ([agent-plan.md](agent-plan.md)) can later explain findings ("why is dining up?")
  using the same totals. CFA doesn't wait for it.

## 5. Phases (each ends with a PR you review)

| Phase | What | Needs Plaid changes |
| --- | --- | --- |
| **R0** | Check that Investments is on the Trial plan, and the brokerages you use; your decisions (§6) | Check only |
| **C1** | Foundations: classification and transfer pairs, `monthly_totals`, daily balance snapshots, `charts.js` | No |
| **C2** | `/audit` charts: cash flow, savings rate, categories, recurring charges, debt, net worth (from day one of snapshots) | No |
| **E1** | EGG data: the retirement Link flow, the investments cron fetch, holdings and activity, islanding | Yes (Investments) |
| **E2** | The EGG view: trend, forecast, contributions against limits, mix and cash; the target | No |
| **C3** | Recommendations and the checklist, the yearly print report, and EGG's numbers in the audit | No |

C1–C2 ship value with no new Plaid product and no slots, so they come first. Balance history
also starts with C1, and every later trend needs it.

## 6. Decisions for the owner

1. **The name "CFA".** "CFA" is a registered mark of CFA Institute, for a professional
   credential, so a button labelled CFA could read as credentialed advice.
   - For a private noncommercial tool the risk is small. But Minty is public, and forks show it to
     their households.
   - Options: keep "CFA (Complete financial audit)" with the disclaimer, or a neutral three
     letters like **AUD** (audit) or **FAR** (financial audit report).
   - My suggestion: name the page "Complete financial audit" and the button **AUD**.
2. **The retirement button: EGG** (nest egg) is my suggestion. Alternatives are RET and NST.
   Avoid RIA (that's a registered investment adviser).
3. **Is an HSA a retirement account?** It's often used as one. The suggestion is islanded but
   switchable.
4. **The profile:** age or birth year, retirement age, employer match % and an optional target,
   kept in D1. All optional; without them the forecast uses your observed contributions and age 65.
5. **Which brokerages first**, for the R0 check.
