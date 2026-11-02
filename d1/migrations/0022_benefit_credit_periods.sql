-- ABC: the period a credit counts in, when the household chose it ("Count in" under a benefit),
-- for a credit that paid back a purchase in another period than Minty could tell. Sync never
-- writes here, like tags and the other ABC choices.
CREATE TABLE benefit_credit_periods (
    account_id     INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    benefit_id     TEXT    NOT NULL,
    transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    period_start   TEXT    NOT NULL,                   -- YYYY-MM-DD, the period's first day
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (account_id, benefit_id, transaction_id)
) WITHOUT ROWID;
