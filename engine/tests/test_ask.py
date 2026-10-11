from __future__ import annotations

import pytest
from perplexity_webui_scraper._internal.exceptions import AuthenticationError, HTTPError

from test_upstream import FakeHTTP, stream
from vinavu_engine import ask, space, token, upstream
from vinavu_engine.ask import AskError, Asker, Delta, Done, Sources, Status, Thread, clean_title


class FakeClient:
    closed = 0

    def close(self):
        FakeClient.closed += 1


class FlakyHTTP(FakeHTTP):
    """Fails the first ask with `error`, after `lines` lines of its stream."""

    def __init__(self, streams, error, lines=0):
        super().__init__(streams)
        self.error = error
        self.lines = lines

    def stream_ask(self, payload):
        if self.error is None:
            yield from super().stream_ask(payload)
            return
        error, self.error = self.error, None
        self.payloads.append(payload)
        yield from self.streams[0][: self.lines]
        raise error


def asker(monkeypatch, http, *, save="space", tokens=None):
    issued = iter(tokens or ["tok-1", "tok-2", "tok-3"])
    monkeypatch.setattr(upstream, "conversation", lambda p, cfg: upstream.Conversation_(http, cfg))
    return Asker(
        find_token=lambda: token.Found(next(issued), "test", None),
        make_client=lambda t: FakeClient(),
        resolve_space=lambda t: "space-1",
        space_exists=lambda t, u: True,
        save=save,
    )


def test_events_arrive_in_order_and_done_carries_the_thread(monkeypatch):
    http = FakeHTTP([stream("slug-1", "b-1", ["Hello ", "world.[1]"])])
    events = list(asker(monkeypatch, http).ask("hi"))
    kinds = [type(e).__name__ for e in events]
    assert kinds[:2] == ["Status", "Status"]
    assert "Sources" in kinds
    assert "".join(e.text for e in events if isinstance(e, Delta)) == "Hello world.[1]"
    done = events[-1]
    assert isinstance(done, Done)
    assert done.content == "Hello world.[1]"
    assert done.sources[0].title == "The Docs"
    assert done.thread == Thread("b-1", "rwt-b-1", "slug-1")
    assert done.url == "https://www.perplexity.ai/search/slug-1"
    assert done.model == "perplexity/best"


def test_linked_answers_carry_markdown_links_in_deltas_and_done(monkeypatch):
    http = FakeHTTP([stream("s", "b", ["Fact.[", "1] end"])])
    events = list(asker(monkeypatch, http).ask("hi", linked=True))
    streamed = "".join(e.text for e in events if isinstance(e, Delta))
    assert streamed == "Fact.[1](https://a.example/docs) end"
    assert events[-1].content == streamed


def test_a_follow_up_keeps_the_first_questions_slug(monkeypatch):
    http = FakeHTTP([stream("entry-2", "b-2", ["More."])])
    events = list(asker(monkeypatch, http).ask("and?", thread=Thread("b-1", "rwt-1", "slug-1")))
    done = events[-1]
    assert http.payloads[0]["params"]["last_backend_uuid"] == "b-1"
    assert done.thread == Thread("b-2", "rwt-b-2", "slug-1")
    assert done.url.endswith("/slug-1")


def test_incognito_has_no_space_and_no_url(monkeypatch):
    http = FakeHTTP([stream("s", "b", ["x"])])
    events = list(asker(monkeypatch, http, save="incognito").ask("q"))
    params = http.payloads[0]["params"]
    assert params["is_incognito"] is True
    assert "target_collection_uuid" not in params
    assert events[-1].url is None


def test_a_refused_session_is_read_again_and_retried_once(monkeypatch):
    seen = []
    http = FlakyHTTP([stream("s", "b", ["ok"])], AuthenticationError())
    a = asker(monkeypatch, http)
    real = a._make_client
    a._make_client = lambda t: (seen.append(t), real(t))[1]
    events = list(a.ask("q"))
    assert seen == ["tok-1", "tok-2"]
    assert events[-1].content == "ok"


def test_no_retry_once_text_has_gone_out(monkeypatch):
    http = FlakyHTTP([stream("s", "b", ["partial ", "rest"])], AuthenticationError(), lines=3)
    got = []
    with pytest.raises(AskError) as e:
        for ev in asker(monkeypatch, http).ask("q"):
            got.append(ev)
    assert e.value.kind == "auth"
    assert "".join(x.text for x in got if isinstance(x, Delta)) == "partial "
    assert len(http.payloads) == 1


