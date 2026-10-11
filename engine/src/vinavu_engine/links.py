"""Turn Perplexity's [n] citation markers into markdown links as text streams."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from typing import Protocol

MARKER = re.compile(r"\[(\d{1,3})\]")
# A marker cut off at the end of a delta: "[", "[1", "[12".
PARTIAL = re.compile(r"\[\d{0,3}$")


class HasUrl(Protocol):
    url: str


def link(text: str, sources: Sequence[HasUrl]) -> str:
    """Replace every [n] that names a known source with [n](url)."""

    def sub(m: re.Match[str]) -> str:
        i = int(m.group(1)) - 1
        if 0 <= i < len(sources) and sources[i].url:
            return f"[{m.group(1)}]({sources[i].url})"
        return m.group(0)

    # A marker already followed by "(" is a link the model wrote itself.
    return MARKER.sub(lambda m: m.group(0) if _followed_by_paren(text, m) else sub(m), text)


def _followed_by_paren(text: str, m: re.Match[str]) -> bool:
    return text[m.end() : m.end() + 1] == "("


# How much text to hold back waiting for sources before giving up on them.
MAX_WAIT = 400


class Linker:
    """Links markers in streamed deltas, holding back one that is cut in half.

    Sources are read through a callable at each step because they arrive
    during the stream, usually before the first word but not always. While
    there are none yet, text from the first marker on is held, so the marker
    can still be linked when they come; past MAX_WAIT characters it goes out
    as it is, so an answer that cites nothing, or writes `a[1]` in code, is
    not held to the end.
    """

    def __init__(self, sources: Callable[[], Sequence[HasUrl]]) -> None:
        self._sources = sources
        self._held = ""

    def feed(self, piece: str) -> str:
        text = self._held + piece
        known = self._sources()
        first = MARKER.search(text)
        if not known and first and len(text) - first.start() <= MAX_WAIT:
            self._held, text = text[first.start() :], text[: first.start()]
            return text
        cut = PARTIAL.search(text)
        # Hold back a trailing partial marker, and a complete marker at the very
        # end too: the next delta might open "(" and make it the model's own link.
        tail = MARKER.search(text, max(0, len(text) - 5))
        if cut:
            self._held, text = text[cut.start() :], text[: cut.start()]
        elif tail and tail.end() == len(text):
            self._held, text = text[tail.start() :], text[: tail.start()]
        else:
            self._held = ""
        return link(text, known)

    def flush(self) -> str:
        text, self._held = self._held, ""
        return link(text, self._sources())
