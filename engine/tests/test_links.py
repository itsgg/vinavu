from __future__ import annotations

from dataclasses import dataclass

from vinavu_engine.links import Linker, link


@dataclass
class S:
    url: str


SOURCES = [S("https://a.example/1"), S("https://b.example/2")]


def test_link_replaces_known_markers_and_leaves_the_rest():
    out = link("Fact.[1][2] Other.[9]", SOURCES)
    assert out == "Fact.[1](https://a.example/1)[2](https://b.example/2) Other.[9]"


def test_a_link_the_model_wrote_itself_is_left_alone():
    assert link("see [1](https://x.example)", SOURCES) == "see [1](https://x.example)"


def test_markers_split_across_deltas_are_linked_once_whole():
    linker = Linker(lambda: SOURCES)
    out = linker.feed("Fact.[") + linker.feed("1") + linker.feed("] and [2") + linker.feed("] end") + linker.flush()
    assert out == "Fact.[1](https://a.example/1) and [2](https://b.example/2) end"


def test_a_marker_at_the_end_of_the_answer_is_flushed():
    linker = Linker(lambda: SOURCES)
    out = linker.feed("Fact.[1]") + linker.flush()
    assert out == "Fact.[1](https://a.example/1)"


def test_sources_that_arrive_late_are_used_for_markers_still_held():
    known: list[S] = []
    linker = Linker(lambda: known)
    first = linker.feed("Fact [1")
    known.extend(SOURCES)
    rest = linker.feed("] done") + linker.flush()
    assert first == "Fact "
    assert rest == "[1](https://a.example/1) done"


def test_concatenated_output_equals_linking_the_whole_text():
    text = "A [1] b [2][1] c [3] d."
    linker = Linker(lambda: SOURCES)
    streamed = "".join(linker.feed(text[i : i + 3]) for i in range(0, len(text), 3)) + linker.flush()
    assert streamed == link(text, SOURCES)


def test_a_whole_marker_waits_for_sources_that_arrive_after_it():
    known: list[S] = []
    linker = Linker(lambda: known)
    first = linker.feed("Fact [1] continues")
    known.extend(SOURCES)
    rest = linker.feed(" here.") + linker.flush()
    assert first == "Fact "
    assert rest == "[1](https://a.example/1) continues here."


def test_without_sources_text_is_held_only_so_long():
    linker = Linker(lambda: [])
    out = linker.feed("code a[1] then " + "x" * 500)
    assert out.startswith("code a[1] then ")
    assert out + linker.flush() == "code a[1] then " + "x" * 500
