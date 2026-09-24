-- Minty schema for Cloudflare D1 (SQLite). Mirrors the Postgres schema (migrations/001-003)
-- with two deliberate differences:
--   * money is stored as integer cents (the API still returns dollars);
--   * tags live in transaction_tags instead of a text[] column. Sync never writes that
--     table, so user labels survive re-syncs by construction.
-- Applied automatically and tracked in d1_migrations (wrangler d1 migrations apply).
-- Never edit this file once applied; add 0002_*.sql instead.

CREATE TABLE items (
    id               INTEGER PRIMARY KEY,
    owner            TEXT    NOT NULL,                 -- MINTY_USERS key (dashboard identity)
    plaid_account    TEXT    NOT NULL,                 -- credential set, e.g. me_primary; distinct from owner
    plaid_item_id    TEXT    NOT NULL UNIQUE,
    access_token_enc TEXT    NOT NULL,                 -- Fernet token (same format/key as the Python app)
    institution_name TEXT,
    txn_cursor       TEXT,                             -- NULL = never synced
    status           TEXT    NOT NULL DEFAULT 'good',  -- good | login_required | error
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_items_plaid_account ON items (plaid_account);

CREATE TABLE accounts (
    id                      INTEGER PRIMARY KEY,
    owner                   TEXT    NOT NULL,
    item_id                 INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    plaid_account_id        TEXT    NOT NULL UNIQUE,
    name                    TEXT,
    mask                    TEXT,
    type                    TEXT,
    subtype                 TEXT,
    balance_current_cents   INTEGER,
    balance_available_cents INTEGER,
    currency                TEXT,
    updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_acct_item ON accounts (item_id);

CREATE TABLE transactions (
    id             INTEGER PRIMARY KEY,
    owner          TEXT    NOT NULL,
    account_id     INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    plaid_txn_id   TEXT    NOT NULL UNIQUE,            -- idempotency key
    amount_cents   INTEGER,                            -- Plaid sign: POSITIVE = money OUT
    currency       TEXT,
    date           TEXT,                               -- YYYY-MM-DD
    datetime       TEXT,                               -- ISO 8601, when Plaid provides it
    name           TEXT,
    merchant_name  TEXT,
    category       TEXT,
    pending        INTEGER NOT NULL DEFAULT 0,         -- 0/1
    pending_txn_id TEXT
);
CREATE INDEX idx_txn_owner_date ON transactions (owner, date DESC);
CREATE INDEX idx_txn_account    ON transactions (account_id);

CREATE TABLE transaction_tags (
    transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    tag            TEXT    NOT NULL COLLATE NOCASE,    -- 'Travel' and 'travel' are the same tag
    position       INTEGER NOT NULL,                   -- keeps the user's order on the row
    PRIMARY KEY (transaction_id, tag)
);
CREATE INDEX idx_tags_tag ON transaction_tags (tag);
