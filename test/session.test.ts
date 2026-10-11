import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  statSync,
  readdirSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// The session store roots itself at VINAVU_HOME, so point it at a scratch dir
// before the module is imported and the real state is never touched.
const HOME = mkdtempSync(join(tmpdir(), "vinavu-home-"));
process.env.VINAVU_HOME = HOME;

const { newSession, saveSession, loadSession, listSessions, latestSession, sessFile, forgetSession, forgetAllSessions, exportSessionMarkdown, updateSession } =
  await import("../src/session.js");

const SESS = join(HOME, "sessions");

test("a saved session round-trips", () => {
  const s = newSession("round");
  s.turns.push({ q: "question", a: "answer", at: 1 });
  saveSession(s);
  const back = loadSession("round");
  assert.equal(back?.name, "round");
  assert.equal(back?.turns.length, 1);
  assert.equal(back?.turns[0].q, "question");
});

test("loading an unknown session returns null", () => {
  assert.equal(loadSession("never-existed"), null);
});

test("session files are written private to the user", () => {
  saveSession(newSession("perms"));
  assert.equal(statSync(sessFile("perms")).mode & 0o777, 0o600);
});

test("the sessions directory is private to the user", () => {
  saveSession(newSession("dirperms"));
  assert.equal(statSync(SESS).mode & 0o777, 0o700);
});

test("a session name is sanitised into the filename but kept verbatim inside", () => {
  const name = "../../escape me";
  const s = newSession(name);
  saveSession(s);
  // The real property: whatever the name, the file lands directly in the
  // sessions directory, as a single filename with nothing traversable in it.
  const path = resolve(sessFile(name));
  assert.equal(dirname(path), resolve(SESS));
  assert.ok(!basename(path).includes("/"));
  assert.equal(loadSession(name)?.name, name);
});

test("session names that differ only in punctuation still round-trip", () => {
  for (const name of ["dots...", ".hidden", "with space", "sl/ash", "..", "-dash"]) {
    const s = newSession(name);
    s.turns.push({ q: name, a: "a", at: 1 });
    saveSession(s);
    assert.equal(loadSession(name)?.name, name, `lost session named ${JSON.stringify(name)}`);
    assert.equal(dirname(resolve(sessFile(name))), resolve(SESS));
  }
});

test("saving is atomic: no partial file is left behind on the happy path", () => {
  saveSession(newSession("atomic"));
  const strays = readdirSync(SESS).filter((f) => !f.endsWith(".json"));
  assert.deepEqual(strays, []);
});

test("a corrupt session file does not hide the healthy ones", () => {
  mkdirSync(SESS, { recursive: true });
  writeFileSync(join(SESS, "corrupt.json"), "{ this is not json");
  saveSession(newSession("healthy"));
  const names = listSessions().map((s) => s.name);
  assert.ok(names.includes("healthy"), "healthy session missing from the listing");
});

test("a session file with the wrong shape is rejected rather than half-loaded", () => {
  mkdirSync(SESS, { recursive: true });
  writeFileSync(join(SESS, "wrong.json"), JSON.stringify({ name: "wrong", turns: "nope" }));
  assert.equal(loadSession("wrong"), null);
  assert.ok(!listSessions().some((s) => s.name === "wrong"));
});

test("a loaded session always has a usable turns array", () => {
  mkdirSync(SESS, { recursive: true });
  writeFileSync(join(SESS, "minimal.json"), JSON.stringify({ name: "minimal" }));
  const s = loadSession("minimal");
  assert.ok(Array.isArray(s?.turns));
});

test("listSessions is ordered most recently updated first", () => {
  const a = newSession("older");
  a.updatedAt = 1000;
  saveSession(a);
  const b = newSession("newer");
  b.updatedAt = 2000;
  saveSession(b);
  const names = listSessions().map((s) => s.name);
  assert.ok(names.indexOf("newer") < names.indexOf("older"));
});

test("latestSession returns the most recently updated one", () => {
  const s = newSession("freshest");
  s.updatedAt = Date.now() + 100000;
  saveSession(s);
  assert.equal(latestSession()?.name, "freshest");
});

test("forgetSession removes exactly one session and reports whether it existed", () => {
  saveSession(newSession("doomed"));
  assert.equal(forgetSession("doomed"), true);
  assert.equal(loadSession("doomed"), null);
  assert.equal(forgetSession("doomed"), false);
});

