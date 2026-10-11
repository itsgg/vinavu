import { test } from "node:test";
import assert from "node:assert/strict";

// stdout is not a TTY under the test runner and NO_COLOR is set below, so the
// renderer emits plain text. That keeps these assertions about structure, not
// escape codes; the colour paths are covered separately in theme.test.ts.
process.env.NO_COLOR = "1";

const {
  render,
  renderMarkdown,
  renderSources,
  inline,
  safeCut,
  wrapPlain,
  stripAnsi,
  vlen,
  maxOf,
  reconcileTail,
  turnRule,
} = await import("../src/render.js");
const { promptMark } = await import("../src/theme.js");

test("headings render with their text and a rule under h1", () => {
  const out = renderMarkdown("# Title");
  assert.match(out, /Title/);
  assert.match(out, /─/);
});

test("h2 and h3 keep their text and drop the hashes", () => {
  assert.match(renderMarkdown("## Sub"), /Sub/);
  assert.doesNotMatch(renderMarkdown("## Sub"), /#/);
  assert.match(renderMarkdown("### Deep"), /Deep/);
});

test("bullets become bullet glyphs and keep indentation", () => {
  const out = renderMarkdown("- one\n- two");
  assert.match(out, /•\s+one/);
  assert.match(out, /•\s+two/);
  assert.match(renderMarkdown("  - nested"), /^ {2}•/m);
});

test("ordered lists keep their numbers", () => {
  assert.match(renderMarkdown("1. first\n2. second"), /1\.\s+first[\s\S]*2\.\s+second/);
});

test("blockquotes are marked and unwrapped", () => {
  const out = renderMarkdown("> quoted");
  assert.match(out, /▏/);
  assert.match(out, /quoted/);
  assert.doesNotMatch(out, /^>/m);
});

test("horizontal rules render as a line", () => {
  assert.match(renderMarkdown("---"), /^─+$/m);
});

test("inline emphasis markers are consumed", () => {
  assert.equal(inline("**bold**"), "bold");
  assert.equal(inline("*em*"), "em");
  assert.equal(inline("__bold__"), "bold");
  // Backticks are kept when there is no colour to carry the distinction.
  assert.equal(inline("a `code` b"), "a `code` b");
});

test("inline links keep the label and expose the url when unlinked", () => {
  const out = inline("[Anthropic](https://example.com)");
  assert.match(out, /Anthropic/);
  assert.match(out, /example\.com/);
});

test("a bare url survives inline rendering", () => {
  assert.match(inline("see https://example.com/x now"), /https:\/\/example\.com\/x/);
});

test("code fences render every line and the language label", () => {
  const out = renderMarkdown("```js\nconst a = 1;\nconst b = 2;\n```");
  assert.match(out, /js/);
  assert.match(out, /const a = 1;/);
  assert.match(out, /const b = 2;/);
});

test("an unterminated code fence still renders its content", () => {
  assert.match(renderMarkdown("```\nunclosed line\n"), /unclosed line/);
});

test("markdown tables render as a box with every cell", () => {
  const out = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.match(out, /╭/);
  assert.match(out, /╰/);
  for (const cell of ["A", "B", "1", "2"]) assert.match(out, new RegExp(cell));
});

test("table rows with missing trailing cells are padded, not dropped", () => {
  const out = renderMarkdown("| A | B |\n| --- | --- |\n| only |");
  assert.match(out, /only/);
  // every drawn line is the same visible width
  const widths = new Set(
    out.split("\n").filter((l) => l.includes("│") || l.includes("├")).map((l) => vlen(l)),
  );
  assert.equal(widths.size, 1);
});

test("a table cell longer than the budget wraps instead of overflowing", () => {
  const long = "x".repeat(400);
  const out = renderMarkdown(`| A | B |\n| --- | --- |\n| ${long} | y |`);
  for (const line of out.split("\n")) assert.ok(vlen(line) <= 120, `line too wide: ${vlen(line)}`);
});

// Model output is untrusted and can be enormous. Math.max(...array) throws
// RangeError somewhere past ~125k arguments, which is well inside the size of a
// long answer, so every width computation goes through maxOf instead.
test("maxOf survives an array far larger than the argument limit", () => {
  const huge = Array.from({ length: 500_000 }, (_, i) => i);
  assert.throws(() => Math.max(...huge), RangeError, "premise: spread should still overflow");
  assert.equal(maxOf(huge), 499_999);
});

test("maxOf returns the seed for an empty array", () => {
  assert.equal(maxOf([], 3), 3);
  assert.equal(maxOf([]), 0);
});

test("a very long code block renders every line without throwing", () => {
  const body = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n");
  const out = renderMarkdown("```\n" + body + "\n```");
  assert.match(out, /line 19999/);
});

test("a long table renders without throwing", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `| ${i} | x |`).join("\n");
  const out = renderMarkdown("| A | B |\n| --- | --- |\n" + rows);
  assert.match(out, /1999/);
});

