-- An account's name as the household wants it shown (+ Add account → Connected → Rename). Sync
-- writes accounts.name (Plaid's) and never this column, so a rename survives every sync, like tags.
-- NULL = Plaid's name, tidied for display (src/accounts.ts).
ALTER TABLE accounts ADD COLUMN display_name TEXT;
