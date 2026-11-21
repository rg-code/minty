-- Kos T6c: live flight status (docs/trips.md §14, §32), from FlightAware AeroAPI, asked only by the cron.
-- flight_status: the latest answer for the leg, as JSON (state, times, gates, terminals, belt, delay,
-- aircraft, FlightAware's flight id); status_checked_at: when; status_next_at: when the cron asks next
-- (NULL: not due, or done after landing). Sync never writes them.
ALTER TABLE trip_items ADD COLUMN flight_status     TEXT;
ALTER TABLE trip_items ADD COLUMN status_checked_at TEXT;
ALTER TABLE trip_items ADD COLUMN status_next_at    TEXT;
-- the cron's look at legs due: flights only
CREATE INDEX idx_trip_items_flight_due ON trip_items (status_next_at) WHERE kind = 'flight';
