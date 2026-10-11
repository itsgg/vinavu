#!/usr/bin/env node
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";

import { parseArgs, UsageError, type Opts } from "./args.js";
import { DIR_MODE, FILE_MODE, HOME, SESS_DIR } from "./paths.js";
import { ESC, T, bold, cols, promptMark, setPlain } from "./theme.js";
import { markdownSources, render, renderSources, turnRule } from "./render.js";
import { createPassThrough, createStreamRender } from "./stream.js";
import { buildMessage, extractAtFiles, splitAttachments } from "./protocol.js";
import {
  exportSessionMarkdown,
  forgetAllSessions,
  forgetSession,
  latestSession,
  listSessions,
  loadSession,
  newSession,
  updateSession,
  type Session,
  type Source,
} from "./session.js";
import {
  DEFAULT_TIMEOUT_MS,
  RESEARCH_TIMEOUT_MS,
  askEngine,
  engineCommand,
  isResearch,
  type Answer,
  type AskFn,
} from "./engine.js";
import { clipboardCopy, editorCompose } from "./system.js";
import { VERSION } from "./version.js";

/** An answer, plus the turn number it was recorded as when there was a session. */
interface Recorded extends Answer {
  turn?: number;
}

/**
 * The answer stopped part way, and what arrived is on screen and in the
 * transcript. Carries the turn number so the boundary drawn afterwards can
 * name the turn that really was recorded.
 */
