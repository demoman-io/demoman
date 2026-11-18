import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSuiteLock } from "./suite-lock.mjs";

const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "suite-lock-")), "suite.lock");
const holder = (pid, cwd = "/x") =>
  JSON.stringify({
    pid,
    command: "vitest",
    cwd,
    startedAt: new Date().toISOString(),
  });
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("takes a free lock and writes its holder", async () => {
  const file = fresh();
  await acquireSuiteLock({
    file,
    pid: 111,
    command: "vitest",
    cwd: "/x",
    say() {},
  });
  const rec = read(file);
  assert.equal(rec.pid, 111);
  assert.equal(rec.command, "vitest");
  assert.equal(rec.cwd, "/x");
  assert.equal(typeof rec.startedAt, "string");
});

test("waits for a live holder and names it", async () => {
  const file = fresh();
  writeFileSync(file, holder(222, "/repo/apps/runner"));
  let polls = 0;
  let sleeps = 0;
  const lines = [];
  await acquireSuiteLock({
    file,
    pid: 111,
    say: (l) => lines.push(l),
    isAlive: () => {
      polls++;
      return polls <= 3;
    },
    sleep: async () => {
      sleeps++;
      if (sleeps === 3) rmSync(file);
    },
  });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /waiting for pid 222 \(vitest in \/repo\/apps\/runner/);
  assert.ok(sleeps >= 3, `slept ${sleeps} times`);
});

test("repeats the waiting line every sayEveryMs", async () => {
  const file = fresh();
  writeFileSync(file, holder(222));
  let t = 0;
  let sleeps = 0;
  const lines = [];
  await acquireSuiteLock({
    file,
    pid: 111,
    sayEveryMs: 60000,
    now: () => t,
    say: (l) => lines.push(l),
    isAlive: () => true,
    sleep: async () => {
      t += 30000;
      if (++sleeps === 5) rmSync(file);
    },
  });
  assert.equal(sleeps, 5);
  assert.equal(lines.length, 3, lines.join("\n"));
});

test("takes a lock whose holder is gone, and says so", async () => {
  const file = fresh();
  writeFileSync(file, holder(333));
  const lines = [];
  await acquireSuiteLock({
    file,
    pid: 111,
    say: (l) => lines.push(l),
    isAlive: () => false,
    sleep: async () => assert.fail("slept"),
  });
  assert.match(lines.join("\n"), /pid 333 .*is gone; taking it/);
  assert.equal(read(file).pid, 111);
});

test("takes a corrupt lock file, and says so", async () => {
  const file = fresh();
  writeFileSync(file, "{");
  const lines = [];
  await acquireSuiteLock({ file, pid: 111, say: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /unreadable/);
  assert.equal(read(file).pid, 111);
});

test("release leaves someone else's lock alone", async () => {
  const file = fresh();
  const release = await acquireSuiteLock({ file, pid: 111, say() {} });
  writeFileSync(file, holder(444));
  release();
  assert.equal(read(file).pid, 444);
});

test("release removes its own lock", async () => {
  const file = fresh();
  const release = await acquireSuiteLock({ file, pid: 111, say() {} });
  release();
  assert.throws(() => readFileSync(file), /ENOENT/);
});

test("two acquirers never both hold it", async () => {
  const file = fresh();
  const alive = new Set([1, 2]);
  const log = [];
  const run = async (pid) => {
    const release = await acquireSuiteLock({
      file,
      pid,
      say() {},
      isAlive: (p) => alive.has(p),
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    });
    log.push(`in ${pid}`);
    await new Promise((r) => setTimeout(r, 20));
    log.push(`out ${pid}`);
    release();
  };
  await Promise.all([run(1), run(2)]);
  assert.equal(log.length, 4);
  assert.equal(log[0].replace("in", "out"), log[1], log.join(", "));
  assert.equal(log[2].replace("in", "out"), log[3], log.join(", "));
});

test("two waiters that read the same dead holder never both take it", async () => {
  const file = fresh();
  writeFileSync(file, holder(333));
  const alive = new Set([1, 2]);
  const log = [];
  let readers = 0;
  const run = async (pid) => {
    const release = await acquireSuiteLock({
      file,
      pid,
      say() {},
      // Yields after both waiters read the dead record and before either
      // removes it: the interleaving a 2 s poll makes realistic.
      isAlive: async (p) => {
        if (p !== 333) return alive.has(p);
        readers++;
        await new Promise((r) => setTimeout(r, 10));
        return false;
      },
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    });
    log.push(`in ${pid}`);
    await new Promise((r) => setTimeout(r, 30));
    log.push(`out ${pid}`);
    release();
  };
  await Promise.all([run(1), run(2)]);
  assert.ok(readers >= 2, `both read the dead holder (${readers})`);
  assert.equal(log.length, 4, log.join(", "));
  assert.equal(log[0].replace("in", "out"), log[1], log.join(", "));
  assert.equal(log[2].replace("in", "out"), log[3], log.join(", "));
});
