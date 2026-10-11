"""The private-API seam, run against the pinned library with a fake transport.

If an upgrade of perplexity-webui-scraper moves the continuation tokens or the
stream handling, these fail before a real question does.
"""

from __future__ import annotations

import json

from perplexity_webui_scraper import ConversationConfig

from vinavu_engine import upstream


def frame(**data) -> bytes:
    return b"data: " + json.dumps(data).encode()


def stream(slug: str, backend: str, text_chunks: list[str]) -> list[bytes]:
    base = {"backend_uuid": backend, "read_write_token": f"rwt-{backend}", "thread_url_slug": slug, "status": "PENDING"}
    lines = [
        frame(**base, blocks=[]),
        frame(
            **base,
            blocks=[
                {
                    "intended_usage": "web_results",
                    "web_result_block": {
                        "progress": "DONE",
                        "web_results": [{"name": "a.example › docsThe Docs", "url": "https://a.example/docs", "snippet": ""}],
                    },
                }
            ],
        ),
    ]
    for i, chunk in enumerate(text_chunks):
        lines.append(
            frame(
                **base,
                blocks=[{"intended_usage": "ask_text", "markdown_block": {"progress": "IN_PROGRESS", "chunks": [chunk], "chunk_starting_offset": i}}],
            )
        )
    lines.append(frame(**base, final=True, text_completed=True, blocks=[]))
    return lines


class FakeResponse:
    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


class FakeHTTP:
    def __init__(self, streams: list[list[bytes]]):
        self.streams = streams
        self.payloads: list[dict] = []

    def get(self, endpoint, params=None, rate_limited=True):
        return FakeResponse({"user": {"subscription_tier": "pro"}})

    def init_search(self, query):
        pass

    def stream_ask(self, payload):
        self.payloads.append(payload)
        yield from self.streams.pop(0)


def test_streams_text_sources_tokens_and_slug():
    http = FakeHTTP([stream("slug-1", "b-1", ["Hello ", "world.[1]"])])
    conv = upstream.Conversation_(http, ConversationConfig(model="perplexity/best", citation_mode="default"))
    conv.ask("hi", stream=True)
    texts = ["".join(f.chunks) for f in conv]
    assert texts[-1] == "Hello world.[1]"
    assert conv.answer == "Hello world.[1]"
    assert [r.url for r in conv.search_results] == ["https://a.example/docs"]
    assert conv.tokens == ("b-1", "rwt-b-1")
    assert conv.thread_slug == "slug-1"


def test_resume_makes_the_next_ask_a_follow_up():
    http = FakeHTTP([stream("slug-2", "b-2", ["More."])])
    conv = upstream.Conversation_(http, ConversationConfig(model="perplexity/best"))
    conv.resume("b-1", "rwt-b-1")
    conv.ask("and?", stream=True)
    list(conv)
    params = http.payloads[0]["params"]
    assert params["last_backend_uuid"] == "b-1"
    assert params["read_write_token"] == "rwt-b-1"
    assert params["query_source"] == "followup"
    assert conv.tokens == ("b-2", "rwt-b-2")


def test_a_space_saves_the_thread_into_it():
    http = FakeHTTP([stream("s", "b", ["x"])])
    conv = upstream.Conversation_(http, ConversationConfig(model="perplexity/best", space_uuid="space-1"))
    conv.ask("q", stream=True)
    list(conv)
    params = http.payloads[0]["params"]
    assert params["target_collection_uuid"] == "space-1"
    assert params["is_incognito"] is False


def test_the_client_has_no_request_rate_limit():
    c = upstream.client("tok")
    try:
        assert c._http._rate_limiter is None
    finally:
        c.close()
