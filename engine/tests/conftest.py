from __future__ import annotations

import pytest

ENV = (
    "VINAVU_HOME",
    "VINAVU_SESSION_TOKEN",
    "VINAVU_SAVE",
    "VINAVU_SPACE",
    "VINAVU_API_KEY",
    "VINAVU_BROWSER",
    "VINAVU_COOKIES",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    """Every test gets its own state root and none of the caller's settings."""
    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("VINAVU_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    return tmp_path
