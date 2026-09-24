import threading
import logging

from .config import settings
from .sync_engine import run_sync_all

log = logging.getLogger("scheduler")

_stop = threading.Event()
_thread: threading.Thread | None = None


def _loop():
    # Run once shortly after startup, then every sync_interval_seconds.
    # Blocking work (psycopg + plaid) is fine here — it's its own thread.
    first = True
    while not _stop.is_set():
        _stop.wait(5 if first else settings.sync_interval_seconds)
        first = False
        if _stop.is_set():
            break
        try:
            results = run_sync_all()
            log.info("scheduled sync complete: %s", results)
        except Exception:
            log.exception("scheduled sync failed")


def start():
    global _thread
    _thread = threading.Thread(target=_loop, name="sync-scheduler", daemon=True)
    _thread.start()
    log.info("sync scheduler started (every %ss)", settings.sync_interval_seconds)


def stop():
    _stop.set()
    if _thread:
        _thread.join(timeout=5)
