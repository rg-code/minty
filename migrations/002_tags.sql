-- Tags live directly on the transaction as a Postgres text[] array.
-- The sync loop's upsert never touches this column, so tags survive re-syncs.
ALTER TABLE transactions
    ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';

-- GIN index makes "= ANY(tags)" / array-contains filtering fast.
CREATE INDEX idx_txn_tags ON transactions USING GIN (tags);
