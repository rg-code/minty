import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from .db import pool
from .config import ALLOWED_LOGINS
from .routes import link, data
from . import scheduler

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("app")

STATIC = Path(__file__).parent / "static"

# Paths reachable without a tailnet identity (local liveness checks only).
OPEN_PATHS = {"/healthz"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool.open()
    scheduler.start()                      # in-process sync; no separate container
    if not ALLOWED_LOGINS:
        log.warning("ALLOWED_LOGINS is empty — identity gate DISABLED. "
                    "Set it in .env to restrict access to your tailnet logins.")
    yield
    scheduler.stop()
    pool.close()


app = FastAPI(title="Household Aggregator", lifespan=lifespan)


@app.middleware("http")
async def tailnet_identity_gate(request: Request, call_next):
    """Allow only known Tailscale identities. The Tailscale-User-Login header is
    injected by Tailscale Serve; the app binds to 127.0.0.1, so requests can't
    reach it without going through Serve. Empty ALLOWED_LOGINS disables the gate."""
    if ALLOWED_LOGINS and request.url.path not in OPEN_PATHS:
        who = (request.headers.get("tailscale-user-login") or "").lower()
        if who not in ALLOWED_LOGINS:
            return JSONResponse({"detail": "forbidden"}, status_code=403)
    return await call_next(request)


app.include_router(link.router)
app.include_router(data.router)


@app.get("/")
def dashboard():
    return FileResponse(STATIC / "index.html")


@app.get("/connect")
def connect():
    return FileResponse(STATIC / "connect.html")


@app.get("/healthz")
def health():
    return {"ok": True}
