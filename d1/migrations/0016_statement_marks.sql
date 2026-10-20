-- Bills (docs/bills.md): a card statement marked paid by hand, for one Minty can't reconcile from
-- transactions (paid from an account that isn't linked, or in a way that doesn't post as a
-- payment). The statement fetch never writes this column, so the mark survives every refresh.
ALTER TABLE card_statements ADD COLUMN marked_paid_at TEXT;
