import {
  T,
  bold,
  colorEnabled,
  hyperlinksEnabled,
  italic,
  cols,
  vlen,
  renderLink,
} from "./theme.js";
import { citedNumbers, type Source } from "./session.js";

export { stripAnsi, vlen } from "./theme.js";

// Model output is untrusted input: it can be enormous and oddly shaped, so
// every width computation here avoids Math.max(...array) (which throws
// RangeError past ~100k elements) and every wrap loop has a floor.
export const maxOf = (xs: number[], seed = 0) => xs.reduce((a, b) => (b > a ? b : a), seed);

// --- inline ----------------------------------------------------------------

export function inline(s: string): string {
  const spans: string[] = [];
  const stash = (v: string) => `\x00${spans.push(v) - 1}\x00`;
  // Colour marks inline code when there is colour; the backticks stay when there
  // is not, because a reader with NO_COLOR set should still be able to tell a
  // command from the prose around it. There used to be a filled background here
  // and the padding spaces that squared it off, which without the fill were just
  // stray spaces in the middle of a sentence.
  s = s.replace(/`([^`]+)`/g, (_, c) => stash(colorEnabled() ? T.code(c) : "`" + c + "`"));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => stash(renderLink(u, t)));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)\]]+)/g, (_, pre, u) => pre + stash(renderLink(u, u)));
  // Perplexity's citation markers, [1], recede: they point at the source list
  // printed under the answer, and at full strength they clutter every sentence.
  s = s.replace(/\[(\d{1,3})\](?!\()/g, (_, n) => stash(T.muted(`[${n}]`)));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t));
  s = s.replace(/__([^_]+)__/g, (_, t) => bold(t));
  s = s.replace(/\*([^*\n]+)\*/g, (_, t) => italic(t));
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, (_, pre, t) => pre + italic(t));
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => spans[+i] ?? "");
  return s;
}

export function wrapPlain(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width) || 1);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let cur = "";
    for (let word of words) {
      while (word.length > w) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        out.push(word.slice(0, w));
        word = word.slice(w);
      }
      if (cur && cur.length + 1 + word.length > w) {
        out.push(cur);
        cur = word;
      } else {
        cur = cur ? cur + " " + word : word;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

// --- tables ----------------------------------------------------------------

type Align = "left" | "right" | "center";

function padCell(styled: string, width: number, align: Align): string {
  const gap = Math.max(0, width - vlen(styled));
  if (align === "right") return " ".repeat(gap) + styled;
  if (align === "center") {
    const l = gap >> 1;
    return " ".repeat(l) + styled + " ".repeat(gap - l);
  }
  return styled + " ".repeat(gap);
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function renderTable(rows: string[][], aligns: Align[]): string {
  const ncol = maxOf(rows.map((r) => r.length), 1);
  const padded = rows.map((r) => {
    const c = r.slice();
    while (c.length < ncol) c.push("");
    return c;
  });
  const align = (i: number): Align => aligns[i] ?? "left";

  const widths = Array.from({ length: ncol }, (_, i) =>
    maxOf(
      padded.map((r) => vlen(r[i])),
      3,
    ),
  );
  const budget = Math.min(cols(), 118) - (ncol * 3 + 1);
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    const widest = maxOf(widths);
    const i = widths.indexOf(widest);
    if (widths[i] <= 6) break;
    widths[i]--;
    total--;
  }

  const seg = (w: number) => "─".repeat(w + 2);
  const top = T.muted("╭" + widths.map(seg).join("┬") + "╮");
  const mid = T.muted("├" + widths.map(seg).join("┼") + "┤");
  const bot = T.muted("╰" + widths.map(seg).join("┴") + "╯");
  const bar = T.muted("│");

  // Cells are styled by the table (header bold); strip emphasis markers so a
  // *span* that wraps across cell lines doesn't leave literal * or ** behind.
  const stripBold = (s: string) => s.replace(/\*+/g, "").replace(/__/g, "");
  const drawRow = (cells: string[], header: boolean) => {
    const wrapped = cells.map((c, i) => wrapPlain(stripBold(c), widths[i]));
    const height = maxOf(wrapped.map((w) => w.length), 1);
    const lines: string[] = [];
    for (let li = 0; li < height; li++) {
      const parts = wrapped.map((w, i) => {
        const raw = w[li] ?? "";
        const styled = header ? bold(T.h2(inline(raw))) : inline(raw);
        return " " + padCell(styled, widths[i], align(i)) + " ";
      });
      lines.push(bar + parts.join(bar) + bar);
    }
    return lines.join("\n");
  };

  const out = [top, drawRow(padded[0], true), mid];
  for (const r of padded.slice(1)) out.push(drawRow(r, false));
  out.push(bot);
  return out.join("\n");
}

function renderTableFromMd(tbl: string[]): string {
  const header = splitRow(tbl[0]);
  const aligns: Align[] = splitRow(tbl[1]).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : "left";
  });
  const body = tbl.slice(2).map(splitRow);
  return renderTable([header, ...body], aligns);
}

// --- code blocks -----------------------------------------------------------

function renderCodeBlock(code: string[], lang: string): string {
  const out: string[] = [];
  if (lang) out.push("  " + T.muted(lang));
  const barCh = T.muted("▕");
  // No padding and no truncation. Both existed to make a filled background
  // rectangle look tidy, and the fill is gone; padding only added trailing
  // whitespace to anything copied out, and truncation silently ate the end of
  // any code line past the block width, which is the one thing a code block
  // must never do.
  for (const l of code) out.push("  " + barCh + T.code(" " + l));
  return out.join("\n");
}

// --- markdown --------------------------------------------------------------

export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(renderCodeBlock(code, fence[1]));
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      lines[i + 1].includes("|") &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])
    ) {
      const tbl: string[] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "")
        tbl.push(lines[i++]);
      out.push(renderTableFromMd(tbl));
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(T.muted("─".repeat(Math.min(cols(), 60))));
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const txt = inline(h[2]);
      if (h[1].length === 1) {
        out.push("", T.h1(bold(txt)), T.muted("─".repeat(Math.min(cols(), vlen(txt) + 4))));
      } else if (h[1].length === 2) {
        out.push("", T.h2(bold(txt)));
      } else {
        out.push(bold(txt));
      }
      i++;
      continue;
    }

    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) {
      out.push(T.accent("▏ ") + T.muted(italic(inline(bq[1]))));
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(bullet[1] + T.accent("•") + " " + inline(bullet[2]));
      i++;
      continue;
    }

    const num = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (num) {
      out.push(num[1] + T.accent(num[2] + ".") + " " + inline(num[3]));
      i++;
      continue;
    }

    out.push(inline(line));
    i++;
  }
  return out.join("\n");
}

export function render(text: string): string {
  return renderMarkdown(text).replace(/\n{3,}/g, "\n\n").trim();
}

// --- sources ---------------------------------------------------------------

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const MAX_TITLE = 80;

/**
 * The numbered source list printed under an answer, matching its [n] markers.
 *
 * Given the answer, it lists only the sources the answer cites, under their
 * own numbers: Perplexity reads ten pages and usually cites three, and the
 * other seven are noise under a short answer. An answer that cites nothing
 * gets the whole list.
 *
 * With OSC 8 the title is the link and the host is enough to judge it by;
 * without, the URL is printed whole, since it is the only way to reach it.
 */
export function renderSources(sources: Source[], answer?: string): string {
  if (!sources.length) return "";
  let numbers = sources.map((_, i) => i + 1);
  if (answer !== undefined) {
    const cited = citedNumbers(answer).filter((n) => n >= 1 && n <= sources.length);
    if (cited.length) numbers = cited.sort((a, b) => a - b);
  }
  const width = String(Math.max(...numbers)).length;
  const lines = [T.muted("Sources")];
  for (const n of numbers) {
    const s = sources[n - 1];
    const label = T.muted(`${String(n).padStart(width)}  `);
    let title = (s.title || hostOf(s.url) || s.url).replace(/\s+/g, " ").trim();
    if ([...title].length > MAX_TITLE) title = [...title].slice(0, MAX_TITLE - 1).join("") + "…";
    if (hyperlinksEnabled()) lines.push(label + renderLink(s.url, title) + T.muted("  " + hostOf(s.url)));
    else lines.push(label + title + T.muted("  " + s.url));
  }
  return lines.join("\n");
}

/** The cited sources as a Markdown list, for --markdown: numbered as the answer's markers. */
export function markdownSources(sources: Source[], answer: string): string {
  if (!sources.length) return "";
  const cited = citedNumbers(answer).filter((n) => n >= 1 && n <= sources.length);
  const numbers = cited.length ? cited.sort((a, b) => a - b) : sources.map((_, i) => i + 1);
  const lines = numbers.map((n) => `- [${n}] ${markdownLink(sources[n - 1])}`);
  return "Sources:\n\n" + lines.join("\n");
}

/**
 * One source as a Markdown link, safe whatever the page called itself.
 *
 * The title loses what would end or escape the link's text (brackets, a
 * backslash) and every Markdown mark; the address goes in angle brackets,
 * which CommonMark reads whole, parentheses and all, with what may not be
 * inside them percent-encoded. Only http and https are linked: another
 * scheme is shown as text, not offered as a link to follow.
 */
export function markdownLink(s: Source): string {
  const title = s.title.replace(/[\[\]\\`*_<>]/g, "").replace(/\s+/g, " ").trim();
  let url: URL | null = null;
  try {
    url = new URL(s.url);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    return (title || "Untitled source").replace(/^\s*$/, "Untitled source");
  const href = url.href.replace(/[<>\s]/g, (c) => encodeURIComponent(c));
  return `[${title || url.hostname}](<${href}>)`;
}