test("wrapPlain never loops forever on a degenerate width", () => {
  assert.deepEqual(wrapPlain("abcdef", 0), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(wrapPlain("abcdef", -5), ["a", "b", "c", "d", "e", "f"]);
});

test("wrapPlain breaks on words and hard-splits an overlong word", () => {
  assert.deepEqual(wrapPlain("aa bb cc", 5), ["aa bb", "cc"]);
  assert.deepEqual(wrapPlain("abcdefgh", 3), ["abc", "def", "gh"]);
});

test("stripAnsi and vlen ignore colour and hyperlink escapes", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[39m"), "red");
  assert.equal(vlen("\x1b[1mabc\x1b[22m"), 3);
  assert.equal(vlen("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\"), 4);
});

test("safeCut refuses to cut inside a code fence", () => {
  const buf = "para\n\n```\ncode\n\nmore\n";
  assert.equal(safeCut(buf), "para\n\n".length);
});

test("safeCut releases a block once the fence closes", () => {
  const buf = "```\ncode\n```\ntail";
  assert.equal(safeCut(buf), "```\ncode\n```\n".length);
});

test("safeCut returns 0 when nothing is complete yet", () => {
  assert.equal(safeCut("half a sentence"), 0);
});

test("safeCut never cuts the trailing partial line", () => {
  const buf = "done\n\npartial";
  assert.equal(buf.slice(safeCut(buf)), "partial");
});

// --- reconciling the streamed answer with the authoritative one -------------

test("nothing more to print when the stream matched the final answer", () => {
  assert.equal(reconcileTail("the whole answer", "the whole answer"), "");
  assert.equal(reconcileTail("  spaced  ", "spaced"), "");
});

test("a truncated stream is topped up with only the missing tail", () => {
  assert.equal(reconcileTail("first half", "first half and the rest"), " and the rest");
});

test("everything is printed when no delta arrived at all", () => {
  assert.equal(reconcileTail("", "the answer"), "the answer");
  assert.equal(reconcileTail("   ", "the answer"), "the answer");
});

test("a divergent final answer is not reprinted on top of the streamed one", () => {
  assert.equal(reconcileTail("what was shown", "something else entirely"), "");
});

test("an empty final answer never adds anything", () => {
  assert.equal(reconcileTail("shown", ""), "");
  assert.equal(reconcileTail("shown", undefined as unknown as string), "");
});

// --- escape stripping -------------------------------------------------------
// vlen drives every table column width, so any escape it fails to recognise is
// counted as visible text and silently misaligns the table it appears in.

test("stripAnsi removes OSC 133 prompt marks", () => {
  assert.equal(stripAnsi("\x1b]133;A\x1b\\you"), "you");
  assert.equal(vlen("\x1b]133;A\x1b\\you ▸ "), 6);
});

test("stripAnsi removes OSC strings terminated by BEL as well as ST", () => {
  assert.equal(stripAnsi("\x1b]0;a title\x07text"), "text");
  assert.equal(stripAnsi("\x1b]8;;https://example.com\x1b\\link"), "link");
});

test("stripAnsi removes CSI sequences that are not colour", () => {
  assert.equal(stripAnsi("\x1b[2Kcleared"), "cleared");
  assert.equal(stripAnsi("\x1b[1;31mred\x1b[0m"), "red");
  assert.equal(stripAnsi("\x1b[?25lhidden\x1b[?25h"), "hidden");
});

test("stripAnsi leaves ordinary text with brackets alone", () => {
  assert.equal(stripAnsi("a [b] c ]133;A"), "a [b] c ]133;A");
});

test("the prompt mark is a well-formed OSC 133;A", async () => {
  const { PROMPT_MARK } = await import("../src/theme.js");
  assert.equal(PROMPT_MARK, "\x1b]133;A\x1b\\");
  // and it is invisible: stripping escapes leaves nothing behind
  assert.equal(stripAnsi(PROMPT_MARK), "");
  assert.equal(vlen(PROMPT_MARK), 0);
});

// NO_COLOR asks for plain text, not for a terminal stripped of the things that
// make it navigable, so the marker must not be tied to the colour setting. This
// file runs with NO_COLOR set, so faking a TTY exercises exactly the case a
// colour-gated implementation would get wrong.
test("prompt marking follows the terminal, not the colour setting", () => {
  const real = process.stdout.isTTY;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    assert.equal(promptMark(), "\x1b]133;A\x1b\\", "NO_COLOR must not disable prompt marking");
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    assert.equal(promptMark(), "", "nothing should be written to a redirected stream");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: real, configurable: true });
  }
});

// --- turn boundaries --------------------------------------------------------

test("a turn rule carries its number and fills the width exactly", () => {
  const r = turnRule(40, 7);
  assert.match(r, /7/);
  assert.equal(vlen(r), 40);
});

// The whole point: the model writes `---` inside answers, and that used to
// render as the only strong horizontal line on screen, at a place that was not
// a boundary. The two must not be confusable.
test("a turn rule is not confusable with a markdown rule inside an answer", () => {
  const turn = turnRule(80, 1);
  const md = renderMarkdown("---");
  assert.ok(turn.includes("━"), "turn rule should use the heavy glyph");
  assert.ok(md.includes("─"), "markdown rule should use the light glyph");
  assert.ok(!turn.includes("─"), "turn rule must not use the light glyph");
  assert.ok(!md.includes("━"), "markdown rule must not use the heavy glyph");
  assert.notEqual(vlen(turn), vlen(md.trim()));
});

