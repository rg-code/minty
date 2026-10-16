-- EGG, the retirement view (docs/cfa.md §3), phase E1: investment accounts from Plaid Investments.
--   items.products: 'transactions' (every bank so far) or 'investments' (a retirement or brokerage
--     login linked for Investments only: the transaction sync skips it).
--   accounts.view: where an account shows. NULL = by its type (retirement accounts, HSAs included,
--     go to EGG; everything else to the dashboard); 'dashboard' or 'retirement' = the household's choice.
--   investment_sync: per bank with Investments on, like statement_sync: pending, ready,
--     consent_required, unsupported or error, fetched by the quiet catch-up cron (src/investments.ts).
--     txn_start / txn_offset page through investment transactions across runs.
--   securities, holdings: what each investment account holds (replaced on each fetch).
--   investment_txns: buys, sells, contributions, dividends and fees, up to 24 months back.
ALTER TABLE items ADD COLUMN products TEXT NOT NULL DEFAULT 'transactions';
ALTER TABLE accounts ADD COLUMN view TEXT CHECK (view IN ('dashboard', 'retirement'));

CREATE TABLE investment_sync (
    item_id         INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    status          TEXT    NOT NULL CHECK (status IN ('pending', 'ready', 'consent_required', 'unsupported', 'error')),
    enabled_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at       TEXT,
    attempted_at    TEXT,
    next_attempt_at TEXT,
    last_error      TEXT,                              -- a Plaid error code, never data
    txn_start       TEXT,                              -- the window being paged through (YYYY-MM-DD)
    txn_offset      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE securities (
    security_id        TEXT PRIMARY KEY,               -- Plaid's, the same across banks
    name               TEXT,
    ticker             TEXT,
    type               TEXT,                           -- equity, etf, mutual fund, fixed income, cash, derivative, other
    is_cash_equivalent INTEGER,
    close_price        REAL,
    close_price_as_of  TEXT,
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE holdings (
    account_id       INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    security_id      TEXT    NOT NULL,
    quantity         REAL,
    value_cents      INTEGER,                          -- the institution's value
    cost_basis_cents INTEGER,
    price            REAL,
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (account_id, security_id)
) WITHOUT ROWID;

CREATE TABLE investment_txns (
    id                INTEGER PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    plaid_inv_txn_id  TEXT    NOT NULL UNIQUE,
    date              TEXT    NOT NULL,
    name              TEXT,
    type              TEXT,                            -- buy, sell, cancel, cash, fee, transfer
    subtype           TEXT,                            -- contribution, dividend, management fee, ...
    amount_cents      INTEGER,                         -- Plaid's sign: positive = cash out of the account
    quantity          REAL,
    fees_cents        INTEGER,
    security_id       TEXT
);
CREATE INDEX idx_inv_txns_account_date ON investment_txns (account_id, date);
