import type { ExportAnswer, FileType } from "@demoman/run-core";
import type { Exporting, Library } from "@demoman/runner/studio";
import type { StudioEvent } from "@demoman/studio-protocol";
import { describe, expect, it } from "vitest";
import {
  createExportQueue,
  type RunExport,
  SCENE_NOT_SAVED,
} from "../../src/queue.js";
import { sceneFixture } from "./seed.js";

// The library is a stand-in whose reads resolve at once, so every step the
// queue takes is a microtask and `flush()` (one macrotask) is enough to let
// anything the queue was going to do happen. That is what lets a test say
// "run was NOT called" without a sleep.

const flush = () => new Promise<void>((r) => setImmediate(r));

async function fakeLibrary(ids: string[]) {
  const scene = await sceneFixture();
  const takes = new Map(ids.map((id) => [id, `rev-${id}`]));
  const library = {
    root: "/library",
    isTakeId: (id: string) => /^[\w-]+$/.test(id),
    async getSceneRead(id: string) {
      const revision = takes.get(id);
      return revision === undefined ? null : { scene, revision };
    },
  } as unknown as Library;
  return { library, takes };
}

/** A `run` whose every call waits for the test to finish it. */
function heldRun() {
  const calls: {
    takeId: string;
    fileType: FileType;
    jobId: string;
    onProgress: (p: Exporting) => void;
    finish: (a: ExportAnswer) => void;
  }[] = [];
  const run: RunExport = (takeId, fileType, jobId, onProgress) =>
    new Promise((finish) => {
      calls.push({ takeId, fileType, jobId, onProgress, finish });
    });
  return { run, calls };
}

const saved = (takeId: string): ExportAnswer =>
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

const shapeOf = (e: StudioEvent): string =>
  e.type === "export" ? `${e.phase}:${e.takeId}` : e.type;

