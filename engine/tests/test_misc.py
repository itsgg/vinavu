"""The small pieces: models, the Space, the engine's ask command, the MCP tool."""

from __future__ import annotations

import io
import json

import pytest

from vinavu_engine import cli, mcp_server, models, space, threads
from vinavu_engine.ask import AskError, Delta, Done, Source, Sources, Status, Thread

# --- models ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "resolved"),
    [
        (None, "perplexity/best"),
        ("best", "perplexity/best"),
        ("Research", "perplexity/deep-research"),
        ("anthropic/claude-opus-4.7-thinking", "anthropic/claude-opus-4.7-thinking"),
        ("claude-opus-4.7-thinking", "anthropic/claude-opus-4.7-thinking"),
    ],
)
def test_model_names_resolve(name, resolved):
    assert models.resolve(name) == resolved


def test_an_unknown_model_suggests_near_names():
    with pytest.raises(models.UnknownModel, match="did you mean"):
        models.resolve("opus-4.7")


def test_listing_hides_models_known_to_be_broken():
    ids = {m.id for m in models.listing()}
    assert "anthropic/claude45haiku" not in ids
    assert "perplexity/best" in ids


# --- space -----------------------------------------------------------------


class R:
    def __init__(self, status, data):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data


class FakeSession:
    def __init__(self, listed, created=None):
        self.listed = listed
        self.created = created
        self.calls: list[str] = []

    def get(self, url, params=None):
        self.calls.append("list")
        return R(200, self.listed)

    def post(self, url, params=None, json=None):
        self.calls.append(f"create {json['title']}")
        return R(200, self.created or {"uuid": "new-uuid"})


def test_the_space_is_found_by_title_and_then_cached():
    s = FakeSession([{"title": "Yoga", "uuid": "y"}, {"title": "vinavu", "uuid": "v-1"}])
    assert space.resolve(s) == "v-1"
    assert space.resolve(s) == "v-1"
    assert s.calls == ["list"]


def test_the_space_is_created_when_missing():
    s = FakeSession([{"title": "Yoga", "uuid": "y"}])
    assert space.resolve(s) == "new-uuid"
    assert s.calls == ["list", "create vinavu"]


def test_renaming_the_space_finds_the_new_one(monkeypatch):
    s = FakeSession([{"title": "vinavu", "uuid": "v-1"}, {"title": "terminal", "uuid": "t-1"}])
    assert space.resolve(s) == "v-1"
    monkeypatch.setenv("VINAVU_SPACE", "terminal")
    assert space.resolve(s) == "t-1"


def test_forget_drops_the_cache():
    s = FakeSession([{"title": "vinavu", "uuid": "v-1"}])
    space.resolve(s)
    space.forget()
    assert space.cached() is None


def test_a_failed_listing_is_a_space_error():
    class Down(FakeSession):
        def get(self, url, params=None):
            return R(500, None)

    with pytest.raises(space.SpaceError, match="HTTP 500"):
        space.resolve(Down([]))


# --- the ask command ------------------------------------------------------


class ScriptedAsker:
    last: dict = {}

    def __init__(self, *a, **k):
        pass

    def ask(self, query, *, model=None, thread=None, files=(), linked=False):
        ScriptedAsker.last = {"query": query, "model": model, "thread": thread, "files": files, "linked": linked}
        if query == "fail":
            raise AskError("quota", "too many")
        yield Status("asking")
        yield Sources([Source("T", "https://t.example")])
        yield Delta("Hi")
        yield Done(content="Hi", model="perplexity/best", sources=[Source("T", "https://t.example")], thread=Thread("b", "r", "s"), url="u")


def run_ask(monkeypatch, capsys, request: str) -> tuple[int, list[dict]]:
    monkeypatch.setattr(cli, "Asker", ScriptedAsker)
    monkeypatch.setattr("sys.stdin", io.StringIO(request))
    code = cli.main(["ask"])
    out = capsys.readouterr().out
    return code, [json.loads(line) for line in out.splitlines()]


def test_ask_prints_one_json_event_per_line(monkeypatch, capsys):
    req = json.dumps({"query": "q", "model": "best", "thread": {"backend_uuid": "b0", "read_write_token": "r0"}, "files": ["/x.png"]})
    code, events = run_ask(monkeypatch, capsys, req)
    assert code == 0
    assert [e["t"] for e in events] == ["status", "sources", "d", "done"]
    assert events[-1]["thread"] == {"backend_uuid": "b", "read_write_token": "r", "slug": "s"}
    assert ScriptedAsker.last["thread"] == Thread("b0", "r0", None)
    assert ScriptedAsker.last["files"] == ["/x.png"]


def test_ask_reports_failures_as_an_error_event(monkeypatch, capsys):
    code, events = run_ask(monkeypatch, capsys, json.dumps({"query": "fail"}))
    assert code == 1
    assert events == [{"t": "err", "kind": "quota", "error": "too many"}]


@pytest.mark.parametrize("bad", ["not json", "[]", '{"query": ""}', '{"query": "q", "files": [1]}'])
def test_ask_rejects_malformed_requests(monkeypatch, capsys, bad):
    code, events = run_ask(monkeypatch, capsys, bad)
    assert code == 1
    assert events[0]["kind"] == "request"


# --- MCP -------------------------------------------------------------------


def test_the_mcp_answer_lists_sources_and_the_thread(monkeypatch):
    monkeypatch.setattr(mcp_server, "_asker", ScriptedAsker())
    text = mcp_server.ask_blocking("q")
    assert text.startswith("Hi")
    assert "[1] T <https://t.example>" in text
    assert "Thread: b" in text
    assert threads.lookup("mcp:b") == Thread("b", "r", "s")


def test_an_mcp_follow_up_resumes_a_known_thread(monkeypatch):
    monkeypatch.setattr(mcp_server, "_asker", ScriptedAsker())
    threads.remember("mcp:known", Thread("known", "rwt", "slug"))
    mcp_server.ask_blocking("more", follow_up="known")
    assert ScriptedAsker.last["thread"] == Thread("known", "rwt", "slug")


def test_an_unknown_mcp_follow_up_says_so():
    assert "no thread" in mcp_server.ask_blocking("more", follow_up="nope")


def test_mcp_errors_come_back_as_text(monkeypatch):
    monkeypatch.setattr(mcp_server, "_asker", ScriptedAsker())
    assert mcp_server.ask_blocking("fail").startswith("Error (quota)")


def test_the_mcp_server_offers_exactly_one_tool():
    import anyio

    server = mcp_server.build()
    tools = anyio.run(server.list_tools)
    assert [t.name for t in tools] == ["perplexity_ask"]


def test_the_mcp_answer_lists_only_cited_sources():
    done = Done(
        content="A.[2](https://two.example) B.",
        model="m",
        sources=[Source("One", "https://one.example"), Source("Two", "https://two.example")],
    )
    text = mcp_server.format_answer(done)
    assert "[2] Two <https://two.example>" in text
    assert "One" not in text



def test_threads_writing_one_file_at_once_leave_it_whole():
    import threading

    from vinavu_engine.paths import home, write_private

    target = home() / "same.json"
    errors = []

    def write(n):
        try:
            for i in range(50):
                write_private(target, json.dumps({"writer": n, "i": i, "pad": "x" * (n * 100)}))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    workers = [threading.Thread(target=write, args=(n,)) for n in range(1, 6)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    assert errors == []
    assert json.loads(target.read_text())["i"] == 49
    assert not [p for p in target.parent.iterdir() if p.name.endswith(".tmp")]
    assert oct(target.stat().st_mode & 0o777) == "0o600"
