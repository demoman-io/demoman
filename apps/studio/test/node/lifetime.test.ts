import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportAnswer } from "@demoman/run-core";
import type { Exporting } from "@demoman/runner/studio";
import { STUDIO_HEADER } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pagePathFor } from "../../src/paths.js";
import type { RunExport } from "../../src/queue.js";
import { runServe } from "../../src/serve.js";
import {
  readStudioState,
  type StudioState,
  studioStatePath,
} from "../../src/state-file.js";
import type { StudioWindow } from "../../src/window.js";
import { writePages } from "./harness.js";
import { seedTake } from "./seed.js";

// runServe against fakes: the window is not a browser and `run` is not a
// render (Task 13 drives the real ones). `exit` and the signal emitter are
// injected, so "the process exited" is a call this test can watch.

const flush = () => new Promise<void>((r) => setImmediate(r));

interface Serve {
  state: StudioState;
  logs: string[];
  opens: { takeId?: string }[];
  /** With `holdOpens`: each open still in flight, settled by the test. */
  held: ((answer: Awaited<ReturnType<StudioWindow["open"]>>) => void)[];
  windowsMade: () => number;
  windowCloses: () => number;
  fireAllClosed(): void;
  runs: {
    takeId: string;
    finish(a: ExportAnswer): void;
    onProgress: (p: Exporting) => void;
    quality: string | undefined;
  }[];
  /** Each exit, and whether studio.json was still there when it ran. */
  exits: { code: number; stateLeft: boolean }[];
  exited: Promise<number>;
  signals: EventEmitter;
}

let home: string;
let live: Serve | null = null;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-lifetime-"));
});
afterEach(async () => {
  // A case that left its studio running stops it, so no server outlives it.
  if (live !== null && live.exits.length === 0) {
    live.signals.emit("SIGTERM");
    await live.exited;
  }
  live = null;
  await rm(home, { recursive: true, force: true });
});

async function serve(
  o: {
    pagesDir?: string;
    noWindowMs?: number;
    waitForState?: boolean;
    /** Opens stay in flight until the test settles them (`held`). */
    holdOpens?: boolean;
  } = {},
): Promise<Serve> {
  const logs: string[] = [];
  const opens: { takeId?: string }[] = [];
  const held: Serve["held"] = [];
  const closedFns: (() => void)[] = [];
  let made = 0;
  let closes = 0;
  const runs: Serve["runs"] = [];
  const exits: Serve["exits"] = [];
  let exitWith: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    exitWith = r;
  });
  const signals = new EventEmitter();
  const pagesDir = o.pagesDir ?? join(home, "pages");
  if (o.pagesDir === undefined) await writePages(pagesDir);

  const run: RunExport = (takeId, _fileType, _jobId, onProgress, quality) =>
    new Promise((finish) => runs.push({ takeId, finish, onProgress, quality }));

  void runServe({
    home,
    outDir: join(home, "out"),
    pagesDir,
    version: "0.0.0-test",
    log: (line) => logs.push(line),
    createWindow: () => {
      made += 1;
      const window: StudioWindow = {
        async open(t) {
          opens.push(t);
          if (o.holdOpens === true) {
            return new Promise((settle) => held.push(settle));
          }
          return { ok: true, path: pagePathFor(t.takeId) };
        },
        onAllClosed(fn) {
          closedFns.push(fn);
        },
        async close() {
          closes += 1;
        },
      };
      return window;
    },
    exit: (code) => {
      exits.push({ code, stateLeft: existsSync(studioStatePath(home)) });
      exitWith(code);
    },
    signals,
    noWindowMs: o.noWindowMs ?? 60_000,
    run,
  });

  let state: StudioState | null = null;
  if (o.waitForState !== false) {
    state = await vi.waitFor(
      async () => {
        const s = await readStudioState(home);
        if (s === null || "unreadable" in s)
          throw new Error("no studio.json yet");
        return s;
      },
      { timeout: 5_000, interval: 20 },
    );
  }
  const handle: Serve = {
    state: state as StudioState,
    logs,
    opens,
    held,
    windowsMade: () => made,
    windowCloses: () => closes,
    fireAllClosed: () => {
      for (const fn of closedFns) fn();
    },
    runs,
    exits,
    exited,
    signals,
  };
  live = handle;
  return handle;
}

function call(
  s: StudioState,
  path: string,
  o: { method?: string; body?: unknown; api?: boolean } = {},
): Promise<{ status: number; json: () => unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: s.port,
        path,
        method: o.method ?? "GET",
        headers: {
          Host: `127.0.0.1:${s.port}`,
          Cookie: `studio=${s.token}`,
          ...(o.api === false ? {} : { [STUDIO_HEADER]: "1" }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text,
            json: () => JSON.parse(text) as unknown,
          }),
        );
      },
    );
    req.on("error", reject);
    if (o.body !== undefined) req.write(JSON.stringify(o.body));
    req.end();
  });
}

