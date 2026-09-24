import pytest

from app import config


def test_four_credential_sets_in_overflow_order():
    assert config.OWNER_ACCOUNTS == {
        "me": ["me_primary", "me_backup"],
        "spouse": ["spouse_primary", "spouse_backup"],
    }
    assert set(config.PLAID_ACCOUNTS) == {"me_primary", "me_backup", "spouse_primary", "spouse_backup"}
    assert config.VALID_OWNERS == {"me", "spouse"}


def test_creds_for_returns_only_that_sets_credentials():
    assert config.creds_for("spouse_backup") == {
        "client_id": "cid_spouse_backup", "secret": "secret_spouse_backup"}


def test_creds_for_unknown_account_raises():
    with pytest.raises(ValueError):
        config.creds_for("me_overflow2")


@pytest.mark.parametrize("account,owner", [
    ("me_primary", "me"), ("me_backup", "me"),
    ("spouse_primary", "spouse"), ("spouse_backup", "spouse"),
])
def test_owner_of(account, owner):
    assert config.owner_of(account) == owner


def test_allowed_logins_are_trimmed_and_lowercased():
    assert config.ALLOWED_LOGINS == {"me@example.com", "spouse@example.com"}
