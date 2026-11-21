-- Kos: the card a booking was paid with, and the day it was booked (docs/trips.md §28). A trip's
-- "Booked before" matches a booking to a charge on that card (the account whose mask ends in the same
-- 4 digits, its network not a different one) from around the day it was booked to just after the trip.
-- Read from the confirmation ("Visa ending in 1234", "Account Ending: 1234") or typed; sync never writes
-- them.
ALTER TABLE trip_items ADD COLUMN card_last4   TEXT CHECK (card_last4 IS NULL OR (length(card_last4) = 4 AND card_last4 NOT GLOB '*[^0-9]*'));
ALTER TABLE trip_items ADD COLUMN card_network TEXT CHECK (card_network IN ('visa', 'mastercard', 'amex', 'discover'));
ALTER TABLE trip_items ADD COLUMN booked_on    TEXT;                -- YYYY-MM-DD: the confirmation's date