/** An open `GET /api/events`, read until the server ends it. */
function events(s: StudioState): Promise<{
  text(): string;
  waitFor(needle: string): Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    let text = "";
    const req = request(
      {
        host: "127.0.0.1",
        port: s.port,
        path: "/api/events",
        headers: {
          Host: `127.0.0.1:${s.port}`,
          Cookie: `studio=${s.token}`,
          [STUDIO_HEADER]: "1",
        },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        resolve({
          text: () => text,
          waitFor: (needle) =>
            vi.waitFor(
              () => {
                if (!text.includes(needle)) {
                  throw new Error(
                    `no ${needle} in the stream; it held:\n${text}`,
                  );
                }
              },
              { timeout: 5_000, interval: 10 },
            ),
        });
      },
    );
    req.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
    });
    req.end();
  });
}

const savedAnswer = (takeId: string): ExportAnswer =>
  ({
    outcome: "saved",
    takeId,
    fileType: "mp4",
    aspect: "16:9",
    width: 1280,
    height: 720,
    fps: 30,
    file: { path: `/out/${takeId}.mp4`, byteLength: 10, downloadId: null },
    warnings: { logo: null, unavailableSpans: [], detailViolations: [] },
    summary: `Saved /out/${takeId}.mp4 (1280×720, 30 fps).`,
  }) as ExportAnswer;

/** A window opened, an event stream, and one export running. */
async function exportRunning(s: Serve) {
  const { takeId } = await seedTake(home);
  const opened = await call(s.state, "/api/window", {
    method: "POST",
    body: {},
  });
  expect(opened.status, opened.text).toBe(200);
  // Red: a `url` with a fresh ticket in it, which reaches agent transcripts
  // and stdout as a live credential (audit run 1).
  expect(opened.json()).toEqual({ path: "/" });
  const stream = await events(s.state);
  const read = await call(s.state, `/api/takes/${takeId}/scene`);
  const { revision } = read.json() as { revision: string };
  const started = await call(s.state, `/api/takes/${takeId}/exports`, {
    method: "POST",
    body: { fileType: "mp4", revision },
  });
  expect(started.status, started.text).toBe(200);
  expect(started.json()).toMatchObject({ position: 0 });
  await vi.waitFor(() => {
    if (s.runs.length !== 1) throw new Error(`${s.runs.length} runs started`);
  });
  return { takeId, stream };
}

describe("the Studio's lifetime (Review Focus 3)", () => {
  it("a window closed mid-export: the process stays until the job is saved, then exits and removes studio.json", async () => {
    const s = await serve();
    const { takeId, stream } = await exportRunning(s);

    s.fireAllClosed();
    // Red: stop on onAllClosed without waiting for the queue — the server
    // has stopped listening by now (its close starts in the same tick), so
    // this ping is refused, and the pages have been told it is stopping.
    const ping = await call(s.state, "/api/ping");
    expect(ping.json()).toMatchObject({ queued: 1 });
    expect(stream.text()).not.toContain("server:stopping");
    expect(s.exits, "exited with an export still running").toEqual([]);

    const job = s.runs[0];
    if (job === undefined) throw new Error("the export never ran");
    job.onProgress({
      outcome: "exporting",
      phase: "rendering",
      done: 1,
      total: 1,
    });
    job.finish(savedAnswer(takeId));

    expect(await s.exited).toBe(0);
    expect(s.exits).toEqual([{ code: 0, stateLeft: false }]);
    await stream.waitFor("event: server:stopping");
    const text = stream.text();
    expect(text.indexOf('"phase":"saved"')).toBeGreaterThan(-1);
    expect(text.indexOf('"phase":"saved"')).toBeLessThan(
      text.indexOf("event: server:stopping"),
    );
    expect(s.windowCloses()).toBe(1);
    expect(s.logs.join("\n")).toContain("finishing 1 export first");
  });

  it("a window asked for during that drain opens on the same process, which then outlives the drain", async () => {
    const s = await serve();
    const { takeId, stream } = await exportRunning(s);
    s.fireAllClosed();

    const again = await call(s.state, "/api/window", {
      method: "POST",
      body: { takeId },
    });
    expect(again.status, again.text).toBe(200);
    expect(again.json()).toMatchObject({ path: pagePathFor(takeId) });
    expect(s.opens).toEqual([{}, { takeId }]);
    expect(s.windowsMade(), "the same window instance").toBe(1);

    s.runs[0]?.finish(savedAnswer(takeId));
    await stream.waitFor('"phase":"saved"');
    await flush();
    await flush();
    // Red: ignore the reopened window when the drain ends.
    expect(s.exits, "exited though a window is open again").toEqual([]);
    expect(existsSync(studioStatePath(home))).toBe(true);

    s.fireAllClosed();
    expect(await s.exited).toBe(0);
    expect(s.exits).toEqual([{ code: 0, stateLeft: false }]);
  });

  it("with nothing queued, the last window closing exits at once", async () => {
    const s = await serve();
    const opened = await call(s.state, "/api/window", {
      method: "POST",
      body: {},
    });
    expect(opened.status).toBe(200);
    s.fireAllClosed();
    expect(await s.exited).toBe(0);
    expect(s.exits).toEqual([{ code: 0, stateLeft: false }]);
  });
});

