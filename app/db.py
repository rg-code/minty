from psycopg_pool import ConnectionPool
from psycopg.rows import dict_row
from .config import settings

pool = ConnectionPool(conninfo=settings.database_url, min_size=1, max_size=5, open=False)


def query(sql: str, params: tuple = ()) -> list[dict]:
    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else []
