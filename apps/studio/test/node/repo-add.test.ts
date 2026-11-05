import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportAnswer } from "@demoman/run-core";
import {
  createLibrary,
  createVideoStore,
  type KeepAnswer,
  type RemoveAnswer,
  readRepo,
} from "@demoman/runner/studio";
import type { StudioEvent } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventHub } from "../../src/events.js";
import { createExportQueue, type RunExport } from "../../src/queue.js";
import { buildHandlers } from "../../src/serve.js";
import type { StudioRequest } from "../../src/server.js";
import { seedTake } from "./seed.js";

type Keep = NonNullable<Parameters<typeof buildHandlers>[0]["keep"]>;
type KeepCall = Parameters<Keep>;
type Removal = NonNullable<Parameters<typeof buildHandlers>[0]["removeFlow"]>;

const flush = () => new Promise<void>((r) => setImmediate(r));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await flush();
  expect(ok()).toBe(true);
};

const keptOk = (o: Partial<Extract<KeepAnswer, { ok: true }>> = {}) =>
  ({
    ok: true,
    file: ".demoman/videos/flow.json",
    moved: null,
    kept: {},
    receipt: null,
    written: ["docs/demos/flow.mp4"],
    ...o,
  }) as unknown as KeepAnswer;

describe("adding a flow to its repo, and removing it", () => {
  let home: string;
  let repo: string;
  let root: string;
  let flowId: string;
  const sent: StudioEvent[] = [];
  const calls: KeepCall[] = [];
  let keep: Keep;
  let removeFlow: Removal;
  let handlers: ReturnType<typeof buildHandlers>;
  let exportRuns: { finish: (a: ExportAnswer) => void }[];
  let queue: ReturnType<typeof createExportQueue>;
  const session = { name: "the one session" };

  const req = (params: Record<string, string>, body?: unknown): StudioRequest =>
    ({
      params,
      body: async () =>
        Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    }) as unknown as StudioRequest;
  const add = (body: unknown, id = flowId) =>
    handlers.repoAdd(req({ id }, body));
  const good = {
    path: "docs/demos/flow.mp4",
    deliver: "commit",
    quality: "high",
  };
  const phases = () =>
    sent.flatMap((e) => (e.type === "repo" ? [e.phase] : []));

  beforeEach(async () => {
    sent.length = 0;
    calls.length = 0;
    exportRuns = [];
    home = await mkdtemp(join(tmpdir(), "studio-repo-add-"));
    repo = await mkdtemp(join(tmpdir(), "studio-repo-add-repo-"));
    await new Promise((r) =>
      spawn("git", ["init", "-q"], { cwd: repo }).on("exit", r),
    );
    root = await realpath(repo);
    const library = createLibrary(home);
    const { scene } = await seedTake(home, { id: "add-take" });
    await library.putScene({ ...scene, edits: { ...scene.edits, masks: [] } });
    const read = await readRepo(repo);
    if (!read.ok) throw new Error(read.none);
    const store = createVideoStore(home, library);
    const made = await store.create({
      name: "Flow",
      repo: { key: read.repo.key },
      startPage: scene.meta.capture.originUrl,
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    flowId = made.video.id;
    await store.join("add-take", {
      videoId: flowId,
      made: {
        repo: read.repo,
        agent: { none: "test" },
        by: { none: "test" },
        door: "mcp",
      },
      recordedRevision:
        (await library.getSceneRead("add-take"))?.revision ?? null,
    });
    const events = createEventHub({ log: () => {} });
    const hub = {
      ...events,
      send: (e: StudioEvent) => {
        sent.push(e);
        events.send(e);
      },
    };
    const run: RunExport = () =>
      new Promise((finish) => exportRuns.push({ finish }));
    queue = createExportQueue({ library, events: hub, run, log: () => {} });
    keep = async (...a) => {
      calls.push(a);
      return keptOk();
    };
    removeFlow = async () =>
      ({
        ok: true,
        name: "Flow",
        removed: ["a.json"],
        exportsLeft: ["b.mp4"],
      }) as RemoveAnswer;
    handlers = buildHandlers({
      home,
      library,
      events: hub,
      feeds: {
        unwatched: () => ({ takes: null, kits: null }),
        kitsWritten: async () => {},
        close: () => {},
      },
      log: () => {},
      version: "0",
      queue,
      session: session as never,
      wallpapersDir: "/none",
      outDir: "/none",
      keep: (...a) => keep(...a),
      removeFlow: (...a) => removeFlow(...a),
      window: { open: async () => ({ ok: true, path: "/" }) },
    });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  // Red if the handler stops queueing, or hands keepVideo another root, path or door.
  it("a valid add answers 202, then queued, adding and added", async () => {
    keep = async (...a) => {
      calls.push(a);
      a[1].log("exporting docs/demos/flow.mp4");
      return keptOk();
    };
    const res = await add(good);
    expect(res).toMatchObject({ status: 202 });
    await until(() => phases().includes("added"));
    expect(phases()).toEqual(["queued", "adding", "added"]);
    expect(calls).toHaveLength(1);
    const [args, deps] = calls[0] as KeepCall;
    expect(args).toMatchObject({
      video: flowId,
      repoRoot: root,
      deliver: "commit",
      to: [{ path: "docs/demos/flow.mp4", fileType: "mp4", quality: "high" }],
    });
    expect(deps.export.door).toBe("studio");
    expect(sent.at(-1)).toMatchObject({
      phase: "added",
      written: ["docs/demos/flow.mp4"],
      root,
    });
  });

  // Red if the body is not checked before keepVideo is called.
  it("a path outside the repo is refused before anything runs", async () => {
    for (const body of [
      { ...good, path: "/etc/x.mp4" },
      { ...good, path: "" },
      { ...good, deliver: "push" },
      { ...good, quality: "huge" },
    ]) {
      expect(await add(body)).toMatchObject({
        status: 400,
        json: { reason: "repoBodyInvalid" },
      });
    }
    await flush();
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  // Red if the click does not ask checkAddable again.
  it("a flow that turned unaddable since the listing is a 409 with its label", async () => {
    const { scene } = await seedTake(home, { id: "add-take" });
    const library = createLibrary(home);
    await library.putScene({
      ...scene,
      edits: {
        ...scene.edits,
        masks: [],
        trim: { tail: { actionId: "act-3", offsetMs: 0 } },
      },
    });
    const res = (await add(good)) as {
      status: number;
      json: { reason: string; detail: string };
    };
    expect(res.status).toBe(409);
    expect(res.json.reason).toBe("notAddable");
    expect(res.json.detail).toContain("has a trim");
    expect(calls).toHaveLength(0);
  });

  // Red if a keep refusal is reported as added or loses its reason.
  it("a refusal from the add is failed, never added", async () => {
    keep = async () =>
      ({
        ok: false,
        reason: "outputTaken",
        detail: "docs/x.mp4 is taken",
      }) as KeepAnswer;
    await add(good);
    await until(() => phases().includes("failed"));
    expect(phases()).not.toContain("added");
    expect(sent.at(-1)).toMatchObject({
      phase: "failed",
      reason: "outputTaken",
      detail: "docs/x.mp4 is taken",
    });
  });

  // Red if added drops the notes (markNote and the others).
  it("notes ride on the added event", async () => {
    keep = async () =>
      keptOk({ markNote: "the mark was not set", platformNote: "off Linux" });
    await add(good);
    await until(() => phases().includes("added"));
    expect(sent.at(-1)).toMatchObject({
      phase: "added",
      notes: ["the mark was not set", "off Linux"],
    });
  });

  // Red if an add runs outside queue.serial: it would start under the export.
  it("adds wait behind a running export, one at a time, on one session", async () => {
    const rev = (await createLibrary(home).getSceneRead("add-take"))
      ?.revision as string;
    await queue.start("add-take", { fileType: "mp4", revision: rev });
    await until(() => exportRuns.length === 1);
    const finishes: (() => void)[] = [];
    let live = 0;
    let most = 0;
    const sessions: unknown[] = [];
    keep = async (...a) => {
      calls.push(a);
      sessions.push(a[1].export.session);
      live += 1;
      most = Math.max(most, live);
      await new Promise<void>((r) => finishes.push(r));
      live -= 1;
      return keptOk();
    };
    await add(good);
    await add(good);
    const positions = sent.flatMap((e) =>
      e.type === "repo" && e.phase === "queued" ? [e.position] : [],
    );
    expect(positions).toEqual([1, 2]);
    await flush();
    expect(calls).toHaveLength(0);
    exportRuns[0]?.finish({ outcome: "failed" } as unknown as ExportAnswer);
    await until(() => calls.length === 1);
    await flush();
    expect(calls).toHaveLength(1);
    finishes[0]?.();
    await until(() => calls.length === 2);
    finishes[1]?.();
    await until(() => phases().filter((p) => p === "added").length === 2);
    expect(most).toBe(1);
    expect(sessions).toEqual([session, session]);
  });

  // Red if remove stops answering exportsLeft, or maps notInRepo to anything but 409.
  it("remove answers what it took and what it left", async () => {
    await add(good);
    await until(() => phases().includes("added"));
    const { createVideoStore: store } = await import("@demoman/runner/studio");
    const videos = store(home, createLibrary(home));
    await videos.setKept(flowId, {
      root,
      file: ".demoman/videos/flow.json",
      key: null,
    } as never);
    expect(await handlers.repoRemove(req({ id: flowId }))).toMatchObject({
      status: 200,
      json: { removed: ["a.json"], exportsLeft: ["b.mp4"], notes: [] },
    });
    removeFlow = async () =>
      ({
        ok: false,
        reason: "notInRepo",
        detail: "not in this repo",
      }) as RemoveAnswer;
    expect(await handlers.repoRemove(req({ id: flowId }))).toMatchObject({
      status: 409,
      json: { reason: "notInRepo", detail: "not in this repo" },
    });
  });
});
