import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { clipboardCopy, editorCompose } = await import("../src/system.js");

const bin = mkdtempSync(join(tmpdir(), "vinavu-bin-"));

/** Write a throwaway executable and return its path. */
function fakeTool(name: string, body: string): string {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

test("clipboardCopy hands the text to the first helper that works", () => {
  const out = join(bin, "clip.txt");
  const tool = fakeTool("faux-copy", `cat > "${out}"`);
  assert.equal(clipboardCopy("the answer", [[tool, []]]), tool);
  assert.equal(readFileSync(out, "utf8"), "the answer");
});

test("clipboardCopy falls through a helper that is missing or fails", () => {
  const out = join(bin, "clip2.txt");
  const good = fakeTool("faux-copy-2", `cat > "${out}"`);
  const failing = fakeTool("faux-fail", "exit 3");
  const chosen = clipboardCopy("second try", [
    ["definitely-not-installed-xyz", []],
    [failing, []],
    [good, []],
  ]);
  assert.equal(chosen, good);
  assert.equal(readFileSync(out, "utf8"), "second try");
});

test("clipboardCopy returns null when nothing can take the text", () => {
  assert.equal(clipboardCopy("x", [["definitely-not-installed-xyz", []]]), null);
});

// wl-copy forks a background process to own the selection. If stdout is
// captured, that child inherits the pipe, so spawnSync blocks on a pipe that
// never closes and the REPL hangs. This is exactly that shape.
test("clipboardCopy does not hang on a helper that forks and holds stdout", () => {
  const out = join(bin, "clip3.txt");
  const forking = fakeTool(
    "faux-forking-copy",
    `cat > "${out}"\n( sleep 30 ) &\nexit 0`,
  );
  const t0 = Date.now();
  assert.equal(clipboardCopy("no hang", [[forking, []]]), forking);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 4000, `clipboardCopy took ${elapsed}ms, it is waiting on the forked child`);
  assert.equal(readFileSync(out, "utf8"), "no hang");
});

test("editorCompose returns null when no editor is configured", () => {
  const { EDITOR, VISUAL } = process.env;
  delete process.env.EDITOR;
  delete process.env.VISUAL;
  try {
    assert.equal(editorCompose("draft"), null);
  } finally {
    if (EDITOR) process.env.EDITOR = EDITOR;
    if (VISUAL) process.env.VISUAL = VISUAL;
  }
});

test("editorCompose returns what the editor wrote and cleans up the scratch file", () => {
  const seen = join(bin, "seen.txt");
  const editor = fakeTool("faux-editor", `cp "$1" "${seen}"\nprintf 'edited text' > "$1"`);
  const prev = process.env.EDITOR;
  process.env.EDITOR = editor;
  try {
    assert.equal(editorCompose("initial draft"), "edited text");
    assert.equal(readFileSync(seen, "utf8"), "initial draft");
  } finally {
    if (prev) process.env.EDITOR = prev;
    else delete process.env.EDITOR;
  }
});

test("editorCompose treats a non-zero editor exit as a cancelled message", () => {
  const editor = fakeTool("faux-editor-abort", "exit 1");
  const prev = process.env.EDITOR;
  process.env.EDITOR = editor;
  try {
    assert.equal(editorCompose("draft"), null);
  } finally {
    if (prev) process.env.EDITOR = prev;
    else delete process.env.EDITOR;
  }
});