export class CutShortError extends Error {
  constructor(
    message: string,
    readonly turn?: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// vinavu - ask Perplexity from your terminal, on your own Pro account.
// Modes: one-shot, piped stdin, and an interactive REPL. Named sessions follow
// up in the same Perplexity thread, so the conversation is remembered there.
// ---------------------------------------------------------------------------

// Defaulted rather than merely declared, so importing this module leaves it in
// a sane state. main() replaces it with the real arguments; a test can drive the
// flows without it being undefined underfoot.
let OPTS: Opts = parseArgs([]);

const timeoutFor = (model?: string) =>
  OPTS.timeout ? OPTS.timeout * 1000 : isResearch(model) ? RESEARCH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

/** The engine, unless a test hands askAndRecord something else. */
const engineAsk: AskFn = (req, hooks) => askEngine(req, hooks, timeoutFor(req.model));

// --- output helpers --------------------------------------------------------

/** Wires the progressive renderer to this invocation's flags and streams. */
function streamRender(label?: string) {
  if (OPTS.markdown) return createPassThrough();
  return createStreamRender({
    label,
    json: OPTS.json,
    ticker: !OPTS.quiet && !OPTS.json && process.stderr.isTTY,
  });
}

const say = (s: string) => process.stdout.write(s);
const note = (s: string) => process.stdout.write(T.muted(s));

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** The sources an answer cites, under it, unless asked not to or writing JSON. */
function showSources(sources: Source[], answer: string): void {
  if (OPTS.json || OPTS.noSources || !sources.length) return;
  if (OPTS.markdown) say("\n" + markdownSources(sources, answer) + "\n");
  else say("\n" + renderSources(sources, answer) + "\n");
}

/**
 * Whether the session's thread is too old to follow up in, with
 * --follow-within: a launcher asking in one session wants a conversation
 * while it is fresh, as Ask's ten minutes, and a new thread after.
 */
export function stale(session: Session | null, now = Date.now()): boolean {
  if (!session || !OPTS.followWithin) return false;
  // Timed from the last answer, not from the session's last write: /model
  // and /system write it too, and must not freshen an old thread (Cursor
  // 2026-10-11). No answer at all is nothing to follow.
  const last = session.turns.length ? session.turns[session.turns.length - 1].at : 0;
  const age = now - last;
  return !(age >= 0 && age < OPTS.followWithin * 60_000);
}

// --- flows -----------------------------------------------------------------

function resolveSession(): Session | null {
  if (OPTS.session) return loadSession(OPTS.session) || newSession(OPTS.session);
  if (OPTS.cont) return latestSession();
  return null;
}

export async function askAndRecord(
  ask: AskFn,
  session: Session | null,
  question: string,
  files: string[],
  label?: string,
): Promise<Recorded> {
  const sr = streamRender(label);
  sr.begin();
  // The sources as they arrive, so an answer cut short keeps the ones its
  // text already cites.
  let sources: Source[] = [];
  // A new thread on purpose: --new, or a session too old to follow up in.
  // The old thread is then let go whatever this answer brings back, so a
  // reply cut short cannot leave it there for the next question to follow
  // (Cursor 2026-10-11).
  const fresh = !!session && (OPTS.fresh || stale(session));
  const letGo = (s: Session) => {
    if (!fresh) return;
    s.thread = undefined;
    s.url = undefined;
  };
  try {
    const { upload, inline } = splitAttachments(files);
    for (const f of upload) if (!existsSync(f)) throw new Error(`cannot read file: ${f}`);
    const system = OPTS.system ?? session?.system;
    const answer = await ask(
      {
        query: buildMessage(question, inline, system),
        model: OPTS.model ?? session?.model,
        thread: session && !fresh ? session.thread : undefined,
        files: upload.map((f) => resolve(f)),
      },
      {
        onDelta: (piece) => sr.push(piece),
        onStatus: (text) => sr.status(text),
        onSources: (items) => {
          sources = items;
        },
      },
    );
    sr.finish(answer.content);
    sr.stop();
    showSources(answer.sources, answer.content);
    if (session) {
      // Read, append and write as one locked step, so a second vinavu
      // answering into the same session cannot overwrite this turn (or
      // resurrect one that /retry just dropped).
      const turn = {
        q: question,
        a: answer.content,
        at: Date.now(),
        ...(answer.sources.length ? { sources: answer.sources } : {}),
      };
      // The session passed to the callback is loaded from disk inside the lock,
      // so it is authoritative: appending to it, rather than to the copy this
      // process has been holding, is what stops a concurrent turn being lost or
      // a turn another process just dropped being written back.
      const saved = updateSession(session.name, (s) => {
        s.turns.push(turn);
        // Two processes asking in one session at once both follow up from the
        // same entry, and Perplexity keeps both answers; whichever lands last
        // is where the next question continues. Both turns stay in the
        // transcript. Serialising whole asks per session would make the second
        // wait out the first's answer, which costs more than it saves.
        letGo(s);
        if (answer.thread) s.thread = answer.thread;
        if (answer.url) s.url = answer.url;
        if (OPTS.model) s.model = OPTS.model;
        if (OPTS.system) s.system = OPTS.system;
      });
      Object.assign(session, saved);
      // The turn's own number, taken from the transcript that was actually
      // written. Comparing lengths before and after would miscount whenever
      // another process removed a turn while this answer was in flight.
      return { ...answer, turn: saved.turns.length };
    }
    return answer;
  } catch (e) {
    // The reader may already be looking at half an answer. Keeping it, saying
    // it was cut short, and recording it as such is the only way the screen and
    // the transcript agree about what happened.
    const shown = sr.shown().trim();
    if (!shown) throw e;
    // A launcher reading --markdown gets the fragment as a whole document:
    // ended by a newline, and with the sources it already cites.
    if (OPTS.markdown) {
      if (!sr.shown().endsWith("\n")) say("\n");
      showSources(sources, shown);
    }
    let turn: number | undefined;
    if (session) {
      const saved = updateSession(session.name, (s) => {
        s.turns.push({ q: question, a: shown, at: Date.now(), partial: true, ...(sources.length ? { sources } : {}) });
        letGo(s);
        if (OPTS.model) s.model = OPTS.model;
        if (OPTS.system) s.system = OPTS.system;
      });
      Object.assign(session, saved);
      turn = saved.turns.length;
    }
    throw new CutShortError(`the answer above was cut short: ${(e as Error).message}`, turn);
  } finally {
    sr.stop();
  }
}

async function runOnce(ask: AskFn): Promise<void> {
  const question = OPTS.question || (await readStdin());
  // Machine output is the answer or nothing: a caller reading --json or
  // --markdown must not get the help page as an answer (Cursor 2026-10-11).
  if (!question && (OPTS.json || OPTS.markdown)) throw new UsageError("no question: give one, or pipe it in");
  if (!question) {
    printHelp();
    process.exit(2);
  }
  const session = resolveSession();
  const answer = await askAndRecord(ask, session, question, OPTS.files);
  if (OPTS.json)
    say(
      JSON.stringify(
        {
          question,
          content: answer.content,
          model: answer.model ?? null,
          sources: answer.sources,
          url: answer.url ?? null,
          session: session?.name ?? null,
        },
        null,
        2,
      ) + "\n",
    );
}

// --- REPL ------------------------------------------------------------------

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "");

/** Open a URL in the desktop's browser, without waiting on it. */
function openUrl(url: string): boolean {
  for (const cmd of ["xdg-open", "open"]) {
    const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    if (r.status !== 0) continue;
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  return false;
}

async function runInteractive(ask: AskFn): Promise<void> {
  let session = resolveSession() || newSession("chat-" + stamp());

  say(
    T.h1(bold("vinavu")) +
      T.muted("  session: " + session.name) +
      (session.turns.length ? T.muted(`  (${session.turns.length} prior turns)`) : "") +
      "\n" +
      T.muted("Ask Perplexity. /help for commands, /exit to quit.") +
      "\n",
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Two speakers, named asymmetrically: the prompt names who is typing, and
  // the label above each answer names who is answering.
  const YOU = "you";
  const THEM = "perplexity";
  // Chrome is for a person reading a terminal. A piped or --raw session gets the
  // bare conversation, so nothing new lands in a file or a pipe.
  const chrome = !OPTS.raw && !OPTS.json && process.stdout.isTTY;
  const prompt = () => (chrome ? promptMark() : "") + T.accent(YOU + " ▸ ");

  /**
   * Closes a turn. Deliberately heavier and wider than the rule renderMarkdown
   * draws for a `---` inside an answer, so the strongest line on screen marks
   * a real boundary. Drawn after an answer rather than before a prompt, since
   * what the next line will be is unknowable at prompt time.
   */
  const closeTurn = (n?: number) => {
    if (!chrome) return;
    say("\n" + turnRule(cols(), n) + "\n");
  };

  const asked = async (text: string, files: string[]) => {
    let turn: number | undefined;
    try {
      turn = (await askAndRecord(ask, session, text, files, chrome ? THEM : undefined)).turn;
    } catch (e) {
      // A cut-short answer was still recorded, so the boundary names its turn.
      if (e instanceof CutShortError) turn = e.turn;
      say(T.tag("! ") + (e as Error).message + "\n");
    } finally {
      closeTurn(turn);
    }
  };

  if (OPTS.question) {
    say(prompt() + OPTS.question + "\n");
    await asked(OPTS.question, OPTS.files);
  }

  let running = true;
  while (running) {
    let line: string;
    try {
      line = (await rl.question(prompt())).trim();
    } catch {
      break;
    }
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      const rest = args.join(" ");
      const last = session.turns[session.turns.length - 1];
      switch (cmd) {
        case "exit":
        case "quit":
        case "q":
          running = false;
          break;
        case "new":
          session = newSession("chat-" + stamp());
          note("Started new session: " + session.name + "\n");
          break;
        case "session":
          if (!rest) note("Current session: " + session.name + "\n");
          else {
            session = loadSession(rest) || newSession(rest);
            note(`Switched to "${session.name}" (${session.turns.length} turns)\n`);
          }
          break;
        case "sessions":
          printSessions();
          break;
        case "forget":
          if (!rest) note("usage: /forget NAME\n");
          else note(forgetSession(rest) ? `Forgot "${rest}".\n` : `No session "${rest}".\n`);
          break;
        case "model":
          if (!rest) note("Model: " + (OPTS.model ?? session.model ?? "best") + "\n");
          else {
            // Kept with the session, through the same lock as an answer.
            OPTS.model = undefined;
            Object.assign(
              session,
              updateSession(session.name, (s) => {
                s.model = rest === "default" ? undefined : rest;
              }),
            );
            note(`Model for this session: ${session.model ?? "best"}\n`);
          }
          break;
        case "system":
          if (!rest) note("System: " + (session.system || "(none)") + "\n");
          else {
            const next = rest === "clear" ? undefined : rest;
            Object.assign(
              session,
              updateSession(session.name, (s) => {
                s.system = next;
              }),
            );
            note(next ? "System note set.\n" : "System note cleared.\n");
          }
          break;
        case "sources":
          if (!last?.sources?.length) note("No sources for the last answer.\n");
          else say(renderSources(last.sources) + "\n");
          break;
        case "open":
          if (!session.url) note("This session has no thread on perplexity.ai yet.\n");
          else if (!openUrl(session.url)) note(session.url + "\n");
          break;
        case "history":
          if (!session.turns.length) note("No turns yet.\n");
          for (const t of session.turns) say(T.accent("▸ ") + t.q + "\n" + render(t.a) + "\n\n");
          break;
        case "retry":
          if (!last) note("Nothing to retry yet.\n");
          else {
            // Persist the removal before re-asking, under the same lock the
            // answer will use, so the transcript on disk cannot restore it.
            Object.assign(
              session,
              updateSession(session.name, (s) => {
                const i = s.turns.findIndex((t) => t.at === last.at && t.q === last.q);
                if (i >= 0) s.turns.splice(i, 1);
              }),
            );
            await asked(last.q, []);
          }
          break;
        case "copy":
          if (!last) note("Nothing to copy yet.\n");
          else {
            const via = clipboardCopy(last.a);
            note(via ? `Copied the last answer (${via}).\n` : "No clipboard helper found.\n");
          }
          break;
        case "save":
          if (!rest) note("usage: /save PATH\n");
          else {
            try {
              writeFileSync(rest, exportSessionMarkdown(session), { mode: FILE_MODE });
              note(`Saved ${session.turns.length} turns to ${rest}.\n`);
            } catch (e) {
              note(`Could not write ${rest}: ${(e as Error).message}\n`);
            }
          }
          break;
        case "edit": {
          const text = editorCompose(rest);
          if (text === null) note("Set $EDITOR to compose in an editor.\n");
          else if (!text) note("Nothing to send.\n");
          else {
            const { text: t, files } = extractAtFiles(text);
            await asked(t || text, files);
          }
          break;
        }
        case "clear":
          say("\x1b[2J\x1b[H");
          break;
        case "help":
          printReplHelp();
          break;
        default:
          note("Unknown command. /help for the list.\n");
      }
      continue;
    }

    const { text, files } = extractAtFiles(line);
    await asked(text || line, files);
  }

  rl.close();
  note("\nSession saved as " + session.name + ".\n");
}

// --- engine commands -------------------------------------------------------

/** Run an engine command in the foreground, wired to this terminal. */
function passThrough(args: string[]): Promise<void> {
  const cmd = engineCommand();
  return new Promise((done, fail) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: "inherit" });
    child.on("error", (e: NodeJS.ErrnoException) =>
      fail(
        new Error(
          e.code === "ENOENT"
            ? `${cmd[0]} was not found: install the engine (make install) or set VINAVU_ENGINE`
            : e.message,
        ),
      ),
    );
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exitCode = code ?? 1;
      done();
    });
  });
}

