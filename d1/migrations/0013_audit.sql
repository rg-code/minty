-- CFA, the Complete financial audit (docs/cfa.md), phase C1: the data the audit's charts read.
--   balance_snapshots: each account's balance once a day (the hourly cron writes it only when it
--     changed), so trends and net worth have a history. Older than a year, only Sundays are kept.
--   monthly_totals: transactions summed per month, person, bucket (income, spend, saving,
--     transfer, debt) and Plaid category, kept by the hourly cron, so opening the audit reads
--     hundreds of rows instead of every transaction. Plaid's sign: positive = money out.
--   bucket_overrides: a household's correction of a merchant's bucket ("BETTERMENT" is saving).
--     Sync never writes it, like tags.
--   idx_txn_pair: finds a transfer's other side (the same amount the other way, within 3 days, one
--     side a Plaid transfer) from the index alone.
CREATE TABLE balance_snapshots (
    account_id      INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    date            TEXT    NOT NULL,                  -- YYYY-MM-DD (UTC)
    current_cents   INTEGER,
    available_cents INTEGER,
    PRIMARY KEY (account_id, date)
) WITHOUT ROWID;

CREATE TABLE monthly_totals (
    month        TEXT    NOT NULL,                     -- YYYY-MM
    owner        TEXT    NOT NULL,                     -- MINTY_USERS key
    bucket       TEXT    NOT NULL CHECK (bucket IN ('income', 'spend', 'saving', 'transfer', 'debt')),
    category     TEXT    NOT NULL,                     -- Plaid's primary category, or 'OTHER'
    amount_cents INTEGER NOT NULL,
    n            INTEGER NOT NULL,
    PRIMARY KEY (month, owner, bucket, category)
) WITHOUT ROWID;

CREATE TABLE bucket_overrides (
    merchant   TEXT PRIMARY KEY,                       -- upper(merchant_name, else name)
    bucket     TEXT NOT NULL CHECK (bucket IN ('income', 'spend', 'saving', 'transfer', 'debt')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_txn_pair ON transactions (amount_cents, date, account_id, pending, category);
