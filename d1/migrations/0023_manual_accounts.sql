-- Manual accounts, holders and a beneficiary (docs/accounts.md). Additive only.
--
-- A manual account is an ordinary accounts row (is_manual = 1) under one "manual" bank row per
-- person (items.products = 'manual', status 'manual', no Plaid credentials or token). Every query
-- that walks the banks skips those through PLAID_ITEM() in src/accounts.ts; a test enforces it.
ALTER TABLE accounts ADD COLUMN is_manual     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN balance_as_of TEXT;                 -- YYYY-MM-DD: the day a manual balance was true
ALTER TABLE accounts ADD COLUMN institution   TEXT;                 -- a manual account's bank, as typed
ALTER TABLE accounts ADD COLUMN notes         TEXT;
-- Any account, linked or manual; sync never writes these (like display_name).
ALTER TABLE accounts ADD COLUMN holders       TEXT NOT NULL DEFAULT '[]';   -- JSON array of MINTY_USERS keys; [] = the owner
ALTER TABLE accounts ADD COLUMN beneficiary   TEXT;                 -- JSON {"key": "..."} or {"name": "..."}, or NULL

-- Net worth without the home: the home's value, and the mortgages and home equity loans against it.
ALTER TABLE net_worth ADD COLUMN home_cents      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE net_worth ADD COLUMN home_debt_cents INTEGER NOT NULL DEFAULT 0;

-- Net worth's history is rebuilt at the next run with the new rules (only a home among other
-- assets, US dollars only) and the new columns. The snapshots are already there.
INSERT INTO app_state (key, value) VALUES ('networth_dirty', '1')
  ON CONFLICT (key) DO UPDATE SET value = '1';
