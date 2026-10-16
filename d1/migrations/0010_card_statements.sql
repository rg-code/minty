-- Card statements (docs/bills.md): each credit card's statements from Plaid Liabilities, for the
-- banks the household turns them on for. Additive only: nothing here changes transaction sync.

-- What an update-mode Link session is for: a reconnect (as before), or asking the bank for
-- statement details (Liabilities consent on an existing Item; no new Item, no Trial slot).
ALTER TABLE link_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reconnect';

-- One row per bank with statement details on. The cron fetches /liabilities/get for one due bank
-- per catch-up run and sets next_attempt_at (about a day after success, an hour after an error).
-- A failure here never touches items.status or the transaction sync.
CREATE TABLE statement_sync (
    item_id         INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    status          TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'ready', 'consent_required', 'unsupported', 'error')),
    enabled_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    attempted_at    TEXT,
    synced_at       TEXT,
    next_attempt_at TEXT,
    last_error      TEXT                                -- Plaid's error code, never a message or payload
);
CREATE INDEX idx_statement_sync_due ON statement_sync (next_attempt_at);

-- One row per card per statement (its issue date). Liabilities reports only the latest statement,
-- so the history grows from the day statement details are turned on. A later fetch of the same
-- statement updates it; a missing field never erases one seen before. The latest row also carries
-- the bank's current due date, minimum and last payment.
CREATE TABLE card_statements (
    account_id            INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    issue_date            TEXT    NOT NULL,             -- YYYY-MM-DD, the statement's closing date
    balance_cents         INTEGER,                      -- the statement balance (Plaid sign: positive = owed)
    minimum_payment_cents INTEGER,
    due_date              TEXT,                         -- YYYY-MM-DD
    last_payment_cents    INTEGER,
    last_payment_date     TEXT,
    is_overdue            INTEGER,                      -- the bank's own flag (0/1), when it sends one
    first_seen_at         TEXT    NOT NULL,
    last_seen_at          TEXT    NOT NULL,
    PRIMARY KEY (account_id, issue_date)
);
