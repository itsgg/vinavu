import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";

const { createStreamRender } = await import("../src/stream.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive the renderer with everything injected.
 *
 * Both sinks also append to one ordered log, because some of what matters here
 * is the order of writes across the two streams (the progress line must be
 * cleared before the answer lands on top of it), which separate buffers cannot
 * show.
 */
function harness(opts: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const log: [("out" | "err"), string][] = [];
  let clock = 0;
  const sr = createStreamRender({
    out: (s) => {
      out.push(s);
      log.push(["out", s]);
    },
    err: (s) => {
      err.push(s);
      log.push(["err", s]);
    },
    width: () => 80,
    now: () => clock,
    ...opts,
  });
  return {
    sr,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    log: () => log,
    tick: (ms: number) => (clock += ms),
    /** True when nothing more is written while real time passes. */
    async settled(ms = 260) {
      const before = err.join("") + out.join("");
      await sleep(ms);
      return err.join("") + out.join("") === before;
    },
  };
}

// --- the speaker label ------------------------------------------------------

test("the label is printed once, above the first block", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("first paragraph\n\n");
  h.sr.push("second paragraph\n\n");
  h.sr.finish("first paragraph\n\nsecond paragraph");
  assert.equal(h.stdout().match(/perplexity/g)?.length, 1);
  assert.match(h.stdout(), /perplexity\nfirst paragraph/);
});

test("no label is printed when none was asked for", () => {
  const h = harness();
  h.sr.push("some text\n\n");
  h.sr.finish("some text");
  assert.doesNotMatch(h.stdout(), /perplexity/);
  assert.match(h.stdout(), /some text/);
});

// An answer that is only an empty code fence is non-empty text that renders to
// nothing, and would leave a speaker label standing over no answer at all.
test("an answer that renders to nothing prints no label", () => {
  const h = harness({ label: "perplexity" });
  h.sr.finish("```\n```");
  assert.equal(h.stdout(), "", `wrote: ${JSON.stringify(h.stdout())}`);
});

test("an answer that is only whitespace prints no label", () => {
  const h = harness({ label: "perplexity" });
  h.sr.finish("   \n\n  ");
  assert.equal(h.stdout(), "");
});

test("an empty fence mid-stream does not trigger the label on its own", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("```\n```\n\n");
  assert.equal(h.stdout(), "");
  h.sr.push("real text\n\n");
  assert.equal(h.stdout().match(/perplexity/g)?.length, 1);
});

// --- blank line arithmetic --------------------------------------------------

test("the label supplies the blank line above the first block", () => {
  const h = harness({ label: "perplexity" });
  h.sr.finish("one line");
  assert.equal(h.stdout(), "\nperplexity\none line\n");
});

test("an unlabelled first block brings its own blank line", () => {
  const h = harness();
  h.sr.finish("one line");
  assert.equal(h.stdout(), "\none line\n");
});

test("later blocks are separated from the ones before them", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("para one\n\n");
  h.sr.push("para two\n\n");
  h.sr.finish("para one\n\npara two");
  assert.equal(h.stdout(), "\nperplexity\npara one\n\npara two\n");
});

// --- reconciling with the authoritative answer ------------------------------

test("a stream that stopped short is topped up with only the missing tail", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("the beginning\n\n");
  h.sr.finish("the beginning\n\nand the end");
  assert.match(h.stdout(), /the beginning/);
  assert.match(h.stdout(), /and the end/);
  assert.equal(h.stdout().match(/the beginning/g)?.length, 1, "the prefix was printed twice");
});

test("a final answer matching the stream adds nothing", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("all of it\n\n");
  h.sr.finish("all of it");
  assert.equal(h.stdout().match(/all of it/g)?.length, 1);
});

test("a final answer that diverges is not printed on top of what was shown", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("what was streamed\n\n");
  h.sr.finish("something else entirely");
  assert.doesNotMatch(h.stdout(), /something else entirely/);
  assert.match(h.stdout(), /what was streamed/);
});

test("an answer that only arrives at the end is still printed", () => {
  const h = harness({ label: "perplexity" });
  h.sr.finish("final only");
  assert.match(h.stdout(), /perplexity\nfinal only/);
});

// --- --json -----------------------------------------------------------------

test("json mode writes nothing at all", () => {
  const h = harness({ label: "perplexity", json: true, ticker: true });
  h.sr.begin();
  h.sr.push("text\n\n");
  h.sr.finish("text");
  assert.equal(h.stdout(), "");
  assert.equal(h.stderr(), "");
});

// --- the progress line ------------------------------------------------------

test("begin acknowledges the question before any content arrives", () => {
  const h = harness({ ticker: true });
  h.sr.begin();
  assert.match(h.stderr(), /thinking…/);
  h.sr.stop();
});

test("nothing is drawn when there is no terminal to draw on", () => {
  const h = harness({ ticker: false });
  h.sr.begin();
  assert.equal(h.stderr(), "");
  h.sr.stop();
});

