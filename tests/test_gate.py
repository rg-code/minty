from fastapi.testclient import TestClient

from app import main
from app.main import app


def test_healthz_is_open_without_identity():
    assert TestClient(app).get("/healthz").json() == {"ok": True}


def test_missing_identity_is_forbidden():
    r = TestClient(app).get("/")
    assert r.status_code == 403


def test_unknown_identity_is_forbidden():
    r = TestClient(app).get("/", headers={"Tailscale-User-Login": "stranger@example.com"})
    assert r.status_code == 403


def test_gated_routes_reject_before_touching_db():
    # /items would hit Postgres; the gate must answer first.
    for method, path in [("get", "/items"), ("get", "/transactions"), ("post", "/link/token")]:
        assert getattr(TestClient(app), method)(path).status_code == 403


def test_allowed_identity_is_case_insensitive():
    r = TestClient(app).get("/", headers={"Tailscale-User-Login": "SPOUSE@example.COM"})
    assert r.status_code == 200
    assert "<title>Minty</title>" in r.text


def test_empty_allowlist_disables_gate(monkeypatch):
    monkeypatch.setattr(main, "ALLOWED_LOGINS", set())
    assert TestClient(app).get("/").status_code == 200


def test_no_sync_http_endpoint():
    # Invariant: sync runs only via the in-process scheduler or the CLI.
    paths = list(app.openapi()["paths"])
    assert "/link/token" in paths and "/transactions" in paths    # sanity: routers are included
    assert not [p for p in paths if "sync" in p.lower()]