// --- doctor ----------------------------------------------------------------

async function doctor(): Promise<void> {
  const rows: [boolean | null, string, string][] = [];
  const add = (ok: boolean | null, label: string, detail = "") => rows.push([ok, label, detail]);

  const [maj] = process.versions.node.split(".").map(Number);
  add(maj >= 18, "node " + process.versions.node, maj >= 18 ? "" : "vinavu needs Node 18 or newer");
  add(true, "vinavu " + VERSION, process.argv[1]);

  const dirOk = existsSync(HOME);
  let dirDetail = HOME;
  if (dirOk) {
    const mode = statSync(HOME).mode & 0o777;
    dirDetail = `${HOME} (mode ${mode.toString(8)})`;
    if (mode & 0o077) dirDetail += ` - readable by other local users; fix with: chmod ${DIR_MODE.toString(8)} ${HOME}`;
  }
  add(dirOk ? !(statSync(HOME).mode & 0o077) : null, "state dir", dirOk ? dirDetail : `${HOME} (made on first use)`);
  add(true, "sessions", `${listSessions().length} saved in ${SESS_DIR}`);

  const mark = (ok: boolean | null) => (ok === null ? T.muted("○") : ok ? T.accent("✓") : T.tag("✗"));
  const w = Math.max(...rows.map((r) => r[1].length));
  for (const [ok, label, detail] of rows) say(`${mark(ok)} ${bold(label.padEnd(w))}  ${T.muted(detail)}\n`);
  say(T.muted("engine:") + "\n");
  await passThrough(["doctor"]);
}

