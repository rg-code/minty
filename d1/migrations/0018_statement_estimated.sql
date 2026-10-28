-- A card the bank sends a due date for (and a minimum payment, a balance) but no statement date:
-- Bills keeps it, with the statement date estimated 25 days before the due date (1), and drops the
-- estimate once the bank sends a real date (src/statements.ts). Before, such a card had nothing.
ALTER TABLE card_statements ADD COLUMN issue_estimated INTEGER NOT NULL DEFAULT 0;
