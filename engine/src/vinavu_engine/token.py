"""The Perplexity session token, read from the browser that is signed in.

A copied token goes stale: next-auth rotates the cookie as the browser uses
the site, and a copy taken once expires within a month whatever happens. So
vinavu keeps no copy of its own. It reads the cookie from the browser's store
each time it starts, which is as fresh as the browser's own sign-in.

Chromium-family browsers on Linux encrypt cookie values with AES-128-CBC under
a key derived from a password: the browser's "Safe Storage" secret in the
keyring for values marked v11, the fixed word "peanuts" for v10. Databases at
meta version 24 or later also put a SHA-256 of the cookie's host in front of
the value.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

COOKIE = "__Secure-next-auth.session-token"
HOST_SUFFIX = "perplexity.ai"

# Config directory under ~/.config, and the `application` attribute its Safe
# Storage secret carries in the keyring.
BROWSERS: dict[str, tuple[str, str]] = {
    "chromium": ("chromium", "chromium"),
    "chrome": ("google-chrome", "chrome"),
    "brave": ("BraveSoftware/Brave-Browser", "brave"),
}

# A next-auth session token is a JWE: base64url segments joined by dots. A
# value that decrypts to anything else came from the wrong key: databases
# before meta version 24 carry no host digest to catch that, and a wrong key
# yields valid padding often enough to matter.
TOKEN_SHAPE = re.compile(r"[A-Za-z0-9_\-]+(\.[A-Za-z0-9_\-]*){2,}")

# Chromium stores times as microseconds since 1601-01-01.
_EPOCH_1601 = datetime(1601, 1, 1, tzinfo=UTC)


class TokenError(Exception):
    """No usable session: the message says what to do about it."""


@dataclass(frozen=True)
class Found:
    token: str
    source: str
    expires: datetime | None


def decrypt_value(encrypted: bytes, host: str, meta_version: int, password: bytes | None) -> str:
    """Decrypt one Chromium cookie value.

    `password` is the keyring secret, needed only for v11 values.
    """
    prefix, body = encrypted[:3], encrypted[3:]
    if prefix == b"v10":
        password = b"peanuts"
    elif prefix != b"v11":
        # Unencrypted values have no prefix at all.
        return encrypted.decode("utf-8")
    if not password:
        raise TokenError("the browser's cookies are encrypted, and its keyring secret was not found")
    key = PBKDF2HMAC(hashes.SHA1(), 16, b"saltysalt", 1).derive(password)
    decryptor = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).decryptor()
    padded = decryptor.update(body) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    plain = unpadder.update(padded) + unpadder.finalize()
    if meta_version >= 24:
        digest = hashlib.sha256(host.encode()).digest()
        if plain[:32] != digest:
            raise TokenError("a cookie decrypted to something else: the keyring secret is wrong")
        plain = plain[32:]
    return plain.decode("utf-8")


def keyring_password(application: str) -> bytes | None:
    """The browser's Safe Storage secret, from the Secret Service keyring."""
    try:
        r = subprocess.run(
            ["secret-tool", "lookup", "application", application],
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    secret = r.stdout.strip()
    return secret or None


def _profiles(config_dir: Path) -> list[Path]:
    """Cookie databases under a browser's config directory, Default first."""
    found = []
    for name in ["Default", *sorted(p.name for p in config_dir.glob("Profile *"))]:
        db = config_dir / name / "Cookies"
        if db.is_file():
            found.append(db)
    return found


def read_cookie_db(db: Path, application: str, *, now: datetime | None = None) -> Found | None:
    """The session cookie from one cookie database, or None if it holds none."""
    # Copied first: the browser holds the live database locked while it runs.
    with tempfile.TemporaryDirectory(prefix="vinavu-") as tmp:
        copy = Path(tmp) / "Cookies"
        shutil.copyfile(db, copy)
        con = sqlite3.connect(copy)
        try:
            meta = int(con.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()[0])
            row = con.execute(
                "SELECT host_key, encrypted_value, value, expires_utc FROM cookies"
                " WHERE name = ? AND (host_key = ? OR host_key LIKE ?)"
                " ORDER BY expires_utc DESC LIMIT 1",
                (COOKIE, HOST_SUFFIX, f"%.{HOST_SUFFIX}"),
            ).fetchone()
        finally:
            con.close()
    if row is None:
        return None
    host, encrypted, plain, expires_utc = row
    expires = _EPOCH_1601 + timedelta(microseconds=expires_utc) if expires_utc else None
    if expires and expires <= (now or datetime.now(UTC)):
        raise TokenError(f"the Perplexity sign-in in {db} expired on {expires:%Y-%m-%d}: sign in again")
    if plain:
        token = plain
    else:
        password = keyring_password(application) if encrypted[:3] == b"v11" else None
        try:
            token = decrypt_value(encrypted, host, meta, password)
        except (ValueError, UnicodeDecodeError) as e:
            raise TokenError(f"the Perplexity sign-in in {db} could not be decrypted: the keyring secret is wrong") from e
    if not TOKEN_SHAPE.fullmatch(token):
        raise TokenError(f"the Perplexity sign-in in {db} decrypted to something that is not a session token")
    return Found(token=token, source=str(db), expires=expires)


def find_token() -> Found:
    """The session token: VINAVU_SESSION_TOKEN, else the signed-in browser.

    VINAVU_BROWSER names the browser (chromium, chrome or brave) and
    VINAVU_COOKIES a cookie database to read instead of searching.
    """
    explicit = os.environ.get("VINAVU_SESSION_TOKEN", "").strip()
    if explicit:
        return Found(token=explicit, source="VINAVU_SESSION_TOKEN", expires=None)

    wanted = os.environ.get("VINAVU_BROWSER", "").strip().lower()
    if wanted and wanted not in BROWSERS:
        raise TokenError(f"VINAVU_BROWSER={wanted} is not one of {', '.join(BROWSERS)}")
    browsers = [wanted] if wanted else list(BROWSERS)
    config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")

    cookies = os.environ.get("VINAVU_COOKIES", "").strip()
    if cookies:
        application = BROWSERS[wanted or "chromium"][1]
        found = read_cookie_db(Path(cookies), application)
        if found:
            return found
        raise TokenError(f"no Perplexity sign-in in {cookies}")

    for browser in browsers:
        directory, application = BROWSERS[browser]
        for db in _profiles(config / directory):
            found = read_cookie_db(db, application)
            if found:
                return found
    looked = ", ".join(browsers)
    raise TokenError(
        f"no Perplexity sign-in found in {looked}: sign in at perplexity.ai in Chromium, "
        "or set VINAVU_SESSION_TOKEN"
    )
