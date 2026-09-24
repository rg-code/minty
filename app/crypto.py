from cryptography.fernet import Fernet
from .config import settings

_f = Fernet(settings.token_enc_key.encode())


def encrypt(token: str) -> bytes:
    return _f.encrypt(token.encode())


def decrypt(blob: bytes) -> str:
    return _f.decrypt(bytes(blob)).decode()
