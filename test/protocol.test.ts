import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildMessage, extractAtFiles, oneLine, splitAttachments, MAX_FILE_CHARS, MAX_TOTAL_CHARS } =
  await import("../src/protocol.js");

test("buildMessage passes a bare question straight through", () => {
  assert.equal(buildMessage("hello", []), "hello");
});

test("buildMessage puts the system preamble first", () => {
  const out = buildMessage("q", [], "be terse");
  assert.ok(out.startsWith("be terse"));
  assert.ok(out.endsWith("q"));
});

test("buildMessage ignores a blank system preamble", () => {
  assert.equal(buildMessage("q", [], "   "), "q");
});

test("buildMessage fences attachments and names them", () => {
  const dir = mkdtempSync(join(tmpdir(), "vinavu-"));
  const f = join(dir, "notes.txt");
  writeFileSync(f, "file body");
  const out = buildMessage("q", [f]);
  assert.match(out, /File: notes\.txt/);
  assert.match(out, /```\nfile body\n```/);
  assert.ok(out.endsWith("q"));
});

test("buildMessage truncates a single oversized attachment", () => {
  const dir = mkdtempSync(join(tmpdir(), "vinavu-"));
  const f = join(dir, "big.txt");
  writeFileSync(f, "z".repeat(MAX_FILE_CHARS + 5000));
  const out = buildMessage("q", [f]);
  assert.match(out, /truncated/);
  assert.ok(out.length < MAX_FILE_CHARS + 5000);
});

test("buildMessage caps the combined size of many attachments", () => {
  const dir = mkdtempSync(join(tmpdir(), "vinavu-"));
  const files = Array.from({ length: 12 }, (_, i) => {
    const f = join(dir, `f${i}.txt`);
    writeFileSync(f, "y".repeat(MAX_FILE_CHARS));
    return f;
  });
  const out = buildMessage("q", files);
  assert.ok(out.length <= MAX_TOTAL_CHARS + 2000, `message was ${out.length} chars`);
});

test("buildMessage reports the path of an unreadable attachment", () => {
  assert.throws(() => buildMessage("q", ["/no/such/file"]), /cannot read file: \/no\/such\/file/);
});

test("extractAtFiles pulls out @paths that exist and leaves the rest alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "vinavu-"));
  const f = join(dir, "real.txt");
  writeFileSync(f, "x");
  const { text, files } = extractAtFiles(`look at @${f} please`);
  assert.deepEqual(files, [f]);
  assert.equal(text, "look at please");
});

test("extractAtFiles leaves a non-existent @token in the text", () => {
  const { text, files } = extractAtFiles("email me @someone about it");
  assert.deepEqual(files, []);
  assert.equal(text, "email me @someone about it");
});

test("extractAtFiles expands a leading tilde", () => {
  const { files } = extractAtFiles("@~/definitely-not-here-xyz");
  assert.deepEqual(files, []);
});

test("PDFs and images are uploaded, anything else is folded in as text", () => {
  const { upload, inline } = splitAttachments(["a.pdf", "b.PNG", "notes.md", "c.jpeg", "log", "d.webp"]);
  assert.deepEqual(upload, ["a.pdf", "b.PNG", "c.jpeg", "d.webp"]);
  assert.deepEqual(inline, ["notes.md", "log"]);
});

// --- untrusted text in a terminal -------------------------------------------
// Whatever the engine relays from Perplexity in an error is printed in the
// user's terminal, so it is treated as untrusted text rather than a message.

test("an error is flattened to a single line with no control characters", () => {
  const esc = String.fromCharCode(27);
  const m = oneLine("line one" + String.fromCharCode(10) + "line two" + String.fromCharCode(9) + "tab" + esc + "[31m");
  assert.doesNotMatch(m, /[\n\r]/, "a newline reached the terminal");
  assert.ok(!m.includes(esc), "an escape sequence reached the terminal");
  assert.equal(m, "line one line two tab [31m");
});

test("an oversized error is capped", () => {
  const m = oneLine("x".repeat(5000));
  assert.ok(m.length <= 200, `message was ${m.length} chars`);
});

// Invisible characters that reorder or hide what follows them: an error message
// is printed straight into a terminal, so it must not be able to rearrange it.
test("bidi overrides and zero-width characters are removed from an error", () => {
  const rlo = String.fromCharCode(0x202e);
  const zwsp = String.fromCharCode(0x200b);
  const ls = String.fromCharCode(0x2028);
  assert.equal(oneLine("safe" + rlo + "text"), "safetext");
  assert.equal(oneLine("a" + zwsp + "b"), "ab");
  assert.equal(oneLine("one" + ls + "two"), "one two");
});

test("capping an error never splits a character in half", () => {
  const m = oneLine("\u{1F600}".repeat(300));
  assert.ok([...m].length <= 200);
  const withoutPairs = m.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
  assert.doesNotMatch(withoutPairs, /[\uD800-\uDFFF]/, "a half character survived the cap");
});

// A cut that falls between a letter and its accent produces a different letter.
test("capping never separates a character from its accent", () => {
  const accented = "e" + String.fromCharCode(0x0301); // e + combining acute
  assert.equal(oneLine(accented.repeat(300)), accented.repeat(199) + "…");
});
