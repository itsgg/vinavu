import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { oneLine } from "./protocol.js";
import { coerceSources, coerceThread, type Source, type Thread } from "./session.js";

// The engine is a Python process (vinavu-engine) that holds the Perplexity
// session. Each question runs `vinavu-engine ask`: one JSON request on its
// stdin, one JSON event per line on its stdout. A process per question costs
// about half a second against answers that take five to fifteen, and it means
// there is no daemon to start, find, outlive or restart.

/** An inactivity deadline: reset by every line the engine writes. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.VINAVU_TIMEOUT_MS) || 180_000;
/** Deep Research goes quiet for minutes at a time, by design. */
export const RESEARCH_TIMEOUT_MS = 30 * 60_000;

export interface AskRequest {
  query: string;
  model?: string;
  thread?: Thread;
  /** Absolute paths of files for Perplexity to read (PDFs, images). */
  files?: string[];
}

export interface Answer {
  content: string;
  model?: string;
  thread?: Thread;
  sources: Source[];
  url?: string;
}

export interface Hooks {
  onDelta?: (piece: string) => void;
  onStatus?: (text: string) => void;
  onSources?: (items: Source[]) => void;
}

export type AskFn = (req: AskRequest, hooks: Hooks) => Promise<Answer>;

/** A question the engine could not answer, with the engine's kind of failure. */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly kind = "engine",
  ) {
    super(message);
  }
}

/** The command that runs the engine: VINAVU_ENGINE (split on spaces), else vinavu-engine. */
export function engineCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.VINAVU_ENGINE?.trim();
  return raw ? raw.split(/\s+/) : ["vinavu-engine"];
}

export const isResearch = (model?: string) =>
  !!model && /^(research|deep|perplexity\/deep-research)$/i.test(model.trim());

/**
 * Newline-delimited JSON from a stream. A read can split one line across
 * chunks or carry several at once, and a chunk boundary can fall inside a
 * multi-byte character, so lines are cut from a stateful decoder's output.
 */
export function createLineReader(onLine: (line: string) => void, maxChars = 8 * 1024 * 1024) {
  let buf = "";
  const decoder = new StringDecoder("utf8");
  return (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (buf.length > maxChars) {
      buf = "";
      throw new Error("line too long");
    }
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  };
}

/** How long an engine may linger: after its answer, and after SIGTERM. */
export interface Reaping {
  graceMs: number;
  killMs: number;
}
const REAPING: Reaping = { graceMs: 2000, killMs: 2000 };

/** Ask one question through `<cmd> ask`. */
export function askEngine(
  req: AskRequest,
  hooks: Hooks = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cmd: string[] = engineCommand(),
  reaping: Reaping = REAPING,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd[0], [...cmd.slice(1), "ask"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(new EngineError(`could not start the engine: ${(e as Error).message}`, "missing"));
      return;
    }
    let settled = false;
    let stderr = "";
    const running = () => child.exitCode === null && child.signalCode === null;

    // No engine outlives its question. One that lingers after answering gets
    // a grace period to exit on its own, one that is abandoned gets SIGTERM at
    // once, and either gets SIGKILL if SIGTERM is not enough. The timers are
    // unref'd, so they never hold the CLI open by themselves, and a CLI that
    // exits first (process.exit on an error, /exit in the REPL) takes the
    // engine with it.
    const term = () => {
      if (!running()) return;
      child.kill("SIGTERM");
      setTimeout(() => running() && child.kill("SIGKILL"), reaping.killMs).unref();
    };
    const reap = (graceMs: number) => {
      if (graceMs <= 0) term();
      else setTimeout(term, graceMs).unref();
    };
    const onExit = () => {
      if (running()) child.kill("SIGKILL");
    };
    process.on("exit", onExit);
    child.on("close", () => process.off("exit", onExit));

    const settle = (fn: () => void, graceMs: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      reap(graceMs);
    };
    // Nobody is waiting for the rest of this answer any more.
    const fail = (e: EngineError) => settle(() => reject(e), 0);

    let timer: NodeJS.Timeout;
    const arm = () => {
      clearTimeout(timer);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0)
        timer = setTimeout(() => fail(new EngineError("the answer took too long", "timeout")), timeoutMs);
    };
    arm();

    const read = createLineReader((line) => {
      arm();
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        return; // not ours: the engine writes nothing else to stdout
      }
      switch (m.t) {
        case "status":
          if (typeof m.text === "string") hooks.onStatus?.(m.text);
          break;
        case "sources":
          hooks.onSources?.(coerceSources(m.items));
          break;
        case "d":
          if (typeof m.d === "string") hooks.onDelta?.(m.d);
          break;
        case "done":
          settle(
            () =>
              resolve({
                content: typeof m.content === "string" ? m.content : "",
                model: typeof m.model === "string" ? m.model : undefined,
                thread: coerceThread(m.thread),
                sources: coerceSources(m.sources),
                url: typeof m.url === "string" && m.url ? m.url : undefined,
              }),
            reaping.graceMs,
          );
          break;
        case "err":
          fail(
            new EngineError(
              oneLine(typeof m.error === "string" ? m.error : "the engine failed"),
              typeof m.kind === "string" ? m.kind : "engine",
            ),
          );
          break;
      }
    });

    child.stdout!.on("data", (d) => {
      try {
        read(d);
      } catch (e) {
        fail(new EngineError((e as Error).message));
      }
    });
    child.stderr!.on("data", (d) => {
      // Kept for the failure message, bounded: a traceback, not a flood.
      stderr = (stderr + d.toString()).slice(-8192);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      // A child that never started may never close either.
      if (child.pid === undefined) process.off("exit", onExit);
      const missing = e.code === "ENOENT";
      fail(
        new EngineError(
          missing
            ? `${cmd[0]} was not found: install the engine (make install) or set VINAVU_ENGINE`
            : `could not start the engine: ${e.message}`,
          missing ? "missing" : "engine",
        ),
      );
    });
    child.on("close", (code, signal) => {
      // The stream may still hold a final line when the process is gone.
      const last = stderr.trim().split("\n").pop() ?? "";
      const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      fail(new EngineError(`the engine ${how}${last ? `: ${oneLine(last)}` : ""}`));
    });
    child.stdin!.on("error", () => {
      // An engine that exits before reading its request is reported by close.
    });
    child.stdin!.end(JSON.stringify(req));
  });
}
