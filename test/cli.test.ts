import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Drive the real compiled entry point the way a user does. The engine is a
// fake: a small node script that speaks the engine's JSON-lines protocol, so
// nothing here touches the network or Perplexity.
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const HOME = mkdtempSync(join(tmpdir(), "vinavu-cli-"));
const BIN = mkdtempSync(join(tmpdir(), "vinavu-fake-"));
const LOG = join(BIN, "requests.log");
const FAKE = join(BIN, "fake-engine.mjs");

writeFileSync(
  FAKE,
  `import { readFileSync, appendFileSync } from "node:fs";
const cmd = process.argv[2];
if (cmd === "models") { console.log("best  alias for perplexity/best"); process.exit(0); }
if (cmd === "doctor") { console.log("ok session: fake"); process.exit(0); }
if (cmd === "serve") { console.log("serve " + process.argv.slice(3).join(" ")); process.exit(0); }
const req = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(req) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (req.query.includes("FAIL")) { out({ t: "err", kind: "quota", error: "too many requests" }); process.exit(1); }
if (req.query.includes("CRASH")) { process.stderr.write("Traceback\\nValueError: boom\\n"); process.exit(3); }
if (req.query.includes("BREAK")) {
  out({ t: "sources", items: [{ title: "Docs", url: "https://docs.example/a" }] });
  out({ t: "d", d: "A first paragraph.[1]\\n\\n" });
  out({ t: "err", kind: "upstream", error: "the answer broke off" });
  process.exit(1);
}
const sources = [{ title: "Docs", url: "https://docs.example/a" }, { title: "Other", url: "https://other.example/b" }];
out({ t: "status", text: "searching" });
out({ t: "sources", items: sources });
out({ t: "d", d: "The answer" });
out({ t: "d", d: " is 42.[1]" });
out({ t: "done", content: "The answer is 42.[1]", model: req.model || "perplexity/best", sources,
      thread: { backend_uuid: "b-" + Date.now(), read_write_token: "rwt", slug: "slug-1" },
      url: "https://www.perplexity.ai/search/slug-1" });
`,
);

function run(args: string[], opts: { input?: string; home?: string; engine?: string } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input: opts.input ?? "",
    env: {
      ...process.env,
      VINAVU_HOME: opts.home ?? HOME,
      VINAVU_ENGINE: opts.engine ?? `${process.execPath} ${FAKE}`,
      NO_COLOR: "1",
    },
  });
}

const requests = (): Record<string, unknown>[] =>
  existsSync(LOG)
    ? readFileSync(LOG, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];

const seed = (name: string, session: Record<string, unknown>) => {
  mkdirSync(join(HOME, "sessions"), { recursive: true });
  writeFileSync(join(HOME, "sessions", `${name}.json`), JSON.stringify(session));
};

