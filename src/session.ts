import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DIR_MODE, FILE_MODE, SESS_DIR } from "./paths.js";

/** What a follow-up needs to land in the same Perplexity thread. */
export interface Thread {
  backend_uuid: string;
  read_write_token?: string | null;
  slug?: string | null;
}

export interface Source {
  title: string;
  url: string;
}

export interface Turn {
  q: string;
  a: string;
  at: number;
  /** The answer was cut short: what is here is what arrived, not the whole reply. */
  partial?: boolean;
  sources?: Source[];
}

export interface Session {
  name: string;
  thread?: Thread;
  /** Where the thread lives on perplexity.ai. */
  url?: string;
  /** The model this session asks with, unless a question names another. */
  model?: string;
  system?: string; // preamble prepended to each message
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The source numbers an answer cites with its [n] markers, in order of first use. */
export function citedNumbers(answer: string): number[] {
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,3})\](?!\()/g)) seen.add(Number(m[1]));
  return [...seen];
}

/** A thread as stored, or undefined for anything that is not one. */
export function coerceThread(raw: unknown): Thread | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const backend = str(o.backend_uuid);
  if (!backend) return undefined;
  return { backend_uuid: backend, read_write_token: str(o.read_write_token) ?? null, slug: str(o.slug) ?? null };
}

/** Sources as stored: well-formed entries only. */
export function coerceSources(raw: unknown): Source[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .filter((x) => typeof x.url === "string")
    .map((x) => ({ title: typeof x.title === "string" ? x.title : String(x.url), url: x.url as string }));
}

// Deliberately unchanged from the original mapping: altering it would orphan
// sessions saved by earlier versions. Path separators already become "_", so a
// name cannot escape SESS_DIR; a leading dot only makes the file hidden.
export const sessFile = (name: string) =>
  join(SESS_DIR, name.replace(/[^\w.-]/g, "_") + ".json");

export const newSession = (name: string): Session => ({
  name,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: [],
});

/**
 * Accept only files that actually look like a session. A truncated or
 * hand-edited file used to load as `{}` and then blow up later on
 * `session.turns.length`, far from the cause.
 */
function coerce(raw: unknown, fallbackName: string): Session | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.turns !== undefined && !Array.isArray(o.turns)) return null;
  // Validate every field a turn is later used through. A turn with a missing
  // answer used to load fine and then throw from /history (render on undefined)
  // or from export (new Date(undefined).toISOString()).
  const turns = Array.isArray(o.turns)
    ? o.turns.reduce<Turn[]>((acc, t) => {
        if (!t || typeof t !== "object") return acc;
        const r = t as Record<string, unknown>;
        if (typeof r.q !== "string" || typeof r.a !== "string") return acc;
        const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : Date.now();
        const turn: Turn = { q: r.q, a: r.a, at };
        if (r.partial === true) turn.partial = true;
        const sources = coerceSources(r.sources);
        if (sources.length) turn.sources = sources;
        acc.push(turn);
        return acc;
      }, [])
    : [];
  return {
    name: typeof o.name === "string" ? o.name : fallbackName,
    thread: coerceThread(o.thread),
    url: str(o.url),
    model: str(o.model),
    system: typeof o.system === "string" ? o.system : undefined,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
    turns,
  };
}

function readSessionFile(path: string, fallbackName: string): Session | null {
  try {
    return coerce(JSON.parse(readFileSync(path, "utf8")), fallbackName);
  } catch {
    return null;
  }
}

export function loadSession(name: string): Session | null {
  const path = sessFile(name);
  if (!existsSync(path)) return null;
  return readSessionFile(path, name);
}

/**
 * Write via a temp file and rename, so an interrupted write (or two vinavu
 * processes saving the same session) can never leave a half-written JSON file
 * that reads back as a lost conversation.
 */
export function saveSession(s: Session): void {
  mkdirSync(SESS_DIR, { recursive: true, mode: DIR_MODE });
  const path = sessFile(s.name);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: FILE_MODE });
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // the temp file may never have been created
    }
    throw e;
  }
}

