-- Plaid Link sessions (docs/security-plan.md, step 3). /link/token reserves a slot under the Trial
-- cap for one login, and /link/exchange claims that session (once, before Plaid's exchange) and
-- takes owner and plaid_account from it, never from the browser.
--   operation: 'link' (a new bank: reserves a slot) or 'update' (reconnecting item_id).
--   A 'link' session counts against its plaid_account's cap while it's open (not used, released or
--   expired) and after it's claimed until it's finished: Plaid may already have created the
--   access token, which uses a Trial slot for good.
--   used_at: claimed by /link/exchange. finished_at: the item is stored. released_at: cancelled,
--   or Plaid refused, so nothing was spent.
CREATE TABLE link_sessions (
    id            TEXT    PRIMARY KEY,
    email         TEXT    NOT NULL,
    operation     TEXT    NOT NULL CHECK (operation IN ('link', 'update')),
    owner         TEXT    NOT NULL,
    plaid_account TEXT    NOT NULL,
    item_id       INTEGER,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at    TEXT    NOT NULL,
    used_at       TEXT,
    finished_at   TEXT,
    released_at   TEXT
);
CREATE INDEX idx_link_sessions_account ON link_sessions (plaid_account);
CREATE INDEX idx_link_sessions_item    ON link_sessions (item_id);
