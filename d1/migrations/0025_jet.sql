-- JET, trips (docs/trips.md): trips, their bookings, and the transactions linked to them. The
-- household writes these (and, from T2, the inbox's confirmed suggestions); sync never does. Additive only.

CREATE TABLE trips (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    start_date  TEXT    NOT NULL,                     -- YYYY-MM-DD, the first day (local)
    end_date    TEXT    NOT NULL,                     -- the last day
    place       TEXT,                                 -- the main destination, as typed
    lat         REAL,
    lon         REAL,
    travellers  TEXT    NOT NULL DEFAULT '[]',        -- JSON array of MINTY_USERS keys
    notes       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (end_date >= start_date)
);
CREATE INDEX idx_trips_dates ON trips (start_date, end_date);

-- One booking: a flight leg, a stay, a car, a train, a reservation, an activity. A booking can wait
-- with no trip (trip_id NULL) until it's put in one.
CREATE TABLE trip_items (
    id             INTEGER PRIMARY KEY,
    trip_id        INTEGER REFERENCES trips (id) ON DELETE SET NULL,
    kind           TEXT    NOT NULL CHECK (kind IN ('flight', 'lodging', 'car', 'train', 'bus', 'restaurant', 'event', 'other')),
    name           TEXT,                              -- the hotel, restaurant, event; a flight's airline
    confirmation   TEXT,
    guest          TEXT,
    start_at       TEXT,                              -- local time as given, "2027-03-10T11:05", with its offset when known
    end_at         TEXT,
    place          TEXT,                              -- an address, or a place's name
    lat            REAL,
    lon            REAL,
    price_cents    INTEGER,
    currency       TEXT,
    points         INTEGER,                           -- an award booking's points or miles
    points_program TEXT,                              -- BAM's program id
    airline        TEXT,                              -- a flight: IATA code (UA)
    flight_number  TEXT,                              -- 837
    dep_airport    TEXT,                              -- IATA (SFO)
    arr_airport    TEXT,
    dep_terminal   TEXT,
    dep_gate       TEXT,
    arr_terminal   TEXT,
    seat           TEXT,
    source         TEXT    NOT NULL DEFAULT 'typed' CHECK (source IN ('typed', 'paste', 'pdf', 'screenshot', 'email')),
    source_sha256  TEXT,
    notes          TEXT,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_trip_items_trip ON trip_items (trip_id, start_at);

-- Transactions in a trip: confirmed by a person, or dismissed (so they aren't suggested again).
-- item_id: the booking it paid for, when it matched one.
CREATE TABLE trip_transactions (
    trip_id        INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    state          TEXT    NOT NULL CHECK (state IN ('confirmed', 'dismissed')),
    item_id        INTEGER REFERENCES trip_items (id) ON DELETE SET NULL,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (trip_id, transaction_id)
) WITHOUT ROWID;
CREATE INDEX idx_trip_txn_transaction ON trip_transactions (transaction_id);
