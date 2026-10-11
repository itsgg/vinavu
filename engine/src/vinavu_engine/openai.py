"""Mapping OpenAI chat requests onto Perplexity threads, and answers back.

Kept apart from the HTTP wiring in server.py so it can be tested as plain
functions.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from vinavu_engine import threads
from vinavu_engine.ask import Source, Thread

MAX_IMAGE_BYTES = 20 * 1024 * 1024


class BadRequest(Exception):
    pass


@dataclass
class Plan:
    """One request, decided: what to ask, in which thread, with which files."""

    query: str
    # Every message as (role, text), images as digests: what the thread key hashes.
    keyed: list[tuple[str, str]]
    thread: Thread | None = None
    files: list[tuple[bytes, str, str]] = field(default_factory=list)


def _text_and_images(content: Any, images: list[tuple[bytes, str, str]] | None) -> str:
    """The text of a message, collecting data-URI images into `images` if given."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        raise BadRequest("message content must be a string or a list of parts")
    texts: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        kind = part.get("type")
        if kind in ("text", "input_text"):
            texts.append(str(part.get("text", "")))
        elif kind in ("image_url", "input_image"):
            ref = part.get("image_url")
            url = ref.get("url") if isinstance(ref, dict) else ref
            if not isinstance(url, str):
                continue
            if url.startswith("data:") and images is not None:
                images.append(_decode_image(url, len(images)))
            elif not url.startswith("data:"):
                texts.append(f"(image: {url})")
    return "\n\n".join(t for t in texts if t)


def _decode_image(url: str, n: int) -> tuple[bytes, str, str]:
    header, _, data = url.partition(",")
    mime = header[5:].split(";", 1)[0] or "image/png"
    if ";base64" not in header:
        raise BadRequest("only base64 data URIs are accepted for images")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as e:
        raise BadRequest("an image is not valid base64") from e
    if len(raw) > MAX_IMAGE_BYTES:
        raise BadRequest("an image is over 20 MB")
    ext = mime.split("/", 1)[-1].split("+", 1)[0] or "png"
    return raw, f"image-{n + 1}.{ext}", mime


def plan(messages: Any) -> Plan:
    """Decide how to ask a chat request.

    A conversation whose history is a thread vinavu answered continues that
    thread with the last message. Any other history, from another model or a
    client that rewrote the answers, is folded into a single first question,
    with its roles named, so the context still arrives.
    """
    if not isinstance(messages, list) or not messages:
        raise BadRequest("messages must be a non-empty list")
    system: list[str] = []
    turns: list[tuple[str, str]] = []
    keyed: list[tuple[str, str]] = []
    files: list[tuple[bytes, str, str]] = []
    last = len(messages) - 1
    for i, m in enumerate(messages):
        if not isinstance(m, dict):
            raise BadRequest("each message must be an object")
        role = m.get("role")
        images: list[tuple[bytes, str, str]] = []
        text = _text_and_images(m.get("content"), images)
        if i == last:
            files = images
        if role in ("system", "developer"):
            if text.strip():
                system.append(text.strip())
                keyed.append(("system", text))
        elif role in ("user", "assistant"):
            turns.append((role, text))
            keyed.append((role, text))
        elif role == "tool":
            turns.append(("user", f"Tool result:\n{text}"))
            keyed.append(("tool", text))
        keyed.extend(("image", hashlib.sha256(img[0]).hexdigest()) for img in images)
    if not turns or turns[-1][0] != "user" or messages[-1].get("role") != "user":
        raise BadRequest("the last message must come from the user")
    question = turns[-1][1].strip()
    if not question and not files:
        raise BadRequest("the last message is empty")

    history = turns[:-1]
    # The key of everything before the last message, which is the key the
    # previous answer was remembered under.
    before = keyed[: _last_index(keyed, "user")]
    thread = threads.lookup(threads.key(before)) if history else None
    if thread:
        return Plan(query=question, keyed=keyed, thread=thread, files=files)

    parts: list[str] = []
    if system:
        parts.append("Instructions:\n" + "\n\n".join(system))
    if history:
        said = "\n\n".join(f"{'User' if r == 'user' else 'Assistant'}: {t.strip()}" for r, t in history)
        parts.append("Earlier in this conversation:\n\n" + said)
        parts.append("Now answer this:\n" + question)
    else:
        parts.append(question)
    return Plan(query="\n\n".join(parts), keyed=keyed, files=files)


def _last_index(keyed: list[tuple[str, str]], role: str) -> int:
    for i in range(len(keyed) - 1, -1, -1):
        if keyed[i][0] == role:
            return i
    return len(keyed)


def remember(p: Plan, answer: str, thread: Thread | None) -> None:
    """Map the conversation, ending with this answer as sent, to its thread."""
    if thread:
        try:
            threads.remember(threads.key([*p.keyed, ("assistant", answer)]), thread)
        except OSError:
            # The map only saves a follow-up a new thread; the answer the
            # client is receiving must not fail over it.
            pass


# --- responses -------------------------------------------------------------


def _extras(sources: list[Source], url: str | None) -> dict[str, Any]:
    # The same two fields Perplexity's own API returns, so a client written for
    # it shows the sources, plus where the thread lives.
    out: dict[str, Any] = {
        "citations": [s.url for s in sources],
        "search_results": [{"title": s.title, "url": s.url} for s in sources],
    }
    if url:
        out["vinavu"] = {"thread_url": url}
    return out


def completion(model: str, content: str, sources: list[Source], url: str | None) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        **_extras(sources, url),
    }


class Chunks:
    """The chat.completion.chunk lines of one streamed answer."""

    def __init__(self, model: str) -> None:
        self.id = f"chatcmpl-{uuid.uuid4().hex}"
        self.created = int(time.time())
        self.model = model

    def _line(self, delta: dict[str, Any], finish: str | None = None, **extra: Any) -> str:
        import json

        body = {
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            **extra,
        }
        return f"data: {json.dumps(body, ensure_ascii=False)}\n\n"

    def role(self) -> str:
        return self._line({"role": "assistant", "content": ""})

    def text(self, piece: str) -> str:
        return self._line({"content": piece})

    def end(self, sources: list[Source], url: str | None) -> str:
        return self._line({}, "stop", **_extras(sources, url)) + "data: [DONE]\n\n"

    def error(self, kind: str, message: str) -> str:
        import json

        return f"data: {json.dumps({'error': {'type': kind, 'message': message}})}\n\ndata: [DONE]\n\n"
