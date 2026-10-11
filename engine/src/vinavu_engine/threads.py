"""Which Perplexity thread a resent OpenAI conversation belongs to.

An OpenAI client sends the whole conversation every turn and nothing that
names a thread. Asking that history as one new question every turn would
start a new Perplexity thread each time and throw the old one's context
away. So after each answer the conversation so far, ending with the answer as
it was sent, is hashed and mapped to its thread. When a request arrives whose
history (everything before its last message) hashes to a known key, the last
message is asked as a follow-up in that thread.

The map is a small JSON file, bounded in size and age, kept beside the CLI's
sessions. It holds thread tokens, so it is written private.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Sequence
from typing import Any

from vinavu_engine.ask import Thread
from vinavu_engine.paths import home, write_private

MAX_ENTRIES = 2000
MAX_AGE_S = 30 * 24 * 3600

_lock = threading.Lock()


def key(turns: Sequence[tuple[str, str]]) -> str:
    """The key for a conversation: its (role, text) pairs, in order.

    Everything that shapes the thread is in it: system messages, and images
    as digests of their bytes, as well as the user and assistant turns. Two
    conversations that share their visible turns but not their instructions
    must not share a thread; a client that rewords its system message every
    turn gets a new thread each time, with the history folded in, which is
    the safe way to be wrong. Whitespace at the ends of each text is ignored,
    because clients trim answers before showing and resending them.
    """
    canonical = [[role, text.strip()] for role, text in turns]
    return hashlib.sha256(json.dumps(canonical, ensure_ascii=False).encode()).hexdigest()


def _file():
    return home() / "threads.json"


def _load() -> dict[str, Any]:
    try:
        data = json.loads(_file().read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def lookup(k: str) -> Thread | None:
    with _lock:
        entry = _load().get(k)
    if not isinstance(entry, dict) or time.time() - entry.get("at", 0) > MAX_AGE_S:
        return None
    return Thread.from_dict(entry.get("thread"))


def remember(k: str, thread: Thread) -> None:
    now = time.time()
    with _lock:
        data = _load()
        data[k] = {"thread": thread.to_dict(), "at": now}
        fresh = {
            kk: v
            for kk, v in data.items()
            if isinstance(v, dict) and now - v.get("at", 0) <= MAX_AGE_S
        }
        if len(fresh) > MAX_ENTRIES:
            newest = sorted(fresh.items(), key=lambda kv: kv[1].get("at", 0), reverse=True)
            fresh = dict(newest[:MAX_ENTRIES])
        write_private(_file(), json.dumps(fresh))
