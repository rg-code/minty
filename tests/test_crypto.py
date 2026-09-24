from app.crypto import encrypt, decrypt


def test_roundtrip():
    blob = encrypt("access-sandbox-123")
    assert isinstance(blob, bytes)
    assert b"access-sandbox-123" not in blob
    assert decrypt(blob) == "access-sandbox-123"


def test_decrypt_accepts_memoryview_from_bytea():
    assert decrypt(memoryview(encrypt("tok"))) == "tok"


def test_decrypts_tokens_encrypted_by_the_worker():
    """Worker (src/fernet.ts, WebCrypto) -> Python direction; the reverse is in test/fernet.test.ts.
    Keeps the two backends interchangeable for the P4 migration: same key, same token format."""
    import json
    import pathlib

    import pytest
    from cryptography.fernet import Fernet

    vectors = json.loads((pathlib.Path(__file__).parent.parent / "test" / "fixtures" / "fernet-vectors.json").read_text())
    assert vectors["worker_tokens"], "run: node scripts/make-fernet-vectors-worker.ts"
    f = Fernet(vectors["key"].encode())
    for v in vectors["worker_tokens"]:
        assert f.decrypt(v["token"].encode()).decode() == v["plaintext"]
    with pytest.raises(Exception):
        Fernet(vectors["other_key"].encode()).decrypt(vectors["worker_tokens"][0]["token"].encode())
