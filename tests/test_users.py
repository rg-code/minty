import pytest

from app import config
from app.routes import link


def test_parse_users_default_and_order():
    assert list(config.parse_users("me:Me,spouse:Spouse").items()) == [("me", "Me"), ("spouse", "Spouse")]
    assert config.USERS == {"me": "Me", "spouse": "Spouse"}        # conftest leaves MINTY_USERS unset


def test_parse_users_trims_and_defaults_label():
    assert config.parse_users(" me : Me , alex ,, kid2:Sam Lee ") == {"me": "Me", "alex": "Alex", "kid2": "Sam Lee"}


@pytest.mark.parametrize("raw", ["Me:Me", "me_2:Me", "2me:Me", ":Nameless", "", " , "])
def test_parse_users_rejects_bad_keys_and_empty(raw):
    with pytest.raises(ValueError):
        config.parse_users(raw)


def test_parse_users_rejects_duplicates():
    with pytest.raises(ValueError, match="duplicate"):
        config.parse_users("me:Me,me:Also me")


def test_cred_reads_per_user_env_vars(monkeypatch):
    monkeypatch.setitem(config._ENV, "PLAID_CLIENT_ID_ALEX_PRIMARY", "cid_alex")
    monkeypatch.setitem(config._ENV, "PLAID_SECRET_ALEX_PRIMARY", "secret_alex")
    assert config._cred("alex", "primary") == {"client_id": "cid_alex", "secret": "secret_alex", "owner": "alex"}
    assert config._cred("alex", "backup") == {"client_id": "", "secret": "", "owner": "alex"}


def test_users_endpoint_reports_slots_without_secrets(client):
    r = client.get("/users")
    assert r.json() == [
        {"key": "me", "label": "Me", "slots": [
            {"account": "me_primary", "slot": "primary", "configured": True},
            {"account": "me_backup", "slot": "backup", "configured": True}]},
        {"key": "spouse", "label": "Spouse", "slots": [
            {"account": "spouse_primary", "slot": "primary", "configured": True},
            {"account": "spouse_backup", "slot": "backup", "configured": True}]},
    ]
    assert "secret_" not in r.text and "cid_" not in r.text


def _unset(monkeypatch, account):
    monkeypatch.setitem(config.PLAID_ACCOUNTS, account,
                        {"client_id": "", "secret": "", "owner": config.owner_of(account)})


def test_users_endpoint_flags_missing_keys(client, monkeypatch):
    _unset(monkeypatch, "spouse_backup")
    spouse = client.get("/users").json()[1]
    assert [s["configured"] for s in spouse["slots"]] == [True, False]


def test_link_token_refuses_slot_without_keys(client, monkeypatch):
    _unset(monkeypatch, "me_primary")
    monkeypatch.setattr(link, "_count", lambda key: 0)
    called = []
    monkeypatch.setattr(link, "client_for", lambda acct: called.append(acct))
    r = client.post("/link/token", json={"owner": "me"})
    assert r.status_code == 400
    assert "PLAID_CLIENT_ID_ME_PRIMARY" in r.json()["detail"]
    assert called == []                                               # never reached Plaid
