-- BAM (docs/bam.md): miles and points balances, typed in or (M2) read from a statement PDF in the
-- browser. Each row is one reading of one balance; the view shows the newest per person, program
-- and account. Only the fields are stored, never the PDF; its SHA-256 lets the same file be
-- skipped next time.
CREATE TABLE point_balances (
    id           INTEGER PRIMARY KEY,
    owner        TEXT    NOT NULL,                     -- MINTY_USERS key
    program      TEXT    NOT NULL,                     -- an id from src/points/programs.ts, or a name typed in
    account_hint TEXT,                                 -- the account's or member number's last 4 digits, if several
    balance      INTEGER NOT NULL CHECK (balance >= 0),
    as_of        TEXT    NOT NULL,                     -- YYYY-MM-DD: the date the balance was correct
    source       TEXT    NOT NULL CHECK (source IN ('manual', 'pdf')),
    file_sha256  TEXT    UNIQUE,                       -- the PDF's fingerprint (pdf only)
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- No index: a household has a few hundred readings, and GET /points reads them all once (an index
-- walk plus row lookups would read each twice).
