// packages/run-core/test/node/refilm-merge.test.ts
import { type SceneDocument, scriptFromTake } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  mergeSkeleton,
  notCarriedOf,
  refilmScript,
} from "../../src/refilm/merge.js";
import type { ScriptSkeleton } from "../../src/refilm/skeleton.js";
import { scene } from "./refilm-fixture.js";

/** The fixture's actions as a skeleton: a pause between every two steps,
 *  each acting step naming its action — what a CLI run of it would save. */
function skeletonFor(doc: SceneDocument): ScriptSkeleton {
  const derived = scriptFromTake(doc);
  if (derived.outcome !== "derived") throw new Error("fixture derives nothing");
  return {
    skeletonVersion: 1,
    name: "Fixture",
    scriptVersion: 1,
    viewport: null,
    device: null,
    look: null,
    steps: derived.draft.steps.flatMap((s, i) => [
      ...(i === 0 ? [] : [{ do: "pause" as const, ms: 700 + i }]),
      { do: s.do, actionId: s.recorded ?? null, anchorDigest: null },
    ]),
  };
}

/** A re-film's options (`refilmScript`'s): refuse a changed verb, and the
 *  scene's own name. */
const refuse = (doc: SceneDocument) => ({
  onVerbChange: "refuse" as const,
  sceneName: doc.meta.name,
});

const derivedOf = (doc: SceneDocument) => {
  const d = scriptFromTake(doc);
  if (d.outcome !== "derived") throw new Error("fixture derives nothing");
  return d;
};

const typeAction = (doc: SceneDocument) => {
  const a = doc.actions.find((x) => x.kind === "type");
  if (a === undefined || a.kind !== "type")
    throw new Error("fixture has no type step");
  return a;
};

describe("the fixture", () => {
  it("has a typed step with text, at least three actions, and no holes", () => {
    const doc = scene();
    expect(typeAction(doc).text).not.toBeNull();
    expect(doc.actions.length).toBeGreaterThanOrEqual(3);
    expect(derivedOf(doc).holes).toEqual([]);
  });
});

