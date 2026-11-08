import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { breakIfStill, takePidLock } from "../src/executor/pid-lock.js";

// A slow disk, on demand: a file under the test's folder exists, empty, for
// 100 ms before its text lands. Off, writeFile is the real one.
const slow = vi.hoisted(() => ({ on: false, hits: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile = (async (file, data, options) => {
    if (slow.on && String(file).includes("pid-lock-")) {
      slow.hits++;
      await fs.writeFile(file, "", options);
      await new Promise((r) => setTimeout(r, 100));
      return fs.writeFile(file, data, { ...(options as object), flag: "w" });
    }
    return fs.writeFile(file, data, options);
  }) as typeof fs.writeFile;
  return { ...fs, default: { ...fs, writeFile }, writeFile };
});

const deadPid = () => spawnSync("true").pid as number;

let dir: string;
let lock: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pid-lock-"));
  lock = join(dir, "x.lock");
});
afterEach(async () => {
  slow.on = false;
  slow.hits = 0;
  await rm(dir, { recursive: true, force: true });
});

describe("takePidLock", () => {
  // Red: make breakIfStill remove the lock without re-reading it. B, which
  // judged the same dead lock as A, then removes A's live lock and both hold
  // it — the double takeover the audit found in three locks.
  it("a waiter that judged a dead lock does not break the one taken since", async () => {
    const dead = `${deadPid()} old-token\n`;
    await writeFile(lock, dead);
    // Premise: the holder really is dead.
    expect(() => process.kill(Number.parseInt(dead, 10), 0)).toThrow();
    const a = await takePidLock(lock, 1000);
    if (!a.ok) throw new Error(`A did not take it: ${JSON.stringify(a)}`);
    const aText = await readFile(lock, "utf8");
    expect(aText.startsWith(`${process.pid} `)).toBe(true);
    // B acts on its earlier read of the dead lock.
    await breakIfStill(lock, dead);
    expect(await readFile(lock, "utf8")).toBe(aText);
    await a.release();
    expect(existsSync(lock)).toBe(false);
  });

  it("many takers of one dead lock never hold it together", async () => {
    await writeFile(lock, `${deadPid()} old-token\n`);
    let active = 0;
    let most = 0;
    let ran = 0;
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        const taken = await takePidLock(lock, 5000, 2);
        if (!taken.ok) throw new Error(JSON.stringify(taken));
        active++;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 3));
        active--;
        ran++;
        await taken.release();
      }),
    );
    expect(ran).toBe(12);
    expect(most).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  // Red: take the lock with `open(path, "wx")` and write the pid after. A
  // waiter reads the empty lock as no pid, breaks it, and both hold it — the
  // two Studios of DEM-66, made certain here by a slow write.
  it("a waiter that comes while the holder's text is still being written does not break it", async () => {
    slow.on = true;
    let active = 0;
    let most = 0;
    await Promise.all(
      [0, 1].map(async () => {
        const taken = await takePidLock(lock, 5000, 2);
        if (!taken.ok) throw new Error(JSON.stringify(taken));
        active++;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        await taken.release();
      }),
    );
    // Premise: the writes really were slow.
    expect(slow.hits).toBeGreaterThan(0);
    expect(most).toBe(1);
  });

  it("waits out a live holder, then names it", async () => {
    const held = await takePidLock(lock, 1000);
    if (!held.ok) throw new Error(JSON.stringify(held));
    const started = Date.now();
    const second = await takePidLock(lock, 100);
    expect(second).toEqual({ ok: false, holder: process.pid });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await held.release();
  });

  it("takes over a lock with no pid in it (an older format)", async () => {
    await writeFile(lock, "");
    const taken = await takePidLock(lock, 1000);
    expect(taken.ok).toBe(true);
    if (taken.ok) await taken.release();
  });

  it("says so when its lock was replaced before release", async () => {
    const taken = await takePidLock(lock, 1000);
    if (!taken.ok) throw new Error(JSON.stringify(taken));
    await writeFile(lock, "1 someone-else\n");
    await expect(taken.release()).rejects.toThrow(
      /no longer this process's lock .*it named 1 someone-else/,
    );
    // Left alone: it is not ours to remove.
    expect(await readFile(lock, "utf8")).toBe("1 someone-else\n");
  });
});
