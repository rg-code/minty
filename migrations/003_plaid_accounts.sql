-- Bind each Item to a specific Plaid Trial account (credential set), separate
-- from 'owner'. Enables per-person primary + backup overflow routing.
ALTER TABLE items ADD COLUMN plaid_account TEXT;

-- Backfill any pre-existing rows onto their owner's primary account.
UPDATE items SET plaid_account = owner || '_primary' WHERE plaid_account IS NULL;

ALTER TABLE items ALTER COLUMN plaid_account SET NOT NULL;
CREATE INDEX idx_items_plaid_account ON items (plaid_account);