test("the elapsed count appears only after a wait worth noticing", () => {
  const h = harness({ ticker: true });
  h.sr.begin();
  assert.doesNotMatch(h.stderr(), /\ds/);
  h.tick(2000);
  h.sr.push("");
  assert.match(h.stderr(), /thinking… 2s/);
  h.sr.stop();
});

// The buffer empties every time a block is flushed, so asking whether it holds
// something now would bring the clock back between paragraphs.
test("the elapsed count does not come back once content has arrived", () => {
  const h = harness({ ticker: true });
  h.sr.begin();
  h.tick(3000);
  h.sr.push("a whole paragraph\n\n");
  const after = h.stderr().split("2K").pop() ?? "";
  assert.doesNotMatch(after, /\d+s/, `clock reappeared: ${JSON.stringify(after)}`);
  h.sr.stop();
});

test("the progress line is cleared before the answer is written over it", () => {
  const h = harness({ label: "perplexity", ticker: true });
  h.sr.begin();
  h.sr.push("text\n\n");
  h.sr.stop();
  const log = h.log();
  const firstOut = log.findIndex(([where]) => where === "out");
  assert.ok(firstOut > 0, "nothing was written to stdout");
  // The write immediately before the answer must be the clear and nothing else.
  // Matching on a substring would not do: every progress frame also begins with
  // the clear code, so a frame sitting there would look like a clear.
  const [where, what] = log[firstOut - 1];
  assert.equal(where, "err");
  assert.equal(
    what,
    "\r\x1b[2K",
    "the answer was written over a progress line that was never cleared",
  );
});

test("the animation really is running before these tests claim to stop it", async () => {
  const h = harness({ ticker: true });
  h.sr.begin();
  assert.equal(await h.settled(), false, "nothing is animating, so stopping it proves nothing");
  h.sr.stop();
});

for (const how of ["stop", "finish"] as const) {
  test(`${how} leaves nothing running`, async () => {
    const h = harness({ ticker: true });
    h.sr.begin();
    await sleep(150); // let it draw a few frames
    if (how === "stop") h.sr.stop();
    else h.sr.finish("done");
    assert.ok(await h.settled(), `${how} left the animation running`);
  });
}

// Without the guard, begin() would start a second and third interval, and stop()
// would only ever clear the last one.
test("repeated begins leave only one animation to stop", async () => {
  const h = harness({ ticker: true });
  h.sr.begin();
  h.sr.begin();
  h.sr.begin();
  await sleep(150);
  h.sr.stop();
  assert.ok(await h.settled(), "an extra interval outlived stop()");
});

test("stop is safe without begin, and safe twice", async () => {
  const h = harness({ ticker: true });
  h.sr.stop();
  h.sr.stop();
  assert.ok(await h.settled());
});

// --- what reached the reader ------------------------------------------------
// A failure needs to know whether the reader is already looking at half an
// answer, so it can keep it and say it was cut short.

test("shown reports everything that was printed", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("first paragraph\n\n");
  h.sr.push("second paragraph\n\n");
  assert.equal(h.sr.shown(), "first paragraph\n\nsecond paragraph\n\n");
});

// The reader has seen nothing durable until a block is printed. Deltas still in
// the buffer have only flickered through the progress line, which is cleared.
test("shown is empty while deltas are still buffered", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("half a sentence with no block boundary yet");
  assert.equal(h.stdout(), "", "premise: nothing was printed");
  assert.equal(h.sr.shown(), "");
});

test("shown is empty for content that renders to nothing", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("```\n```\n\n");
  assert.equal(h.stdout(), "", "premise: an empty fence prints nothing");
  assert.equal(h.sr.shown(), "");
});

test("shown is empty before anything arrives", () => {
  const h = harness({ label: "perplexity" });
  assert.equal(h.sr.shown(), "");
  h.sr.begin();
  assert.equal(h.sr.shown(), "");
});

test("shown reports nothing in json mode, where nothing was displayed", () => {
  const h = harness({ label: "perplexity", json: true });
  h.sr.push("text");
  assert.equal(h.sr.shown(), "", "json mode displayed nothing, so nothing was shown");
});

test("shown excludes a tail that was buffered but never printed", () => {
  const h = harness({ label: "perplexity" });
  h.sr.push("first paragraph\n\n");
  h.sr.push("a tail with no boundary yet");
  assert.match(h.stdout(), /first paragraph/);
  assert.doesNotMatch(h.stdout(), /a tail/, "premise: the tail was not printed");
  assert.equal(h.sr.shown(), "first paragraph\n\n");
});

test("the engine's status shows on the progress line until text arrives", () => {
  const h = harness({ ticker: true });
  h.sr.begin();
  h.sr.status("reading 10 sources");
  assert.match(h.stderr(), /reading 10 sources…/);
  h.sr.status("line one\nline two");
  assert.match(h.stderr(), /line one line two…/);
  h.sr.stop();
});