describe("mergeSkeleton", () => {
  it("keeps the skeleton's pauses, in place", () => {
    const doc = scene();
    const sk = skeletonFor(doc);
    // Premise: the skeleton holds pauses; the derivation alone has none.
    expect(sk.steps.some((s) => s.do === "pause")).toBe(true);
    expect(
      derivedOf(doc).draft.steps.some((s) => (s.do as string) === "pause"),
    ).toBe(false);
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      refuse(doc),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.draft.steps.map((s) => s.do)).toEqual(sk.steps.map((s) => s.do));
    expect(out.draft.steps[1]).toEqual({ do: "pause", ms: 701 });
  });

  it("carries the skeleton's account into the draft", () => {
    const doc = scene();
    const sk = {
      ...skeletonFor(doc),
      scriptVersion: 5 as const,
      account: "seller",
    };
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      refuse(doc),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.draft.account).toBe("seller");
    expect(out.draft.scriptVersion).toBe(5);
    const plain = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: skeletonFor(doc) },
      refuse(doc),
    );
    if (!plain.ok) throw new Error(JSON.stringify(plain));
    expect("account" in plain.draft).toBe(false);
  });

  it("carries the scene's edited typed text, not the filmed one", () => {
    const doc = scene();
    const sk = skeletonFor(doc);
    const t = typeAction(doc);
    const edited = {
      ...doc,
      actions: doc.actions.map((a) =>
        a.id === t.id ? { ...a, text: "Maple" } : a,
      ),
    } as SceneDocument;
    const out = mergeSkeleton(
      derivedOf(edited),
      { kind: "ok", skeleton: sk },
      refuse(edited),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    const typed = out.draft.steps.find((s) => s.do === "type");
    expect(typed).toMatchObject({ text: "Maple", recorded: t.id });
  });

  it("takes the look from the scene, not the skeleton", () => {
    const doc = scene();
    const sk = {
      ...skeletonFor(doc),
      look: { canvas: { aspect: "16:9" as const } },
    };
    const restyled = {
      ...doc,
      canvas: { aspect: "9:16" as const },
    } as SceneDocument;
    // Premise: the skeleton's look and the scene's canvas really differ.
    expect(sk.look.canvas.aspect).not.toBe(restyled.canvas.aspect);
    const out = mergeSkeleton(
      derivedOf(restyled),
      { kind: "ok", skeleton: sk },
      refuse(restyled),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.draft.look).toEqual(derivedOf(restyled).draft.look);
    expect(out.draft.look).toMatchObject({ canvas: { aspect: "9:16" } });
  });

  it("names the script after the scene, or the skeleton when the scene's name is blank", () => {
    const doc = scene();
    const sk = { ...skeletonFor(doc), name: "Filmed as" };
    // Premise: the scene has a name of its own, not the skeleton's.
    expect(doc.meta.name.trim()).not.toBe("");
    expect(doc.meta.name).not.toBe(sk.name);
    const renamed = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      refuse(doc),
    );
    if (!renamed.ok) throw new Error(JSON.stringify(renamed));
    expect(renamed.draft.name).toBe(doc.meta.name);
    const blank = { ...doc, meta: { ...doc.meta, name: "  " } };
    // Premise: the derivation stands in a name of its own for a blank one,
    // which is why the merge reads the scene's, not the draft's.
    expect(derivedOf(blank).draft.name).not.toBe(sk.name);
    const out = mergeSkeleton(
      derivedOf(blank),
      { kind: "ok", skeleton: sk },
      refuse(blank),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.draft.name).toBe("Filmed as");
  });

  it("keeps the derivation's scriptVersion when it is higher", () => {
    const doc = scene();
    const sk: ScriptSkeleton = { ...skeletonFor(doc), scriptVersion: 1 };
    const withMotion = {
      ...doc,
      motion: { smoothness: 0.5, blur: 0.5, follow: true },
    } as SceneDocument;
    // Premise: a take with a motion block derives a higher scriptVersion than the skeleton's 1.
    expect(derivedOf(withMotion).draft.scriptVersion).toBeGreaterThan(1);
    const out = mergeSkeleton(
      derivedOf(withMotion),
      { kind: "ok", skeleton: sk },
      refuse(withMotion),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.draft.scriptVersion).toBe(
      derivedOf(withMotion).draft.scriptVersion,
    );
  });

  it("drops a step whose action was deleted, and says so", () => {
    const doc = scene();
    const sk = skeletonFor(doc);
    const gone = doc.actions[doc.actions.length - 1]?.id as string;
    const without = {
      ...doc,
      actions: doc.actions.filter((a) => a.id !== gone),
    } as SceneDocument;
    const out = mergeSkeleton(
      derivedOf(without),
      { kind: "ok", skeleton: sk },
      refuse(without),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(
      out.draft.steps.some((s) => "recorded" in s && s.recorded === gone),
    ).toBe(false);
    expect(out.notes).toContainEqual(
      expect.objectContaining({
        kind: "stepDropped",
        actionId: gone,
        why: "actionGone",
      }),
    );
  });

  it("drops a step the run never performed, and says so", () => {
    const doc = scene();
    const sk = skeletonFor(doc);
    const last = sk.steps.length - 1;
    const step = sk.steps[last];
    if (step === undefined || step.do === "pause")
      throw new Error("premise: last skeleton step acts");
    sk.steps[last] = { ...step, actionId: null };
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      refuse(doc),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.notes).toContainEqual({
      kind: "stepDropped",
      index: last,
      actionId: null,
      why: "neverPerformed",
    });
  });

  it("films an action the scene has and the skeleton does not, first when nothing precedes it", () => {
    const doc = scene();
    const sk = skeletonFor(doc);
    const first = sk.steps[0];
    if (first === undefined || first.do === "pause" || first.actionId === null)
      throw new Error("premise: first step acts");
    // The saved script never had the first action (a step added by hand).
    sk.steps = sk.steps.slice(1);
    expect(
      sk.steps.some((s) => s.do !== "pause" && s.actionId === first.actionId),
    ).toBe(false);
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      refuse(doc),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.notes).toEqual([
      { kind: "actionAdded", actionId: first.actionId },
    ]);
    expect(out.draft.steps[0]).toMatchObject({ recorded: first.actionId });
    expect(out.draft.steps).toHaveLength(sk.steps.length + 1);
  });

  it("films an added action right after the step before it in scene.json", () => {
    const doc = scene();
    const sk = skeletonFor(doc);
    const ids = derivedOf(doc).draft.steps.map((s) => s.recorded);
    const [a, b, c] = ids;
    // Premise: three derived steps to take the middle one out of.
    if (a === undefined || b === undefined || c === undefined)
      throw new Error("premise: three derived steps");
    // The saved script never had b, nor the pause before it: a, pause, c, …
    const at = sk.steps.findIndex((s) => s.do !== "pause" && s.actionId === b);
    expect(sk.steps[at - 1]?.do).toBe("pause");
    sk.steps.splice(at - 1, 2);
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      refuse(doc),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.notes).toEqual([{ kind: "actionAdded", actionId: b }]);
    const order = out.draft.steps.map((s) =>
      s.do === "pause" ? "pause" : s.recorded,
    );
    // Right after a, ahead of the pause that led to c.
    expect(order.slice(0, 4)).toEqual([a, b, "pause", c]);
  });

  it("films two added actions in their scene order", () => {
    const doc = scene();
    const ids = derivedOf(doc).draft.steps.map((s) => s.recorded);
    const [a, b, c, d] = ids;
    if ([a, b, c, d].some((x) => x === undefined))
      throw new Error("premise: four derived steps");
    // The saved script had only a and d.
    const sk: ScriptSkeleton = {
      ...skeletonFor(doc),
      steps: skeletonFor(doc).steps.filter(
        (s) => s.do !== "pause" && (s.actionId === a || s.actionId === d),
      ),
    };
    expect(sk.steps).toHaveLength(2);
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      refuse(doc),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(
      out.draft.steps.map((s) => (s.do === "pause" ? "pause" : s.recorded)),
    ).toEqual([a, b, c, d]);
    expect(out.notes).toEqual([
      { kind: "actionAdded", actionId: b },
      { kind: "actionAdded", actionId: c },
    ]);
  });

  it("remaps an added step's hole to where it was placed", () => {
    const doc = scene();
    const t = typeAction(doc);
    const redacted = {
      ...doc,
      actions: doc.actions.map((a) =>
        a.id === t.id ? { ...a, text: null, redacted: true } : a,
      ),
    } as SceneDocument;
    // The saved script never had the typed step.
    const sk: ScriptSkeleton = {
      ...skeletonFor(doc),
      steps: skeletonFor(doc).steps.filter(
        (s) => s.do === "pause" || s.actionId !== t.id,
      ),
    };
    const d = derivedOf(redacted);
    // Premise: the typed step has a hole in the derivation.
    expect(d.holes).toContainEqual(
      expect.objectContaining({ actionId: t.id, field: "text" }),
    );
    const out = mergeSkeleton(d, { kind: "ok", skeleton: sk }, refuse(doc));
    if (!out.ok) throw new Error(JSON.stringify(out));
    const at = out.draft.steps.findIndex(
      (s) => "recorded" in s && s.recorded === t.id,
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(out.holes).toContainEqual(
      expect.objectContaining({ step: at, field: "text" }),
    );
  });

  /** The skeleton with its type step saved as a click: the hand edit that
   *  changed a step's verb, seen from the merge's side. */
  const verbChanged = (doc: SceneDocument) => {
    const sk = skeletonFor(doc);
    const i = sk.steps.findIndex((s) => s.do === "type");
    expect(i).toBeGreaterThanOrEqual(0);
    const step = sk.steps[i] as {
      actionId: string | null;
      anchorDigest: string | null;
    };
    sk.steps[i] = { ...step, do: "click" };
    return { sk, i, actionId: step.actionId };
  };

  it("refuses a step whose verb no longer matches its action, naming the route that works", () => {
    const doc = scene();
    const { sk, i } = verbChanged(doc);
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      refuse(doc),
    );
    expect(out).toMatchObject({
      ok: false,
      reason: "invalidScript",
      field: `steps.${i}.do`,
    });
    if (out.ok) return;
    expect(out.detail).toContain(
      "derive the take, write the step as you want it, and run that draft",
    );
  });

  it("takes the scene's verb for derive, and notes the change", () => {
    const doc = scene();
    const { sk, i, actionId } = verbChanged(doc);
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      { onVerbChange: "useScene", sceneName: doc.meta.name },
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.draft.steps[i]).toMatchObject({
      do: "type",
      recorded: actionId,
    });
    expect(out.notes).toEqual([
      { kind: "verbChanged", index: i, actionId, was: "click", now: "type" },
    ]);
  });

  it("remaps each hole to the merged step it belongs to", () => {
    const doc = scene();
    const sk = skeletonFor(doc);
    const t = typeAction(doc);
    const redacted = {
      ...doc,
      actions: doc.actions.map((a) =>
        a.id === t.id ? { ...a, text: null, redacted: true } : a,
      ),
    } as SceneDocument;
    const d = derivedOf(redacted);
    // Premise: the derivation has a hole at the typed step's action index.
    expect(d.holes).toContainEqual(
      expect.objectContaining({ actionId: t.id, field: "text" }),
    );
    const out = mergeSkeleton(d, { kind: "ok", skeleton: sk }, refuse(doc));
    if (!out.ok) throw new Error(JSON.stringify(out));
    const at = out.draft.steps.findIndex(
      (s) => "recorded" in s && s.recorded === t.id,
    );
    expect(out.holes).toContainEqual(
      expect.objectContaining({ step: at, field: "text" }),
    );
  });

  it("falls back to the derivation, saying why, with no skeleton or a broken one", () => {
    const doc = scene();
    const none = mergeSkeleton(derivedOf(doc), { kind: "none" }, refuse(doc));
    const broken = mergeSkeleton(
      derivedOf(doc),
      { kind: "unreadable", error: "script.json is not a JSON object" },
      refuse(doc),
    );
    if (!none.ok || !broken.ok) throw new Error("fallback refused");
    expect(none.notes).toEqual([{ kind: "noSkeleton" }]);
    expect(broken.notes).toEqual([
      { kind: "skeletonUnreadable", error: "script.json is not a JSON object" },
    ]);
    expect(none.draft.steps).toEqual(derivedOf(doc).draft.steps);
  });
});

