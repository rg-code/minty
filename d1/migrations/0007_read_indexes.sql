-- Indexes that keep D1 rows read small (the free plan allows 5,000,000 a day; a full scan of
-- transactions is ~7,000 rows on a real household, and the first ABC query read 463,000).
--   idx_txn_date_id: the dashboard's list, newest first, reads only the rows it returns.
--   idx_txn_account_date: a card's first transaction (ABC) is one index read.
--   idx_txn_member: card members on multi-card accounts (/accounts) read only rows that have one.
CREATE INDEX idx_txn_date_id      ON transactions (date DESC, id DESC);
CREATE INDEX idx_txn_account_date ON transactions (account_id, date);
CREATE INDEX idx_txn_member       ON transactions (account_id, account_owner) WHERE account_owner IS NOT NULL;