// --- completions -----------------------------------------------------------

const FLAGS = [
  "--session",
  "--continue",
  "--new",
  "--model",
  "--research",
  "--file",
  "--system",
  "--timeout",
  "--interactive",
  "--list",
  "--raw",
  "--json",
  "--markdown",
  "--follow-within",
  "--quiet",
  "--no-sources",
  "--help",
  "--version",
];
const SUBCOMMANDS = ["serve", "mcp", "models", "forget", "export", "doctor", "completions"];

function printCompletions(shell: string): void {
  const words = [...SUBCOMMANDS, ...FLAGS].join(" ");
  if (shell === "bash") {
    say(`# vinavu bash completion: eval "$(vinavu completions bash)"
_vinavu() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    -s|--session) COMPREPLY=( $(compgen -W "$(vinavu --list 2>/dev/null | sed -n 's/^. \\([^ ]*\\) .*/\\1/p')" -- "$cur") ); return;;
    -m|--model) COMPREPLY=( $(compgen -W "$(vinavu models 2>/dev/null | cut -d' ' -f1)" -- "$cur") ); return;;
    -f|--file) COMPREPLY=( $(compgen -f -- "$cur") ); return;;
    completions) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return;;
  esac
  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
}
complete -F _vinavu vinavu
`);
    return;
  }
  if (shell === "zsh") {
    say(`# vinavu zsh completion: eval "$(vinavu completions zsh)"
_vinavu() {
  local -a subs flags
  subs=(${SUBCOMMANDS.map((s) => `'${s}'`).join(" ")})
  flags=(${FLAGS.map((f) => `'${f}'`).join(" ")})
  case "\${words[CURRENT-1]}" in
    -s|--session) compadd \${(f)"$(vinavu --list 2>/dev/null | sed -n 's/^. \\([^ ]*\\) .*/\\1/p')"}; return;;
    -m|--model) compadd \${(f)"$(vinavu models 2>/dev/null | cut -d' ' -f1)"}; return;;
    -f|--file) _files; return;;
    completions) compadd bash zsh fish; return;;
  esac
  compadd -a subs flags
}
compdef _vinavu vinavu
`);
    return;
  }
  if (shell === "fish") {
    const lines = [
      "# vinavu fish completion: vinavu completions fish > ~/.config/fish/completions/vinavu.fish",
      ...SUBCOMMANDS.map((s) => `complete -c vinavu -n __fish_use_subcommand -a ${s}`),
      ...FLAGS.map((f) => `complete -c vinavu -l ${f.replace(/^--/, "")}`),
      "complete -c vinavu -s f -l file -r -F",
      "complete -c vinavu -s s -l session -x -a \"(vinavu --list 2>/dev/null | string replace -r '^. ([^ ]*) .*' '$1')\"",
      "complete -c vinavu -s m -l model -x -a \"(vinavu models 2>/dev/null | string split -f1 ' ')\"",
    ];
    say(lines.join("\n") + "\n");
    return;
  }
  throw new UsageError(`unknown shell: ${shell} (try bash, zsh or fish)`);
}

