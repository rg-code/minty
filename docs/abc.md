# ABC ("All but coupon clipping"): card credits

The **ABC** button on the dashboard opens a popup (`/?abc` opens it directly). For a year, it lists every monthly, quarterly,
semi-annual and annual credit on the household's cards, with what's been used and what's still
open. It's checked against the statement credits in the transactions. Built 2026-10-12.

## Where things live

- `src/benefits/catalog.ts`: the benefit list. These are facts from Frequent Miler, cross-checked
  with Doctor of Credit, The Points Guy, Upgraded Points and the issuers' pages, with a source per
  benefit and the date it was checked (`CHECKED`). It's code, never fetched at runtime: benefits
  change a few times a year, and forks get updates through "Sync fork".
- `src/benefits/engine.ts`: the matching rules (below). Pure functions, tested at a fixed "today".
- `src/routes/benefits.ts`: `GET /benefits?year=`, `PUT /benefits/cards/:id` (product, card-year
  month, hidden) and `PUT /benefits/marks` (ticks).
- Migration 0006: `card_products` and `benefit_marks`. Only the household's choices; no benefit
  data.
- `public/abc.js` and `public/abc.css`: the popup, a native `<dialog>` handled like Inkling's.
  It opens with `showModal()`, and closes with its × button, Esc or a click outside. Its data is
  reloaded each time it opens.

## Rules

- **Which card is which:** the bank plus the Plaid account name ("Business Platinum Card®"), or a
  credit only that product gets ("Annual Travel/dining Credit" means Altitude Reserve). Otherwise
  the household picks it on the page.
- **Credits** match on their description (`credit` patterns, which always name the credit). A
  positive row with a credit's description is that credit being reversed, so credits are
  netted. Money back at the merchant counts only for `merchantCredit` benefits (Hilton posts as
  "Hilton" −$50), and only when it doesn't equal an earlier purchase, which would make it a
  refund. For `creditAsRefund` benefits, money back that is exactly the bare merchant name, up to
  the credit plus tax, *is* the credit: Walmart+ posts it as "Walmart" for the membership charge.
  A credit can post up to 3 days before its purchase (while the purchase is still pending).
- **Which period:** a credit counts in the period of the purchase it paid back (at the benefit's
  `charge` merchants, within 60 days, in a period with room). Otherwise it counts in the period
  it posted, or the previous one if it posted in the first 15 days of a full period (Amex
  sometimes credits by statement month).
- **Status per period:** used, partly used, charged with the credit pending (within 8 weeks),
  not unlocked yet (spend thresholds), open, missed (with "charged, no credit came" when there
  was a purchase), not started. Outside-the-card credits (Uber Cash, Citi's hotel discount) are
  ticked by hand.
- **Card years:** periods start in the month of the first annual fee, or as chosen.
- **Totals:** a period counts in the year it starts in. Locked credits count once unlocked, and
  Global Entry (every 4 years) is shown separately.
- **Free plan:** D1 bills rows read (5,000,000 a day on the free plan), and the Worker has 10 ms
  of CPU.
  - `/benefits` reads each transaction of the cards ABC tracks exactly once, through
    `idx_txn_account`. SQLite tags each row with the patterns it matched, so the Worker does no
    string matching. The patterns are inlined as one balanced expression of `CASE … LIKE …`
    terms.
  - The first version joined a `json_each` list of patterns instead. That read every transaction
    once per pattern: **hundreds of thousands of rows a request**, which used up the day's
    5,000,000 in a handful of opens (2026-10-12).
  - A chain of 100+ `OR`s or `||`s hits SQLite's expression-depth limit of 100, hence the
    balanced tree.
  - Each card's first transaction is one read on `idx_txn_account_date`.
  - Annual fees come from the same pass.
  - About 2,700 rows a request on a 7,000-transaction household, which `test/reads.test.ts`
    holds it to. CPU is about 7 ms cold and 2 ms warm. Dates compare as strings, since
    `localeCompare` loads ICU on a cold isolate.

## Updating the list

Re-check Frequent Miler (and the issuer) for each product, edit `catalog.ts`, bump `CHECKED`, and
run `npm test`: the catalog test checks every pattern, amount and source. When a new credit first
posts, set its `credit` pattern to the real description and mark it `labelSeen`.
