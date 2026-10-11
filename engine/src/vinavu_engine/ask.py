"""Ask Perplexity one question, as a stream of events.

Everything above this (the CLI's `ask` command, the OpenAI server, the MCP
tool) is a different way of printing these events.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from perplexity_webui_scraper import ConversationConfig
from perplexity_webui_scraper._internal.exceptions import (
    AuthenticationError,
    FileAccessError,
    FileUploadError,
    FileValidationError,
    HTTPError,
    ModelAccessError,
    ModelStatusError,
    PerplexityError,
    RateLimitError,
)

from vinavu_engine import links, models, space, token, upstream
from vinavu_engine.paths import home, write_private

SAVE_MODES = ("space", "library", "incognito")
# How long the account's tier is trusted before it is asked again.
TIER_TTL_S = 24 * 3600
# The tiers the pinned library knows: it reads any other as "unknown", and
# its checks refuse even the default model for one (Cursor 2026-10-11).
KNOWN_TIERS = ("free", "pro", "max")
THREAD_URL = "https://www.perplexity.ai/search/{}"
CRUMB_SEPARATORS = (" › ", " · ")
HEARTBEAT_S = 15


# --- values ----------------------------------------------------------------


@dataclass(frozen=True)
class Thread:
    """What a follow-up needs to land in the same Perplexity thread."""

    backend_uuid: str
    read_write_token: str | None = None
    slug: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: object) -> Thread | None:
        if not isinstance(raw, dict):
            return None
        backend = raw.get("backend_uuid")
        if not isinstance(backend, str) or not backend:
            return None
        rwt = raw.get("read_write_token")
        slug = raw.get("slug")
        return cls(backend, rwt if isinstance(rwt, str) else None, slug if isinstance(slug, str) else None)


@dataclass(frozen=True)
class Source:
    title: str
    url: str


@dataclass(frozen=True)
class Status:
    text: str


@dataclass(frozen=True)
class Sources:
    items: list[Source]


@dataclass(frozen=True)
class Delta:
    text: str


@dataclass(frozen=True)
class Done:
    content: str
    model: str
    sources: list[Source] = field(default_factory=list)
    thread: Thread | None = None
    url: str | None = None


Event = Status | Sources | Delta | Done


class AskError(Exception):
    """A question that could not be answered, with a kind a caller can act on."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


# --- helpers ---------------------------------------------------------------


def save_mode() -> str:
    mode = os.environ.get("VINAVU_SAVE", "").strip().lower() or "space"
    if mode not in SAVE_MODES:
        raise AskError("config", f"VINAVU_SAVE={mode} is not one of {', '.join(SAVE_MODES)}")
    return mode


def local_timezone() -> str | None:
    """The IANA zone name, so dates and "today" in answers are local."""
    tz = os.environ.get("TZ", "").lstrip(":")
    if "/" in tz:
        return tz
    try:
        target = os.readlink("/etc/localtime")
    except OSError:
        return None
    marker = "zoneinfo/"
    return target.split(marker, 1)[1] if marker in target else None


def clean_title(name: str | None, url: str | None) -> str:
    """Strip the breadcrumb Perplexity glues in front of a page title.

    Titles arrive as "www.kernel.org › releasesActive kernel releases": the
    host, a breadcrumb of the path, then the title with no separator. The
    breadcrumb may skip path segments, cut a long one short, or use a middle
    dot, so each crumb is matched as the longest run it shares with the start
    of some segment of the URL's path.
    """
    name = (name or "").strip()
    parsed = urlparse(url or "")
    host = parsed.hostname or ""
    rest = None
    for h in (host, host.removeprefix("www.")):
        if h and name.startswith(h):
            rest = name[len(h) :]
            break
    if rest is None:
        return name or host
    segments = [unquote(s) for s in parsed.path.split("/") if s]
    segments += [s.rsplit(".", 1)[0] for s in segments if "." in s]
    while True:
        sep = next((sep for sep in CRUMB_SEPARATORS if rest.startswith(sep)), None)
        if sep is None:
            break
        body = rest[len(sep) :]
        crumb = max((_shared_prefix(body, seg) for seg in segments), default=0)
        if crumb == 0:
            break
        rest = body[crumb:]
    return rest.strip() or host


def _shared_prefix(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b, strict=False):
        if x != y:
            break
        n += 1
    return n


def _sources(results: Sequence[Any]) -> list[Source]:
    return [Source(clean_title(r.title, r.url), r.url or "") for r in results]