// --- help / listings -------------------------------------------------------

function printHelp(): void {
  const b = (s: string) => bold(s);
  say(
    `${T.h1(bold("vinavu"))} ${T.muted("- ask Perplexity from your terminal")} ${T.muted("v" + VERSION)}

${b("Usage")}
  vinavu [options] [question]

${b("Modes")}
  vinavu "question"       one-shot answer, with its sources
  vinavu                  interactive chat (REPL)
  echo "q" | vinavu       read the question from stdin

${b("Options")}
  -s, --session NAME      use or resume a named session (one Perplexity thread)
  -c, --continue          resume the most recent session
      --new               start a new thread, even in a saved session
  -m, --model NAME        best (default), research, sonar, or any model id
  -r, --research          Deep Research (minutes; same as -m research)
  -f, --file PATH         attach a file (repeatable): PDFs and images are
                          uploaded, anything else is pasted in as text
  -y, --system TEXT       prepend a steering instruction to each question
  -t, --timeout SECONDS   give up after this long without a word from the engine
  -i, --interactive       open the REPL (asks the given question first)
      --list              list saved sessions
      --raw               plain text, no color or markdown styling
      --json              print one JSON object instead of a rendered answer
      --markdown          the answer as raw Markdown, written as it arrives,
                          its cited sources as links after it
      --follow-within MIN follow up in the session's thread only if its last
                          answer is under MIN minutes old
      --no-sources        leave out the source list under the answer
  -q, --quiet             no spinner or progress line
  -h, --help              show this help
  -V, --version           show the version

${b("Sessions")}
  vinavu --list           list saved sessions
  vinavu export NAME      print a session as markdown
  vinavu export NAME --json   print a session as JSON
  vinavu forget NAME      delete a session
  vinavu forget --all     delete all sessions

${b("Engine")}
  vinavu serve [--port N] run the OpenAI-compatible server (default 127.0.0.1:8790)
  vinavu mcp              run the MCP server on stdio (one tool: perplexity_ask)
  vinavu models           list model names
  vinavu doctor           check the install, the Perplexity session and the Space

${b("Shell")}
  vinavu completions bash|zsh|fish

${b("In the REPL")} ${T.muted("(you ▸ asks, perplexity answers, a numbered rule closes each turn)")}
  @path in a message      attach a file
  /model [NAME|default]   show or set this session's model
  /sources                list the last answer's sources again
  /open                   open this session's thread on perplexity.ai
  /session [NAME]         show or switch/resume a session
  /sessions               list saved sessions
  /system [TEXT|clear]    show/set/clear a steering instruction
  /new                    start a new session
  /retry                  ask the last question again
  /edit [TEXT]            compose the message in $EDITOR
  /copy                   copy the last answer to the clipboard
  /save PATH              write the session to a markdown file
  /history                replay this session's turns
  /forget NAME            delete a saved session
  /clear                  clear the screen
  /exit                   quit

${b("Env")}
  VINAVU_SAVE=space|library|incognito   where threads are kept (default space)
  VINAVU_SPACE=vinavu                   the Space's title
  VINAVU_BROWSER=chromium|chrome|brave  where the Perplexity sign-in is read from
  VINAVU_SESSION_TOKEN=...              use this token instead of the browser's
  VINAVU_ENGINE=vinavu-engine           the engine command
  VINAVU_HOME=~/.local/state/vinavu     sessions, thread map, Space id
  NO_COLOR=1  FORCE_COLOR=1  NO_HYPERLINKS=1
`,
  );
}

