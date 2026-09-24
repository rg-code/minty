import plaid
from plaid.api import plaid_api
from .config import settings, creds_for

_HOSTS = {
    "production": plaid.Environment.Production,
    "sandbox": plaid.Environment.Sandbox,
}


def client_for(plaid_account: str) -> plaid_api.PlaidApi:
    """Build a Plaid client bound to one Trial account's credentials."""
    c = creds_for(plaid_account)
    configuration = plaid.Configuration(
        host=_HOSTS[settings.plaid_env],
        api_key={"clientId": c["client_id"], "secret": c["secret"]},
    )
    return plaid_api.PlaidApi(plaid.ApiClient(configuration))
