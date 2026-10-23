import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStudio, stopStudio } from "../../src/open.js";
import { readStudioState, studioStatePath } from "../../src/state-file.js";
import { seedTake } from "./seed.js";

// openStudio against a real detached child: fake-serve.mjs runs runServe from
// the built dist with a window that is not a browser (build first, as every
// lane here does). Locally a cold start is about 1 s; the 15 s wait is the
// shipped default and CI is ~5x slower, so cases get 60 s.

const FAKE = fileURLToPath(new URL("./fake-serve.mjs", import.meta.url));
const DIE = fileURLToPath(new URL("./fake-die.mjs", import.meta.url));
const CASE_MS = 60_000;

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-open-"));
});
afterEach(async () => {
  // Never leave a detached studio behind, whatever the case did.
  const s = await readStudioState(home);
  if (s !== null && !("unreadable" in s) && s.pid !== process.pid) {
    try {
      process.kill(s.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await rm(home, { recursive: true, force: true });
});

const serveFake = (version = "0.0.0-test") => ({
  command: process.execPath,
  args: [FAKE, home, version],
});
const servings = async (): Promise<number> =>
  (
    (await readFile(join(home, "studio.log"), "utf8")).match(
      /studio: serving/g,
    ) ?? []
  ).length;

describe("openStudio", () => {
  it(
    "starts a studio when none runs, and the file names a live pid",
    async () => {
      const a = await openStudio({
        home,
        version: "0.0.0-test",
        serve: serveFake(),
      });
      expect(a).toMatchObject({ outcome: "opened" });
      if (!("outcome" in a)) throw new Error(JSON.stringify(a));
      expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
      expect(a.note).toBeUndefined();
      const s = await readStudioState(home);
      if (s === null || "unreadable" in s) throw new Error("no studio.json");
      expect(() => process.kill(s.pid, 0)).not.toThrow();
      // the url carries a ticket, never the session token (R12)
      expect(a.url).not.toContain(s.token);
    },
    CASE_MS,
  );

  it(
    "reuses a running studio: same pid, one start in the log",
    async () => {
      const first = await openStudio({
        home,
        version: "0.0.0-test",
        serve: serveFake(),
      });
      const s1 = await readStudioState(home);
      const second = await openStudio({
        home,
        version: "0.0.0-test",
        serve: serveFake(),
      });
      const s2 = await readStudioState(home);
      expect(first).toMatchObject({ outcome: "opened" });
      expect(second).toMatchObject({ outcome: "opened" });
      if (s1 === null || "unreadable" in s1) throw new Error("no state");
      if (s2 === null || "unreadable" in s2) throw new Error("no state");
      expect(s2.pid).toBe(s1.pid);
      // A second spawn would have moved this log aside and started a new one.
      expect(existsSync(join(home, "studio.log.1"))).toBe(false);
      expect(await servings()).toBe(1);
    },
    CASE_MS,
  );

  it(
    "replaces a studio.json naming a dead pid, and says so (Review Focus 4)",
    async () => {
      // A pid that is certainly dead: a child that has exited.
      const dead = spawn(process.execPath, ["-e", ""]);
      const deadPid = dead.pid as number;
      await new Promise((r) => dead.on("exit", r));
      expect(() => process.kill(deadPid, 0)).toThrow();
      // Something still answers a ping on the recorded port, as the dead
      // studio's pid would on a port the system handed to another process:
      // only the pid check tells the record is stale.
      const impostor: Server = createServer((_q, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ version: "0.0.0-test", pid: deadPid, queued: 0 }),
        );
      });
      await new Promise<void>((r) => impostor.listen(0, "127.0.0.1", r));
      const port = (impostor.address() as { port: number }).port;
      try {
        await writeFile(
          studioStatePath(home),
          JSON.stringify({
            pid: deadPid,
            port,
            token: "old",
            startedAt: new Date().toISOString(),
            version: "0.0.0-test",
          }),
        );
        const a = await openStudio({
          home,
          version: "0.0.0-test",
          serve: serveFake(),
        });
        expect(a).toMatchObject({
          outcome: "opened",
          note: "A stale Studio record was replaced.",
        });
        const s = await readStudioState(home);
        if (s === null || "unreadable" in s) throw new Error("no state");
        expect(s.pid).not.toBe(deadPid);
        expect(() => process.kill(s.pid, 0)).not.toThrow();
      } finally {
        impostor.close();
      }
    },
    CASE_MS,
  );

  it(
    "answers studioDidNotStart, quoting the script's stderr, when the script exits at once",
    async () => {
      const a = await openStudio({
        home,
        version: "0.0.0-test",
        serve: { command: process.execPath, args: [DIE] },
      });
      expect(a).toMatchObject({ reason: "studioDidNotStart" });
      expect((a as { detail: string }).detail).toContain(
        "fake studio: cannot bind anything today",
      );
    },
    CASE_MS,
  );

  it(
    "answers studioDidNotStart when the script runs but never writes studio.json",
    async () => {
      const a = await openStudio({
        home,
        version: "0.0.0-test",
        waitMs: 400,
        serve: {
          command: process.execPath,
          args: ["-e", "setTimeout(()=>{},3000)"],
        },
      });
      expect(a).toMatchObject({ reason: "studioDidNotStart" });
      expect((a as { detail: string }).detail).toContain(
        "did not write studio.json",
      );
    },
    CASE_MS,
  );

  it(
    "refuses an unknown take before anything starts",
    async () => {
      const a = await openStudio({
        home,
        takeId: "no-such-take",
        version: "0.0.0-test",
        serve: serveFake(),
      });
      expect(a).toMatchObject({ reason: "takeNotFound" });
      expect(existsSync(join(home, "studio.log"))).toBe(false);
      expect(existsSync(studioStatePath(home))).toBe(false);
    },
    CASE_MS,
  );

  it(
    "opens a known take and says which",
    async () => {
      const { takeId } = await seedTake(home);
      const a = await openStudio({
        home,
        takeId,
        version: "0.0.0-test",
        serve: serveFake(),
      });
      expect(a).toMatchObject({ outcome: "opened", takeId });
      expect((a as { url: string }).url).toContain(
        `take=${encodeURIComponent(takeId)}`,
      );
    },
    CASE_MS,
  );

  it(
    "stops an older Studio with nothing queued and starts its own (version skew)",
    async () => {
      await openStudio({ home, version: "0.0.1", serve: serveFake("0.0.1") });
      const old = await readStudioState(home);
      if (old === null || "unreadable" in old) throw new Error("no state");
      const a = await openStudio({
        home,
        version: "0.0.2",
        serve: serveFake("0.0.2"),
      });
      expect(a).toMatchObject({ outcome: "opened" });
      const now = await readStudioState(home);
      if (now === null || "unreadable" in now) throw new Error("no state");
      expect(now.version).toBe("0.0.2");
      expect(now.pid).not.toBe(old.pid);
      expect(() => process.kill(old.pid, 0)).toThrow();
    },
    CASE_MS,
  );
  it(
    "two concurrent opens share one studio: same pid, one process, both opened",
    async () => {
      const [a, b] = await Promise.all([
        openStudio({ home, version: "0.0.0-test", serve: serveFake() }),
        openStudio({ home, version: "0.0.0-test", serve: serveFake() }),
      ]);
      expect(a).toMatchObject({ outcome: "opened" });
      expect(b).toMatchObject({ outcome: "opened" });
      // Premise: both really ran together, so the lock was what separated them.
      expect(existsSync(join(home, "studio.start.lock"))).toBe(false);
      expect(existsSync(join(home, "studio.log.1"))).toBe(false);
      expect(await servings()).toBe(1);
    },
    CASE_MS,
  );

  it("refuses a malformed take id as takeNotFound, in a sentence", async () => {
    const a = await openStudio({
      home,
      takeId: "..",
      version: "0.0.0-test",
      serve: serveFake(),
    });
    expect(a).toMatchObject({ reason: "takeNotFound" });
    expect((a as { detail: string }).detail).toBe(
      '".." is not a take id, so no take has it.',
    );
    expect(existsSync(join(home, "studio.log"))).toBe(false);
  });

  it(
    "opens an older Studio holding an export, with the R15 note",
    async () => {
      await openStudio({ home, version: "0.0.1", serve: serveFake("0.0.1") });
      const old = await readStudioState(home);
      if (old === null || "unreadable" in old) throw new Error("no state");
      // An impostor on the old studio's record that reports queued work.
      const busy: Server = createServer((q, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          q.url === "/api/ping"
            ? JSON.stringify({ version: "0.0.1", pid: old.pid, queued: 1 })
            : JSON.stringify({ path: "/", url: "http://127.0.0.1:1/?t=x" }),
        );
      });
      await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
      try {
        await writeFile(
          studioStatePath(home),
          JSON.stringify({
            ...old,
            port: (busy.address() as { port: number }).port,
          }),
        );
        const a = await openStudio({
          home,
          version: "0.0.2",
          serve: serveFake("0.0.2"),
        });
        expect(a).toMatchObject({
          outcome: "opened",
          note: "An older Studio is running an export; it stays open until that export ends and its window closes, and the next Studio call starts the new version.",
        });
        const now = await readStudioState(home);
        if (now === null || "unreadable" in now) throw new Error("no state");
        expect(now.pid).toBe(old.pid);
      } finally {
        busy.close();
      }
    },
    CASE_MS,
  );
});

