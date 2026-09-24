from app.crypto import encrypt, decrypt


def test_roundtrip():
    blob = encrypt("access-sandbox-123")
    assert isinstance(blob, bytes)
    assert b"access-sandbox-123" not in blob
    assert decrypt(blob) == "access-sandbox-123"


def test_decrypt_accepts_memoryview_from_bytea():
    assert decrypt(memoryview(encrypt("tok"))) == "tok"
