from __future__ import annotations

import base64
import json

import pytest

from vinavu_engine import openai, threads
from vinavu_engine.ask import Source, Thread


def test_a_first_question_is_asked_as_is():
    p = openai.plan([{"role": "user", "content": "What is uv?"}])
    assert p.query == "What is uv?"
    assert p.thread is None


def test_system_messages_become_instructions_on_a_new_thread():
    p = openai.plan([{"role": "system", "content": "Be brief."}, {"role": "user", "content": "What is uv?"}])
    assert p.query == "Instructions:\nBe brief.\n\nWhat is uv?"


def test_an_unknown_history_is_folded_in_with_roles_named():
    p = openai.plan(
        [
            {"role": "user", "content": "Capital of France?"},
            {"role": "assistant", "content": "Paris."},
            {"role": "user", "content": "Population?"},
        ]
    )
    assert p.thread is None
    assert "User: Capital of France?" in p.query
    assert "Assistant: Paris." in p.query
    assert p.query.endswith("Now answer this:\nPopulation?")


def test_a_known_history_continues_its_thread_with_the_last_message():
    first = openai.plan([{"role": "user", "content": "Capital of France?"}])
    openai.remember(first, "Paris.[1](https://x.example)", Thread("b-1", "rwt", "slug"))
    p = openai.plan(
        [
            {"role": "user", "content": "Capital of France?"},
            {"role": "assistant", "content": "  Paris.[1](https://x.example)\n"},
            {"role": "user", "content": "Population?"},
        ]
    )
    assert p.thread == Thread("b-1", "rwt", "slug")
    assert p.query == "Population?"


def test_content_parts_and_data_uri_images():
    png = base64.b64encode(b"\x89PNG fake").decode()
    p = openai.plan(
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "What is this?"},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png}"}},
                    {"type": "image_url", "image_url": {"url": "https://example.com/cat.jpg"}},
                ],
            }
        ]
    )
    assert p.files == [(b"\x89PNG fake", "image-1.png", "image/png")]
    assert "What is this?" in p.query
    assert "(image: https://example.com/cat.jpg)" in p.query


@pytest.mark.parametrize(
    "messages",
    [
        [],
        "hello",
        [{"role": "assistant", "content": "hi"}],
        [{"role": "user", "content": "   "}],
        [{"role": "user", "content": 5}],
        [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png,notbase64"}}]}],
    ],
)
def test_bad_requests(messages):
    with pytest.raises(openai.BadRequest):
        openai.plan(messages)


def test_completion_carries_perplexity_style_citations():
    body = openai.completion("perplexity/best", "Paris.", [Source("Wiki", "https://w.example")], "https://p/s")
    assert body["choices"][0]["message"] == {"role": "assistant", "content": "Paris."}
    assert body["citations"] == ["https://w.example"]
    assert body["search_results"] == [{"title": "Wiki", "url": "https://w.example"}]
    assert body["vinavu"] == {"thread_url": "https://p/s"}


def test_chunks_are_well_formed_server_sent_events():
    c = openai.Chunks("m")
    lines = c.role() + c.text("Hi") + c.end([Source("t", "u")], None)
    datas = [line[6:] for line in lines.split("\n\n") if line.startswith("data: ")]
    assert datas[-1] == "[DONE]"
    parsed = [json.loads(d) for d in datas[:-1]]
    assert parsed[0]["choices"][0]["delta"]["role"] == "assistant"
    assert parsed[1]["choices"][0]["delta"]["content"] == "Hi"
    assert parsed[2]["choices"][0]["finish_reason"] == "stop"
    assert parsed[2]["citations"] == ["u"]


def test_thread_keys_ignore_surrounding_whitespace_but_not_system_messages():
    a = threads.key([("system", "x"), ("user", "q"), ("assistant", "a ")])
    assert a == threads.key([("system", " x"), ("user", " q"), ("assistant", "a")])
    assert a != threads.key([("user", "q"), ("assistant", "a")])
    assert a != threads.key([("system", "x"), ("user", "q"), ("assistant", "b")])


def test_thread_map_forgets_old_entries(monkeypatch):
    threads.remember("k", Thread("b"))
    assert threads.lookup("k") == Thread("b")
    real = threads.time.time
    monkeypatch.setattr(threads.time, "time", lambda: real() + threads.MAX_AGE_S + 10)
    assert threads.lookup("k") is None


def test_thread_map_is_bounded(monkeypatch):
    monkeypatch.setattr(threads, "MAX_ENTRIES", 3)
    for i in range(5):
        threads.remember(f"k{i}", Thread(f"b{i}"))
    assert threads.lookup("k0") is None
    assert threads.lookup("k4") == Thread("b4")


def test_conversations_that_differ_only_in_their_system_message_do_not_share_a_thread():
    a = openai.plan([{"role": "system", "content": "Be a pirate."}, {"role": "user", "content": "Hi"}])
    openai.remember(a, "Ahoy.", Thread("pirate"))
    b = openai.plan(
        [
            {"role": "system", "content": "Be formal."},
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Ahoy."},
            {"role": "user", "content": "More"},
        ]
    )
    assert b.thread is None


def test_a_follow_up_after_an_image_keeps_its_thread():
    png = "data:image/png;base64," + base64.b64encode(b"img").decode()
    first_msgs = [{"role": "user", "content": [{"type": "text", "text": "What?"}, {"type": "image_url", "image_url": {"url": png}}]}]
    first = openai.plan(first_msgs)
    openai.remember(first, "A cat.", Thread("cat"))
    again = openai.plan([*first_msgs, {"role": "assistant", "content": "A cat."}, {"role": "user", "content": "Colour?"}])
    assert again.thread == Thread("cat")
    assert again.files == []
    other = base64.b64encode(b"other").decode()
    swapped = [{"role": "user", "content": [{"type": "text", "text": "What?"}, {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{other}"}}]}]
    assert openai.plan([*swapped, {"role": "assistant", "content": "A cat."}, {"role": "user", "content": "Colour?"}]).thread is None


def test_an_unwritable_thread_map_does_not_fail_the_answer(isolated, monkeypatch):
    def boom(*a, **k):
        raise OSError("read-only file system")

    monkeypatch.setattr(threads, "write_private", boom)
    p = openai.plan([{"role": "user", "content": "q"}])
    openai.remember(p, "a", Thread("b"))  # must not raise