describe("stopStudio", () => {
  it(
    "ends a running studio, and says nothing was running afterwards",
    async () => {
      await openStudio({ home, version: "0.0.0-test", serve: serveFake() });
      const s = await readStudioState(home);
      if (s === null || "unreadable" in s) throw new Error("no state");
      expect(await stopStudio({ home })).toEqual({
        stopped: true,
        cutShort: 0,
      });
      expect(() => process.kill(s.pid, 0)).toThrow();
      expect(await stopStudio({ home })).toEqual({
        stopped: false,
        cutShort: 0,
      });
    },
    CASE_MS,
  );

  it("leaves a pid that is not a studio alone", async () => {
    // A live process the record names but that answers no ping: ours.
    await writeFile(
      studioStatePath(home),
      JSON.stringify({
        pid: process.pid,
        port: 1,
        token: "x",
        startedAt: new Date().toISOString(),
        version: "0.0.0-test",
      }),
    );
    const r = await stopStudio({ home });
    expect(r).toMatchObject({ stopped: false, cutShort: 0 });
    // Could not tell is not "nothing running": it says what it found.
    expect(r.why).toContain(`pid ${process.pid} is alive but did not answer`);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("says why when studio.json is unreadable, not that nothing runs", async () => {
    await writeFile(studioStatePath(home), "{not json");
    const r = await stopStudio({ home });
    expect(r.stopped).toBe(false);
    expect(r.why).toBe("studio.json is not valid JSON");
  });

  it("says nothing was running, without a reason, when there is no file", async () => {
    expect(await stopStudio({ home })).toEqual({ stopped: false, cutShort: 0 });
  });
});
