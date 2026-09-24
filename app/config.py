import os
import re

from dotenv import dotenv_values
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # People, in display order: comma-separated "key:Label". Each gets a primary + backup
    # Plaid Trial credential set from PLAID_CLIENT_ID_<KEY>_<SLOT> / PLAID_SECRET_<KEY>_<SLOT>.
    minty_users: str = "me:Me,spouse:Spouse"

    plaid_env: str = "production"
    plaid_redirect_uri: str = ""
    trial_item_cap: int = 10

    # In-process sync scheduler (no separate container / HTTP endpoint).
    sync_interval_seconds: int = 21600     # 6 hours

    # Identity gate: comma-separated Tailscale logins allowed to reach the app.
    # Empty = gate DISABLED (open to the whole tailnet) — set this to lock it down.
    allowed_logins: str = ""

    database_url: str
    token_enc_key: str


settings = Settings()

# Parsed set of allowed Tailscale identities; empty set means the gate is off.
ALLOWED_LOGINS = {s.strip().lower() for s in settings.allowed_logins.split(",") if s.strip()}

# Keys end up in env var names and in plaid_account ("<key>_<slot>"), so no underscores.
_USER_KEY = re.compile(r"[a-z][a-z0-9]{0,23}")


def parse_users(raw: str) -> dict[str, str]:
    """'me:Me,spouse:Spouse' -> {'me': 'Me', 'spouse': 'Spouse'}, preserving order."""
    users: dict[str, str] = {}
    for part in raw.split(","):
        if not part.strip():
            continue
        key, _, label = part.partition(":")
        key, label = key.strip(), label.strip()
        if not _USER_KEY.fullmatch(key):
            raise ValueError(f"MINTY_USERS: invalid user key {key!r} "
                             "(lowercase letters and digits, starting with a letter)")
        if key in users:
            raise ValueError(f"MINTY_USERS: duplicate user key {key!r}")
        users[key] = label or key.capitalize()
    if not users:
        raise ValueError("MINTY_USERS is empty")
    return users


# key -> display label, in display order
USERS: dict[str, str] = parse_users(settings.minty_users)

# Which credential slots each person has, in overflow order (primary first).
# To add a third overflow account later: add "overflow2" here + the env vars.
SLOTS = ["primary", "backup"]
_LAYOUT: dict[str, list[str]] = {owner: list(SLOTS) for owner in USERS}

# Per-user Plaid keys can't be declared Settings fields, so read them the way
# pydantic-settings does: real environment first, then the .env file.
_ENV = {**dotenv_values(".env"), **os.environ}


def _cred(owner: str, slot: str) -> dict[str, str]:
    return {
        "client_id": _ENV.get(f"PLAID_CLIENT_ID_{owner}_{slot}".upper()) or "",
        "secret": _ENV.get(f"PLAID_SECRET_{owner}_{slot}".upper()) or "",
        "owner": owner,
    }


# plaid_account key (e.g. "me_primary") -> {client_id, secret, owner}
PLAID_ACCOUNTS: dict[str, dict[str, str]] = {}
# owner -> ordered list of its plaid_account keys
OWNER_ACCOUNTS: dict[str, list[str]] = {}

for _owner, _slots in _LAYOUT.items():
    OWNER_ACCOUNTS[_owner] = []
    for _slot in _slots:
        _key = f"{_owner}_{_slot}"
        PLAID_ACCOUNTS[_key] = _cred(_owner, _slot)
        OWNER_ACCOUNTS[_owner].append(_key)

VALID_OWNERS = set(OWNER_ACCOUNTS.keys())


def creds_for(plaid_account: str) -> dict[str, str]:
    if plaid_account not in PLAID_ACCOUNTS:
        raise ValueError(f"unknown plaid_account: {plaid_account!r}")
    c = PLAID_ACCOUNTS[plaid_account]
    return {"client_id": c["client_id"], "secret": c["secret"]}


def is_configured(plaid_account: str) -> bool:
    """True when both the client_id and secret for this credential set are present."""
    return all(creds_for(plaid_account).values())


def owner_of(plaid_account: str) -> str:
    return PLAID_ACCOUNTS[plaid_account]["owner"]
