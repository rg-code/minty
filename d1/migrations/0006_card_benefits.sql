-- ABC ("All but coupon clipping"): card credits (src/benefits/). The benefit list itself is code
-- (src/benefits/catalog.ts); these tables hold only the household's choices.
--   card_products: per card, which product it is when its name doesn't say (product_id NULL with
--     hidden = 0 means "use the automatic match"; 'none' means no tracked credits), the month its
--     card year starts (NULL = inferred from the annual fee), and whether ABC hides it.
--   benefit_marks: ticks for credits Minty can't see on a statement (e.g. Uber Cash in the Uber
--     app), one row per card, benefit and period.
CREATE TABLE card_products (
    account_id        INTEGER PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    product_id        TEXT,
    anniversary_month INTEGER CHECK (anniversary_month BETWEEN 1 AND 12),
    hidden            INTEGER NOT NULL DEFAULT 0,
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE benefit_marks (
    account_id   INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    benefit_id   TEXT    NOT NULL,
    period_start TEXT    NOT NULL,                 -- YYYY-MM-DD, the period's first day
    marked_by    TEXT,                             -- Access email
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (account_id, benefit_id, period_start)
);