function printReplHelp(): void {
  note(
    [
      "  @path                  attach a file to the message",
      "  /model [NAME|default]  show or set this session's model",
      "  /sources               list the last answer's sources again",
      "  /open                  open this session's thread on perplexity.ai",
      "  /session [NAME]        show or switch/resume a session",
      "  /sessions              list saved sessions",
      "  /system [TEXT|clear]   show/set/clear a steering instruction",
      "  /new                   start a new session",
      "  /retry                 ask the last question again",
      "  /edit [TEXT]           compose the message in $EDITOR",
      "  /copy                  copy the last answer to the clipboard",
      "  /save PATH             write the session to a markdown file",
      "  /history               replay this session's turns",
      "  /forget NAME           delete a saved session",
      "  /clear                 clear the screen",
      "  /exit                  quit",
    ].join("\n") + "\n",
  );
}

function printSessions(): void {
  const sessions = listSessions();
  if (!sessions.length) {
    note("No saved sessions.\n");
    return;
  }
  for (const s of sessions) {
    const when = new Date(s.updatedAt).toLocaleString();
    say(T.accent("• ") + bold(s.name) + T.muted(`  ${s.turns.length} turns  ${when}`) + "\n");
    const last = s.turns[s.turns.length - 1];
    if (last) note("    last: " + last.q.slice(0, 70) + "\n");
  }
}

