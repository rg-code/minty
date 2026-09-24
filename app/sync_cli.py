"""Manual one-shot sync, run inside the container:

    docker compose exec api python -m app.sync_cli

No HTTP endpoint is exposed for this — it opens its own pool, syncs, exits.
"""
from .db import pool
from .sync_engine import run_sync_all

if __name__ == "__main__":
    pool.open()
    try:
        print(run_sync_all())
    finally:
        pool.close()
