-- Kos K2 (docs/trips.md §25): a trip's Immich album, and its photos' metadata (never the images).
-- Written only by the cron (src/immich.ts) and by "Make the album now" (a request flag). Sync never
-- touches these. Additive only.

ALTER TABLE trips ADD COLUMN immich_album_id TEXT;        -- the album the cron made, in the key's user's Immich
ALTER TABLE trips ADD COLUMN immich_state TEXT;           -- NULL (not looked yet), 'ready', 'empty' (no photos those days), 'gone' (deleted in Immich)
ALTER TABLE trips ADD COLUMN immich_requested_at TEXT;    -- "Make the album now": the next quiet run does it
ALTER TABLE trips ADD COLUMN immich_checked_at TEXT;      -- the last run that looked at this trip
ALTER TABLE trips ADD COLUMN immich_next_at TEXT;         -- not before this (backing off after a failure)
ALTER TABLE trips ADD COLUMN immich_error TEXT;           -- the last failure, in plain words; NULL once a run works
ALTER TABLE trips ADD COLUMN immich_page INTEGER;         -- the next search page, while a big trip spans runs
ALTER TABLE trips ADD COLUMN immich_count INTEGER;        -- photos and videos taken during the trip
ALTER TABLE trips ADD COLUMN immich_days TEXT;            -- JSON {"2026-02-27": 41, …}: how many each day

-- One photo or video taken during a trip (its local day): what the journal shows and the thumbnail
-- route allows. `pick`: up to 6 a day, spread through the day, chosen by the cron, so the journal reads
-- the same few rows however many photos there are.
CREATE TABLE trip_photos (
    trip_id   INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    asset_id  TEXT    NOT NULL,                 -- Immich's id (a UUID)
    taken     TEXT    NOT NULL,                 -- local time, "2026-02-27T14:05:09"
    day       TEXT    NOT NULL,                 -- its local day
    lat       REAL,
    lon       REAL,
    city      TEXT,
    video     INTEGER NOT NULL DEFAULT 0,
    added     INTEGER NOT NULL DEFAULT 0,       -- in the trip's album
    pick      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (trip_id, asset_id)
) WITHOUT ROWID;
CREATE INDEX idx_trip_photos_pick ON trip_photos (trip_id, pick, taken);
CREATE INDEX idx_trip_photos_added ON trip_photos (trip_id, added, taken);
