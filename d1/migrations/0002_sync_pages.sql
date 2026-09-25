-- Scratch space for one /transactions/sync page while its batch runs (src/sync.ts). The page is
-- sent to D1 once, as text, and unpacked by SQLite, so the Worker never parses it (free-plan CPU
-- limit). The row is deleted in the same batch that inserts it.
CREATE TABLE sync_pages (
    item_id INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    body    TEXT    NOT NULL
);