function exportSession(args: string[]): void {
  for (const a of args)
    if (a.startsWith("-") && a !== "--json") throw new UsageError(`unknown option: ${a}`);
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) throw new UsageError("usage: vinavu export NAME [--json]");
  const s = loadSession(name);
  if (!s) throw new UsageError(`no session "${name}"`);
  // A transcript is for reading, not for following up from: the thread tokens
  // stay out of what gets pasted around.
  const { thread: _thread, ...shareable } = s;
  say(args.includes("--json") ? JSON.stringify(shareable, null, 2) + "\n" : exportSessionMarkdown(s));
}

function forgetSessions(args: string[]): void {
  if (args[0] === "--all") {
    const n = forgetAllSessions();
    note(`Cleared ${n} session${n === 1 ? "" : "s"}.\n`);
    return;
  }
  for (const a of args)
    if (a.startsWith("-")) throw new UsageError(`unknown option: ${a}`);
  const name = args[0];
  if (!name) throw new UsageError("usage: vinavu forget NAME | --all");
  note(forgetSession(name) ? `Forgot session "${name}".\n` : `No session "${name}".\n`);
}

// --- main ------------------------------------------------------------------

export async function main(argv = process.argv, ask: AskFn = engineAsk): Promise<void> {
  const args = argv.slice(2);

  // Subcommands are matched on the first argument only, so their own flags may
  // follow. The engine's commands take their arguments as the engine reads them.
  const sub = args[0];
  if (sub === "serve" || sub === "mcp" || sub === "models") return passThrough(args);
  if (sub === "doctor") {
    OPTS = parseArgs(args.slice(1));
    setPlain(OPTS.raw || OPTS.json);
    return doctor();
  }
  if (sub === "completions") {
    OPTS = parseArgs([]);
    setPlain(true);
    return printCompletions(args[1] ?? "");
  }
  if (sub === "export") {
    OPTS = parseArgs([]);
    setPlain(true); // a transcript on stdout is for a file or a pipe
    return exportSession(args.slice(1));
  }
  if (sub === "forget") {
    OPTS = parseArgs([]);
    return forgetSessions(args.slice(1));
  }

  OPTS = parseArgs(args);
  setPlain(OPTS.raw || OPTS.json);

  if (OPTS.help) return printHelp();
  if (OPTS.version) return void say(VERSION + "\n");
  if (OPTS.list) return printSessions();

  const interactive =
    OPTS.interactive || (!OPTS.question && process.stdin.isTTY && process.stdout.isTTY);
  // The REPL has no single object to emit, and --json suppresses the rendered
  // answer, so the combination would show a prompt and nothing else.
  if (interactive && OPTS.json)
    throw new UsageError("--json is for one-shot questions, not the interactive REPL");
  if (interactive && OPTS.markdown)
    throw new UsageError("--markdown is for one-shot questions, not the interactive REPL");
  if (OPTS.json && OPTS.markdown) throw new UsageError("--json and --markdown are two ways to print one answer: pick one");
  if (interactive) await runInteractive(ask);
  else await runOnce(ask);
}

// Only run when invoked as a program, so the module can be imported by tests.
// argv[1] is resolved through realpath first: `npm link` puts a symlink on PATH,
// and comparing the symlink against the module's real URL never matches.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write("\r" + ESC + "2K");
    const usage = err instanceof UsageError;
    process.stderr.write(T.tag(usage ? "" : "Error: ") + (err?.message || String(err)) + "\n");
    if (usage) process.stderr.write(T.muted("Try `vinavu --help`.\n"));
    process.exit(usage ? 2 : 1);
  });
}
