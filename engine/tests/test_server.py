from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from vinavu_engine.ask import AskError, Delta, Done, Source, Sources, Status, Thread
from vinavu_engine.server import create_app


class FakeAsker:
    def __init__(self, script=None, error=None, error_after=None):
        self.calls: list[dict] = []
        self.script = script
        self.error = error
        self.error_after = error_after
        self.n = 0

    def ask(self, query, *, model=None, thread=None, files=(), linked=False):
        self.calls.append({"query": query, "model": model, "thread": thread, "files": files, "linked": linked})
        self.n += 1
        yield Status("asking")
        if self.error:
            raise self.error
        src = [Source("Docs", "https://a.example")]
        yield Sources(src)
        pieces = self.script or ["Answer ", f"{self.n}."]
        for i, p in enumerate(pieces):
            if self.error_after is not None and i == self.error_after:
                raise AskError("upstream", "broke off")
            yield Delta(p)
        yield Done(
            content="".join(pieces),
            model=model or "perplexity/best",
            sources=src,
            thread=Thread(f"b-{self.n}", "rwt", "slug-1"),
            url="https://www.perplexity.ai/search/slug-1",
        )


def client(asker, monkeypatch=None, key=None):
    if monkeypatch and key:
        monkeypatch.setenv("VINAVU_API_KEY", key)
    return TestClient(create_app(asker))


def sse(text: str) -> list[dict]:
    out = []
    for line in text.split("\n\n"):
        if line.startswith("data: ") and line != "data: [DONE]":
            out.append(json.loads(line[6:]))
    return out


def test_models_lists_aliases_first():
    r = client(FakeAsker()).get("/v1/models")
    ids = [m["id"] for m in r.json()["data"]]
    assert ids[:2] == ["best", "pro"]
    assert "perplexity/deep-research" in ids


def test_a_plain_completion():
    a = FakeAsker()
    r = client(a).post("/v1/chat/completions", json={"model": "best", "messages": [{"role": "user", "content": "q"}]})
    assert r.status_code == 200
    body = r.json()
    assert body["choices"][0]["message"]["content"] == "Answer 1."
    assert body["citations"] == ["https://a.example"]
    assert a.calls[0]["linked"] is True
    assert a.calls[0]["model"] == "perplexity/best"


def test_a_streamed_completion_and_its_follow_up_continue_one_thread():
    a = FakeAsker()
    c = client(a)
    first = [{"role": "user", "content": "q1"}]
    r = c.post("/v1/chat/completions", json={"stream": True, "messages": first})
    chunks = sse(r.text)
    said = "".join(ch["choices"][0]["delta"].get("content") or "" for ch in chunks)
    assert said == "Answer 1."
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    assert r.text.rstrip().endswith("data: [DONE]")

    second = [*first, {"role": "assistant", "content": said}, {"role": "user", "content": "q2"}]
    c.post("/v1/chat/completions", json={"stream": True, "messages": second})
    assert a.calls[1]["thread"] == Thread("b-1", "rwt", "slug-1")
    assert a.calls[1]["query"] == "q2"


def test_a_failure_before_the_answer_is_an_http_error():
    a = FakeAsker(error=AskError("auth", "Perplexity refused the session"))
    r = client(a).post("/v1/chat/completions", json={"stream": True, "messages": [{"role": "user", "content": "q"}]})
    assert r.status_code == 503
    assert r.json()["error"]["type"] == "auth"


def test_a_failure_mid_stream_ends_with_an_error_event():
    a = FakeAsker(script=["one ", "two"], error_after=1)
    r = client(a).post("/v1/chat/completions", json={"stream": True, "messages": [{"role": "user", "content": "q"}]})
    assert r.status_code == 200
    events = sse(r.text)
    assert events[-1]["error"]["type"] == "upstream"


def test_a_failure_in_a_plain_completion_is_an_http_error():
    a = FakeAsker(script=["one ", "two"], error_after=1)
    r = client(a).post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "q"}]})
    assert r.status_code == 502


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"messages": []}, 400),
        ({"messages": [{"role": "user", "content": "q"}], "model": "no-such-model"}, 400),
        ([1, 2], 400),
    ],
)
def test_bad_requests_are_400(body, status):
    r = client(FakeAsker()).post("/v1/chat/completions", json=body)
    assert r.status_code == status


def test_an_api_key_is_demanded_only_when_set(monkeypatch):
    c = client(FakeAsker(), monkeypatch, key="sekrit")
    msg = {"messages": [{"role": "user", "content": "q"}]}
    assert c.post("/v1/chat/completions", json=msg).status_code == 401
    assert c.get("/v1/models").status_code == 401
    ok = c.post("/v1/chat/completions", json=msg, headers={"Authorization": "Bearer sekrit"})
    assert ok.status_code == 200


class SourcesThenFail(FakeAsker):
    def ask(self, query, *, model=None, thread=None, files=(), linked=False):
        yield Status("asking")
        yield Sources([Source("Docs", "https://a.example")])
        raise AskError("quota", "too many")


def test_a_failure_after_sources_but_before_text_is_still_an_http_error():
    r = client(SourcesThenFail()).post("/v1/chat/completions", json={"stream": True, "messages": [{"role": "user", "content": "q"}]})
    assert r.status_code == 429


def test_a_thread_map_that_cannot_be_written_still_finishes_the_stream(monkeypatch):
    from vinavu_engine import threads

    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(threads, "write_private", boom)
    r = client(FakeAsker()).post("/v1/chat/completions", json={"stream": True, "messages": [{"role": "user", "content": "q"}]})
    assert r.text.rstrip().endswith("data: [DONE]")
    assert sse(r.text)[-1]["choices"][0]["finish_reason"] == "stop"