def _error(e: Exception) -> AskError:
    match e:
        case AskError():
            return e
        case token.TokenError():
            return AskError("auth", str(e))
        case AuthenticationError():
            return AskError("auth", "Perplexity refused the session: sign in at perplexity.ai in Chromium again")
        case RateLimitError():
            return AskError("quota", "Perplexity says too many requests (HTTP 429): wait a little and ask again")
        case ModelAccessError() | ModelStatusError() | models.UnknownModel():
            return AskError("model", str(e))
        case FileAccessError() | FileUploadError() | FileValidationError():
            return AskError("files", str(e))
        case space.SpaceError():
            return AskError("space", str(e))
        case HTTPError():
            return AskError("upstream", f"Perplexity answered HTTP {e.status_code}")
        case PerplexityError():
            return AskError("upstream", str(e))
    return AskError("internal", f"{type(e).__name__}: {e}")


def _may_be_the_space(e: Exception) -> bool:
    """A failure a vanished Space could explain.

    A deleted Space does not come back as an HTTP error: the stream fails with
    "Query processing failed: Please try again later" (seen 2026-10-11). So
    any failure that is not plainly about something else is checked against
    the account's Spaces before it is reported.
    """
    plainly_else = (AuthenticationError, RateLimitError, ModelAccessError, ModelStatusError, FileAccessError,
                    FileUploadError, FileValidationError, AskError)
    return isinstance(e, PerplexityError) and not isinstance(e, plainly_else)


# --- asking ----------------------------------------------------------------


class _Emitter:
    """What of the answer's chunks has gone out, and what is new in a frame.

    The library keeps the answer as a list of chunks and can replace an
    earlier chunk when the stream corrects it. Text already printed cannot be
    taken back in an append-only stream, so a correction is recorded and not
    reprinted, and the stream carries on with the chunks after it: comparing
    the whole text instead would stop at the first correction and drop every
    word after it. Done carries the corrected whole.
    """

    def __init__(self) -> None:
        self._chunks: list[str] = []
        self.text = ""

    def update(self, chunks: Sequence[str]) -> str:
        out: list[str] = []
        for i, chunk in enumerate(chunks):
            if i >= len(self._chunks):
                self._chunks.append(chunk)
                out.append(chunk)
            elif chunk != self._chunks[i]:
                if chunk.startswith(self._chunks[i]) and i == len(self._chunks) - 1:
                    out.append(chunk[len(self._chunks[i]) :])
                self._chunks[i] = chunk
        piece = "".join(out)
        self.text += piece
        return piece

    def top_up(self, final: str) -> str:
        """The end of the final answer the chunks never carried, if any."""
        if len(final) > len(self.text) and final.startswith(self.text):
            piece = final[len(self.text) :]
            self.text = final
            return piece
        return ""



