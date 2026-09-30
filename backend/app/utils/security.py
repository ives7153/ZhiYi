"""Security helpers for password hashing (Argon2id) and verification codes."""

import base64
import hashlib
import hmac
import os
import secrets
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

from app.config import get_settings


def hash_password(password: str) -> str:
    """Hash password using OWASP-compliant Argon2id."""
    salt = os.urandom(16)
    kdf = Argon2id(
        salt=salt,
        length=32,
        iterations=2,
        lanes=4,
        memory_cost=65536,
        ad=None,
        secret=None,
    )
    key = kdf.derive(password.encode("utf-8"))
    salt_b64 = base64.b64encode(salt).decode("ascii").rstrip("=")
    key_b64 = base64.b64encode(key).decode("ascii").rstrip("=")
    return f"$argon2id$v=19$m=65536,t=2,p=4${salt_b64}${key_b64}"


def verify_password(password: str, hashed: str | None) -> bool:
    """Verify password against Argon2id hash."""
    if not hashed or not isinstance(hashed, str) or not hashed.startswith("$argon2id$"):
        return False
    try:
        parts = hashed.split("$")
        # parts: ['', 'argon2id', 'v=19', 'm=65536,t=2,p=4', '<salt_b64>', '<key_b64>']
        if len(parts) < 6:
            return False
        params = dict(kv.split("=") for kv in parts[3].split(","))
        m = int(params["m"])
        t = int(params["t"])
        p = int(params["p"])

        salt_str = parts[4]
        salt_padding = "=" * (-len(salt_str) % 4)
        salt = base64.b64decode(salt_str + salt_padding)

        key_str = parts[5]
        key_padding = "=" * (-len(key_str) % 4)
        expected_key = base64.b64decode(key_str + key_padding)

        kdf = Argon2id(
            salt=salt,
            length=len(expected_key),
            iterations=t,
            lanes=p,
            memory_cost=m,
            ad=None,
            secret=None,
        )
        kdf.verify(password.encode("utf-8"), expected_key)
        return True
    except Exception:
        return False


def generate_numeric_code(length: int = 6) -> str:
    """Generate cryptographically secure numeric code."""
    digits = "0123456789"
    return "".join(secrets.choice(digits) for _ in range(length))


def hash_code(code: str) -> str:
    """Hash a verification code with server secret key to store safely."""
    settings = get_settings()
    key = settings.secret_key.encode("utf-8")
    return hmac.new(key, code.strip().encode("utf-8"), hashlib.sha256).hexdigest()


def verify_code(code: str, stored_hash: str) -> bool:
    """Constant-time verification of code hash."""
    if not code or not stored_hash:
        return False
    computed = hash_code(code)
    return hmac.compare_digest(computed, stored_hash)
