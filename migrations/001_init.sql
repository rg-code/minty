CREATE TABLE items (
    id                SERIAL PRIMARY KEY,
    owner             TEXT        NOT NULL,              -- 'me' | 'spouse'  (dashboard identity)
    plaid_item_id     TEXT        NOT NULL UNIQUE,
    access_token_enc  BYTEA       NOT NULL,              -- Fernet-encrypted, never plaintext
    institution_name  TEXT,
    txn_cursor        TEXT,                              -- NULL = never synced
    status            TEXT        NOT NULL DEFAULT 'good',  -- good | login_required | error
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    id                SERIAL PRIMARY KEY,
    owner             TEXT        NOT NULL,
    item_id           INT         NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    plaid_account_id  TEXT        NOT NULL UNIQUE,
    name              TEXT,
    mask              TEXT,
    type              TEXT,
    subtype           TEXT,
    balance_current   NUMERIC,
    balance_available NUMERIC,
    currency          TEXT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
    id                SERIAL PRIMARY KEY,
    owner             TEXT        NOT NULL,
    account_id        INT         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    plaid_txn_id      TEXT        NOT NULL UNIQUE,       -- idempotency key
    amount            NUMERIC,                           -- Plaid sign: POSITIVE = money OUT
    currency          TEXT,
    date              DATE,
    datetime          TIMESTAMPTZ,
    name              TEXT,
    merchant_name     TEXT,
    category          TEXT,
    pending           BOOLEAN     NOT NULL DEFAULT false,
    pending_txn_id    TEXT
);

CREATE INDEX idx_txn_owner_date ON transactions (owner, date DESC);
CREATE INDEX idx_txn_account    ON transactions (account_id);
CREATE INDEX idx_acct_item      ON accounts (item_id);
