import pytest

from app.routes import data


def test_normalise_tags():
    assert data._normalise(["  Travel", "travel", "", "  ", "Food", "TRAVEL"]) == ["Travel", "Food"]


@pytest.fixture
def captured(monkeypatch):
    calls = []
    monkeypatch.setattr(data, "query", lambda sql, params=(): calls.append((" ".join(sql.split()), params)) or [])
    return calls


def test_transactions_without_filters(client, captured):
    assert client.get("/transactions").json() == []
    (sql, params), = captured
    assert "WHERE" not in sql and sql.endswith("LIMIT %s")
    assert params == (500,)


def test_transactions_filters_are_parameterised(client, captured):
    client.get("/transactions", params={"owner": "spouse", "tag": "travel", "q": "50%'; --",
                                        "start": "2026-01-01", "end": "2026-01-31", "limit": 10})
    (sql, params), = captured
    assert "50%" not in sql                                   # user input never inlined
    assert "t.owner = %s" in sql and "%s = ANY(t.tags)" in sql and "ILIKE %s" in sql
    assert params == ("spouse", "2026-01-01", "2026-01-31", "travel", "%50%'; --%", "%50%'; --%", 10)


def test_transactions_limit_is_capped(client, captured):
    assert client.get("/transactions", params={"limit": 1001}).status_code == 422
    assert captured == []


def test_capacity_reports_every_slot(client, monkeypatch):
    monkeypatch.setattr(data, "query", lambda sql, params=(): [{"plaid_account": "me_primary", "n": 10},
                                                              {"plaid_account": "spouse_backup", "n": 2}])
    assert client.get("/capacity").json() == {
        "me": [{"account": "me_primary", "slot": "primary", "used": 10, "cap": 10},
               {"account": "me_backup", "slot": "backup", "used": 0, "cap": 10}],
        "spouse": [{"account": "spouse_primary", "slot": "primary", "used": 0, "cap": 10},
                   {"account": "spouse_backup", "slot": "backup", "used": 2, "cap": 10}],
    }


def test_set_tags_normalises(client, fake_pool, monkeypatch):
    monkeypatch.setattr(data, "pool", fake_pool)
    fake_pool.rows.append((7, ["Food"]))
    r = client.put("/transactions/7/tags", json={"tags": ["Food", "food", " "]})
    (sql, params), = fake_pool.executed
    assert sql.startswith("UPDATE transactions SET tags") and params == (["Food"], 7)
    assert r.json() == {"id": 7, "tags": ["Food"]}
    assert fake_pool.commits == [1]


def test_set_tags_unknown_transaction(client, fake_pool, monkeypatch):
    monkeypatch.setattr(data, "pool", fake_pool)
    fake_pool.rows.append(None)
    assert client.put("/transactions/999/tags", json={"tags": []}).status_code == 404
