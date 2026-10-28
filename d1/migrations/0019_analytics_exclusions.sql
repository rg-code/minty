-- Left out of the numbers (CFA, docs/cfa.md): a tag, a bank (an Item) or an account the household
-- keeps out of the audit, the dashboard's cards and EGG. Their transactions still show on the
-- dashboard. Sync never writes here, like tags and corrections.
CREATE TABLE analytics_exclusions (
    kind       TEXT NOT NULL CHECK (kind IN ('tag', 'bank', 'account')),
    value      TEXT NOT NULL,                          -- the tag as spelled, or items.id / accounts.id
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (kind, value)
) WITHOUT ROWID;
