"""Regenerate test/fixtures/fernet-vectors.json (Python -> Worker direction).

Run from the repo root with the Python test env:
    .venv/bin/python scripts/make-fernet-vectors.py
The key is a throwaway test key; the plaintexts are fake. The file's "worker_tokens" section
(Worker -> Python direction) is produced by scripts/make-fernet-vectors-worker.ts and kept.
"""
import json
import pathlib

from cryptography.fernet import Fernet

PATH = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures" / "fernet-vectors.json"
KEY = "uJ2Cr7n5n8QXZd8r6l0eH8tq3aK4bmFvK4H2Q9F3Wn8="          # TEST ONLY — never a real key
PLAINTEXTS = [
    "access-sandbox-8ab976e6-64bc-4b38-98f7-731e7a349970",   # the shape of a Plaid access token
    "access-production-00000000-1111-2222-3333-444444444444",
    "",
    "x" * 16,                                                # exactly one AES block (+ full pad block)
    "unicode ✓ café",
]

existing = json.loads(PATH.read_text()) if PATH.exists() else {}
f = Fernet(KEY.encode())
PATH.parent.mkdir(parents=True, exist_ok=True)
PATH.write_text(json.dumps({
    "_comment": "Fernet cross-compatibility vectors. TEST KEY AND FAKE TOKENS ONLY.",
    "key": KEY,
    "other_key": "dGhpcy1pcy1hbm90aGVyLXRlc3Qta2V5LTMyYnl0ZXM=",
    "python_tokens": [{"plaintext": p, "token": f.encrypt(p.encode()).decode()} for p in PLAINTEXTS],
    "worker_tokens": existing.get("worker_tokens", []),
}, indent=2, ensure_ascii=False) + "\n")
print(f"wrote {PATH}")
