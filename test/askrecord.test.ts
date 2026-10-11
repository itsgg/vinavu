import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NO_COLOR = "1";
process.env.VINAVU_HOME = mkdtempSync(join(tmpdir(), "vinavu-ask-"));

const { askAndRecord } = await import("../src/cli.js");
const { newSession, saveSession, loadSession, exportSessionMarkdown } = await import(
  "../src/session.js"
);
import type { Answer, AskRequest, Hooks } from "../src/engine.js";

/**
 * Run something with the answer text swallowed.
 *
 * The renderer writes to the real stdout, which would scatter answer text
 * through the reporter's output. Scoped to the call rather than the file: held
 * across the whole file it also swallows the reporter, which then reports
 * nothing.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const real = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = real;
  }
}

/** An engine that streams what it is told to, then answers or fails; it keeps what it was asked. */
function engine(script: { stream?: string[]; answer?: Partial<Answer>; fail?: string }) {
  const asked: AskRequest[] = [];
  const ask = async (req: AskRequest, hooks: Hooks): Promise<Answer> => {
    asked.push(req);
    hooks.onStatus?.("searching");
    for (const piece of script.stream ?? []) hooks.onDelta?.(piece);
    if (script.fail) throw new Error(script.fail);
    return { content: (script.stream ?? []).join(""), sources: [], ...script.answer };
  };
  return Object.assign(ask, { asked });
}

test("a completed answer is recorded whole, with its thread and sources, and numbered", async () => {
  const s = newSession("whole");
  saveSession(s);
  const thread = { backend_uuid: "b-1", read_write_token: "rwt", slug: "slug-1" };
  const sources = [{ title: "T", url: "https://t.example" }];
  const r = await quietly(() =>
    askAndRecord(
      engine({
        stream: ["the ", "answer\n\n"],
        answer: { content: "the answer", thread, sources, url: "https://www.perplexity.ai/search/slug-1" },
      }),
      s,
      "a question",
      [],
    ),
  );
  assert.equal(r.turn, 1);
  const disk = loadSession("whole")!;
  assert.equal(disk.turns.length, 1);
  assert.equal(disk.turns[0].a, "the answer");
  assert.equal(disk.turns[0].partial, undefined);
  assert.deepEqual(disk.turns[0].sources, sources);
  assert.deepEqual(disk.thread, thread);
  assert.equal(disk.url, "https://www.perplexity.ai/search/slug-1");
});

test("a follow-up carries the session's thread and model to the engine", async () => {
  const s = newSession("follow");
  s.thread = { backend_uuid: "b-1", read_write_token: "rwt", slug: "slug-1" };
  s.model = "sonar";
  saveSession(s);
  const e = engine({ stream: ["ok\n\n"] });
  await quietly(() => askAndRecord(e, s, "and then?", []));
  assert.deepEqual(e.asked[0].thread, s.thread);
  assert.equal(e.asked[0].model, "sonar");
  assert.equal(e.asked[0].query, "and then?");
});

test("a one-shot with no session starts a new thread", async () => {
  const e = engine({ stream: ["ok\n\n"] });
  await quietly(() => askAndRecord(e, null, "q", []));
  assert.equal(e.asked[0].thread, undefined);
});

test("PDFs go to the engine to upload and text files are folded into the question", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vinavu-files-"));
  const notes = join(dir, "notes.md");
  const pdf = join(dir, "paper.pdf");
  writeFileSync(notes, "my notes");
  writeFileSync(pdf, "%PDF-1.4");
  const e = engine({ stream: ["ok\n\n"] });
  await quietly(() => askAndRecord(e, null, "summarise", [notes, pdf]));
  assert.deepEqual(e.asked[0].files, [pdf]);
  assert.match(e.asked[0].query, /File: notes\.md\n```\nmy notes\n```/);
  assert.doesNotMatch(e.asked[0].query, /PDF-1\.4/);
});

