import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary, type Library } from "../src/executor/library.js";
import { ensureVideos, JOIN_GRACE_MS } from "../src/executor/migrate-videos.js";
import { refilmFromLibrary } from "../src/executor/refilm.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { createVideoStore } from "../src/executor/videos.js";
import { videoOfTake } from "./fixture.js";

let home: string;
let executor: LocalExecutor;
const scene = readonlyScene();

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-refilm-door-"));
  executor = createLocalExecutor({
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  await createLibrary(home).putScene(scene);
});
afterAll(async () => {
  await executor.close();
  await rm(home, { recursive: true, force: true });
});

const run = async (args: Record<string, unknown>) => {
  const out = await executor.request("run", args);
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value as {
    outcome: string;
    reason?: string;
    field?: string | null;
    detail?: string;
  };
};

/** A take of its own name in the library, and the video it joins (the
 *  migration every run starts with makes one per name and start page). */
async function takeInVideo(
  id: string,
  edit: (doc: typeof scene) => typeof scene = (d) => d,
): Promise<{ id: string }> {
  const library = createLibrary(home);
  await library.putScene(
    edit({ ...scene, meta: { ...scene.meta, id, name: id } }),
  );
  await ensureVideos(createVideoStore(home, library), library);
  return videoOfTake(home, id);
}

describe("run's door, given a video", () => {
  it("refuses a run that names no video, saying a takeId is gone", async () => {
    expect(await run({ script: {} })).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "videoRequired",
      field: "video",
    });
    const old = await run({ takeId: scene.meta.id });
    expect(old).toMatchObject({ reason: "videoRequired" });
    expect(old.detail).toMatch(/takeId is gone/);
  });
  it("refuses a new video with no script", async () => {
    expect(await run({ video: { new: "Anything" } })).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "invalidScript",
      field: "script",
    });
  });
  it("answers videoNotFound for an id the library does not hold", async () => {
    for (const id of ["nope", "00000000-0000-4000-8000-000000000000", "../x"]) {
      expect(await run({ video: { id } }), id).toMatchObject({
        outcome: "refusedBeforeRun",
        reason: "videoNotFound",
        field: "video",
      });
    }
  });
  it("answers videoUnreadable for a video whose version will not parse", async () => {
    const video = await takeInVideo("scene-broken");
    await writeFile(join(home, "takes", "scene-broken", "scene.json"), "{");
    const out = await run({ video });
    expect(out).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "videoUnreadable",
      field: "video",
    });
    expect(out.detail).toContain("scene-broken");
  });
  it("answers videoUnwritable when the migration before the run cannot write", async () => {
    const library = createLibrary(home);
    await library.putScene({
      ...scene,
      meta: { ...scene.meta, id: "scene-unmigrated", name: "Unmigrated" },
    });
    // Premise: the take is old enough to migrate, and is in no video yet.
    expect(Date.now() - Date.parse(scene.meta.createdAt)).toBeGreaterThan(
      JOIN_GRACE_MS,
    );
    expect(
      await createVideoStore(home, library).videoOf("scene-unmigrated"),
    ).toBeNull();
    const videosDir = join(home, "videos");
    await mkdir(videosDir, { recursive: true });
    await chmod(videosDir, 0o500);
    let out: Awaited<ReturnType<typeof run>>;
    try {
      out = await run({ video: { id: randomUUID() }, script: {} });
    } finally {
      await chmod(videosDir, 0o700);
    }
    expect(out).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "videoUnwritable",
      field: "video",
    });
    // The migration takes the library's lock first; that is the write
    // refused here, and the detail names it.
    expect(out.detail).toContain(`could not take ${join(videosDir, ".lock")}`);
  });
  it("refuses a video whose version's typed text was redacted, naming derive", async () => {
    const t = scene.actions.find((a) => a.kind === "type");
    if (t === undefined) throw new Error("fixture has no type step");
    const video = await takeInVideo(
      "scene-redacted",
      (d) =>
        ({
          ...d,
          actions: d.actions.map((a) =>
            a.id === t.id ? { ...a, text: null, redacted: true } : a,
          ),
        }) as typeof scene,
    );
    const out = await run({ video });
    expect(out).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "unfilledHoles",
    });
    expect(out.detail).toMatch(/derive/);
    expect(out.detail).toMatch(
      /^version 1 of video "scene-redacted" \(take scene-redacted\)/,
    );
  });

  it("says a script built from the video's version that the schema refuses came from that take", async () => {
    const id = "scene-bad-viewport";
    const video = await takeInVideo(id);
    // A saved script whose viewport the script schema refuses.
    await createLibrary(home).putJson(id, "script.json", {
      skeletonVersion: 1,
      name: "Bad viewport",
      scriptVersion: 1,
      viewport: { width: -1, height: -1 },
      device: null,
      look: null,
      steps: [],
    });
    const out = await run({ video });
    expect(out).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "invalidScript",
    });
    expect(out.detail).toMatch(
      new RegExp(
        `^the script built from take ${id}'s script\\.json and scene\\.json is not valid — `,
      ),
    );
    // Control: a script passed as itself carries no such prefix.
    const own = await run({
      video,
      script: {
        scriptVersion: 1,
        name: "x",
        target: "https://app.example.com/",
        viewport: { width: -1, height: -1 },
        steps: [{ do: "waitForLoad" }],
      },
    });
    expect(own).toMatchObject({ reason: "invalidScript" });
    expect(own.detail).not.toMatch(/built from take/);
  });

  it("holds the slot while the version is read, and releases it after", async () => {
    // Premise: this video refuses unfilledHoles after the library reads.
    const video = await videoOfTake(home, "scene-redacted");
    const first = run({ video });
    const second = run({ video });
    const reasons = (await Promise.all([first, second]))
      .map((o) => o.reason)
      .sort();
    expect(reasons).toEqual(["alreadyRunning", "unfilledHoles"]);
    const third = await run({ video });
    expect(third.reason).toBe("unfilledHoles");
  });
});

