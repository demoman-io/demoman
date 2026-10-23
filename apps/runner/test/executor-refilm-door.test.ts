import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary, type Library } from "../src/executor/library.js";
import { refilmFromLibrary } from "../src/executor/refilm.js";
import type { LocalExecutor } from "../src/executor/types.js";

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

describe("run's door, given a take", () => {
  it("refuses both a script and a takeId", async () => {
    expect(await run({ script: {}, takeId: scene.meta.id })).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "invalidScript",
      field: "script, takeId",
    });
  });
  it("refuses neither", async () => {
    expect(await run({})).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "invalidScript",
      field: "script",
    });
  });
  it("answers takeNotFound for an id the library does not hold", async () => {
    expect(await run({ takeId: "scene-nope" })).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "takeNotFound",
    });
  });
  it("answers takeUnreadable for a take that will not parse", async () => {
    await mkdir(join(home, "takes", "scene-broken"), { recursive: true });
    await writeFile(join(home, "takes", "scene-broken", "scene.json"), "{");
    expect(await run({ takeId: "scene-broken" })).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "takeUnreadable",
    });
  });
  it("refuses a take whose typed text was redacted, naming derive", async () => {
    const t = scene.actions.find((a) => a.kind === "type");
    if (t === undefined) throw new Error("fixture has no type step");
    const redacted = {
      ...scene,
      meta: { ...scene.meta, id: "scene-redacted" },
      actions: scene.actions.map((a) =>
        a.id === t.id ? { ...a, text: null, redacted: true } : a,
      ),
    };
    await createLibrary(home).putScene(redacted as typeof scene);
    const out = await run({ takeId: "scene-redacted" });
    expect(out).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "unfilledHoles",
    });
    expect(out.detail).toMatch(/derive/);
  });

  it("says a script built from the take that the schema refuses came from the take", async () => {
    const id = "scene-bad-viewport";
    const library = createLibrary(home);
    await library.putScene({ ...scene, meta: { ...scene.meta, id } });
    // A saved script whose viewport the script schema refuses.
    await library.putJson(id, "script.json", {
      skeletonVersion: 1,
      name: "Bad viewport",
      scriptVersion: 1,
      viewport: { width: -1, height: -1 },
      device: null,
      look: null,
      steps: [],
    });
    const out = await run({ takeId: id });
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

  it("holds the slot while the take is read, and releases it after", async () => {
    // Premise: this take refuses unfilledHoles after the library reads.
    const first = run({ takeId: "scene-redacted" });
    const second = run({ takeId: "scene-redacted" });
    const reasons = (await Promise.all([first, second]))
      .map((o) => o.reason)
      .sort();
    expect(reasons).toEqual(["alreadyRunning", "unfilledHoles"]);
    const third = await run({ takeId: "scene-redacted" });
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
