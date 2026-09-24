from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Four Plaid Trial credential sets: primary + backup for each person.
    plaid_client_id_me_primary: str = ""
    plaid_secret_me_primary: str = ""
    plaid_client_id_me_backup: str = ""
    plaid_secret_me_backup: str = ""
    plaid_client_id_spouse_primary: str = ""
    plaid_secret_spouse_primary: str = ""
    plaid_client_id_spouse_backup: str = ""
    plaid_secret_spouse_backup: str = ""

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

# Which credential slots each person has, in overflow order (primary first).
# To add a third overflow account later: add "overflow2" here + the four env vars.
_LAYOUT: dict[str, list[str]] = {
    "me": ["primary", "backup"],
    "spouse": ["primary", "backup"],
}


def _cred(owner: str, slot: str) -> dict[str, str]:
    return {
        "client_id": getattr(settings, f"plaid_client_id_{owner}_{slot}"),
        "secret": getattr(settings, f"plaid_secret_{owner}_{slot}"),
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


def owner_of(plaid_account: str) -> str:
    return PLAID_ACCOUNTS[plaid_account]["owner"]