def test_a_refused_space_is_forgotten_and_found_again(monkeypatch):
    forgot = []
    monkeypatch.setattr(space, "forget", lambda: forgot.append(True))
    refusal = HTTPError("HTTP 404", status_code=404, response_body='{"detail":"collection not found"}')
    http = FlakyHTTP([stream("s", "b", ["ok"])], refusal)
    a = asker(monkeypatch, http)
    a._space_exists = lambda t, u: False
    events = list(a.ask("q"))
    assert forgot == [True]
    assert events[-1].content == "ok"


def test_other_http_errors_are_reported_with_their_status(monkeypatch):
    http = FlakyHTTP([stream("s", "b", ["ok"])], HTTPError("boom", status_code=500))
    with pytest.raises(AskError, match="HTTP 500") as e:
        list(asker(monkeypatch, http).ask("q"))
    assert e.value.kind == "upstream"


def test_an_unknown_model_fails_before_any_request(monkeypatch):
    http = FakeHTTP([])
    with pytest.raises(AskError) as e:
        list(asker(monkeypatch, http).ask("q", model="no-such-model"))
    assert e.value.kind == "model"
    assert http.payloads == []


def test_an_empty_answer_is_an_error_not_a_blank(monkeypatch):
    http = FakeHTTP([stream("s", "b", [])])
    with pytest.raises(AskError, match="no answer"):
        list(asker(monkeypatch, http).ask("q"))


def test_the_client_is_closed_even_when_the_ask_fails(monkeypatch):
    before = FakeClient.closed
    http = FlakyHTTP([stream("s", "b", ["ok"])], HTTPError("boom", status_code=500))
    with pytest.raises(AskError):
        list(asker(monkeypatch, http).ask("q"))
    assert FakeClient.closed == before + 1


def test_save_mode_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("VINAVU_SAVE", "library")
    assert ask.save_mode() == "library"
    monkeypatch.setenv("VINAVU_SAVE", "everywhere")
    with pytest.raises(AskError, match="not one of"):
        ask.save_mode()


@pytest.mark.parametrize(
    ("name", "url", "title"),
    [
        ("www.kernel.org › releasesActive kernel releases", "https://www.kernel.org/releases.html", "Active kernel releases"),
        ("www.python.org · downloadsDownload Python | Python.org", "https://www.python.org/downloads/?keys=x", "Download Python | Python.org"),
        ("censusindia.gov.in › data › population-finderPopulation finder", "https://censusindia.gov.in/data/population-finder", "Population finder"),
        ("www.kernel.orgThe Linux Kernel Archives", "https://www.kernel.org/", "The Linux Kernel Archives"),
        ("Latest Linux Kernel Versions", "https://example.com/kernels", "Latest Linux Kernel Versions"),
        ("example.com", "https://example.com/", "example.com"),
        (None, "https://example.com/a", "example.com"),
        (
            "www.britannica.com › What-is-the-capital-of-JapanWhat is the capital of Japan? | Britannica",
            "https://www.britannica.com/question/What-is-the-capital-of-Japan",
            "What is the capital of Japan? | Britannica",
        ),
        (
            "www.vedantu.com › what-is-theWhat is the capital of Japan? A) Kyoto",
            "https://www.vedantu.com/question-answer/what-is-the-capital-of-japan-a-kyoto-5f1b",
            "What is the capital of Japan? A) Kyoto",
        ),
    ],
)
def test_clean_title(name, url, title):
    assert clean_title(name, url) == title


def test_statuses_name_the_source_count(monkeypatch):
    http = FakeHTTP([stream("s", "b", ["x"])])
    statuses = [e.text for e in asker(monkeypatch, http).ask("q") if isinstance(e, Status)]
    assert statuses == ["asking", "searching", "reading 1 source"]


def test_sources_event_lists_cleaned_titles(monkeypatch):
    http = FakeHTTP([stream("s", "b", ["x"])])
    sources = [e for e in asker(monkeypatch, http).ask("q") if isinstance(e, Sources)]
    assert sources[0].items[0].title == "The Docs"


# --- from review (Cursor gpt-5.6-sol-high, 2026-10-11) ----------------------

from perplexity_webui_scraper._internal.exceptions import ResponseParsingError  # noqa: E402

from test_upstream import frame  # noqa: E402