test("a missing upload fails before anything is asked", async () => {
  const e = engine({ stream: ["ok\n\n"] });
  await assert.rejects(quietly(() => askAndRecord(e, null, "q", ["/nowhere/x.pdf"])), /cannot read file/);
  assert.equal(e.asked.length, 0);
});

// The reader is already looking at half an answer. Dropping it left text on the
// screen that the transcript and an export both denied ever existed.
test("an answer cut short is kept, marked, and recorded", async () => {
  const s = newSession("cut");
  saveSession(s);
  await assert.rejects(
    quietly(() =>
      askAndRecord(engine({ stream: ["half an ", "answer\n\n"], fail: "the connection died" }), s, "a question", []),
    ),
    /cut short: the connection died/,
  );
  const disk = loadSession("cut")!;
  assert.equal(disk.turns.length, 1, "the text the reader saw was not recorded");
  assert.equal(disk.turns[0].a, "half an answer");
  assert.equal(disk.turns[0].partial, true);
});

test("a cut-short turn says so in an export", async () => {
  const s = newSession("cutexport");
  saveSession(s);
  await assert.rejects(
    quietly(() => askAndRecord(engine({ stream: ["some text\n\n"], fail: "gone" }), s, "q", [])),
    /cut short/,
  );
  assert.match(exportSessionMarkdown(loadSession("cutexport")!), /cut short/);
});

test("a failure before anything arrived records nothing and keeps its message", async () => {
  const s = newSession("nothing");
  saveSession(s);
  await assert.rejects(
    quietly(() => askAndRecord(engine({ fail: "refused at the door" }), s, "q", [])),
    (e: unknown) => {
      assert.equal((e as Error).message, "refused at the door", "the message was rewritten");
      return true;
    },
  );
  assert.equal(loadSession("nothing")!.turns.length, 0);
});

test("whitespace alone does not count as an answer worth keeping", async () => {
  const s = newSession("blank");
  saveSession(s);
  await assert.rejects(
    quietly(() => askAndRecord(engine({ stream: ["  \n "], fail: "died" }), s, "q", [])),
    /^Error: died$/,
  );
  assert.equal(loadSession("blank")!.turns.length, 0);
});

test("a cut-short answer reports the turn it was recorded as", async () => {
  const { CutShortError } = await import("../src/cli.js");
  const s = newSession("cutturn");
  s.turns.push({ q: "earlier", a: "answer", at: 1 });
  saveSession(s);
  await assert.rejects(
    quietly(() => askAndRecord(engine({ stream: ["partial\n\n"], fail: "died" }), s, "q", [])),
    (e: unknown) => {
      assert.ok(e instanceof CutShortError);
      assert.equal((e as InstanceType<typeof CutShortError>).turn, 2);
      return true;
    },
  );
  assert.equal(loadSession("cutturn")!.turns.length, 2);
});

// Nothing durable reached the screen, so there is no "answer above" to speak of
// and nothing worth keeping.
test("a failure before any block printed records nothing", async () => {
  const s = newSession("unflushed");
  saveSession(s);
  await assert.rejects(
    quietly(() => askAndRecord(engine({ stream: ["half a sentence, no boundary"], fail: "died" }), s, "q", [])),
    /^Error: died$/,
  );
  assert.equal(loadSession("unflushed")!.turns.length, 0);
});

test("a cut-short turn keeps the sources that had arrived", async () => {
  const s = newSession("cutsources");
  saveSession(s);
  const sources = [{ title: "T", url: "https://t.example" }];
  const ask = async (_req: AskRequest, hooks: Hooks): Promise<Answer> => {
    hooks.onSources?.(sources);
    hooks.onDelta?.("half of it [1]\n\n");
    throw new Error("broke off");
  };
  await assert.rejects(quietly(() => askAndRecord(ask, s, "q", [])), /cut short: broke off/);
  const disk = loadSession("cutsources")!;
  assert.equal(disk.turns[0].partial, true);
  assert.deepEqual(disk.turns[0].sources, sources);
});
