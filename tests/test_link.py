import pytest
from fastapi import HTTPException

from app.crypto import decrypt, encrypt
from app.routes import link
from tests.conftest import FakeResp


def _counts(monkeypatch, counts):
    monkeypatch.setattr(link, "_count", lambda key: counts.get(key, 0))


def test_routes_to_primary_while_under_cap(monkeypatch):
    _counts(monkeypatch, {"me_primary": 9})
    assert link.choose_account_for("me") == "me_primary"


def test_overflows_to_backup_at_cap(monkeypatch):
    _counts(monkeypatch, {"me_primary": 10, "me_backup": 3})
    assert link.choose_account_for("me") == "me_backup"


def test_never_routes_to_the_other_persons_accounts(monkeypatch):
    _counts(monkeypatch, {"spouse_primary": 10})
    assert link.choose_account_for("spouse") == "spouse_backup"
    _counts(monkeypatch, {"spouse_primary": 10, "spouse_backup": 10})
    with pytest.raises(HTTPException) as e:
        link.choose_account_for("spouse")
    assert e.value.status_code == 409


class FakePlaid:
    def __init__(self):
        self.calls = []

    def link_token_create(self, req):
        self.calls.append(("link_token_create", req))
        return FakeResp({"link_token": "link-sandbox-abc"})

    def item_public_token_exchange(self, req):
        self.calls.append(("exchange", req))
        return FakeResp({"item_id": "plaid-item-1", "access_token": "access-sandbox-secret"})


@pytest.fixture
def plaid(monkeypatch):
    fake, used = FakePlaid(), []
    monkeypatch.setattr(link, "client_for", lambda acct: used.append(acct) or fake)
    fake.used = used
    return fake


def test_token_unknown_owner(client, plaid):
    assert client.post("/link/token", json={"owner": "neighbour"}).status_code == 400
    assert plaid.calls == []


def test_token_uses_chosen_account_and_reports_it(client, plaid, monkeypatch):
    _counts(monkeypatch, {"me_primary": 10})
    r = client.post("/link/token", json={"owner": "me"})
    assert r.status_code == 200, r.text
    assert r.json() == {"link_token": "link-sandbox-abc", "plaid_account": "me_backup"}
    assert plaid.used == ["me_backup"]
    (_, req), = plaid.calls
    assert "redirect_uri" not in req                         # blank setting -> field omitted


def test_token_passes_redirect_uri_when_configured(client, plaid, monkeypatch):
    _counts(monkeypatch, {})
    monkeypatch.setattr(link.settings, "plaid_redirect_uri", "https://minty.example.ts.net/connect")
    assert client.post("/link/token", json={"owner": "spouse"}).status_code == 200
    (_, req), = plaid.calls
    assert req["redirect_uri"] == "https://minty.example.ts.net/connect"


@pytest.mark.parametrize("body", [
    {"owner": "me", "plaid_account": "me_overflow2", "public_token": "p"},     # unknown account
    {"owner": "me", "plaid_account": "spouse_primary", "public_token": "p"},   # owner mismatch
])
def test_exchange_rejects_bad_owner_account_pairs(client, plaid, body):
    assert client.post("/link/exchange", json=body).status_code == 400
    assert plaid.calls == []


def test_exchange_stores_token_encrypted_then_backfills(client, plaid, fake_pool, monkeypatch):
    monkeypatch.setattr(link, "pool", fake_pool)
    monkeypatch.setattr(link, "query", lambda sql, params=(): [{"id": params[0], "owner": "me"}])
    synced = []
    monkeypatch.setattr(link, "sync_item", lambda item: synced.append(item) or "good")

    r = client.post("/link/exchange",
                    json={"owner": "me", "plaid_account": "me_backup", "public_token": "public-x"})

    assert r.status_code == 200, r.text
    assert r.json()["plaid_account"] == "me_backup" and r.json()["status"] == "good"
    assert plaid.used == ["me_backup"]
    (sql, params), = fake_pool.executed
    assert sql.startswith("INSERT INTO items")
    owner, account, item_id, token_blob = params
    assert (owner, account, item_id) == ("me", "me_backup", "plaid-item-1")
    assert token_blob != b"access-sandbox-secret"
    assert decrypt(token_blob) == "access-sandbox-secret"
    assert "access-sandbox-secret" not in r.text
    assert fake_pool.commits == [1] and len(synced) == 1


def test_update_mode_unknown_item(client, plaid, monkeypatch):
    monkeypatch.setattr(link, "query", lambda sql, params=(): [])
    assert client.post("/link/token/update", json={"item_id": 42}).status_code == 404


def test_update_mode_uses_items_own_account_and_token(client, plaid, monkeypatch):
    item = {"id": 3, "owner": "me", "plaid_account": "me_backup",
            "access_token_enc": encrypt("access-sandbox-secret")}
    monkeypatch.setattr(link, "query", lambda sql, params=(): [item])
    r = client.post("/link/token/update", json={"item_id": 3})
    assert r.status_code == 200, r.text
    assert r.json() == {"link_token": "link-sandbox-abc", "plaid_account": "me_backup"}
    assert plaid.used == ["me_backup"]
    (_, req), = plaid.calls
    assert req["access_token"] == "access-sandbox-secret" and "products" not in req
    assert "access-sandbox-secret" not in r.text
