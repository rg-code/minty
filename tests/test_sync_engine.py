import json

import pytest
from plaid.exceptions import ApiException

from app import sync_engine
from app.crypto import encrypt
from tests.conftest import FakeResp


def _acct(aid):
    return {"account_id": aid, "name": "Checking", "mask": "1234", "type": "depository",
            "subtype": "checking", "balances": {"current": 10.5, "available": 9.0, "iso_currency_code": "USD"}}


def _txn(tid, aid="acc-1"):
    return {"transaction_id": tid, "account_id": aid, "amount": 12.34, "iso_currency_code": "USD",
            "date": "2026-09-01", "datetime": None, "name": "Coffee", "merchant_name": "Cafe",
            "personal_finance_category": {"primary": "FOOD_AND_DRINK"}, "pending": False,
            "pending_transaction_id": None}


class PagedPlaid:
    def __init__(self, pages=None, error=None):
        self.pages, self.error, self.cursors = list(pages or []), error, []

    def transactions_sync(self, req):
        self.cursors.append(req.cursor)
        if self.error:
            raise self.error
        return FakeResp(self.pages.pop(0))


ITEM = {"id": 5, "owner": "spouse", "plaid_account": "spouse_backup", "txn_cursor": None,
        "access_token_enc": encrypt("access-sandbox-secret")}


@pytest.fixture
def wire(monkeypatch, fake_pool):
    def _wire(plaid):
        used = []
        monkeypatch.setattr(sync_engine, "pool", fake_pool)
        monkeypatch.setattr(sync_engine, "client_for", lambda acct: used.append(acct) or plaid)
        return used
    return _wire


def test_syncs_all_pages_and_advances_cursor_only_after_each_page(wire, fake_pool):
    plaid = PagedPlaid([
        {"accounts": [_acct("acc-1")], "added": [_txn("t1"), _txn("t-orphan", aid="acc-unknown")],
         "modified": [], "removed": [], "next_cursor": "c1", "has_more": True},
        {"accounts": [_acct("acc-1")], "added": [], "modified": [_txn("t1")],
         "removed": [{"transaction_id": "t0"}], "next_cursor": "c2", "has_more": False},
    ])
    used = wire(plaid)

    assert sync_engine.sync_item(ITEM) == "good"

    assert used == ["spouse_backup"]                 # creds follow item.plaid_account, not owner
    assert plaid.cursors == ["", "c1"]
    sqls = [s for s, _ in fake_pool.executed]
    cursor_updates = [(i, p) for i, (s, p) in enumerate(fake_pool.executed) if s.startswith("UPDATE items SET txn_cursor")]
    assert [p for _, p in cursor_updates] == [("c1", 5), ("c2", 5)]
    # each page commits right after its cursor update, i.e. cursor moves with the data
    assert fake_pool.commits == [i + 1 for i, _ in cursor_updates]
    txn_inserts = [p for s, p in fake_pool.executed if s.startswith("INSERT INTO transactions")]
    assert [p[2] for p in txn_inserts] == ["t1", "t1"]       # orphan skipped
    assert all(p[0] == "spouse" for p in txn_inserts)
    assert txn_inserts[0][9] == "FOOD_AND_DRINK"
    assert ("DELETE FROM transactions WHERE plaid_txn_id = ANY(%s)", (["t0"],)) in fake_pool.executed
    assert not any("tags" in s for s in sqls if s.startswith("INSERT INTO transactions"))


def test_resumes_from_stored_cursor(wire):
    plaid = PagedPlaid([{"accounts": [], "added": [], "modified": [], "removed": [],
                         "next_cursor": "c9", "has_more": False}])
    wire(plaid)
    sync_engine.sync_item({**ITEM, "txn_cursor": "c8"})
    assert plaid.cursors == ["c8"]


@pytest.mark.parametrize("code,status", [("ITEM_LOGIN_REQUIRED", "login_required"),
                                         ("INTERNAL_SERVER_ERROR", "error")])
def test_plaid_errors_set_item_status(wire, fake_pool, code, status):
    err = ApiException(status=400)
    err.body = json.dumps({"error_code": code})
    wire(PagedPlaid(error=err))
    assert sync_engine.sync_item(ITEM) == status
    assert fake_pool.executed == [("UPDATE items SET status=%s, updated_at=now() WHERE id=%s", (status, 5))]


def test_run_sync_all_sweeps_items(monkeypatch):
    monkeypatch.setattr(sync_engine, "query", lambda sql, params=(): [{"id": 1}, {"id": 2}])
    monkeypatch.setattr(sync_engine, "sync_item", lambda item: f"good-{item['id']}")
    assert sync_engine.run_sync_all() == {1: "good-1", 2: "good-2"}