describe("the export queue", () => {
  it("is FIFO, one job at a time: positions 0 and 1, events in job order", async () => {
    const { library } = await fakeLibrary(["a", "b"]);
    const events: StudioEvent[] = [];
    const { run, calls } = heldRun();
    const queue = createExportQueue({
      library,
      events: { send: (e) => events.push(e) },
      run,
      log: () => {},
    });

    // Both requests in flight at once, as two editors pressing Export.
    const answers = await Promise.all([
      queue.start("a", { fileType: "mp4", revision: "rev-a" }),
      queue.start("b", { fileType: "gif", revision: "rev-b" }),
    ]);
    expect(answers.map((a) => ("position" in a ? a.position : a))).toEqual([
      0, 1,
    ]);
    await flush();

    // Red: start jobs concurrently (drop the `running !== null` check in
    // pump): b's run is called here, before a's has resolved.
    expect(
      calls.map((c) => c.takeId),
      "only the first job runs while it is unfinished",
    ).toEqual(["a"]);
    expect(queue.size()).toBe(2);

    const first = calls[0];
    if (first === undefined) throw new Error("a's run was never called");
    first.onProgress({
      outcome: "exporting",
      phase: "rendering",
      done: 1,
      total: 2,
    });
    first.onProgress({
      outcome: "exporting",
      phase: "saving",
      done: 0,
      total: 0,
    });
    first.finish(saved("a"));
    await flush();

    expect(calls.map((c) => c.takeId)).toEqual(["a", "b"]);
    expect(calls[1]?.fileType).toBe("gif");
    const second = calls[1];
    if (second === undefined) throw new Error("b's run was never called");
    second.onProgress({
      outcome: "exporting",
      phase: "rendering",
      done: 2,
      total: 2,
    });
    second.finish(saved("b"));
    await queue.drained();

    expect(events.map(shapeOf)).toEqual([
      "queued:a",
      "queued:b",
      "rendering:a",
      "saving:a",
      "saved:a",
      "rendering:b",
      "saved:b",
    ]);
    const jobIds = answers.map((a) => ("jobId" in a ? a.jobId : null));
    expect(calls.map((c) => c.jobId)).toEqual(jobIds);
    const savedA = events.find(
      (e) => e.type === "export" && e.phase === "saved" && e.takeId === "a",
    );
    expect(savedA).toMatchObject({ jobId: jobIds[0], report: saved("a") });
    const rendering = events.find(
      (e) => e.type === "export" && e.phase === "rendering",
    );
    expect(rendering).toMatchObject({ done: 1, total: 2 });
    expect(queue.size()).toBe(0);
  });

  it("a stale revision is 409 sceneNotSaved, and run is never called", async () => {
    const { library } = await fakeLibrary(["a"]);
    const events: StudioEvent[] = [];
    const { run, calls } = heldRun();
    const queue = createExportQueue({
      library,
      events: { send: (e) => events.push(e) },
      run,
      log: () => {},
    });
    const answer = await queue.start("a", {
      fileType: "mp4",
      revision: "an-older-revision",
    });
    // Red: drop the revision comparison in admit.
    expect(answer).toEqual({
      reason: "sceneNotSaved",
      detail: SCENE_NOT_SAVED,
    });
    await flush();
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(queue.size()).toBe(0);
  });

  it("an unknown take is takeNotFound, before anything is queued", async () => {
    const { library } = await fakeLibrary([]);
    const { run, calls } = heldRun();
    const queue = createExportQueue({
      library,
      events: { send: () => {} },
      run,
      log: () => {},
    });
    const answer = await queue.start("gone", {
      fileType: "mp4",
      revision: "x",
    });
    expect(answer).toMatchObject({ reason: "takeNotFound" });
    await flush();
    expect(calls).toEqual([]);
  });

  it("a take deleted between start and its turn fails takeNotFound", async () => {
    const { library, takes } = await fakeLibrary(["a", "b"]);
    const events: StudioEvent[] = [];
    const { run, calls } = heldRun();
    const queue = createExportQueue({
      library,
      events: { send: (e) => events.push(e) },
      run,
      log: () => {},
    });
    await queue.start("a", { fileType: "mp4", revision: "rev-a" });
    const b = await queue.start("b", { fileType: "mp4", revision: "rev-b" });
    expect(b).toMatchObject({ position: 1 });
    // Premise: b was admitted, so its take existed when it was queued.
    expect(events.map(shapeOf)).toEqual(["queued:a", "queued:b"]);
    takes.delete("b");
    await flush();
    calls[0]?.finish(saved("a"));
    await flush();

    // Red: drop the existence check at the job's turn — run is called for b.
    expect(calls.map((c) => c.takeId)).toEqual(["a"]);
    await queue.drained();
    const failed = events.at(-1);
    expect(failed).toMatchObject({
      type: "export",
      takeId: "b",
      phase: "failed",
      reason: "takeNotFound",
    });
    expect((failed as { detail: string }).detail).toMatch(/deleted/);
  });

  it("an export that does not save fails with the refusal's reason and its sentence", async () => {
    const { library } = await fakeLibrary(["a"]);
    const events: StudioEvent[] = [];
    const { run, calls } = heldRun();
    const queue = createExportQueue({
      library,
      events: { send: (e) => events.push(e) },
      run,
      log: () => {},
    });
    await queue.start("a", { fileType: "mp4", revision: "rev-a" });
    await flush();
    calls[0]?.finish({
      outcome: "renderFailed",
      takeId: "a",
      error: "the window was closed",
      summary: "The render failed, so no file was made: the window was closed.",
    });
    await queue.drained();
    expect(events.at(-1)).toEqual({
      type: "export",
      takeId: "a",
      jobId: calls[0]?.jobId,
      phase: "failed",
      reason: "renderFailed",
      detail: "The render failed, so no file was made: the window was closed.",
    });
  });

  it("a run that throws fails the job, says so, and the next job still runs", async () => {
    const { library } = await fakeLibrary(["a", "b"]);
    const events: StudioEvent[] = [];
    const logs: string[] = [];
    let fail: (e: Error) => void = () => {};
    let n = 0;
    const queue = createExportQueue({
      library,
      events: { send: (e) => events.push(e) },
      run: (takeId) => {
        n += 1;
        if (n === 1) {
          return new Promise((_ok, reject) => {
            fail = reject;
          });
        }
        return Promise.resolve(saved(takeId));
      },
      log: (l) => logs.push(l),
    });
    await queue.start("a", { fileType: "mp4", revision: "rev-a" });
    await queue.start("b", { fileType: "mp4", revision: "rev-b" });
    await flush();
    fail(new Error("boom"));
    await queue.drained();
    expect(events.map(shapeOf)).toEqual([
      "queued:a",
      "queued:b",
      "failed:a",
      "saved:b",
    ]);
    expect(events[2]).toMatchObject({ reason: "internalError" });
    expect(logs.join("\n")).toContain("boom");
  });

  it("drained() waits for a job admitted but not yet answered", async () => {
    const { library } = await fakeLibrary(["a"]);
    const { run, calls } = heldRun();
    const queue = createExportQueue({
      library,
      events: { send: () => {} },
      run,
      log: () => {},
    });
    const answer = queue.start("a", { fileType: "mp4", revision: "rev-a" });
    // Counted from the moment it is asked, so a window closing now does not
    // read an empty queue and stop the studio under a job about to start.
    expect(queue.size()).toBe(1);
    let drained = false;
    void queue.drained().then(() => {
      drained = true;
    });
    await answer;
    await flush();
    expect(drained).toBe(false);
    calls[0]?.finish(saved("a"));
    await flush();
    expect(drained).toBe(true);
  });
});
