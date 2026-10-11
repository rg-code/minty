-- Bank health, shown on the dashboard and in Setup checks (src/health.ts).
--   last_error_message: Plaid's own text for last_error (its display_message, else error_message),
--     at most 200 characters. Generic text about the error, never account data.
--   checked_at: the last daily connection check (Plaid /item/get); NULL = not yet.
--   consent_expires_at: when the bank's consent through Plaid ends (some OAuth banks, e.g. after
--     12 months), from that check; NULL = no expiry. Reconnecting renews it.
ALTER TABLE items ADD COLUMN last_error_message TEXT;
ALTER TABLE items ADD COLUMN checked_at TEXT;
ALTER TABLE items ADD COLUMN consent_expires_at TEXT;
