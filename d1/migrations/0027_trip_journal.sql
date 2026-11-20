-- Kos's trip journal (docs/trips.md §20): when a trip's journal was ready (the hourly run marks it
-- the day after the trip ends) and first opened, and the household's notes, one per day plus one
-- for the trip ('trip'). Everything else in a journal is built from the trip's bookings when it's
-- opened. Sync never writes these. Additive only.
ALTER TABLE trips ADD COLUMN journal_ready_at TEXT;
ALTER TABLE trips ADD COLUMN journal_seen_at TEXT;
CREATE TABLE trip_journal_notes (
    trip_id    INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    day        TEXT    NOT NULL,                       -- YYYY-MM-DD, or 'trip'
    text       TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (trip_id, day)
) WITHOUT ROWID;