// --- streaming boundaries --------------------------------------------------

/**
 * Largest prefix of `buf` that ends at a completed top-level block boundary (a
 * blank line or a closed code fence), so a half-finished block is never
 * rendered. Blank lines inside fences don't count. Returns 0 when nothing is
 * safely renderable yet.
 */
export function safeCut(buf: string): number {
  const lines = buf.split("\n");
  let inFence = false;
  let pos = 0;
  let cut = 0;
  for (let k = 0; k < lines.length - 1; k++) {
    // exclude the last (possibly partial) line
    const line = lines[k];
    pos += line.length + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (!inFence) cut = pos;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") cut = pos;
  }
  return cut;
}

/**
 * What still needs printing after a streamed answer finishes.
 *
 * The engine's final event carries the authoritative answer, while the deltas
 * are what actually reached the screen. When a delta is dropped or the stream ends
 * mid-answer the two diverge, and the terminal is left holding a truncated
 * answer. Only a clean prefix match is topped up: if the final text is not an
 * extension of what was shown, reprinting it would duplicate the answer, so the
 * streamed version is left alone.
 *
 * The tail is rendered on its own, so a markdown construct split across the
 * boundary (`**hel` then `lo**`) renders as literal text. That only arises on
 * an already-degraded path, where the alternative is showing a truncated
 * answer, so the missing words win over the missing emphasis.
 */
export function reconcileTail(streamed: string, full: string): string {
  const shown = streamed.trim();
  const complete = (full ?? "").trim();
  if (!complete) return "";
  if (!shown) return complete;
  if (complete === shown || !complete.startsWith(shown)) return "";
  return complete.slice(shown.length);
}

/**
 * The line that closes a conversation turn.
 *
 * Deliberately unlike the rule renderMarkdown draws for a `---` inside an
 * answer: heavier (U+2501 against U+2500) and full width against that rule's
 * 60. They used to be the same glyph at similar widths, so the strongest
 * horizontal line on screen marked a place that was not a turn boundary at all.
 */
export function turnRule(width: number, n?: number): string {
  const w = Math.max(0, Math.floor(width) || 0);
  // Give up the number, then the leading dashes, rather than overflow: a rule
  // wider than the terminal wraps and stops looking like a boundary at all.
  let label = n === undefined ? "" : ` ${n} `;
  if (label.length + 1 > w) label = "";
  const lead = Math.min(3, Math.max(0, w - label.length));
  const tail = Math.max(0, w - lead - label.length);
  return T.muted("━".repeat(lead)) + (label ? T.tag(label) : "") + T.muted("━".repeat(tail));
}
