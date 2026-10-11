import { test } from "node:test";
import assert from "node:assert/strict";

const { parseArgs } = await import("../src/args.js");

test("a bare question becomes the question", () => {
  assert.equal(parseArgs(["what", "is", "dharma"]).question, "what is dharma");
});

test("flags are stripped from the question", () => {
  const o = parseArgs(["-s", "work", "hello", "there"]);
  assert.equal(o.session, "work");
  assert.equal(o.question, "hello there");
});

test("repeated -f collects every file", () => {
  assert.deepEqual(parseArgs(["-f", "a.txt", "-f", "b.txt", "q"]).files, ["a.txt", "b.txt"]);
});

test("boolean flags set their fields", () => {
  const o = parseArgs(["-c", "--new", "-i", "--raw", "--json", "--quiet"]);
  assert.equal(o.cont, true);
  assert.equal(o.fresh, true);
  assert.equal(o.interactive, true);
  assert.equal(o.raw, true);
  assert.equal(o.json, true);
  assert.equal(o.quiet, true);
});

test("long and short forms agree", () => {
  assert.deepEqual(parseArgs(["--session", "x"]), parseArgs(["-s", "x"]));
  assert.deepEqual(parseArgs(["--file", "x"]), parseArgs(["-f", "x"]));
  assert.deepEqual(parseArgs(["--system", "x"]), parseArgs(["-y", "x"]));
});

test("a flag missing its value is an error, not a silently swallowed next flag", () => {
  assert.throws(() => parseArgs(["-s"]), /--session needs a value/);
  assert.throws(() => parseArgs(["-f"]), /--file needs a value/);
  assert.throws(() => parseArgs(["-y"]), /--system needs a value/);
  assert.throws(() => parseArgs(["--timeout"]), /--timeout needs a value/);
});

test("a flag followed by another flag does not eat it", () => {
  assert.throws(() => parseArgs(["-s", "--raw"]), /--session needs a value/);
});

test("--timeout parses to seconds and rejects nonsense", () => {
  assert.equal(parseArgs(["--timeout", "45"]).timeout, 45);
  assert.throws(() => parseArgs(["--timeout", "abc"]), /positive number/);
  assert.throws(() => parseArgs(["--timeout", "-3"]), /positive number/);
});

test("an unknown long flag is rejected rather than treated as the question", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown option: --nope/);
});

test("everything after -- is question text, even if it looks like a flag", () => {
  assert.equal(parseArgs(["--", "--raw", "is", "a", "flag"]).question, "--raw is a flag");
});

test("a lone hyphen is question text, not a flag", () => {
  assert.equal(parseArgs(["-"]).question, "-");
});

test("help and version are recognised in both forms", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-V"]).version, true);
  assert.equal(parseArgs(["--version"]).version, true);
});

test("--model takes a name and --research is shorthand for it", () => {
  assert.equal(parseArgs(["-m", "sonar", "q"]).model, "sonar");
  assert.equal(parseArgs(["--model", "anthropic/claude-opus-4.7", "q"]).model, "anthropic/claude-opus-4.7");
  assert.equal(parseArgs(["-r", "q"]).model, "research");
  assert.equal(parseArgs(["q"]).model, undefined);
});

test("--model without a name is a usage error", () => {
  assert.throws(() => parseArgs(["-m"]), /--model needs a value/);
});

test("--no-sources is a flag, not part of the question", () => {
  const o = parseArgs(["--no-sources", "what", "is", "uv"]);
  assert.equal(o.noSources, true);
  assert.equal(o.question, "what is uv");
});
