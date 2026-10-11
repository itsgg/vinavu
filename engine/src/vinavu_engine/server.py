"""The OpenAI-compatible server: /v1/models and /v1/chat/completions.

It holds the session itself, so a client is configured with this address and
any key at all. It binds to 127.0.0.1 unless told otherwise. Setting
VINAVU_API_KEY makes it demand that key, for a server that listens wider.
"""

from __future__ import annotations

import hmac
import os
import time
from collections.abc import Iterator
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from vinavu_engine import DEFAULT_HOST, DEFAULT_PORT, models, openai
from vinavu_engine.ask import AskError, Asker, Delta, Done

# What an upstream failure becomes for an OpenAI client.
STATUS = {"auth": 503, "quota": 429, "model": 400, "files": 400, "config": 500, "space": 502, "upstream": 502}


def _error(status: int, kind: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"type": kind, "message": message}}, status_code=status)


def create_app(asker: Asker | None = None) -> FastAPI:
    app = FastAPI(title="vinavu", docs_url=None, redoc_url=None)
    shared = asker or Asker()
    key = os.environ.get("VINAVU_API_KEY", "")

    def authorized(request: Request) -> bool:
        if not key:
            return True
        given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        return hmac.compare_digest(given.encode(), key.encode())

    @app.get("/v1/models")
    async def list_models(request: Request) -> Any:
        if not authorized(request):
            return _error(401, "auth", "wrong API key")
        now = int(time.time())
        data = [{"id": m.id, "object": "model", "created": now, "owned_by": "perplexity"} for m in models.listing()]
        return {"object": "list", "data": data}

    @app.post("/v1/chat/completions")
    async def chat(request: Request) -> Any:
        if not authorized(request):
            return _error(401, "auth", "wrong API key")
        try:
            body = await request.json()
        except ValueError:
            return _error(400, "request", "the body is not JSON")
        if not isinstance(body, dict):
            return _error(400, "request", "the body must be a JSON object")
        try:
            p = openai.plan(body.get("messages"))
            model_id = models.resolve(body.get("model") if isinstance(body.get("model"), str) else None)
        except openai.BadRequest as e:
            return _error(400, "request", str(e))
        except models.UnknownModel as e:
            return _error(400, "model", str(e))

        events = shared.ask(p.query, model=model_id, thread=p.thread, files=p.files, linked=True)
        # Run up to the first event that carries an answer before replying, so a
        # refused session or an unknown model comes back as an HTTP error rather
        # than a 200 that breaks off.
        try:
            first = await run_in_threadpool(_first_answer_event, events)
        except AskError as e:
            return _error(STATUS.get(e.kind, 500), e.kind, str(e))

        if body.get("stream"):
            return StreamingResponse(_stream(p, model_id, first, events), media_type="text/event-stream")
        try:
            done = await run_in_threadpool(_collect, first, events)
        except AskError as e:
            return _error(STATUS.get(e.kind, 500), e.kind, str(e))
        openai.remember(p, done.content, done.thread)
        return openai.completion(model_id, done.content, done.sources, done.url)

    return app


def _first_answer_event(events: Iterator[Any]) -> Any:
    """The first event that is part of the answer: text, or the whole answer.

    Statuses and sources are passed over, since the stream sends neither: a
    failure after the sources arrive, before any text, can still be an HTTP
    error rather than a 200 that breaks off.
    """
    for ev in events:
        if isinstance(ev, Delta | Done):
            return ev
    raise AskError("upstream", "the answer ended before it began")


def _collect(first: Any, events: Iterator[Any]) -> Done:
    ev = first
    while not isinstance(ev, Done):
        # A StopIteration must not escape into the threadpool's future.
        ev = next(events, None)
        if ev is None:
            raise AskError("upstream", "the answer ended without finishing")
    return ev


def _stream(p: openai.Plan, model_id: str, first: Any, events: Iterator[Any]) -> Iterator[str]:
    out = openai.Chunks(model_id)
    sent: list[str] = []
    yield out.role()
    try:
        ev = first
        while True:
            if isinstance(ev, Delta):
                sent.append(ev.text)
                yield out.text(ev.text)
            elif isinstance(ev, Done):
                # Keyed on what this client actually received, which is what it
                # will send back as the assistant turn.
                openai.remember(p, "".join(sent), ev.thread)
                yield out.end(ev.sources, ev.url)
                return
            ev = next(events, None)
            if ev is None:
                yield out.error("upstream", "the answer ended without finishing")
                return
    except AskError as e:
        yield out.error(e.kind, str(e))


def serve(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> None:
    import uvicorn

    uvicorn.run(create_app(), host=host, port=port, log_level="warning")
