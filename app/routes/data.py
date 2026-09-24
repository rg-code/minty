from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel

from ..db import pool, query
from ..config import settings, OWNER_ACCOUNTS


router = APIRouter()


@router.get("/items")
def items():
    return query(
        "SELECT id, owner, plaid_account, institution_name, status, updated_at "
        "FROM items ORDER BY owner, id"
    )


@router.get("/accounts")
def accounts(owner: str | None = Query(None)):
    if owner:
        return query("SELECT * FROM accounts WHERE owner=%s ORDER BY name", (owner,))
    return query("SELECT * FROM accounts ORDER BY owner, name")


@router.get("/capacity")
def capacity():
    """Per-person Trial-account usage: how many Items each holds vs the cap."""
    counts = {r["plaid_account"]: r["n"]
              for r in query("SELECT plaid_account, count(*) AS n FROM items GROUP BY plaid_account")}
    out = {}
    for owner, keys in OWNER_ACCOUNTS.items():
        out[owner] = [
            {"account": k, "slot": k.split("_", 1)[1], "used": counts.get(k, 0), "cap": settings.trial_item_cap}
            for k in keys
        ]
    return out


@router.get("/transactions")
def transactions(
    owner: str | None = Query(None),
    account_id: int | None = Query(None),
    start: str | None = Query(None),
    end: str | None = Query(None),
    q: str | None = Query(None),
    tag: str | None = Query(None),
    limit: int = Query(500, le=1000),
):
    base = """
        SELECT t.*,
               a.name    AS account_name,
               a.mask    AS account_mask,
               a.type    AS account_type,
               a.subtype AS account_subtype
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
    """
    clauses, params = [], []
    if owner:      clauses.append("t.owner = %s");        params.append(owner)
    if account_id: clauses.append("t.account_id = %s");   params.append(account_id)
    if start:      clauses.append("t.date >= %s");        params.append(start)
    if end:        clauses.append("t.date <= %s");        params.append(end)
    if tag:        clauses.append("%s = ANY(t.tags)");    params.append(tag)
    if q:
        clauses.append("(t.name ILIKE %s OR t.merchant_name ILIKE %s)")
        params += [f"%{q}%", f"%{q}%"]
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    return query(f"{base} {where} ORDER BY t.date DESC, t.id DESC LIMIT %s", tuple(params))


@router.get("/tags")
def list_tags():
    rows = query("SELECT DISTINCT unnest(tags) AS tag FROM transactions ORDER BY tag")
    return [r["tag"] for r in rows]


class TagsBody(BaseModel):
    tags: list[str]


def _normalise(tags: list[str]) -> list[str]:
    seen, clean = set(), []
    for t in tags:
        t = t.strip()
        if t and t.lower() not in seen:
            seen.add(t.lower())
            clean.append(t)
    return clean


@router.put("/transactions/{txn_id}/tags")
def set_tags(txn_id: int, body: TagsBody):
    clean = _normalise(body.tags)
    with pool.connection() as conn:
        row = conn.execute(
            "UPDATE transactions SET tags = %s WHERE id = %s RETURNING id, tags",
            (clean, txn_id),
        ).fetchone()
        conn.commit()
    if not row:
        raise HTTPException(404, "transaction not found")
    return {"id": row[0], "tags": row[1]}
