import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateToCurrent,
  type SceneDocument,
  scriptFromTake,
  URL_SCRUB_PLACEHOLDER,
} from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { deriveOp } from "../src/executor/derive.js";
import { createLibrary } from "../src/executor/library.js";

// The schema package's own take with actions (move, click, type, waitFor);
// the runner's `fixtures/scene.ts` take has none, so it derives nothing.
const takeWithActions = async () =>
  migrateToCurrent(
    JSON.parse(
      await readFile(
        new URL(
          "../../../packages/scene-schema/fixtures/readonly-scene.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

const deriveVerb = (scene: SceneDocument, actionId: string): string => {
  const d = scriptFromTake(scene);
  if (d.outcome !== "derived") throw new Error("fixture derives nothing");
  const s = d.draft.steps.find((x) => x.recorded === actionId);
  if (s === undefined) throw new Error(`no derived step for ${actionId}`);
  return s.do;
};

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-derive-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe("deriveOp", () => {
  it("keeps a take's pauses when it has a script.json, and its own name and look", async () => {
    const library = createLibrary(home);
    const scene = readonlyScene();
    await library.putScene(scene);
    const acting = scene.actions.map((a) => a.id);
    const skeletonLook = { canvas: { aspect: "16:9" } };
    await library.putJson(scene.meta.id, "script.json", {
      skeletonVersion: 1,
      name: "With pauses",
      scriptVersion: 1,
      viewport: null,
      device: null,
      look: skeletonLook,
      steps: acting.flatMap((id, i) => [
        ...(i === 0 ? [] : [{ do: "pause", ms: 800 }]),
        { do: deriveVerb(scene, id), actionId: id, anchorDigest: null },
      ]),
    });
    const out = await deriveOp(library, { takeId: scene.meta.id });
    if (!out.outcome.ok) throw new Error(JSON.stringify(out.outcome));
    const { script } = out.outcome.value as {
      script: { steps: { do: string }[]; look: unknown; name: string };
    };
    // Premise: the scene has more than one action, so pauses sit between.
    expect(acting.length).toBeGreaterThan(1);
    expect(script.steps.filter((s) => s.do === "pause")).toHaveLength(
      acting.length - 1,
    );
    // The look is the take's own (scene.json), never the skeleton's.
    const own = scriptFromTake(scene);
    if (own.outcome !== "derived") throw new Error("fixture derives nothing");
    // Premise: the skeleton's look differs from the take's own.
    expect(skeletonLook).not.toEqual(own.draft.look);
    expect(script.look).toEqual(own.draft.look);
    // The name is the take's own too (a studio rename survives); the
    // skeleton's is only for a take whose name is blank.
    expect(scene.meta.name).not.toBe("With pauses");
    expect(script.name).toBe(scene.meta.name);
    // A clean skeleton: the merge had nothing to say.
    expect(
      (out.outcome.value as { report: { skeleton: unknown } }).report.skeleton,
    ).toEqual([]);
  });

  it("derives a take whose step's verb was changed by hand, taking the scene's and saying so", async () => {
    const library = createLibrary(home);
    const scene = readonlyScene();
    await library.putScene(scene);
    const typed = scene.actions.find((a) => a.kind === "type");
    if (typed === undefined) throw new Error("fixture has no type step");
    // Premise: the scene derives this action as a type step; the saved
    // script says it was filmed as a click.
    expect(deriveVerb(scene, typed.id)).toBe("type");
    const steps = scene.actions.map((a) => ({
      do: a.id === typed.id ? "click" : deriveVerb(scene, a.id),
      actionId: a.id,
      anchorDigest: null,
    }));
    const index = steps.findIndex((s) => s.actionId === typed.id);
    await library.putJson(scene.meta.id, "script.json", {
      skeletonVersion: 1,
      name: "Verb changed",
      scriptVersion: 1,
      viewport: null,
      device: null,
      look: null,
      steps,
    });
    const out = await deriveOp(library, { takeId: scene.meta.id });
    if (!out.outcome.ok) throw new Error(JSON.stringify(out.outcome));
    const value = out.outcome.value as {
      report: { outcome: string; skeleton: unknown };
      script: { steps: { do: string; recorded?: string }[] } | null;
    };
    expect(value.report.outcome, JSON.stringify(value.report)).toBe("derived");
    expect(value.script?.steps[index]).toMatchObject({
      do: "type",
      recorded: typed.id,
    });
    expect(value.report.skeleton).toEqual([
      {
        kind: "verbChanged",
        index,
        actionId: typed.id,
        was: "click",
        now: "type",
      },
    ]);
  });

  it("answers takeNotFound for an id the library does not hold", async () => {
    const { outcome } = await deriveOp(createLibrary(home), {
      takeId: "scene-nope",
    });
    expect(outcome).toEqual({
      ok: true,
      value: {
        report: { outcome: "takeNotFound", takeId: "scene-nope" },
        script: null,
      },
    });
  });

  it("derives a script and remembers its hole paths", async () => {
    const lib = createLibrary(home);
    const doc = await takeWithActions();
    // Capture scrubbed the origin: the one hole this take can be given.
    doc.meta.capture.originUrl = `https://app.example.com/orders?q=${URL_SCRUB_PLACEHOLDER}`;
    await lib.putScene(doc);
    const { outcome, holePaths } = await deriveOp(lib, { takeId: doc.meta.id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = outcome.value as {
      report: { outcome: string; takeId: string; holes: unknown[] };
      script: { target: string; steps: unknown[] } | null;
    };
    // The fixture premise: this take has actions to derive.
    expect(value.report.outcome).toBe("derived");
    expect(value.script?.steps.length).toBeGreaterThan(0);
    // The premise: the take leaves holes, so the mapping below is not vacuous.
    expect(value.report.holes.length).toBeGreaterThan(0);
    expect(value.script?.target).toBe("");
    // No script.json beside this take: the report says so.
    expect((value.report as unknown as { skeleton: unknown }).skeleton).toEqual(
      [{ kind: "noSkeleton" }],
    );
    expect(holePaths).toContain("target");
    expect(holePaths).toEqual(
      (value.report.holes as Array<{ step: number | null; field: string }>).map(
        (h) => (h.step === null ? h.field : `steps.${h.step}.${h.field}`),
      ),
    );
  });

  // Review 2026-10-13, #6: export answers such an id takeNotFound, and an
  // agent branching on derive's outcome must not read a wrong id as a broken
  // library. Red if derive hands the id to the library unchecked.
  it("answers takeNotFound, not unreadable, for an id outside the library", async () => {
    const { outcome, holePaths } = await deriveOp(createLibrary(home), {
      takeId: "../x",
    });
    expect(holePaths).toBeNull();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      (outcome.value as { report: { outcome: string; takeId: string } }).report,
    ).toEqual({ outcome: "takeNotFound", takeId: "../x" });
  });
});
