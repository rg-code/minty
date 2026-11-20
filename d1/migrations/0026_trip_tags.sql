-- JET trip tags (docs/trips.md §18): a trip's tags, and which transaction tags a trip put there.
-- A trip's tags are written onto its confirmed transactions as ordinary transaction_tags rows, so
-- everything that reads tags (the dashboard's filter, CFA's "Left out of the numbers") follows them.
-- transaction_tags.trip_id marks a row the trip added (NULL: added by a person), so taking a tag off
-- the trip, or a transaction out of it, removes only what the trip added. Sync never writes either.
-- Additive only.
ALTER TABLE trips ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';            -- JSON array, as typed
ALTER TABLE transaction_tags ADD COLUMN trip_id INTEGER REFERENCES trips (id) ON DELETE SET NULL;
CREATE INDEX idx_tags_trip ON transaction_tags (trip_id) WHERE trip_id IS NOT NULL;
