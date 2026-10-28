-- A category's transactions over a few months (CFA and the dashboard's donut list them,
-- GET /audit/transactions): this index reads only that category's rows in the range, instead of
-- every transaction in it.
CREATE INDEX idx_txn_category_date ON transactions (category, date);