describe("refilmScript", () => {
  it("refuses a hole rather than inventing a value", () => {
    const doc = scene();
    const t = typeAction(doc);
    const redacted = {
      ...doc,
      actions: doc.actions.map((a) =>
        a.id === t.id ? { ...a, text: null, redacted: true } : a,
      ),
    } as SceneDocument;
    const out = refilmScript(redacted, {
      kind: "ok",
      skeleton: skeletonFor(doc),
    });
    expect(out).toMatchObject({ ok: false, reason: "unfilledHoles" });
    if (out.ok) return;
    // The hole's own sentence says what is missing, then the route.
    const hole = derivedOf(redacted).holes.find((h) => h.actionId === t.id);
    if (hole === undefined)
      throw new Error("premise: the typed step has a hole");
    expect(out.detail).toContain(hole.sentence);
    expect(out.detail).toMatch(
      /derive the take, fill the hole, and run the draft$/,
    );
  });

  it("refuses a hand-changed verb, pointing at derive", () => {
    const doc = scene();
    const sk = skeletonFor(doc);
    const i = sk.steps.findIndex((s) => s.do === "type");
    expect(i).toBeGreaterThanOrEqual(0);
    sk.steps[i] = {
      ...(sk.steps[i] as {
        actionId: string | null;
        anchorDigest: string | null;
      }),
      do: "click",
    };
    expect(refilmScript(doc, { kind: "ok", skeleton: sk })).toMatchObject({
      ok: false,
      reason: "invalidScript",
      field: `steps.${i}.do`,
      detail: expect.stringContaining("run that draft"),
    });
  });

  it("refuses a take with no step left that acts", () => {
    const doc = scene();
    const emptied = { ...doc, actions: [] } as SceneDocument;
    expect(
      refilmScript(emptied, { kind: "ok", skeleton: skeletonFor(doc) }),
    ).toMatchObject({ ok: false, reason: "nothingToRerecord", field: null });
  });

  it("films the scene's steps when the saved script kept only a pause, naming each as added", () => {
    const doc = scene();
    const sk: ScriptSkeleton = {
      ...skeletonFor(doc),
      steps: [{ do: "pause", ms: 500 }],
    };
    const out = refilmScript(doc, { kind: "ok", skeleton: sk });
    if (!out.ok) throw new Error(JSON.stringify(out));
    const ids = derivedOf(doc).draft.steps.map((s) => s.recorded);
    expect(out.refilm.notes).toEqual(
      ids.map((actionId) => ({ kind: "actionAdded", actionId })),
    );
    // Every added step goes first, ahead of the pause: none has a placed
    // step before it in scene.json.
    expect((out.script.steps as { do: string }[]).map((s) => s.do).at(-1)).toBe(
      "pause",
    );
  });

  it("builds a script with the scene's name, look and target, recordedFrom the take", () => {
    const doc = scene();
    const sk = {
      ...skeletonFor(doc),
      name: "Filmed as",
      look: { canvas: { aspect: "16:9" as const } },
    };
    const restyled = {
      ...doc,
      canvas: { aspect: "9:16" as const },
    } as SceneDocument;
    // Premise: the skeleton's saved look (16:9) is not the scene's (9:16).
    expect(sk.look.canvas.aspect).not.toBe(restyled.canvas.aspect);
    const out = refilmScript(restyled, { kind: "ok", skeleton: sk });
    if (!out.ok) throw new Error(JSON.stringify(out));
    // Premise: the scene's name is not the skeleton's.
    expect(restyled.meta.name).not.toBe(sk.name);
    expect(out.script).toMatchObject({
      name: restyled.meta.name,
      target: restyled.meta.capture.originUrl,
      recordedFrom: restyled.meta.id,
      look: derivedOf(restyled).draft.look,
    });
    expect(out.script).toMatchObject({ look: { canvas: { aspect: "9:16" } } });
    expect(out.script).not.toHaveProperty("viewport");
    expect(out.refilm.from).toBe(restyled.meta.id);
  });
});

