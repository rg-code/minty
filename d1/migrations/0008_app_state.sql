-- Small household-wide state, one row per key. For now, sync requests from the dashboard:
--   sync_requested_at / sync_requested_by: someone clicked the logo; the next cron run (the
--     10-minute catch-up at the latest) syncs every bank. The click itself never calls Plaid.
--   last_sweep_at: the last full sync of every bank (hourly, or a requested one).
CREATE TABLE app_state (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
