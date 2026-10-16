-- Bills you add yourself (docs/bills.md): PG&E, water, trash and the like, by hand or read from a
-- PDF in the browser. One row per bill (a quarterly bill is simply one row a quarter). Only the
-- fields are stored, never the PDF; its SHA-256 lets the same file be skipped next time.
CREATE TABLE bills (
    id             INTEGER PRIMARY KEY,
    owner          TEXT    NOT NULL,                   -- MINTY_USERS key
    biller         TEXT    NOT NULL,                   -- shown name, e.g. "PG&E"
    match_name     TEXT    NOT NULL,                   -- what its payment is called in transactions (LIKE, upper case)
    amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
    due_date       TEXT    NOT NULL,                   -- YYYY-MM-DD
    statement_date TEXT,                               -- YYYY-MM-DD, when the bill was issued
    account_hint   TEXT,                               -- the account's last 4 digits, if the bill shows them
    source         TEXT    NOT NULL CHECK (source IN ('manual', 'pdf')),
    file_sha256    TEXT    UNIQUE,                     -- the PDF's fingerprint (pdf only)
    paid_at        TEXT,                               -- marked paid by hand (an ISO time), else NULL
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_bills_due ON bills (due_date);
