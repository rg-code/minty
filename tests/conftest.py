"""Test env: dummy credentials only. app.config reads settings at import time,
so everything is set here before any app module is imported. Explicit env vars
take precedence over a .env file, so a real .env never leaks into tests."""
import os

from cryptography.fernet import Fernet

os.environ.update({
    "DATABASE_URL": "postgresql://test:test@127.0.0.1:1/test",   # pool is never opened
    "TOKEN_ENC_KEY": Fernet.generate_key().decode(),
    "PLAID_ENV": "sandbox",
    "PLAID_REDIRECT_URI": "",
    "TRIAL_ITEM_CAP": "10",
    "SYNC_INTERVAL_SECONDS": "21600",
    "ALLOWED_LOGINS": " me@example.com , Spouse@Example.com ",
    **{f"PLAID_CLIENT_ID_{k}": f"cid_{k.lower()}" for k in
       ("ME_PRIMARY", "ME_BACKUP", "SPOUSE_PRIMARY", "SPOUSE_BACKUP")},
    **{f"PLAID_SECRET_{k}": f"secret_{k.lower()}" for k in
       ("ME_PRIMARY", "ME_BACKUP", "SPOUSE_PRIMARY", "SPOUSE_BACKUP")},
})

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._row = None

    def __enter__(self): return self
    def __exit__(self, *a): return False

    def execute(self, sql, params=()):
        self.conn.executed.append((" ".join(sql.split()), params))
        self.conn.next_id += 1
        rows = self.conn.pool.rows
        self._row = rows.pop(0) if rows else (self.conn.next_id,)
        return self

    def fetchone(self): return self._row


class FakeConn:
    def __init__(self, pool):
        self.pool = pool
        self.executed = pool.executed
        self.next_id = 0

    def __enter__(self): return self
    def __exit__(self, *a): return False

    def cursor(self, *a, **k): return FakeCursor(self)
    def execute(self, sql, params=()): return FakeCursor(self).execute(sql, params)
    def commit(self): self.pool.commits.append(len(self.executed))


class FakePool:
    """Records every statement; commits[] holds len(executed) at each commit.
    Queue rows[] to control what fetchone() returns (default: a fresh (id,))."""
    def __init__(self):
        self.executed, self.commits, self.rows = [], [], []

    def connection(self): return FakeConn(self)


class FakeResp:
    def __init__(self, d): self._d = d
    def to_dict(self): return self._d


@pytest.fixture
def fake_pool():
    return FakePool()


@pytest.fixture
def client():
    from app.main import app
    # No `with`: the lifespan (DB pool + sync scheduler) is deliberately not started.
    return TestClient(app, headers={"Tailscale-User-Login": "me@example.com"})