function sessionFiles(): string[] {
  try {
    return readdirSync(SESS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Every readable session, newest first. One corrupt file no longer hides the rest. */
export function listSessions(): Session[] {
  return sessionFiles()
    .map((f) => readSessionFile(join(SESS_DIR, f), f.replace(/\.json$/, "")))
    .filter((s): s is Session => s !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function latestSession(): Session | null {
  const byMtime = sessionFiles()
    .map((f) => {
      try {
        return { f, t: statSync(join(SESS_DIR, f)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { f: string; t: number } => x !== null)
    .sort((a, b) => b.t - a.t);
  for (const { f } of byMtime) {
    const s = readSessionFile(join(SESS_DIR, f), f.replace(/\.json$/, ""));
    if (s) return s;
  }
  return null;
}

/** Returns whether a session was actually removed. */
export function forgetSession(name: string): boolean {
  try {
    unlinkSync(sessFile(name));
    return true;
  } catch {
    return false;
  }
}

export function forgetAllSessions(): number {
  let n = 0;
  for (const f of sessionFiles()) {
    try {
      unlinkSync(join(SESS_DIR, f));
      n++;
    } catch {
      // already gone
    }
  }
  return n;
}

/** ISO 8601, or empty for a timestamp that is not a usable date. */
function isoOrBlank(ms: unknown): string {
  const d = new Date(typeof ms === "number" ? ms : NaN);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function exportSessionMarkdown(s: Session): string {
  const updated = isoOrBlank(s.updatedAt);
  const out: string[] = [`# ${s.name}`, ""];
  out.push(
    `*${s.turns.length} turn${s.turns.length === 1 ? "" : "s"}` +
      (updated ? `, last updated ${updated}` : "") +
      "*",
    "",
  );
  if (s.url) out.push(`Thread: ${s.url}`, "");
  if (s.system) out.push(`> System: ${s.system}`, "");
  for (const t of s.turns) {
    const at = isoOrBlank(t.at);
    out.push(`## ${t.q}`, "");
    if (at) out.push(`*${at}*`, "");
    out.push(t.a, "");
    // Said plainly, so a transcript never presents a fragment as a whole answer.
    if (t.partial) out.push("*(this answer was cut short)*", "");
    if (t.sources?.length) {
      // The sources the answer cites, under their own numbers, as on screen.
      const cited = citedNumbers(t.a).filter((n) => n >= 1 && n <= t.sources!.length);
      const numbers = cited.length ? cited.sort((a, b) => a - b) : t.sources.map((_, i) => i + 1);
      out.push("Sources:", "");
      // Not an ordered list: markdown renumbers those, and the numbers must match the [n] markers.
      for (const n of numbers) out.push(`- [${n}] [${t.sources[n - 1].title}](${t.sources[n - 1].url})`);
      out.push("");
    }
  }
  return out.join("\n");
}


// --- cross-process updates --------------------------------------------------

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

/** Block this thread briefly. The critical section is a read and a rename. */
function pause(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable: spin instead, still only for a few ms
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

/**
 * Read, modify and write a session as one step, excluding other vinavu
 * processes.
 *
 * Reading, appending and renaming without a lock loses turns: two processes
 * answering into the same named session can both read the same transcript and
 * then overwrite each other, and a process holding a transcript from before a
 * /retry will happily write the dropped turn back.
 *
 * The lock is an exclusively-created file. One that outlives LOCK_STALE_MS is
 * assumed to belong to a process that died holding it and is broken. If the
 * lock cannot be taken at all, the update still goes ahead: losing the race is
 * better than losing the answer.
 */
export function updateSession(name: string, mutate: (s: Session) => void): Session {
  mkdirSync(SESS_DIR, { recursive: true, mode: DIR_MODE });
  const lock = sessFile(name) + ".lock";
  const deadline = Date.now() + LOCK_WAIT_MS;
  // A token, not just a flag: if this process is suspended long enough for
  // another to break our lock as stale and take its own, releasing on a flag
  // alone would delete theirs.
  const mine = `${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  let held = false;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lock, "wx", FILE_MODE);
      writeFileSync(fd, mine);
      closeSync(fd);
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          // Break it only if the same holder is still there a moment later:
          // otherwise a slow stale check can delete a lock someone just took.
          const before = readFileSync(lock, "utf8");
          pause(20);
          if (readFileSync(lock, "utf8") === before) unlinkSync(lock);
        }
      } catch {
        // it went away on its own, which is just as good
      }
      pause(15);
    }
  }

  try {
    const s = loadSession(name) ?? newSession(name);
    mutate(s);
    s.updatedAt = Date.now();
    saveSession(s);
    return s;
  } finally {
    if (held) {
      try {
        // Only our own lock: another process may have broken ours as stale and
        // be holding one of its own by now.
        if (readFileSync(lock, "utf8") === mine) unlinkSync(lock);
      } catch {
        // already gone, which is the same outcome
      }
    }
  }
}