describe("notCarriedOf", () => {
  it("lists a zoom the editor aimed or ended, and leaves a generated one to the new take", () => {
    const doc = scene();
    const a = doc.actions[0]?.id as string;
    const generated = doc.camera[0];
    // Premise: the fixture's zoom is a generated one, aimed at an anchor
    // with no authored end.
    expect(generated).toMatchObject({ kind: "zoom" });
    expect(generated?.anchorId).toBeDefined();
    expect(generated?.point).toBeUndefined();
    expect(generated?.end).toBeUndefined();
    const withZooms = {
      ...doc,
      edits: { ...doc.edits, masks: [] },
      camera: [
        ...doc.camera,
        {
          id: "cam-point",
          kind: "zoom",
          point: { x: 10, y: 10 },
          marker: { actionId: a, offsetMs: 0 },
        },
        {
          id: "cam-end",
          kind: "zoom",
          anchorId: generated?.anchorId,
          marker: { actionId: a, offsetMs: 0 },
          end: { actionId: a, offsetMs: 900 },
        },
      ],
    } as SceneDocument;
    expect(notCarriedOf(withZooms)).toEqual([
      { kind: "zoom", id: "cam-point" },
      { kind: "zoom", id: "cam-end" },
    ]);
  });

  it("lists every editor edit bound to the old take's actions", () => {
    const doc = scene();
    const a = doc.actions[0]?.id as string;
    const edited = {
      ...doc,
      edits: {
        ...doc.edits,
        removed: [
          {
            id: "cut-1",
            start: { actionId: a, sourceOffsetMs: 0 },
            end: null,
          },
        ],
        splits: [{ id: "split-1", at: { actionId: a, sourceOffsetMs: 40 } }],
        masks: [{ id: "mask-1", rect: { x: 0, y: 0, width: 10, height: 10 } }],
        holds: [],
        gaps: [{ id: "gap-1", afterActionId: a, durationMs: 0 }],
        trim: { head: { actionId: a, offsetMs: 0 } },
      },
    } as unknown as SceneDocument;
    expect(notCarriedOf(edited)).toEqual([
      { kind: "removed", id: "cut-1" },
      { kind: "split", id: "split-1" },
      { kind: "mask", id: "mask-1" },
      { kind: "gap", id: "gap-1" },
      { kind: "trim", id: "head" },
    ]);
    // Premise: the fixture carries a mask, and nothing else. Asserted
    // against the file's own edits so a changed fixture goes red here.
    expect(doc.edits.masks.map((m) => m.id)).toEqual(["mask-1"]);
    expect(doc.edits.removed).toEqual([]);
    expect(doc.edits.splits).toEqual([]);
    expect(doc.edits.holds).toEqual([]);
    expect(doc.edits.gaps).toEqual([]);
    expect(doc.edits.trim).toBeUndefined();
    expect(notCarriedOf(doc)).toEqual([{ kind: "mask", id: "mask-1" }]);
    // The empty case, on the same fixture with its edits cleared.
    const cleared = {
      ...doc,
      edits: { ...doc.edits, masks: [] },
    } as SceneDocument;
    expect(notCarriedOf(cleared)).toEqual([]);
  });
});
