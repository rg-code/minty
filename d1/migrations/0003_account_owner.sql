-- Plaid's transaction `account_owner`: on an account with several cards (e.g. American Express
-- authorized-user cards), the card member's name and/or card mask, in the bank's own format.
-- Plaid says it's usually empty. NULL for transactions synced before this column existed.
ALTER TABLE transactions ADD COLUMN account_owner TEXT;
