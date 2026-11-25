-- Kos: files attached to a booking (docs/trips.md §38): a boarding pass, a confirmation with tickets, a Wallet
-- pass. The file itself is in R2 (the FILES bucket, at r2_key), never in D1; this is its name, type, size and
-- fingerprint. Removed 30 days after its trip ends (ATTACHMENTS_KEEP_DAYS), and with its booking.
CREATE TABLE trip_files (
    id           INTEGER PRIMARY KEY,
    item_id      INTEGER NOT NULL REFERENCES trip_items (id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    content_type TEXT    NOT NULL,
    size         INTEGER NOT NULL,
    sha256       TEXT    NOT NULL,
    r2_key       TEXT    NOT NULL UNIQUE,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_trip_files_item ON trip_files (item_id);
