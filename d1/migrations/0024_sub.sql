-- SUB, sign-up bonuses (docs/sub.md). Three tables the household writes; sync never does, and none
-- of them changes a balance, net worth or a transaction. Additive only.

CREATE TABLE sub_offers (
    id                   INTEGER PRIMARY KEY,
    owner                TEXT    NOT NULL,                          -- MINTY_USERS key
    account_id           INTEGER REFERENCES accounts (id) ON DELETE SET NULL,   -- NULL until linked (planned, applied)
    kind                 TEXT    NOT NULL DEFAULT 'card' CHECK (kind IN ('card', 'bank', 'brokerage', 'other')),
    institution          TEXT,                                      -- as typed, e.g. "Chase"
    product              TEXT,                                      -- e.g. "Sapphire Preferred"
    status               TEXT    NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('planned', 'applied', 'open', 'met', 'paid', 'closed', 'lost')),
    reward_cents         INTEGER,                                   -- a cash reward
    reward_points        INTEGER,                                   -- or points / miles
    reward_program       TEXT,                                      -- BAM's program id (src/points/programs.ts)
    opened_date          TEXT,                                      -- YYYY-MM-DD
    expected_payout_date TEXT,
    -- How long it must stay open: an explicit rule, never guessed (docs/sub.md §3)
    rule_trigger         TEXT    CHECK (rule_trigger IN ('opened', 'first_payout', 'last_payout', 'date')),
    rule_trigger_date    TEXT,                                      -- for rule_trigger = 'date'
    rule_length          INTEGER,
    rule_unit            TEXT    CHECK (rule_unit IN ('days', 'months')),
    rule_text            TEXT,                                      -- the rule in the terms' own words
    keep_open_until      TEXT,                                      -- a manual date, overriding the rule
    keep_open_reason     TEXT,                                      -- required with keep_open_until
    annual_fee_cents     INTEGER,
    fee_date             TEXT,
    terms_url            TEXT,
    terms_text           TEXT,                                      -- up to 8,000 characters
    terms_sha256         TEXT,                                      -- of the PDF or screenshot it was read from
    notes                TEXT,
    created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_sub_offers_account ON sub_offers (account_id);

CREATE TABLE sub_requirements (
    id            INTEGER PRIMARY KEY,
    offer_id      INTEGER NOT NULL REFERENCES sub_offers (id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL CHECK (kind IN ('spend', 'deposits', 'direct_deposits', 'balance', 'transactions', 'other')),
    target_cents  INTEGER,
    target_count  INTEGER,
    start_date    TEXT,                                             -- NULL: the offer's opening date
    deadline      TEXT,                                             -- YYYY-MM-DD, overdue only the day after
    done_at       TEXT,                                             -- ticked by hand; wins over the estimate
    note          TEXT
);
CREATE INDEX idx_sub_requirements_offer ON sub_requirements (offer_id);

CREATE TABLE sub_payouts (
    id             INTEGER PRIMARY KEY,
    offer_id       INTEGER NOT NULL REFERENCES sub_offers (id) ON DELETE CASCADE,
    date           TEXT,                                            -- either may be unknown, not both
    amount_cents   INTEGER,
    points         INTEGER,
    transaction_id INTEGER REFERENCES transactions (id) ON DELETE SET NULL,   -- the matched credit, if any
    note           TEXT,
    CHECK (date IS NOT NULL OR amount_cents IS NOT NULL OR points IS NOT NULL)
);
CREATE INDEX idx_sub_payouts_offer ON sub_payouts (offer_id);