test("forgetAllSessions clears the store and returns the count", () => {
  saveSession(newSession("a"));
  saveSession(newSession("b"));
  const n = forgetAllSessions();
  assert.ok(n >= 2);
  assert.deepEqual(listSessions(), []);
});

test("a session exports as readable markdown", () => {
  const s = newSession("exportable");
  s.system = "be brief";
  s.turns.push({ q: "what is truth", a: "**this**", at: Date.parse("2026-01-02T03:04:05Z") });
  saveSession(s);
  const md = exportSessionMarkdown(s);
  assert.match(md, /# exportable/);
  assert.match(md, /be brief/);
  assert.match(md, /what is truth/);
  assert.match(md, /\*\*this\*\*/);
});

// --- regressions from review -----------------------------------------------

test("a turn with no answer is dropped rather than loaded into a crash", () => {
  mkdirSync(SESS, { recursive: true });
  writeFileSync(
    join(SESS, "halfturn.json"),
    JSON.stringify({ name: "halfturn", turns: [{ q: "only a question" }, { q: "ok", a: "yes", at: 5 }] }),
  );
  const s = loadSession("halfturn");
  assert.equal(s?.turns.length, 1);
  assert.equal(s?.turns[0].a, "yes");
});

test("a turn with a nonsense timestamp still loads and exports", () => {
  mkdirSync(SESS, { recursive: true });
  writeFileSync(
    join(SESS, "badtime.json"),
    JSON.stringify({ name: "badtime", turns: [{ q: "q", a: "a", at: "yesterday" }] }),
  );
  const s = loadSession("badtime");
  assert.equal(s?.turns.length, 1);
  assert.ok(Number.isFinite(s!.turns[0].at));
  assert.doesNotThrow(() => exportSessionMarkdown(s!));
});

test("export survives an unusable updatedAt without throwing", () => {
  const s = newSession("weird");
  (s as unknown as Record<string, unknown>).updatedAt = Number.NaN;
  s.turns.push({ q: "q", a: "a", at: Number.NaN });
  const md = exportSessionMarkdown(s);
  assert.match(md, /# weird/);
  assert.doesNotMatch(md, /Invalid Date/);
});




// Two vinavu processes answering into the same named session. Each loaded the
// transcript before asking, so appending from its own stale copy would drop the
// other's turn; updateSession reloads inside the lock instead.
test("a concurrent writer's turn is not lost", () => {
  const name = "shared";
  saveSession(newSession(name));

  // A and B both hold a copy from before either finished
  const a = loadSession(name)!;
  const b = loadSession(name)!;
  assert.equal(a.turns.length, 0);
  assert.equal(b.turns.length, 0);

  updateSession(name, (s) => s.turns.push({ q: "from A", a: "answer A", at: 1 }));
  updateSession(name, (s) => s.turns.push({ q: "from B", a: "answer B", at: 2 }));

  assert.deepEqual(
    loadSession(name)!.turns.map((t) => t.q),
    ["from A", "from B"],
  );
});

// /retry drops a turn and asks again. A question already in flight elsewhere
// must not write the dropped turn back from its stale copy.
test("retry replaces the last turn, even against a concurrent stale writer", () => {
  const name = "retried";
  const s = newSession(name);
  s.turns.push({ q: "the question", a: "first answer", at: 1 });
  saveSession(s);

  // another process is mid-question and still holds the pre-retry transcript
  const stale = loadSession(name)!;
  assert.equal(stale.turns.length, 1);

  // /retry removes that specific turn
  updateSession(name, (t) => {
    const i = t.turns.findIndex((x) => x.at === 1 && x.q === "the question");
    if (i >= 0) t.turns.splice(i, 1);
  });

  // the stale writer appends its own answer: it must not resurrect the removed one
  updateSession(name, (t) => t.turns.push({ q: "elsewhere", a: "other", at: 3 }));

  // and the retry lands
  updateSession(name, (t) => t.turns.push({ q: "the question", a: "second answer", at: 2 }));

  const final = loadSession(name)!;
  assert.deepEqual(
    final.turns.map((t) => t.a),
    ["other", "second answer"],
    "a dropped turn was written back by a stale copy",
  );
});

// --- locked updates ---------------------------------------------------------

test("updateSession appends under a lock and returns the saved session", () => {
  const name = "locked";
  saveSession(newSession(name));
  const out = updateSession(name, (s) => s.turns.push({ q: "q1", a: "a1", at: 1 }));
  assert.equal(out.turns.length, 1);
  assert.equal(loadSession(name)?.turns[0].q, "q1");
});

test("updateSession creates the session when it does not exist yet", () => {
  const out = updateSession("brand-new", (s) => s.turns.push({ q: "q", a: "a", at: 1 }));
  assert.equal(out.name, "brand-new");
  assert.equal(loadSession("brand-new")?.turns.length, 1);
});

test("updateSession leaves no lock file behind", () => {
  updateSession("tidy", (s) => s.turns.push({ q: "q", a: "a", at: 1 }));
  const locks = readdirSync(SESS).filter((f) => f.endsWith(".lock"));
  assert.deepEqual(locks, []);
});

test("updateSession releases the lock even when the mutation throws", () => {
  assert.throws(() =>
    updateSession("thrower", () => {
      throw new Error("mutation failed");
    }),
  );
  assert.deepEqual(readdirSync(SESS).filter((f) => f.endsWith(".lock")), []);
});

test("a lock left behind by a dead process is broken rather than obeyed", () => {
  const name = "stale-lock";
  saveSession(newSession(name));
  const lock = sessFile(name) + ".lock";
  writeFileSync(lock, "9999999");
  // backdate it well past the staleness window
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const out = updateSession(name, (s) => s.turns.push({ q: "went through", a: "a", at: 1 }));
  assert.equal(out.turns.length, 1);
});

test("a fresh lock held by someone else does not lose the update", () => {
  const name = "held-lock";
  saveSession(newSession(name));
  const lock = sessFile(name) + ".lock";
  writeFileSync(lock, String(process.pid + 1)); // someone else holds it, right now
  try {
    // It waits, gives up, and writes anyway: losing the race beats losing the answer.
    const out = updateSession(name, (s) => s.turns.push({ q: "still saved", a: "a", at: 1 }));
    assert.equal(out.turns.length, 1);
    assert.equal(loadSession(name)?.turns[0].q, "still saved");
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already broken as stale
    }
  }
});

test("releasing a lock only removes our own, never a replacement", () => {
  const name = "lock-token";
  saveSession(newSession(name));
  const lock = sessFile(name) + ".lock";
  updateSession(name, () => {
    // While we hold the lock, pretend a slow-process recovery replaced it.
    writeFileSync(lock, "someone-else");
  });
  assert.equal(readFileSync(lock, "utf8"), "someone-else", "another process's lock was deleted");
  unlinkSync(lock);
});

// --- threads, models and sources --------------------------------------------

test("a session keeps its thread, url, model and per-turn sources", () => {
  const s = newSession("threaded");
  s.thread = { backend_uuid: "b-1", read_write_token: "rwt", slug: "slug-1" };
  s.url = "https://www.perplexity.ai/search/slug-1";
  s.model = "research";
  s.turns.push({ q: "q", a: "a [1]", at: 1, sources: [{ title: "T", url: "https://t.example" }] });
  saveSession(s);
  const back = loadSession("threaded")!;
  assert.deepEqual(back.thread, { backend_uuid: "b-1", read_write_token: "rwt", slug: "slug-1" });
  assert.equal(back.url, "https://www.perplexity.ai/search/slug-1");
  assert.equal(back.model, "research");
  assert.deepEqual(back.turns[0].sources, [{ title: "T", url: "https://t.example" }]);
});

test("a malformed thread or source list is dropped, not half-loaded", () => {
  mkdirSync(SESS, { recursive: true });
  writeFileSync(
    join(SESS, "odd.json"),
    JSON.stringify({
      name: "odd",
      thread: { read_write_token: "no backend" },
      turns: [{ q: "q", a: "a", at: 1, sources: [{ title: "no url" }, "junk", { url: "https://ok.example" }] }],
    }),
  );
  const back = loadSession("odd")!;
  assert.equal(back.thread, undefined);
  assert.deepEqual(back.turns[0].sources, [{ title: "https://ok.example", url: "https://ok.example" }]);
});

test("an export lists the cited sources under their own numbers and the thread", () => {
  const s = newSession("cited");
  s.url = "https://www.perplexity.ai/search/x";
  s.turns.push({
    q: "q",
    a: "Claim.[2]",
    at: 1,
    sources: [
      { title: "One", url: "https://one.example" },
      { title: "Two", url: "https://two.example" },
    ],
  });
  const md = exportSessionMarkdown(s);
  assert.match(md, /Thread: https:\/\/www\.perplexity\.ai\/search\/x/);
  assert.match(md, /- \[2\] \[Two\]\(https:\/\/two\.example\)/);
  assert.doesNotMatch(md, /One/);
});
