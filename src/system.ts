import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { FILE_MODE } from "./paths.js";

const CLIPBOARD_TOOLS: [string, string[]][] = [
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
  ["pbcopy", []],
];

/**
 * Copy text to the system clipboard, returning the helper that took it.
 *
 * stdout and stderr are deliberately not captured. wl-copy forks a background
 * process to serve the selection, and that child inherits any captured pipe, so
 * spawnSync waits on a pipe that never closes and the REPL hangs forever. The
 * timeout is a second line of defence for other tools that behave the same way.
 */
export function clipboardCopy(text: string, tools = CLIPBOARD_TOOLS): string | null {
  for (const [cmd, args] of tools) {
    const r = spawnSync(cmd, args, {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5000,
    });
    if (!r.error && r.status === 0) return cmd;
  }
  return null;
}

/** Open $EDITOR on a scratch file and return what was written, or null. */
export function editorCompose(initial = ""): string | null {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) return null;
  const file = join(tmpdir(), `vinavu-${process.pid}-${Date.now()}.md`);
  writeFileSync(file, initial, { mode: FILE_MODE });
  try {
    const r = spawnSync(editor, [file], { stdio: "inherit", shell: true });
    if (r.error || r.status !== 0) return null;
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // best effort
    }
  }
}