class Asker:
    """Asks questions on the signed-in account.

    The token is read from the browser once and kept, and read again when
    Perplexity refuses it: the browser may have rotated it since.
    """

    def __init__(
        self,
        *,
        find_token: Callable[[], token.Found] = token.find_token,
        make_client: Callable[[str], Any] = upstream.client,
        resolve_space: Callable[[str], str] | None = None,
        space_exists: Callable[[str, str], bool | None] | None = None,
        save: str | None = None,
    ) -> None:
        self._find_token = find_token
        self._make_client = make_client
        self._resolve_space = resolve_space or (lambda t: space.resolve(upstream.rest_session(t)))
        self._space_exists = space_exists or (lambda t, u: space.exists(upstream.rest_session(t), u))
        self._save = save
        self._token: str | None = None
        self._space: str | None = None
        # (tier, account digest, when asked), and the account last asked for.
        self._tier: tuple[str, str, float] | None = None
        self._tier_asked: str | None = None

    def tier(self, perplexity: Any) -> str | None:
        """The account's tier: known here, cached for a day, else asked once.

        Cached with a digest of the session token it was asked with, so
        another sign-in asks again. None when it cannot be told, and the
        library then asks before the question, as it always did.
        """
        now = time.time()
        account = hashlib.sha256(self.token().encode()).hexdigest()[:16]
        held = self._tier
        if held and held[1] == account and 0 <= now - held[2] < TIER_TTL_S:
            return held[0]
        cache = home() / "account.json"
        try:
            saved = json.loads(cache.read_text())
            at = float(saved["at"])
            if (saved.get("tier") in KNOWN_TIERS and saved.get("account") == account
                    and math.isfinite(at) and 0 <= now - at < TIER_TTL_S):
                self._tier = (str(saved["tier"]), account, at)
                return self._tier[0]
        except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
            pass
        if self._tier_asked == account:
            return None
        self._tier_asked = account
        try:
            tier = str(perplexity.get_account_profile().account_tier)
        except Exception:  # noqa: BLE001 - the library's own check still runs
            return None
        if tier not in KNOWN_TIERS:
            return None
        # Held in memory too: a cache that cannot be written must not put the
        # round trip back on every question a long-running server answers.
        self._tier = (tier, account, now)
        try:
            write_private(cache, json.dumps({"tier": tier, "account": account, "at": now}))
        except OSError:
            pass
        return tier

    def forget_tier(self) -> None:
        self._tier = None
        self._tier_asked = None
        try:
            (home() / "account.json").unlink(missing_ok=True)
        except OSError:
            # The error being reported is the refusal, not this.
            pass

    def token(self) -> str:
        if self._token is None:
            self._token = self._find_token().token
        return self._token

    def ask(
        self,
        query: str,
        *,
        model: str | None = None,
        thread: Thread | None = None,
        files: Sequence[str | Path | tuple[bytes, str] | tuple[bytes, str, str]] = (),
        linked: bool = False,
    ) -> Iterator[Event]:
        """Stream the answer. `linked` turns [n] markers into markdown links.

        A refused session or a vanished Space is retried once, but only while
        no answer text has gone out: retrying after that would replay the
        answer on top of what the caller already printed.
        """
        try:
            save = self._save or save_mode()
            model_id = models.resolve(model)
        except Exception as e:
            raise _error(e) from e
        retried_auth = retried_space = False
        while True:
            progress = {"text": False}
            try:
                yield from self._once(query, model_id, thread, files, linked, save, progress)
                return
            except Exception as e:
                if not progress["text"] and isinstance(e, AuthenticationError) and not retried_auth:
                    retried_auth = True
                    self._token = None
                    continue
                if isinstance(e, ModelAccessError | FileAccessError):
                    # Refused on a tier read from the cache: it may have changed.
                    self.forget_tier()
                if not progress["text"] and save == "space" and not retried_space and self._space_gone(e):
                    retried_space = True
                    space.forget()
                    continue
                raise _error(e) from e

    def _space_gone(self, e: Exception) -> bool:
        if not self._space or not _may_be_the_space(e):
            return False
        try:
            return self._space_exists(self.token(), self._space) is False
        except Exception:  # noqa: BLE001 - the check only decides whether to retry
            return False

    def _once(
        self,
        query: str,
        model_id: str,
        thread: Thread | None,
        files: Sequence[Any],
        linked: bool,
        save: str,
        progress: dict[str, bool],
    ) -> Iterator[Event]:
        tok = self.token()
        space_uuid = self._space = self._resolve_space(tok) if save == "space" else None
        config = ConversationConfig(
            model=model_id,
            save_to_library=save != "incognito",
            space_uuid=space_uuid,
            citation_mode="default",
            timezone=local_timezone(),
        )
        perplexity = self._make_client(tok)
        try:
            conv = upstream.conversation(perplexity, config)
            conv.tier = self.tier(perplexity)
            if thread:
                conv.resume(thread.backend_uuid, thread.read_write_token)
            yield Status("asking")
            conv.ask(query, files=list(files) or None, stream=True)
            status = Status("searching")
            yield status
            spoke = time.monotonic()
            emitted = _Emitter()
            counted = 0
            linker = links.Linker(lambda: conv.search_results) if linked else None
            for frame in conv:
                if len(frame.search_results) != counted:
                    counted = len(frame.search_results)
                    yield Sources(_sources(frame.search_results))
                    spoke = time.monotonic()
                    if not emitted.text:
                        status = Status(f"reading {counted} source{'' if counted == 1 else 's'}")
                        yield status
                piece = emitted.update(frame.chunks)
                if piece:
                    progress["text"] = True
                    out = linker.feed(piece) if linker else piece
                    if out:
                        yield Delta(out)
                        spoke = time.monotonic()
                elif time.monotonic() - spoke > HEARTBEAT_S:
                    # Deep Research works for minutes between words. Saying so
                    # again tells a caller with an inactivity deadline that the
                    # stream is alive.
                    yield status
                    spoke = time.monotonic()
            # The library sets the answer only from the stream's final frame, so
            # without one the stream broke off: what arrived is a fragment.
            if conv.answer is None:
                if emitted.text.strip():
                    raise AskError("upstream", "the answer broke off before Perplexity finished it")
                raise AskError("upstream", "Perplexity sent no answer")
            final = conv.answer
            piece = emitted.top_up(final)
            if piece:
                progress["text"] = True
                out = linker.feed(piece) if linker else piece
                if out:
                    yield Delta(out)
            if linker:
                tail = linker.flush()
                if tail:
                    yield Delta(tail)
            if not final.strip():
                raise AskError("upstream", "Perplexity sent no answer")
            sources = _sources(conv.search_results)
            backend, rwt = conv.tokens
            # A follow-up's frames carry its own entry id as the slug, but the
            # thread's address stays the first question's.
            slug = (thread.slug if thread else None) or conv.thread_slug
            yield Done(
                content=links.link(final, sources) if linked else final,
                model=model_id,
                sources=sources,
                thread=Thread(backend, rwt, slug) if backend else None,
                url=THREAD_URL.format(slug) if slug and save != "incognito" else None,
            )
        finally:
            perplexity.close()