def text_frame(i, chunk, **extra):
    base = {"backend_uuid": "b", "read_write_token": "rwt-b", "thread_url_slug": "s", "status": "PENDING"}
    return frame(
        **base,
        **extra,
        blocks=[{"intended_usage": "ask_text", "markdown_block": {"progress": "IN_PROGRESS", "chunks": [chunk], "chunk_starting_offset": i}}],
    )


def test_a_stream_that_breaks_off_before_its_final_frame_is_an_error(monkeypatch):
    lines = stream("s", "b", ["Half an ", "answer"])[:-1]  # the final frame never came
    http = FakeHTTP([lines])
    got = []
    with pytest.raises(AskError, match="broke off") as e:
        for ev in asker(monkeypatch, http).ask("q"):
            got.append(ev)
    assert e.value.kind == "upstream"
    assert not any(isinstance(x, Done) for x in got)
    assert "".join(x.text for x in got if isinstance(x, Delta)) == "Half an answer"


def test_a_correction_to_an_earlier_chunk_does_not_stop_the_stream(monkeypatch):
    lines = [
        text_frame(0, "The capital "),
        text_frame(1, "of Japn "),
        text_frame(1, "of Japan "),  # the stream corrects chunk 1 in place
        text_frame(2, "is Tokyo."),
        frame(backend_uuid="b", read_write_token="rwt-b", final=True, text_completed=True, blocks=[]),
    ]
    events = list(asker(monkeypatch, FakeHTTP([lines])).ask("q"))
    streamed = "".join(e.text for e in events if isinstance(e, Delta))
    # What was printed stays printed; the words after the correction still come.
    assert streamed == "The capital of Japn is Tokyo."
    assert events[-1].content == "The capital of Japan is Tokyo."


def test_a_growing_last_chunk_streams_only_its_new_end(monkeypatch):
    lines = [
        text_frame(0, "Tok"),
        text_frame(0, "Tokyo"),
        text_frame(1, " is big."),
        frame(backend_uuid="b", read_write_token="rwt-b", final=True, text_completed=True, blocks=[]),
    ]
    events = list(asker(monkeypatch, FakeHTTP([lines])).ask("q"))
    assert [e.text for e in events if isinstance(e, Delta)] == ["Tok", "yo", " is big."]


def gone_asker(monkeypatch, http, exists):
    checked = []
    a = asker(monkeypatch, http)
    a._space_exists = lambda tok, uuid: (checked.append(uuid), exists)[1]
    return a, checked


def test_a_deleted_space_is_found_out_and_replaced(monkeypatch):
    forgot = []
    monkeypatch.setattr(space, "forget", lambda: forgot.append(True))
    failure = ResponseParsingError("Query processing failed: Please try again later.")
    a, checked = gone_asker(monkeypatch, FlakyHTTP([stream("s", "b", ["ok"])], failure), exists=False)
    events = list(a.ask("q"))
    assert checked == ["space-1"]
    assert forgot == [True]
    assert events[-1].content == "ok"


def test_a_failure_with_the_space_still_there_is_reported_not_retried(monkeypatch):
    forgot = []
    monkeypatch.setattr(space, "forget", lambda: forgot.append(True))
    failure = ResponseParsingError("Query processing failed: Please try again later.")
    a, checked = gone_asker(monkeypatch, FlakyHTTP([stream("s", "b", ["ok"])], failure), exists=True)
    with pytest.raises(AskError, match="try again later"):
        list(a.ask("q"))
    assert checked == ["space-1"]
    assert forgot == []


def test_the_space_is_not_suspected_for_a_rate_limit(monkeypatch):
    from perplexity_webui_scraper._internal.exceptions import RateLimitError

    a, checked = gone_asker(monkeypatch, FlakyHTTP([stream("s", "b", ["ok"])], RateLimitError()), exists=False)
    with pytest.raises(AskError) as e:
        list(a.ask("q"))
    assert e.value.kind == "quota"
    assert checked == []



class TierClient(FakeClient):
    asked = 0

    def get_account_profile(self):
        TierClient.asked += 1

        class P:
            account_tier = "pro"

        return P()


