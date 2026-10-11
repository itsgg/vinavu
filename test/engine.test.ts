import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { askEngine, createLineReader, engineCommand, isResearch, EngineError } = await import("../src/engine.js");

const DIR = mkdtempSync(join(tmpdir(), "vinavu-engine-"));

/** A fake engine: `body` runs with `req` (the parsed request) and `out` (write one event). */
function fake(name: string, body: string): string[] {
  const file = join(DIR, `${name}.mjs`);
  writeFileSync(
    file,
    `import { readFileSync } from "node:fs";
const req = process.argv[2] === "ask" ? JSON.parse(readFileSync(0, "utf8")) : null;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
${body}
`,
  );
  return [process.execPath, file];
}

test("events reach their hooks and done resolves the answer", async () => {
  const cmd = fake(
    "ok",
    `out({ t: "status", text: "searching" });
out({ t: "sources", items: [{ title: "T", url: "https://t.example" }, { nonsense: true }] });
out({ t: "d", d: "Hel" }); out({ t: "d", d: "lo" });
out({ t: "done", content: "Hello " + req.query, model: "m", sources: [{ title: "T", url: "https://t.example" }],
      thread: { backend_uuid: "b", read_write_token: "r", slug: "s" }, url: "https://p/s" });`,
  );
  const seen: string[] = [];
  const a = await askEngine(
    { query: "world" },
    {
      onStatus: (t) => seen.push(`status:${t}`),
      onSources: (s) => seen.push(`sources:${s.length}`),
      onDelta: (d) => seen.push(`d:${d}`),
    },
    5000,
    cmd,
  );
  assert.deepEqual(seen, ["status:searching", "sources:1", "d:Hel", "d:lo"]);
  assert.equal(a.content, "Hello world");
  assert.deepEqual(a.thread, { backend_uuid: "b", read_write_token: "r", slug: "s" });
  assert.equal(a.url, "https://p/s");
});

test("an err event rejects with the engine's kind and a one-line message", async () => {
  const cmd = fake("err", `out({ t: "err", kind: "auth", error: "refused\\nsign in again" }); process.exit(1);`);
  await assert.rejects(askEngine({ query: "q" }, {}, 5000, cmd), (e: unknown) => {
    assert.ok(e instanceof EngineError);
    assert.equal((e as InstanceType<typeof EngineError>).kind, "auth");
    assert.equal((e as Error).message, "refused sign in again");
    return true;
  });
});

test("an engine that dies without answering is reported with its last stderr line", async () => {
  const cmd = fake("die", `process.stderr.write("Traceback\\nKeyError: 'x'\\n"); process.exit(2);`);
  await assert.rejects(askEngine({ query: "q" }, {}, 5000, cmd), /exited with code 2: KeyError: 'x'/);
});

test("silence past the deadline kills the engine and says so", async () => {
  const cmd = fake("hang", `out({ t: "status", text: "searching" }); setInterval(() => {}, 1000);`);
  const started = Date.now();
  await assert.rejects(askEngine({ query: "q" }, {}, 300, cmd), (e: unknown) => {
    assert.equal((e as InstanceType<typeof EngineError>).kind, "timeout");
    return true;
  });
  assert.ok(Date.now() - started < 3000);
});

test("each line resets the deadline, so a slow but steady answer completes", async () => {
  const cmd = fake(
    "steady",
    `let n = 0;
const t = setInterval(() => {
  if (++n < 5) out({ t: "status", text: "still working" });
  else { clearInterval(t); out({ t: "done", content: "made it", sources: [] }); }
}, 150);`,
  );
  const a = await askEngine({ query: "q" }, {}, 400, cmd);
  assert.equal(a.content, "made it");
});

test("the request reaches the engine whole", async () => {
  const cmd = fake("echo", `out({ t: "done", content: JSON.stringify(req), sources: [] });`);
  const req = { query: "q", model: "sonar", thread: { backend_uuid: "b" }, files: ["/a.pdf"] };
  const a = await askEngine(req, {}, 5000, cmd);
  assert.deepEqual(JSON.parse(a.content), req);
});

test("a missing engine command is named, with what to do", async () => {
  await assert.rejects(askEngine({ query: "q" }, {}, 5000, ["/nowhere/vinavu-engine"]), (e: unknown) => {
    assert.equal((e as InstanceType<typeof EngineError>).kind, "missing");
    assert.match((e as Error).message, /make install/);
    return true;
  });
});

test("the line reader handles split lines, bursts and split characters", () => {
  const lines: string[] = [];
  const read = createLineReader((l) => lines.push(l));
  const tamil = Buffer.from('{"d":"வினவு"}\n');
  read('{"a":1}\n{"b"');
  read(':2}\n\n');
  read(tamil.subarray(0, 8));
  read(tamil.subarray(8));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"d":"வினவு"}']);
});

test("the engine command comes from VINAVU_ENGINE, split on spaces", () => {
  assert.deepEqual(engineCommand({}), ["vinavu-engine"]);
  assert.deepEqual(engineCommand({ VINAVU_ENGINE: " uv run vinavu-engine " }), ["uv", "run", "vinavu-engine"]);
});

test("Deep Research is recognised by every name it goes by", () => {
  for (const m of ["research", "deep", "perplexity/deep-research", "Research"]) assert.ok(isResearch(m), m);
  for (const m of [undefined, "best", "sonar", "researcher"]) assert.ok(!isResearch(m), String(m));
});

// --- from review (Cursor gpt-5.6-sol-high, 2026-10-11) ----------------------

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an engine that lingers after answering is reaped after its grace period", async () => {
  const cmd = fake(
    "linger",
    `out({ t: "done", content: String(process.pid), sources: [] }); setInterval(() => {}, 1000);`,
  );
  const a = await askEngine({ query: "q" }, {}, 5000, cmd, { graceMs: 200, killMs: 200 });
  const pid = Number(a.content);
  assert.ok(alive(pid), "reaped before its grace period");
  await sleep(700);
  assert.ok(!alive(pid), "the engine outlived its answer");
});

test("an engine that ignores SIGTERM after a timeout is killed", async () => {
  const cmd = fake(
    "stubborn",
    `process.on("SIGTERM", () => {});
out({ t: "status", text: String(process.pid) }); setInterval(() => {}, 1000);`,
  );
  let pid = 0;
  await assert.rejects(
    askEngine({ query: "q" }, { onStatus: (t) => (pid = Number(t)) }, 300, cmd, { graceMs: 200, killMs: 300 }),
    /took too long/,
  );
  assert.ok(pid > 0);
  await sleep(150);
  assert.ok(alive(pid), "SIGTERM should have been ignored");
  await sleep(600);
  assert.ok(!alive(pid), "SIGKILL never came");
});