// A rule wider than the terminal wraps, and a wrapped boundary stops reading as
// a boundary. It gives up the number, then the leading dashes, before it grows.
test("a turn rule never exceeds the width it was given", () => {
  for (const w of [0, 1, 2, 3, 4, 5, 6, 10, 40]) {
    for (const n of [undefined, 1, 1234, 999999]) {
      const r = turnRule(w, n);
      assert.equal(vlen(r), w, `turnRule(${w}, ${n}) was ${vlen(r)} wide`);
    }
  }
});

test("a turn rule keeps its number whenever the width allows one", () => {
  assert.match(turnRule(40, 7), /7/);
  assert.match(turnRule(5, 1), /1/);
  assert.doesNotMatch(turnRule(3, 1), /1/, "no room for a number at width 3");
});



// A question that failed recorded no turn, so numbering it would claim a turn
// that is not in the transcript.
test("a turn rule with no number is still a full-width boundary", () => {
  const r = turnRule(50);
  assert.equal(vlen(r), 50);
  assert.doesNotMatch(r, /\d/);
  assert.ok(r.includes("━"));
});

// An answer that is only an empty code fence is non-empty text that renders to
// nothing. The speaker label must follow the rendered answer, not the raw one,
// or it stands over nothing.
test("text that renders to nothing is recognised as empty", () => {
  assert.equal(render("```\n```"), "");
  assert.equal(render("   \n\n  "), "");
  assert.notEqual(render("```\ncode\n```"), "");
});

test("a fractional width rounds down rather than overflowing", () => {
  for (const w of [4.9, 10.5, 39.999]) {
    assert.equal(vlen(turnRule(w, 3)), Math.floor(w), `turnRule(${w}, 3)`);
  }
});

// --- code blocks ------------------------------------------------------------

test("a long code line is never truncated", () => {
  const line = "const x = " + "y".repeat(140) + ";";
  const out = renderMarkdown("```js\n" + line + "\n```");
  assert.ok(out.includes(line), "the code line was cut short");
});

test("code lines carry no trailing padding", () => {
  const out = renderMarkdown("```\nshort\na much longer line here\n```");
  for (const l of out.split("\n")) assert.equal(l, l.replace(/\s+$/, ""), `trailing space: ${JSON.stringify(l)}`);
});

test("a code block still marks every line and names its language", () => {
  const out = renderMarkdown("```python\nimport os\nprint(os.getcwd())\n```");
  assert.match(out, /python/);
  assert.match(out, /▕ import os/);
  assert.match(out, /▕ print\(os\.getcwd\(\)\)/);
});

// --- inline code ------------------------------------------------------------
// The backticks used to be replaced by a filled background. With the background
// gone, colour alone would carry the distinction, which NO_COLOR readers do not
// get. This file runs with NO_COLOR set.

test("inline code stays distinguishable without colour", () => {
  assert.equal(inline("use `npm test` now"), "use `npm test` now");
});

test("inline code carries no stray padding spaces", () => {
  assert.doesNotMatch(inline("a `b` c"), /  /, "double space around inline code");
});

test("several inline spans in one line all survive", () => {
  assert.equal(inline("`a` and `b`"), "`a` and `b`");
});

// --- citations and sources ---------------------------------------------------

const SOURCES = [
  { title: "One", url: "https://www.one.example/a" },
  { title: "Two", url: "https://two.example/b" },
  { title: "Three", url: "https://three.example/c" },
];

test("citation markers survive inline rendering and links are left alone", () => {
  assert.equal(stripAnsi(inline("Fact.[1][2]")), "Fact.[1][2]");
  assert.match(stripAnsi(inline("see [1](https://x.example)")), /1 \(https:\/\/x\.example\)/);
});

test("the source list under an answer names only what it cites, by its own numbers", () => {
  const out = stripAnsi(renderSources(SOURCES, "Claim.[3] Another.[1]"));
  assert.match(out, /^Sources/);
  assert.match(out, /1 {2}One {2}https:\/\/www\.one\.example\/a/);
  assert.match(out, /3 {2}Three/);
  assert.doesNotMatch(out, /Two/);
});

test("an answer that cites nothing gets the whole list", () => {
  const out = stripAnsi(renderSources(SOURCES, "No markers here."));
  for (const t of ["One", "Two", "Three"]) assert.match(out, new RegExp(t));
});

test("markers past the end of the list are ignored rather than crashing", () => {
  const out = stripAnsi(renderSources(SOURCES, "Odd.[9] Fine.[2]"));
  assert.match(out, /2 {2}Two/);
  assert.doesNotMatch(out, /\b9\b/);
});

test("an overlong title is cut, and no sources means no list", () => {
  const out = stripAnsi(renderSources([{ title: "x".repeat(200), url: "https://a.example" }]));
  assert.ok(out.split("\n")[1].length < 130);
  assert.equal(renderSources([]), "");
});