def test_the_tier_is_asked_once_and_cached_for_a_day(monkeypatch):
    import json as _json

    from vinavu_engine.paths import home

    seen = []
    monkeypatch.setattr(upstream, "conversation", lambda p, cfg: (seen.append(upstream.Conversation_(FakeHTTP([stream("s", "b", ["ok"])]), cfg)), seen[-1])[1])
    before = TierClient.asked
    for _ in range(2):
        a = Asker(find_token=lambda: token.Found("t", "test", None), make_client=lambda t: TierClient(),
                  resolve_space=lambda t: "space-1", space_exists=lambda t, u: True, save="space")
        list(a.ask("q"))
    assert TierClient.asked == before + 1
    assert [c.tier for c in seen] == ["pro", "pro"]
    assert _json.loads((home() / "account.json").read_text())["tier"] == "pro"


def test_a_model_refused_on_a_cached_tier_forgets_the_tier(monkeypatch):
    from perplexity_webui_scraper._internal.exceptions import ModelAccessError

    from vinavu_engine.paths import home, write_private

    import hashlib as _h
    import time as _t

    digest = _h.sha256(b"tok-1").hexdigest()[:16]
    write_private(home() / "account.json", '{"tier": "pro", "account": "%s", "at": %f}' % (digest, _t.time()))
    http = FlakyHTTP([stream("s", "b", ["ok"])], ModelAccessError("perplexity/best", "max", "pro"))
    with pytest.raises(AskError) as e:
        list(asker(monkeypatch, http).ask("q"))
    assert e.value.kind == "model"
    assert not (home() / "account.json").exists()



# --- from review of the tier cache (Cursor gpt-5.6-sol-high, 2026-10-11) ----


def tier_asker(monkeypatch, tok="t", tier="pro"):
    class C(FakeClient):
        asked = 0

        def get_account_profile(self):
            C.asked += 1

            class P:
                account_tier = tier

            return P()

    held = []
    monkeypatch.setattr(upstream, "conversation",
                        lambda p, cfg: (held.append(upstream.Conversation_(FakeHTTP([stream("s", "b", ["ok"])]), cfg)), held[-1])[1])
    a = Asker(find_token=lambda: token.Found(tok, "test", None), make_client=lambda t: C(),
              resolve_space=lambda t: "space-1", space_exists=lambda t, u: True, save="space")
    return a, C, held


def test_another_sign_in_asks_its_own_tier(monkeypatch):
    a, C, _ = tier_asker(monkeypatch, tok="first")
    list(a.ask("q"))
    b, D, held = tier_asker(monkeypatch, tok="second", tier="free")
    list(b.ask("q"))
    assert D.asked == 1, "the first account's cached tier was used for the second"
    assert held[-1].tier == "free"


def test_a_tier_the_library_does_not_know_is_not_used(monkeypatch):
    from vinavu_engine.paths import home

    a, C, held = tier_asker(monkeypatch, tier="enterprise")
    list(a.ask("q"))
    assert held[-1].tier is None, "the library's own check runs instead"
    assert not (home() / "account.json").exists()


@pytest.mark.parametrize("at", ["9999999999", "1e400", "-5", '"soon"'])
def test_a_cache_from_the_future_or_malformed_is_not_trusted(monkeypatch, at):
    import hashlib as _h

    from vinavu_engine.paths import home, write_private

    digest = _h.sha256(b"t").hexdigest()[:16]
    write_private(home() / "account.json", '{"tier": "max", "account": "%s", "at": %s}' % (digest, at))
    a, C, held = tier_asker(monkeypatch)
    list(a.ask("q"))
    assert C.asked == 1
    assert held[-1].tier == "pro"


def test_a_tier_that_cannot_be_cached_is_still_held_in_memory(monkeypatch):
    import vinavu_engine.ask as ask_module

    def boom(*a, **k):
        raise OSError("read-only")

    monkeypatch.setattr(ask_module, "write_private", boom)
    a, C, held = tier_asker(monkeypatch)
    for _ in range(3):
        list(a.ask("q"))
    assert C.asked == 1
    assert [c.tier for c in held] == ["pro", "pro", "pro"]


def test_forgetting_the_tier_never_hides_the_refusal(monkeypatch):
    from pathlib import Path

    from perplexity_webui_scraper._internal.exceptions import ModelAccessError

    def boom(self, missing_ok=False):
        raise PermissionError("read-only")

    monkeypatch.setattr(Path, "unlink", boom)
    http = FlakyHTTP([stream("s", "b", ["ok"])], ModelAccessError("perplexity/best", "max", "pro"))
    with pytest.raises(AskError) as e:
        list(asker(monkeypatch, http).ask("q"))
    assert e.value.kind == "model"
