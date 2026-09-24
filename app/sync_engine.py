import json
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from plaid.exceptions import ApiException

from .db import pool, query
from .crypto import decrypt
from .plaid_client import client_for


def run_sync_all() -> dict:
    """Sweep every non-errored Item. Called by the in-process scheduler and the CLI."""
    results = {}
    for item in query("SELECT * FROM items WHERE status != 'error' OR status IS NULL"):
        results[item["id"]] = sync_item(item)   # creds resolved per item.plaid_account
    return results


class _Obj:
    """resp is already a dict (we call .to_dict()); wrap so helpers can call .to_dict()."""
    def __init__(self, d): self._d = d
    def to_dict(self): return self._d


def _upsert_account(cur, owner, item_id, acct) -> int:
    a = acct.to_dict()
    bal = a.get("balances", {}) or {}
    cur.execute(
        """
        INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype,
                              balance_current, balance_available, currency, updated_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (plaid_account_id) DO UPDATE SET
            name=EXCLUDED.name, mask=EXCLUDED.mask, type=EXCLUDED.type, subtype=EXCLUDED.subtype,
            balance_current=EXCLUDED.balance_current, balance_available=EXCLUDED.balance_available,
            currency=EXCLUDED.currency, updated_at=now()
        RETURNING id
        """,
        (owner, item_id, a["account_id"], a.get("name"), a.get("mask"),
         str(a.get("type")), str(a.get("subtype")),
         bal.get("current"), bal.get("available"), bal.get("iso_currency_code")),
    )
    return cur.fetchone()[0]


def _upsert_txn(cur, owner, acct_id_map, txn):
    t = txn.to_dict()
    acct_id = acct_id_map.get(t["account_id"])
    if acct_id is None:
        return  # account not seen yet; a later run's accounts[] will backfill it
    pfc = t.get("personal_finance_category") or {}
    cur.execute(
        """
        INSERT INTO transactions (owner, account_id, plaid_txn_id, amount, currency, date, datetime,
                                  name, merchant_name, category, pending, pending_txn_id)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (plaid_txn_id) DO UPDATE SET
            amount=EXCLUDED.amount, date=EXCLUDED.date, datetime=EXCLUDED.datetime,
            name=EXCLUDED.name, merchant_name=EXCLUDED.merchant_name, category=EXCLUDED.category,
            pending=EXCLUDED.pending, pending_txn_id=EXCLUDED.pending_txn_id
        """,
        (owner, acct_id, t["transaction_id"], t.get("amount"), t.get("iso_currency_code"),
         t.get("date"), t.get("datetime"), t.get("name"), t.get("merchant_name"),
         pfc.get("primary"), t.get("pending"), t.get("pending_transaction_id")),
    )
    # NOTE: 'tags' is intentionally never written here, so user labels survive re-syncs.


def sync_item(item: dict) -> str:
    """Sync one Item to completion. Credentials are chosen by the Item's plaid_account."""
    owner = item["owner"]
    client = client_for(item["plaid_account"])      # <- routes to the right Trial account
    access_token = decrypt(item["access_token_enc"])
    cursor = item["txn_cursor"] or ""

    try:
        has_more = True
        while has_more:
            req = TransactionsSyncRequest(access_token=access_token, cursor=cursor)
            resp = client.transactions_sync(req).to_dict()

            with pool.connection() as conn:
                with conn.cursor() as cur:
                    acct_id_map = {}
                    for acct in resp["accounts"]:
                        acct_id_map[acct["account_id"]] = _upsert_account(
                            cur, owner, item["id"], _Obj(acct))
                    for txn in resp["added"] + resp["modified"]:
                        _upsert_txn(cur, owner, acct_id_map, _Obj(txn))
                    removed_ids = [r["transaction_id"] for r in resp["removed"]]
                    if removed_ids:
                        cur.execute("DELETE FROM transactions WHERE plaid_txn_id = ANY(%s)", (removed_ids,))
                    # advance cursor ONLY after the page is persisted
                    cur.execute(
                        "UPDATE items SET txn_cursor=%s, status='good', updated_at=now() WHERE id=%s",
                        (resp["next_cursor"], item["id"]))
                conn.commit()

            cursor = resp["next_cursor"]
            has_more = resp["has_more"]
        return "good"

    except ApiException as e:
        try:
            code = (json.loads(e.body) or {}).get("error_code")
        except Exception:
            code = None
        new_status = "login_required" if code == "ITEM_LOGIN_REQUIRED" else "error"
        with pool.connection() as conn:
            conn.execute("UPDATE items SET status=%s, updated_at=now() WHERE id=%s",
                         (new_status, item["id"]))
            conn.commit()
        return new_status