describe("the window answer (R12)", () => {
  // Red: answer `url: o.entryUrl(takeId)` — a fresh, unspent ticket that
  // reaches agent transcripts and stdout as a live credential (audit run 1).
  it("names the page and carries no link", async () => {
    const s = await serve();
    const { takeId } = await seedTake(home);
    const r = await call(s.state, "/api/window", {
      method: "POST",
      body: { takeId },
    });
    expect(r.status, r.text).toBe(200);
    expect(r.json()).toEqual({ path: pagePathFor(takeId) });
  });
});

describe("stopping", () => {
  it("SIGTERM sends server:stopping, closes the browser, removes studio.json and exits", async () => {
    const s = await serve();
    await call(s.state, "/api/window", { method: "POST", body: {} });
    const stream = await events(s.state);
    s.signals.emit("SIGTERM");
    expect(await s.exited).toBe(0);
    await stream.waitFor("event: server:stopping");
    expect(s.exits).toEqual([{ code: 0, stateLeft: false }]);
    expect(s.windowCloses()).toBe(1);
    expect(s.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("no window within noWindowMs: the Studio stops and says why", async () => {
    const s = await serve({ noWindowMs: 50 });
    expect(await s.exited).toBe(0);
    expect(s.exits).toEqual([{ code: 0, stateLeft: false }]);
    expect(s.opens).toEqual([]);
    expect(s.logs.join("\n")).toMatch(/no window opened within/);
  });

  it("an open still in flight when the wait runs out keeps the Studio up (M1)", async () => {
    const s = await serve({ noWindowMs: 50, holdOpens: true });
    const answer = call(s.state, "/api/window", { method: "POST", body: {} });
    await vi.waitFor(() => {
      if (s.held.length !== 1) throw new Error(`${s.held.length} opens held`);
    });
    // Premise: the wait has run out with the open still in flight.
    await vi.waitFor(
      () => {
        if (!s.logs.join("\n").includes("one is still opening"))
          throw new Error(`logs:\n${s.logs.join("\n")}`);
      },
      { timeout: 2_000, interval: 10 },
    );
    // Red: drop the in-flight count from the no-window check — the studio
    // stops underneath its own launch.
    expect(s.exits, "stopped under an open in flight").toEqual([]);
    s.held[0]?.({ ok: true, path: "/" });
    expect((await answer).status).toBe(200);
    await flush();
    await flush();
    expect(s.exits, "stopped though the open worked").toEqual([]);
    expect(s.logs.join("\n")).not.toMatch(/no window opened within/);
  });

  it("an open in flight that then fails: the deferred wait stops the Studio", async () => {
    const s = await serve({ noWindowMs: 50, holdOpens: true });
    const answer = call(s.state, "/api/window", { method: "POST", body: {} });
    await vi.waitFor(
      () => {
        if (!s.logs.join("\n").includes("one is still opening"))
          throw new Error(`logs:\n${s.logs.join("\n")}`);
      },
      { timeout: 2_000, interval: 10 },
    );
    expect(s.exits).toEqual([]);
    s.held[0]?.({ reason: "windowDidNotOpen", detail: "Chrome did not start" });
    expect((await answer).status).toBe(500);
    expect(await s.exited).toBe(0);
    expect(s.exits).toEqual([{ code: 0, stateLeft: false }]);
    expect(s.logs.join("\n")).toMatch(/no window opened within/);
  });
});

describe("the window and export routes", () => {
  it("an unknown take is refused takeNotFound and opens nothing", async () => {
    const s = await serve();
    const r = await call(s.state, "/api/window", {
      method: "POST",
      body: { takeId: "no-such-take" },
    });
    expect(r.status).toBe(404);
    expect(r.json()).toMatchObject({ reason: "takeNotFound" });
    expect(s.opens).toEqual([]);
  });

  it("a stale revision is 409 sceneNotSaved; a bad file type is 400", async () => {
    const s = await serve();
    const { takeId } = await seedTake(home);
    const stale = await call(s.state, `/api/takes/${takeId}/exports`, {
      method: "POST",
      body: { fileType: "mp4", revision: "not-the-revision" },
    });
    expect(stale.status).toBe(409);
    expect(stale.json()).toEqual({
      reason: "sceneNotSaved",
      detail: "The editor has changes that are not saved yet.",
    });
    const bad = await call(s.state, `/api/takes/${takeId}/exports`, {
      method: "POST",
      body: { fileType: "mov", revision: "x" },
    });
    expect(bad.status).toBe(400);
    expect(bad.json()).toMatchObject({ reason: "invalidFileType" });
    expect(s.runs).toEqual([]);
  });

  // Red if the route drops the editor's quality, or lets one through that
  // the export would refuse or ignore.
  it("an MP4's quality reaches the run; a bad one, or one on a GIF, is 400", async () => {
    const s = await serve();
    const { takeId } = await seedTake(home);
    const read = await call(s.state, `/api/takes/${takeId}/scene`);
    const { revision } = read.json() as { revision: string };
    for (const body of [
      { fileType: "mp4", revision, quality: "best" },
      { fileType: "gif", revision, quality: "full" },
    ]) {
      const bad = await call(s.state, `/api/takes/${takeId}/exports`, {
        method: "POST",
        body,
      });
      expect(bad.status, bad.text).toBe(400);
      expect(bad.json()).toMatchObject({ reason: "exportQualityInvalid" });
    }
    expect(s.runs).toEqual([]);
    const started = await call(s.state, `/api/takes/${takeId}/exports`, {
      method: "POST",
      body: { fileType: "mp4", revision, quality: "full" },
    });
    expect(started.status, started.text).toBe(200);
    await vi.waitFor(() => {
      if (s.runs.length !== 1) throw new Error(`${s.runs.length} runs started`);
    });
    expect(s.runs[0]?.quality).toBe("full");
  });

  it("ping's queued counts the export queue", async () => {
    const s = await serve();
    await exportRunning(s);
    const ping = await call(s.state, "/api/ping");
    expect(ping.json()).toMatchObject({ queued: 1, version: "0.0.0-test" });
  });
});

describe("start-up checks", () => {
  async function checkout(stampAgeMs: number) {
    const app = join(home, "repo", "apps", "studio");
    const pagesDir = join(app, ".output", "pages");
    await mkdir(join(app, "pages", "src"), { recursive: true });
    await writeFile(join(app, "package.json"), "{}\n");
    await writePages(pagesDir);
    await writeFile(
      join(pagesDir, "studio-build.json"),
      JSON.stringify({ sha: "abc1234", builtAt: "2026-10-16T00:00:00Z" }),
    );
    const source = join(app, "pages", "src", "main.ts");
    await writeFile(source, "export {};\n");
    const now = Date.now() / 1000;
    await utimes(source, now, now);
    const stamp = now + stampAgeMs / 1000;
    await utimes(join(pagesDir, "studio-build.json"), stamp, stamp);
    return pagesDir;
  }

  it("refuses a checkout's pages older than their source, before writing studio.json", async () => {
    const pagesDir = await checkout(-60_000);
    // A short no-window wait, so the red version ends (with 0) rather than
    // timing out.
    const s = await serve({ pagesDir, waitForState: false, noWindowMs: 200 });
    // Red: drop the checkPagesFresh call in runServe.
    expect(await s.exited).toBe(1);
    expect(s.exits).toEqual([{ code: 1, stateLeft: false }]);
    expect(s.logs.join("\n")).toMatch(/older than the source/);
  });

  it("serves a checkout's fresh pages and logs their build sha", async () => {
    const pagesDir = await checkout(60_000);
    const s = await serve({ pagesDir });
    expect(s.exits).toEqual([]);
    expect(s.logs.join("\n")).toContain("pages built from abc1234");
  });

  // Pages no longer read settings.json (the studio is dark only, spec
  // 2026-10-19 §6). Red: read the file per page load again and log on it.
  it("an unreadable settings file does not touch a page load", async () => {
    await writeFile(join(home, "settings.json"), "{ not json");
    const s = await serve();
    for (let i = 0; i < 3; i += 1) {
      const page = await call(s.state, "/", { api: false });
      expect(page.status).toBe(200);
    }
    expect(s.logs.filter((l) => /theme|settings\.json/.test(l))).toEqual([]);
  });
});