test("--version prints just the version", () => {
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("--help explains the modes and exits cleanly", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  for (const bit of ["Usage", "--session", "--model", "--research", "--json", "serve", "mcp", "completions", "doctor"])
    assert.match(r.stdout, new RegExp(bit.replace(/[-[\]]/g, "\\$&")));
});

test("an unknown flag fails with usage guidance, not a stack trace", () => {
  const r = run(["--nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option: --nope/);
  assert.match(r.stderr, /vinavu --help/);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
});

test("a flag with a missing value fails before the engine is started", () => {
  const before = requests().length;
  const r = run(["-s"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--session needs a value/);
  assert.equal(requests().length, before);
});

// --- asking ------------------------------------------------------------------

test("a one-shot question prints the answer and the sources it cites", () => {
  const r = run(["what is the answer"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /The answer is 42\.\[1\]/);
  assert.match(r.stdout, /Sources\n1 {2}Docs {2}https:\/\/docs\.example\/a/);
  assert.doesNotMatch(r.stdout, /Other/, "an uncited source was listed");
  assert.equal(requests().at(-1)!.query, "what is the answer");
});

test("a question can come from stdin", () => {
  const r = run([], { input: "piped question\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(requests().at(-1)!.query, "piped question");
});

test("--no-sources leaves the list out", () => {
  const r = run(["--no-sources", "q"]);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /Sources/);
});

test("--json prints one object with the sources and the thread's address", () => {
  const r = run(["--json", "-m", "sonar", "q"]);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.content, "The answer is 42.[1]");
  assert.equal(o.model, "sonar");
  assert.equal(o.sources.length, 2);
  assert.equal(o.url, "https://www.perplexity.ai/search/slug-1");
  assert.equal(requests().at(-1)!.model, "sonar");
});

test("a named session follows up in its thread, and --new starts another", () => {
  const home = mkdtempSync(join(tmpdir(), "vinavu-sess-"));
  run(["-s", "work", "first"], { home });
  assert.equal(requests().at(-1)!.thread, undefined);
  run(["-s", "work", "second"], { home });
  const followUp = requests().at(-1)!;
  assert.equal((followUp.thread as { slug: string }).slug, "slug-1");
  run(["-s", "work", "--new", "third"], { home });
  assert.equal(requests().at(-1)!.thread, undefined);
  const md = run(["export", "work"], { home }).stdout;
  assert.match(md, /3 turns/);
  assert.match(md, /Thread: https:\/\/www\.perplexity\.ai\/search\/slug-1/);
});

test("--research asks Deep Research", () => {
  run(["-r", "q"]);
  assert.equal(requests().at(-1)!.model, "research");
});

test("an engine error is reported plainly and exits 1", () => {
  const r = run(["FAIL please"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: too many requests/);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
});

test("an engine that crashes is reported with its last words", () => {
  const r = run(["CRASH please"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the engine exited with code 3: ValueError: boom/);
});

test("a missing engine says how to install it", () => {
  const r = run(["q"], { engine: "/nowhere/vinavu-engine" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /was not found: install the engine/);
});

test("engine commands pass through with their arguments", () => {
  assert.match(run(["models"]).stdout, /best {2}alias/);
  assert.match(run(["serve", "--port", "9999"]).stdout, /serve --port 9999/);
});

// --- sessions ---------------------------------------------------------------

test("--list reports an empty store plainly", () => {
  const empty = mkdtempSync(join(tmpdir(), "vinavu-empty-"));
  const r = run(["--list"], { home: empty });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No saved sessions/);
});

test("--list shows saved sessions newest first", () => {
  seed("alpha", { name: "alpha", updatedAt: 1000, createdAt: 1, turns: [{ q: "old q", a: "a", at: 1 }] });
  seed("beta", { name: "beta", updatedAt: 9000, createdAt: 1, turns: [{ q: "new q", a: "a", at: 1 }] });
  const r = run(["--list"]);
  assert.ok(r.stdout.indexOf("beta") < r.stdout.indexOf("alpha"));
  assert.match(r.stdout, /new q/);
});

test("export prints a session as markdown", () => {
  seed("expo", {
    name: "expo",
    updatedAt: 5,
    createdAt: 1,
    system: "be terse",
    turns: [{ q: "what is uv", a: "an answer", at: 5 }],
  });
  const r = run(["export", "expo"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^# expo/m);
  assert.match(r.stdout, /what is uv/);
  assert.match(r.stdout, /an answer/);
  assert.match(r.stdout, /be terse/);
});

test("export --json prints the session without its thread tokens", () => {
  seed("jexp", {
    name: "jexp",
    updatedAt: 5,
    createdAt: 1,
    thread: { backend_uuid: "b", read_write_token: "secret-rwt", slug: "s" },
    turns: [{ q: "q", a: "a", at: 5 }],
  });
  const r = run(["export", "jexp", "--json"]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.name, "jexp");
  assert.equal(parsed.turns.length, 1);
  assert.doesNotMatch(r.stdout, /secret-rwt/);
});

test("export of an unknown session is a usage error", () => {
  const r = run(["export", "ghost"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no session "ghost"/);
});

test("export with no name explains itself", () => {
  const r = run(["export"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: vinavu export/);
});

test("forget removes a session and says so, twice over", () => {
  seed("doomed", { name: "doomed", updatedAt: 1, createdAt: 1, turns: [] });
  assert.match(run(["forget", "doomed"]).stdout, /Forgot session "doomed"/);
  assert.match(run(["forget", "doomed"]).stdout, /No session "doomed"/);
});

test("completions emit a script for every supported shell", () => {
  for (const [shell, marker] of [
    ["bash", /complete -F _vinavu vinavu/],
    ["zsh", /compdef _vinavu vinavu/],
    ["fish", /complete -c vinavu/],
  ] as const) {
    const r = run(["completions", shell]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, marker);
  }
});

test("completions rejects an unknown shell", () => {
  const r = run(["completions", "csh"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown shell: csh/);
});

test("doctor reports on the install and runs the engine's checks", () => {
  const r = run(["doctor"]);
  assert.equal(r.status, 0);
  for (const line of ["node", "vinavu", "state dir", "sessions", "ok session: fake"])
    assert.match(r.stdout, new RegExp(line));
});

test("the built entry point is executable with a node shebang", () => {
  assert.ok(existsSync(CLI));
  const first = spawnSync("head", ["-1", CLI], { encoding: "utf8" }).stdout.trim();
  assert.equal(first, "#!/usr/bin/env node");
});

test("--json is refused in the REPL rather than printing nothing", () => {
  const r = run(["--json", "--interactive", "a question"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--json is for one-shot questions/);
});

test("export rejects a flag it does not understand", () => {
  const r = run(["export", "whatever", "--yaml"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option: --yaml/);
});

test("forget refuses to treat a flag as a session name", () => {
  const r = run(["forget", "--everything"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option: --everything/);
});

test("an answer that breaks off is kept with its sources and the model it was asked with", () => {
  const home = mkdtempSync(join(tmpdir(), "vinavu-break-"));
  const r = run(["-s", "cut", "-m", "research", "BREAK now"], { home });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /A first paragraph\.\[1\]/);
  assert.match(r.stderr, /cut short: the answer broke off/);
  const saved = JSON.parse(run(["export", "cut", "--json"], { home }).stdout);
  assert.equal(saved.model, "research");
  assert.equal(saved.turns[0].partial, true);
  assert.deepEqual(saved.turns[0].sources, [{ title: "Docs", url: "https://docs.example/a" }]);
});

test("--markdown prints the answer raw, then its cited sources as Markdown links", () => {
  const r = run(["--markdown", "q"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "The answer is 42.[1]\n\nSources:\n\n- [1] [Docs](<https://docs.example/a>)\n");
});

test("--markdown is refused with --json and in the REPL", () => {
  assert.equal(run(["--markdown", "--json", "q"]).status, 2);
  assert.match(run(["--markdown", "-i", "q"]).stderr, /--markdown is for one-shot questions/);
});

test("--follow-within follows a fresh session up and starts a new thread for a stale one", () => {
  const home = mkdtempSync(join(tmpdir(), "vinavu-within-"));
  const at = (name: string, updatedAt: number) => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(
      join(home, "sessions", `${name}.json`),
      JSON.stringify({
        name,
        createdAt: 1,
        updatedAt,
        thread: { backend_uuid: "old-b", read_write_token: "r", slug: "s" },
        turns: [{ q: "earlier", a: "answer", at: updatedAt }],
      }),
    );
  };
  at("fresh", Date.now() - 2 * 60_000);
  run(["-s", "fresh", "--follow-within", "10", "q"], { home });
  assert.equal((requests().at(-1)!.thread as { backend_uuid: string }).backend_uuid, "old-b");
  at("stale", Date.now() - 30 * 60_000);
  run(["-s", "stale", "--follow-within", "10", "q"], { home });
  assert.equal(requests().at(-1)!.thread, undefined);
  run(["-s", "stale", "q again"], { home });
  assert.notEqual(requests().at(-1)!.thread, undefined, "the new thread was not kept for the next question");
});

// --- from review (Cursor gpt-5.6-sol-high, 2026-10-11, second round) --------

test("--markdown with no question is a usage error with nothing on stdout", () => {
  const r = run(["--markdown"], { input: "" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no question/);
});

test("a cut-short --markdown answer still ends with a newline and its sources", () => {
  const r = run(["--markdown", "BREAK now"]);
  assert.equal(r.status, 1);
  // Blank lines between the fragment and the list are Markdown's to collapse.
  assert.match(r.stdout, /^A first paragraph\.\[1\]\n+Sources:\n\n- \[1\] \[Docs\]\(<https:\/\/docs\.example\/a>\)\n$/);
});

test("--follow-within is timed from the last answer, not the session's last write", () => {
  const home = mkdtempSync(join(tmpdir(), "vinavu-within2-"));
  mkdirSync(join(home, "sessions"), { recursive: true });
  // Written a minute ago (a /model, say), answered an hour ago.
  writeFileSync(
    join(home, "sessions", "old.json"),
    JSON.stringify({
      name: "old",
      createdAt: 1,
      updatedAt: Date.now() - 60_000,
      thread: { backend_uuid: "old-b", read_write_token: "r", slug: "s" },
      turns: [{ q: "earlier", a: "answer", at: Date.now() - 60 * 60_000 }],
    }),
  );
  run(["-s", "old", "--follow-within", "10", "q"], { home });
  assert.equal(requests().at(-1)!.thread, undefined);
});

test("a thread let go by --new is not followed after a reply cut short", () => {
  const home = mkdtempSync(join(tmpdir(), "vinavu-letgo-"));
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(
    join(home, "sessions", "s.json"),
    JSON.stringify({
      name: "s",
      createdAt: 1,
      updatedAt: Date.now(),
      thread: { backend_uuid: "rejected", read_write_token: "r", slug: "s" },
      url: "https://www.perplexity.ai/search/s",
      turns: [{ q: "earlier", a: "answer", at: Date.now() }],
    }),
  );
  run(["-s", "s", "--new", "BREAK now"], { home });
  run(["-s", "s", "next"], { home });
  assert.equal(requests().at(-1)!.thread, undefined, "followed the thread --new let go");
});
