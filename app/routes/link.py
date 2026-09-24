from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.products import Products
from plaid.model.country_code import CountryCode

from ..config import settings, VALID_OWNERS, PLAID_ACCOUNTS, OWNER_ACCOUNTS, owner_of
from ..plaid_client import client_for
from ..crypto import encrypt, decrypt
from ..db import pool, query
from ..sync_engine import sync_item

router = APIRouter(prefix="/link")


class TokenReq(BaseModel):
    owner: str


class ExchangeReq(BaseModel):
    owner: str
    plaid_account: str
    public_token: str


class UpdateReq(BaseModel):
    item_id: int


def _base_user(owner: str):
    return LinkTokenCreateRequestUser(client_user_id=owner)


def _redirect() -> dict:
    # plaid-python rejects redirect_uri=None, so omit the field when it isn't configured.
    return {"redirect_uri": settings.plaid_redirect_uri} if settings.plaid_redirect_uri else {}


def _count(plaid_account: str) -> int:
    return query("SELECT count(*) AS n FROM items WHERE plaid_account=%s", (plaid_account,))[0]["n"]


def choose_account_for(owner: str) -> str:
    """Pick this person's first Trial account under the item cap (primary, then backup)."""
    for key in OWNER_ACCOUNTS[owner]:
        if _count(key) < settings.trial_item_cap:
            return key
    raise HTTPException(
        409,
        f"All Plaid trial accounts for '{owner}' are at the {settings.trial_item_cap}-item cap. "
        f"Add another overflow account or upgrade to a paid Plaid plan.",
    )


@router.post("/token")
def create_link_token(body: TokenReq):
    if body.owner not in VALID_OWNERS:
        raise HTTPException(400, "unknown owner")
    account = choose_account_for(body.owner)           # <- overflow decision happens here
    req = LinkTokenCreateRequest(
        user=_base_user(body.owner),
        client_name="Minty",
        products=[Products("transactions")],
        country_codes=[CountryCode("US")],
        language="en",
        **_redirect(),
    )
    resp = client_for(account).link_token_create(req).to_dict()
    # Return which account was used so /exchange uses the SAME credentials.
    return {"link_token": resp["link_token"], "plaid_account": account}


@router.post("/exchange")
def exchange(body: ExchangeReq):
    if body.plaid_account not in PLAID_ACCOUNTS:
        raise HTTPException(400, "unknown plaid_account")
    if owner_of(body.plaid_account) != body.owner:
        raise HTTPException(400, "owner/account mismatch")

    client = client_for(body.plaid_account)
    resp = client.item_public_token_exchange(
        ItemPublicTokenExchangeRequest(public_token=body.public_token)).to_dict()

    with pool.connection() as conn:
        row = conn.execute(
            """INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc)
               VALUES (%s,%s,%s,%s) RETURNING id""",
            (body.owner, body.plaid_account, resp["item_id"], encrypt(resp["access_token"])),
        ).fetchone()
        conn.commit()
    item_pk = row[0]

    item = query("SELECT * FROM items WHERE id=%s", (item_pk,))[0]
    status = sync_item(item)   # initial backfill
    return {"item_id": item_pk, "plaid_account": body.plaid_account, "status": status}


@router.post("/token/update")
def update_mode(body: UpdateReq):
    rows = query("SELECT * FROM items WHERE id=%s", (body.item_id,))
    if not rows:
        raise HTTPException(404, "item not found")
    item = rows[0]
    req = LinkTokenCreateRequest(
        user=_base_user(item["owner"]),
        client_name="Minty",
        country_codes=[CountryCode("US")],
        language="en",
        access_token=decrypt(item["access_token_enc"]),   # update mode; no products
        **_redirect(),
    )
    resp = client_for(item["plaid_account"]).link_token_create(req).to_dict()
    return {"link_token": resp["link_token"], "plaid_account": item["plaid_account"]}
