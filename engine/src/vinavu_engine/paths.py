"""Where vinavu keeps what it writes.

One root for everything, shared with the TypeScript CLI: its sessions, the
engine's thread map and the cached Space id. VINAVU_HOME relocates it, which is
how the tests stay off the real state.
"""

from __future__ import annotations

import os
from pathlib import Path

DIR_MODE = 0o700
FILE_MODE = 0o600


def home() -> Path:
    """The state root, read on every call so a test can point it elsewhere."""
    explicit = os.environ.get("VINAVU_HOME")
    if explicit:
        return Path(explicit)
    state = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(state) / "vinavu"


def ensure_home() -> Path:
    """The state root, created private: it holds conversations and thread tokens."""
    root = home()
    root.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    return root


def write_private(path: Path, text: str) -> None:
    """Write through a temp file and a rename, readable by this user alone."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
