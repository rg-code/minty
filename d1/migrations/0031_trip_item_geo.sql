-- Kos: a booking's exact place, looked up from its name and address with LocationIQ (docs/trips.md §31)
-- when it has none. geo_source 'lookup' marks coordinates Kos found (typed or pasted ones stay NULL);
-- geo_tried_at is the last lookup, so one that found nothing waits 30 days before another try.
ALTER TABLE trip_items ADD COLUMN geo_source   TEXT CHECK (geo_source IN ('lookup'));
ALTER TABLE trip_items ADD COLUMN geo_tried_at TEXT;
-- the cron's list of bookings still without a place: only those rows (flights never need one)
CREATE INDEX idx_trip_items_unplaced ON trip_items (geo_tried_at) WHERE lat IS NULL AND kind <> 'flight';
