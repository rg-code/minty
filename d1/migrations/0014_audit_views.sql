-- CFA (docs/cfa.md), phase C2: what the audit's net worth and recurring charges read, kept by the
-- hourly cron (src/audit/totals.ts), never on a request.
--   net_worth: per day and person, what the accounts hold (bank and investment balances) and owe
--     (cards and loans), written with the day's balance snapshot, only when it changed.
--   recurring_charges: payments that repeat (same merchant, a weekly, monthly, quarterly or yearly
--     rhythm, similar amounts), found in the last 400 days of spending. Rebuilt daily.
CREATE TABLE net_worth (
    date         TEXT    NOT NULL,                     -- YYYY-MM-DD (UTC)
    owner        TEXT    NOT NULL,
    assets_cents INTEGER NOT NULL,
    debts_cents  INTEGER NOT NULL,                     -- what's owed, positive
    PRIMARY KEY (date, owner)
) WITHOUT ROWID;

CREATE TABLE recurring_charges (
    owner           TEXT    NOT NULL,
    merchant        TEXT    NOT NULL,                  -- upper(merchant_name, else name), as bucket_overrides
    name            TEXT,                              -- as the newest charge shows it
    category        TEXT,
    cadence         TEXT    NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'yearly')),
    n               INTEGER NOT NULL,                  -- charges seen
    avg_cents       INTEGER NOT NULL,
    last_cents      INTEGER NOT NULL,
    prev_cents      INTEGER,                           -- the charge before the newest
    distinct_amounts INTEGER NOT NULL,                 -- few means a fixed price (a rise is worth flagging)
    first_date      TEXT    NOT NULL,
    last_date       TEXT    NOT NULL,
    PRIMARY KEY (owner, merchant)
) WITHOUT ROWID;
