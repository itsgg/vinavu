from __future__ import annotations

import hashlib
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest
from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from vinavu_engine import token

HOST = ".perplexity.ai"


def encrypt(value: str, password: bytes, prefix: bytes = b"v11", meta: int = 24, host: str = HOST) -> bytes:
    """The inverse of what Chromium does, to build test fixtures."""
    plain = value.encode()
    if meta >= 24:
        plain = hashlib.sha256(host.encode()).digest() + plain
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plain) + padder.finalize()
    key = PBKDF2HMAC(hashes.SHA1(), 16, b"saltysalt", 1).derive(password)
    enc = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).encryptor()
    return prefix + enc.update(padded) + enc.finalize()


def chromium_time(dt: datetime) -> int:
    return int((dt - datetime(1601, 1, 1, tzinfo=UTC)).total_seconds() * 1_000_000)


def make_db(path, rows, meta: int = 24):
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE meta (key TEXT, value TEXT)")
    con.execute("INSERT INTO meta VALUES ('version', ?)", (str(meta),))
    con.execute("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)")
    for host, name, value, enc, exp in rows:
        con.execute("INSERT INTO cookies VALUES (?, ?, ?, ?, ?)", (host, name, value, enc, exp))
    con.commit()
    con.close()


FUTURE = chromium_time(datetime.now(UTC) + timedelta(days=20))


def test_v11_round_trip_with_host_digest():
    enc = encrypt("hdr.tok.123", b"secret")
    assert token.decrypt_value(enc, HOST, 24, b"secret") == "hdr.tok.123"


def test_v10_uses_the_fixed_password_and_older_dbs_have_no_digest():
    enc = encrypt("hdr.tok.old", b"peanuts", prefix=b"v10", meta=20)
    assert token.decrypt_value(enc, HOST, 20, None) == "hdr.tok.old"


def test_a_wrong_keyring_secret_is_reported_not_returned_as_garbage():
    enc = encrypt("hdr.tok.123", b"secret")
    with pytest.raises((token.TokenError, ValueError)):
        token.decrypt_value(enc, HOST, 24, b"other")


def test_v11_without_a_keyring_secret_says_so():
    enc = encrypt("hdr.tok.123", b"secret")
    with pytest.raises(token.TokenError, match="keyring"):
        token.decrypt_value(enc, HOST, 24, None)


def test_env_token_wins_over_any_browser(monkeypatch):
    monkeypatch.setenv("VINAVU_SESSION_TOKEN", " from-env ")
    found = token.find_token()
    assert found.token == "from-env"
    assert found.source == "VINAVU_SESSION_TOKEN"


def test_finds_the_cookie_in_a_chromium_profile(isolated, monkeypatch):
    db = isolated / "config" / "chromium" / "Default" / "Cookies"
    make_db(
        db,
        [
            (".example.com", token.COOKIE, "", encrypt("hdr.not.this", b"secret", host=".example.com"), FUTURE),
            (HOST, token.COOKIE, "", encrypt("hdr.the.token", b"secret"), FUTURE),
        ],
    )
    monkeypatch.setattr(token, "keyring_password", lambda app: b"secret" if app == "chromium" else None)
    found = token.find_token()
    assert found.token == "hdr.the.token"
    assert found.source == str(db)
    assert found.expires and found.expires > datetime.now(UTC)


def test_a_later_profile_is_searched_when_default_has_no_sign_in(isolated, monkeypatch):
    make_db(isolated / "config" / "chromium" / "Default" / "Cookies", [])
    make_db(
        isolated / "config" / "chromium" / "Profile 2" / "Cookies",
        [(HOST, token.COOKIE, "", encrypt("hdr.profile.two", b"secret"), FUTURE)],
    )
    monkeypatch.setattr(token, "keyring_password", lambda app: b"secret")
    assert token.find_token().token == "hdr.profile.two"


def test_an_expired_sign_in_says_to_sign_in_again(isolated, monkeypatch):
    past = chromium_time(datetime.now(UTC) - timedelta(days=1))
    make_db(isolated / "config" / "chromium" / "Default" / "Cookies", [(HOST, token.COOKIE, "", encrypt("old", b"s"), past)])
    monkeypatch.setattr(token, "keyring_password", lambda app: b"s")
    with pytest.raises(token.TokenError, match="expired"):
        token.find_token()


def test_no_sign_in_anywhere_names_what_to_do(isolated):
    with pytest.raises(token.TokenError, match="sign in at perplexity.ai"):
        token.find_token()


def test_an_unknown_browser_is_a_clear_error(monkeypatch):
    monkeypatch.setenv("VINAVU_BROWSER", "netscape")
    with pytest.raises(token.TokenError, match="not one of"):
        token.find_token()


def test_explicit_cookie_db(isolated, monkeypatch):
    db = isolated / "elsewhere" / "Cookies"
    make_db(db, [(HOST, token.COOKIE, "hdr.plain.token", b"", FUTURE)])
    monkeypatch.setenv("VINAVU_COOKIES", str(db))
    assert token.find_token().token == "hdr.plain.token"


def test_a_value_that_is_not_a_session_token_is_refused(isolated, monkeypatch):
    # An old database has no host digest, so a wrong key can decrypt to junk
    # that pads correctly; the token's shape is the last check.
    make_db(
        isolated / "config" / "chromium" / "Default" / "Cookies",
        [(HOST, token.COOKIE, "", encrypt("not a token at all", b"peanuts", prefix=b"v10", meta=20), FUTURE)],
        meta=20,
    )
    with pytest.raises(token.TokenError, match="not a session token"):
        token.find_token()


def test_a_wrong_keyring_secret_is_a_token_error(isolated, monkeypatch):
    make_db(isolated / "config" / "chromium" / "Default" / "Cookies", [(HOST, token.COOKIE, "", encrypt("hdr.a.b", b"right"), FUTURE)])
    monkeypatch.setattr(token, "keyring_password", lambda app: b"wrong")
    with pytest.raises(token.TokenError):
        token.find_token()