describe("refilmFromLibrary", () => {
  it("answers takeUnreadable when the take cannot be built into a script", async () => {
    // A scene the library handed back that the merge cannot read: the
    // derivation throws on it (`actions` is not a list).
    const library = {
      isTakeId: () => true,
      getSceneRead: async () => ({
        scene: { ...scene, actions: null },
        revision: "r",
        notes: [],
      }),
      getSkeleton: async () => ({ kind: "none" }),
    } as unknown as Library;
    const out = await refilmFromLibrary(library, scene.meta.id);
    expect(out).toMatchObject({
      ok: false,
      refusal: {
        outcome: "refusedBeforeRun",
        reason: "takeUnreadable",
        field: "takeId",
      },
    });
    if (out.ok) return;
    expect(out.refusal.detail).toContain(
      `take ${scene.meta.id} could not be built into a script (`,
    );
  });

  // Review 2026-10-22: schema 12 drops an old take's text overlays on read,
  // so the re-film's notCarried can no longer name them; the read's own
  // sentence has to reach the report instead.
  it("says an old take's text overlays were not carried", async () => {
    const lib = createLibrary(home);
    await lib.putScene({
      ...scene,
      meta: { ...scene.meta, id: "scene-v11" },
    } as typeof scene);
    const path = join(home, "takes", "scene-v11", "scene.json");
    const v11 = JSON.parse(await readFile(path, "utf8"));
    v11.schemaVersion = 11;
    delete v11.edits.splits;
    delete v11.edits.removed;
    v11.edits.cuts = [];
    v11.edits.replacements = [
      { id: "rep", targetAnchorId: "a-search", find: null, replace: "x" },
    ];
    await writeFile(path, JSON.stringify(v11));
    const out = await refilmFromLibrary(lib, "scene-v11");
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.refilm.notes).toContainEqual({
      kind: "migrated",
      sentence:
        "1 text overlay was removed from this take: the video shows the text that was recorded.",
    });
  });
});
