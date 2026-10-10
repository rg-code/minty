-- Sync bookkeeping, so a history download spread over many cron runs can recover from Plaid's
-- TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, and a failing bank can't hold up the others.
--   sync_start_cursor: the cursor the current multi-page update began from ('' = the very
--     beginning, i.e. the first history download); NULL once caught up. Plaid says to restart
--     the whole update from it on that error. Also what the 10-minute catch-up cron looks for.
--   attempted_at: the last sync attempt, successful or not; the sweep goes oldest first.
--     (updated_at stays the last successful sync.)
--   last_error / last_error_at: the last sync failure (a Plaid error code, never data), cleared
--     by the next saved page. Shown in Setup checks.
ALTER TABLE items ADD COLUMN sync_start_cursor TEXT;
ALTER TABLE items ADD COLUMN attempted_at TEXT;
ALTER TABLE items ADD COLUMN last_error TEXT;
ALTER TABLE items ADD COLUMN last_error_at TEXT;
