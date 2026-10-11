import { ESC, T, cols } from "./theme.js";
import { reconcileTail, render, safeCut } from "./render.js";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface StreamOptions {
  /** Name shown once above the first block of the answer. Omitted for one-shot output. */
  label?: string;
  /** --json emits a single object at the end, so nothing may be written before it. */
  json?: boolean;
  /** Whether to animate progress. False for --quiet, and whenever stderr is not a terminal. */
  ticker?: boolean;
  /** Where the answer goes. */
  out?: (s: string) => void;
  /** Where progress goes, kept off `out` so a redirected answer stays clean. */
  err?: (s: string) => void;
  /** Terminal width, read at each draw so a resize is picked up. */
  width?: () => number;
  /** Injectable clock, so tests need not wait for seconds to pass. */
  now?: () => number;
}

export interface StreamRender {
  begin(): void;
  /** What the engine says it is doing, shown on the progress line until text arrives. */
  status(text: string): void;
  push(chunk: string): void;
  finish(content: string): void;
  stop(): void;
  /**
   * The text that actually landed on the screen, so a failure can say what
   * survived. Not the deltas received: text still sitting in the buffer when a
   * question fails has only ever appeared in the progress line, which is
   * transient and gets cleared, and text that renders to nothing was never
   * there at all.
   */
  shown(): string;
}

/**
 * Progressive renderer: prints completed blocks as they stream in, append-only
 * so nothing on screen is ever rewritten, with a progress line below them.
 *
 * Everything it touches is injected. This is the fiddliest logic in the program
 * (a label that must appear exactly once, blank-line arithmetic that differs for
 * the first block, and reconciling the streamed text against the authoritative
 * final answer), and it used to reach straight for process.stdout and a module
 * global, which left it impossible to test.
 */
export function createStreamRender(o: StreamOptions = {}): StreamRender {
  const label = o.label;
  const json = o.json ?? false;
  // --json promises a single object and nothing else, so it silences progress
  // here rather than trusting every caller to have combined the two flags.
  const ticker = (o.ticker ?? false) && !json;
  const out = o.out ?? ((s: string) => process.stdout.write(s));
  const err = o.err ?? ((s: string) => process.stderr.write(s));
  const width = o.width ?? cols;
  const now = o.now ?? Date.now;

  let buf = "";
  let printed = 0;
  let streamed = ""; // every delta received, to reconcile against the final text
  let displayed = ""; // only the part of it that actually reached the screen
  let frame = 0;
  let since = 0;
  let doing = "thinking";
  let beat: NodeJS.Timeout | undefined;
  // Printed once, immediately above the first block of the answer, so the reply
  // is marked by something it has rather than by the absence of a prompt.
  let labelled = false;

  const speaker = () => {
    if (labelled || !label) return;
    labelled = true;
    out("\n" + T.tag(label) + "\n");
  };
  const clearTicker = () => {
    if (ticker) err("\r" + ESC + "2K");
  };
  const stopBeat = () => {
    if (beat) clearInterval(beat);
    beat = undefined;
  };
  const showTicker = () => {
    if (!ticker) return;
    const secs = Math.floor((now() - since) / 1000);
    const tail = buf.replace(/\s+/g, " ").trim();
    // Counted only while nothing has arrived yet, and only once the wait is long
    // enough to wonder about. Answer text arriving is its own evidence of
    // progress. This asks whether anything has ever arrived rather than whether
    // the buffer holds something now: the buffer empties every time a block is
    // flushed, which would bring the clock back between paragraphs.
    const waiting = streamed.trim() === "";
    const elapsed = waiting && secs >= 2 ? ` ${secs}s` : "";
    const glyph = SPIN[frame++ % SPIN.length];
    const room = Math.max(10, width() - 4 - elapsed.length);
    const s = tail.length > room ? "…" + tail.slice(-(room - 1)) : tail || doing + "…";
    err("\r" + ESC + "2K" + T.accent(glyph + " ") + T.muted(s + elapsed));
  };

  /** The blank line above a block. The label already supplies one for the first. */
  const lead = () => (printed === 0 && label ? "" : "\n");

  const flush = (final: boolean) => {
    for (;;) {
      const cut = final ? buf.length : safeCut(buf);
      if (cut <= 0) break;
      const source = buf.slice(0, cut);
      buf = buf.slice(cut);
      const block = render(source);
      if (block) {
        clearTicker();
        speaker();
        out(lead() + block + "\n");
        // The source of a block that was printed, not merely one that was
        // consumed: a fence that renders to nothing reached nobody, and neither
        // did whatever is still sitting in the buffer when a question fails.
        displayed += source;
        printed++;
      }
      if (final) break;
    }
  };

  return {
    /**
     * Acknowledge the question straight away.
     *
     * The progress line used to be redrawn only when a delta arrived, so between
     * pressing Enter and the model's first token the screen showed nothing at
     * all. That gap is routinely five to ten seconds, which reads as a hang
     * rather than as thinking.
     */
    begin() {
      if (!ticker || beat) return;
      since = now();
      showTicker();
      beat = setInterval(showTicker, 100);
      beat.unref?.();
    },
    status(text: string) {
      // One line of the engine's own words, flattened: it lands in the middle
      // of the progress line, where a newline would break the redraw.
      const flat = text.replace(/\s+/g, " ").trim();
      if (flat) doing = flat.slice(0, 60);
      showTicker();
    },
    push(chunk: string) {
      if (json) return;
      streamed += chunk;
      buf += chunk;
      flush(false);
      showTicker();
    },
    finish(content: string) {
      stopBeat();
      if (json) return;
      flush(true);
      clearTicker();
      // No deltas streamed (some responses only carry the final): print it once.
      // Otherwise top up whatever the stream stopped short of.
      const tail = printed === 0 ? (content ?? "").trim() : reconcileTail(streamed, content);
      // Render first, then decide: an answer that is only an empty code fence is
      // non-empty text that renders to nothing, and would otherwise leave a
      // speaker label standing over no answer at all.
      const block = tail.trim() ? render(tail) : "";
      if (block) {
        speaker();
        out(lead() + block + "\n");
        displayed += tail;
        printed++;
      }
    },
    stop() {
      stopBeat();
      clearTicker();
    },
    shown() {
      return displayed;
    },
  };
}
