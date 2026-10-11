import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { homedir } from "node:os";

// A single attachment is truncated at MAX_FILE_CHARS; the attachments together
// are capped at MAX_TOTAL_CHARS so `-f *.log` cannot build a 50 MB prompt that
// the upstream API will only reject after a long upload.
export const MAX_FILE_CHARS = 100_000;
export const MAX_TOTAL_CHARS = 400_000;

/**
 * Collapse untrusted text to a single bounded line.
 *
 * Whatever the service puts in an error field is going to be printed in the
 * user's terminal, so it arrives with its control characters removed, its
 * newlines flattened and its length capped: an error is a line, not a payload.
 */
export function oneLine(s: string, max = 200): string {
  const flat = s
    // C0 and C1 controls, then the invisible characters that reorder or hide
    // what follows them: a right-to-left override in an error message can make
    // the rest of the line read backwards in the terminal.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(flat, max);
}

/**
 * Cut to `max` user-perceived characters.
 *
 * Segmented by grapheme, not by code unit or code point, so the cut can fall
 * neither between the halves of a surrogate pair nor between a letter and the
 * accent that belongs to it.
 */
function truncate(s: string, max: number): string {
  let units: string[];
  try {
    units = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map(
      (g) => g.segment,
    );
  } catch {
    units = [...s]; // no Segmenter: code points still never split a pair
  }
  return units.length > max ? units.slice(0, max - 1).join("") + "…" : s;
}

// Files Perplexity reads itself, uploaded as attachments rather than pasted
// into the question. Everything else is read as text and folded in.
const UPLOADED = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Split attachments into those to upload and those to fold into the question as text. */
export function splitAttachments(files: string[]): { upload: string[]; inline: string[] } {
  const upload: string[] = [];
  const inline: string[] = [];
  for (const f of files) (UPLOADED.has(extname(f).toLowerCase()) ? upload : inline).push(f);
  return { upload, inline };
}

/**
 * Build the outgoing message: an optional system preamble, any text files as
 * fenced blocks, then the question.
 */
export function buildMessage(question: string, files: string[], system?: string): string {
  let prefix = "";
  if (system && system.trim()) prefix += system.trim() + "\n\n";
  let budget = MAX_TOTAL_CHARS;
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      throw new Error(`cannot read file: ${f}`);
    }
    const room = Math.min(MAX_FILE_CHARS, budget);
    if (room <= 0) {
      prefix += `File: ${basename(f)}\n(omitted: attachment budget exhausted)\n\n`;
      continue;
    }
    if (content.length > room) content = content.slice(0, room) + "\n...(truncated)";
    budget -= content.length;
    prefix += `File: ${basename(f)}\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }
  return prefix + question;
}

/** Pull @path tokens out of a REPL line and treat existing ones as attachments. */
export function extractAtFiles(line: string): { text: string; files: string[] } {
  const files: string[] = [];
  const text = line
    .replace(/(^|\s)@(\S+)/g, (m, pre, path) => {
      const p = path.replace(/^~(?=\/|$)/, homedir());
      if (existsSync(p)) {
        files.push(p);
        return pre;
      }
      return m;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { text, files };
}
