-- Kos: places found by LocationIQ before its searches were kept to the address's country (docs/trips.md §31)
-- are looked up again: one stay matched a namesake on another continent. Only looked-up coordinates go;
-- ones the household gave (a map link, a plus code) stay.
UPDATE trip_items SET lat = NULL, lon = NULL, geo_source = NULL, geo_tried_at = NULL WHERE geo_source = 'lookup';
