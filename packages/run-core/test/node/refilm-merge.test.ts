// packages/run-core/test/node/refilm-merge.test.ts
import {
  DemoScriptSchema,
  SCRIPT_VERSION_EDITS,
  type SceneDocument,
  SceneDocumentSchema,
  scriptFromTake,
  type ZoomIntent,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { zoomsForClicks } from "../../src/auto-zoom.js";
import {
  mergeSkeleton,
  notCarriedOf,
  refilmScript,
} from "../../src/refilm/merge.js";
import {
  parseSkeleton,
  type ScriptSkeleton,
} from "../../src/refilm/skeleton.js";
import { MIN_ZOOM_GAP_MS } from "../../src/zoom-defaults.js";
import { scene } from "./refilm-fixture.js";

/** The fixture's actions as a skeleton: a pause between every two steps,
 *  each acting step naming its action — what a CLI run of it would save. */
function skeletonFor(doc: SceneDocument): ScriptSkeleton {
  const derived = scriptFromTake(doc);
  if (derived.outcome !== "derived") throw new Error("fixture derives nothing");
  return {
    skeletonVersion: 2,
    trim: null,
    name: "Fixture",
    scriptVersion: 1,
    viewport: null,
    device: null,
    look: null,
    steps: derived.draft.steps.flatMap((s, i) => [
      ...(i === 0 ? [] : [{ do: "pause" as const, ms: 700 + i }]),
      {
        do: s.do,
        actionId: s.recorded ?? null,
        anchorDigest: null,
        finishMs: null,
        zoomOutMs: null,
      },
    ]),
  };
}

/** A re-film's options (`refilmScript`'s): refuse a changed verb, and the
 *  scene it reads names and Studio edits from. */
const refuse = (doc: SceneDocument) => ({
  onVerbChange: "refuse" as const,
  scene: doc,
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
      finishMs: number | null;
      zoomOutMs: number | null;
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
      "derive the video, write the step as you want it, and run that draft",
    );
  });

  it("takes the scene's verb for derive, and notes the change", () => {
    const doc = scene();
    const { sk, i, actionId } = verbChanged(doc);
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: sk },
      { onVerbChange: "useScene", scene: doc },
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
      /derive the video, fill the hole, and run the draft$/,
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
        finishMs: number | null;
        zoomOutMs: number | null;
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
    // The head is written back into the script (`trim.start`), so it is
    // carried, never listed.
    expect(notCarriedOf(edited)).toEqual([
      { kind: "removed", id: "cut-1" },
      { kind: "split", id: "split-1" },
      { kind: "mask", id: "mask-1" },
      { kind: "gap", id: "gap-1" },
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

// Write-back (spec 2026-11-01 video-as-code §4): the Studio's trim and zoom
// edits become the script's `trim` and `zoom`, so a re-record keeps them.
describe("write-back", () => {
  /** The fixture with its mask cleared, so `notCarried` is only what the
   *  write-back leaves; parsed, so every scene here is one the library reads. */
  const plain = (edit: (d: SceneDocument) => SceneDocument = (d) => d) =>
    SceneDocumentSchema.parse(
      edit({ ...scene(), edits: { ...scene().edits, masks: [] } }),
    );

  /** `sk` with the step that filmed `actionId` timed, as a v2 run saves it. */
  const timed = (
    sk: ScriptSkeleton,
    actionId: string,
    finishMs: number,
    zoomOutMs: number | null,
  ): ScriptSkeleton => ({
    ...sk,
    steps: sk.steps.map((s) =>
      s.do !== "pause" && s.actionId === actionId
        ? { ...s, finishMs, zoomOutMs }
        : s,
    ),
  });

  const trimmed = (
    head?: { actionId: string; offsetMs: number },
    tail?: { actionId: string; offsetMs: number },
  ) =>
    plain((d) => ({
      ...d,
      edits: {
        ...d.edits,
        trim: {
          ...(head === undefined ? {} : { head }),
          ...(tail === undefined ? {} : { tail }),
        },
      },
    }));

  /** The re-record's script, parsed as the run's door parses it. */
  const rerecorded = (doc: SceneDocument, sk: ScriptSkeleton) => {
    const out = refilmScript(doc, { kind: "ok", skeleton: sk });
    if (!out.ok) throw new Error(JSON.stringify(out));
    return { ...out, parsed: DemoScriptSchema.parse(out.script) };
  };

  it("the fixture's shown steps: act-1 first (step 1), act-3 last (step 5), act-4 not shown (step 7)", () => {
    const doc = plain();
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: skeletonFor(doc) },
      refuse(doc),
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    // Premise for every step number below.
    expect(
      out.draft.steps.map((s) => (s.do === "pause" ? "pause" : s.recorded)),
    ).toEqual(["act-1", "pause", "act-2", "pause", "act-3", "pause", "act-4"]);
    expect(out.draft.steps.map((s) => s.do)).toEqual([
      "hover",
      "pause",
      "click",
      "pause",
      "type",
      "pause",
      "waitForLoad",
    ]);
  });

  it("nothing in the scene, nothing in the script", () => {
    // The take as a run saves it today: a generated zoom on its click, with
    // a source and no scale anyone set.
    const doc = plain((d) => ({
      ...d,
      camera: d.camera.map((c) => ({ ...c, source: "click" as const })),
    }));
    expect(doc.camera).toHaveLength(1); // premise: a zoom is there to ignore
    const sk = skeletonFor(doc);
    const { script, parsed, refilm } = rerecorded(
      doc,
      timed(sk, "act-3", 400, 1500),
    );
    expect(script).not.toHaveProperty("trim");
    expect((script.steps as object[]).filter((s) => "zoom" in s)).toEqual([]);
    expect(parsed.scriptVersion).toBeLessThan(SCRIPT_VERSION_EDITS);
    expect(refilm.notes).toEqual([]);
    expect(refilm.notCarried).toEqual([]);
  });

  it.each<
    [number, number, number | null, { ms: number; after?: "action" }, string]
  >([
    // [offsetMs, finishMs, zoomOutMs, end, why]
    [1800, 400, 1500, { ms: 300 }, "past the zoom-out: the default"],
    [900, 400, 1500, { ms: 500, after: "action" }, "before the zoom-out"],
    [900, 400, null, { ms: 500 }, "no zoom yet: the finish is the zoom-out"],
    [1500, 400, 1500, { ms: 0 }, "right at the zoom-out"],
    [
      1000,
      900,
      300,
      { ms: 100 },
      "a zoom-out before the finish: measured from the finish",
    ],
  ])(
    "a Studio tail trim becomes trim.end: offset %d, finish %d, zoom-out %s (%s)",
    (offsetMs, finishMs, zoomOutMs, end) => {
      const doc = trimmed(undefined, { actionId: "act-3", offsetMs });
      const { parsed, refilm } = rerecorded(
        doc,
        timed(skeletonFor(doc), "act-3", finishMs, zoomOutMs),
      );
      // act-3 is the last shown step, so `step` is left to the default.
      expect(parsed.trim).toEqual({ end });
      expect(parsed.scriptVersion).toBe(SCRIPT_VERSION_EDITS);
      expect(refilm.notCarried).toEqual([]);
      expect(refilm.notes).toEqual([]);
    },
  );

  it("a tail the author cut inside the step ends right after it, and says so", () => {
    const doc = trimmed(undefined, { actionId: "act-3", offsetMs: 100 });
    const { parsed, refilm } = rerecorded(
      doc,
      timed(skeletonFor(doc), "act-3", 400, 1500),
    );
    expect(parsed.trim).toEqual({ end: { ms: 0, after: "action" } });
    expect(refilm.notes).toEqual([{ kind: "trimClampedToStep", side: "end" }]);
  });

  it("a tail on a step that is not the last shown names it", () => {
    const doc = trimmed(undefined, { actionId: "act-2", offsetMs: 700 });
    const { parsed } = rerecorded(
      doc,
      timed(skeletonFor(doc), "act-2", 200, 1000),
    );
    expect(parsed.trim).toEqual({ end: { step: 3, ms: 500, after: "action" } });
  });

  it("a Studio head trim on the third step names step 3", () => {
    const doc = trimmed({ actionId: "act-2", offsetMs: -250 });
    const { parsed, refilm } = rerecorded(doc, skeletonFor(doc));
    expect(parsed.trim).toEqual({ start: { step: 3, ms: 250 } });
    expect(parsed.scriptVersion).toBe(SCRIPT_VERSION_EDITS);
    expect(refilm.notCarried).toEqual([]);
  });

  it("a head on the first shown step leaves step to the default; one inside the step starts at it, and says so", () => {
    const first = trimmed({ actionId: "act-1", offsetMs: -120 });
    expect(rerecorded(first, skeletonFor(first)).parsed.trim).toEqual({
      start: { ms: 120 },
    });
    const inside = trimmed({ actionId: "act-1", offsetMs: 300 });
    const out = rerecorded(inside, skeletonFor(inside));
    expect(out.parsed.trim).toEqual({ start: { ms: 0 } });
    expect(out.refilm.notes).toEqual([
      { kind: "trimClampedToStep", side: "start" },
    ]);
  });

  it("a v1 skeleton leaves the tail in notCarried and carries the head", () => {
    const doc = trimmed(
      { actionId: "act-2", offsetMs: -250 },
      { actionId: "act-3", offsetMs: 900 },
    );
    const { trim: _t, ...v2 } = skeletonFor(doc);
    const v1 = parseSkeleton({
      ...v2,
      skeletonVersion: 1,
      steps: v2.steps.map((s) => {
        if (s.do === "pause") return s;
        const { finishMs: _f, zoomOutMs: _z, ...rest } = s;
        return rest;
      }),
    });
    if (!v1.ok) throw new Error(v1.error);
    // Premise: the v1 file knows no finish for the tail's step.
    expect(
      v1.skeleton.steps.find((s) => s.do !== "pause" && s.actionId === "act-3"),
    ).toMatchObject({ finishMs: null });
    const { parsed, refilm } = rerecorded(doc, v1.skeleton);
    expect(parsed.trim).toEqual({ start: { step: 3, ms: 250 } });
    expect(refilm.notCarried).toEqual([{ kind: "trim", id: "tail" }]);
    // No skeleton at all: the same, the head carried from the scene alone.
    const none = refilmScript(doc, { kind: "none" });
    if (!none.ok) throw new Error(JSON.stringify(none));
    expect(DemoScriptSchema.parse(none.script).trim).toEqual({
      start: { step: 2, ms: 250 },
    });
    expect(none.refilm.notCarried).toEqual([{ kind: "trim", id: "tail" }]);
  });

  /** The fixture with one click's zoom edited as the Studio records it. */
  const zoomed = (edit: Partial<SceneDocument>) =>
    plain((d) => ({ ...d, ...edit }) as SceneDocument);

  const zoomOf = (script: { steps: object[] }, actionId: string) =>
    script.steps.find((s) => "recorded" in s && s.recorded === actionId);

  it("an off skip becomes zoom false", () => {
    const doc = zoomed({
      camera: [],
      zoomsSkipped: [{ actionId: "act-2", reason: "off" }],
    });
    const { parsed } = rerecorded(doc, skeletonFor(doc));
    expect(zoomOf(parsed, "act-2")).toMatchObject({ do: "click", zoom: false });
    expect(parsed.scriptVersion).toBe(SCRIPT_VERSION_EDITS);
    expect(parsed.steps.filter((s) => "zoom" in s)).toHaveLength(1);
  });

  it("scaleSetBy author becomes zoom scale", () => {
    const doc = zoomed({
      camera: scene().camera.map((c) => ({
        ...c,
        source: "click" as const,
        scaleSetBy: "author" as const,
        scale: 1.8,
      })),
    });
    // Premise: the edited zoom is the one on act-2's click.
    expect(doc.camera[0]?.marker.actionId).toBe("act-2");
    const { parsed, refilm } = rerecorded(doc, skeletonFor(doc));
    expect(zoomOf(parsed, "act-2")).toMatchObject({ zoom: { scale: 1.8 } });
    expect(refilm.notCarried).toEqual([]);
    // The same zoom with no one's scale is the camera's to choose again.
    const generated = zoomed({
      camera: scene().camera.map((c) => ({ ...c, source: "click" as const })),
    });
    expect(
      zoomOf(rerecorded(generated, skeletonFor(generated)).parsed, "act-2"),
    ).not.toHaveProperty("zoom");
  });

  it("a zoom the scene asks of a step that is not a click or drag is not written, and says so", () => {
    const doc = zoomed({
      zoomsSkipped: [{ actionId: "act-3", reason: "off" }],
    });
    const { parsed, refilm } = rerecorded(doc, skeletonFor(doc));
    expect(zoomOf(parsed, "act-3")).not.toHaveProperty("zoom");
    expect(refilm.notes).toEqual([
      { kind: "zoomNotWritten", actionId: "act-3", why: "notClickOrDrag" },
    ]);
  });

  it("a scale the script cannot hold is not written, and says so", () => {
    const doc = zoomed({
      camera: scene().camera.map((c) => ({
        ...c,
        source: "click" as const,
        scaleSetBy: "author" as const,
        scale: 4,
      })),
    });
    const { parsed, refilm } = rerecorded(doc, skeletonFor(doc));
    expect(zoomOf(parsed, "act-2")).not.toHaveProperty("zoom");
    expect(refilm.notes).toEqual([
      { kind: "zoomNotWritten", actionId: "act-2", why: "invalidScale" },
    ]);
  });

  it("askedScale survives two re-records", () => {
    // act-1 made a click on act-2's element, so act-2 comes too soon after
    // act-1's zoom for one of its own.
    const twoClicks = plain((d) => ({
      ...d,
      camera: [],
      actions: d.actions.map((a) =>
        a.id === "act-1" ? ({ ...a, kind: "click" } as typeof a) : a,
      ),
    }));
    const [a1, a2] = twoClicks.actions;
    expect(Math.abs((a2?.timestamp ?? 0) - (a1?.timestamp ?? 0))).toBeLessThan(
      MIN_ZOOM_GAP_MS,
    );
    /** The take a run of `script` saves: its zooms decided from the
     *  script's intent by `zoomsForClicks`, as Tasks 3–5 record them. */
    const recorded = (script: { steps: object[] }) => {
      const intent = (id: string) =>
        (zoomOf(script, id) as { zoom?: ZoomIntent } | undefined)?.zoom;
      const { camera, zoomsSkipped } = zoomsForClicks(
        twoClicks.actions,
        twoClicks.meta.capture.viewport,
        undefined,
        intent,
      );
      return SceneDocumentSchema.parse({
        ...twoClicks,
        camera,
        ...(zoomsSkipped.length === 0 ? {} : { zoomsSkipped }),
      });
    };
    const first = recorded({
      steps: [{ do: "click", recorded: "act-2", zoom: { scale: 2 } }],
    });
    // Premise: the gap rule refused the asked scale and kept it as asked.
    expect(first.zoomsSkipped).toEqual([
      expect.objectContaining({
        actionId: "act-2",
        reason: "sameTarget",
        askedScale: 2,
      }),
    ]);
    // The skeleton's own record of the ask is not what the merge reads.
    const sk = skeletonFor(first);
    const once = rerecorded(first, sk).parsed;
    expect(zoomOf(once, "act-2")).toMatchObject({ zoom: { scale: 2 } });
    expect(zoomOf(once, "act-1")).not.toHaveProperty("zoom");
    const second = recorded(once);
    expect(second.zoomsSkipped).toEqual(first.zoomsSkipped);
    const twice = rerecorded(second, sk).parsed;
    expect(zoomOf(twice, "act-2")).toMatchObject({ zoom: { scale: 2 } });
    expect(twice.steps).toEqual(once.steps);
  });

  it("derive's draft carries the same fields", () => {
    const doc = trimmed({ actionId: "act-2", offsetMs: -250 });
    const out = mergeSkeleton(
      derivedOf(doc),
      { kind: "ok", skeleton: skeletonFor(doc) },
      { onVerbChange: "useScene", scene: doc },
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.draft.trim).toEqual({ start: { step: 3, ms: 250 } });
  });
});

describe("notCarriedOf, with the skeleton", () => {
  const withTail = () => {
    const doc = scene();
    return {
      ...doc,
      edits: {
        ...doc.edits,
        masks: [],
        trim: {
          head: { actionId: "act-1", offsetMs: -50 },
          tail: { actionId: "act-3", offsetMs: 900 },
        },
      },
    } as SceneDocument;
  };

  it("lists a tail only when its step's finish is unknown", () => {
    const doc = withTail();
    const sk = skeletonFor(doc);
    // Premise: skeletonFor times no step.
    expect(sk.steps.every((s) => s.do === "pause" || s.finishMs === null)).toBe(
      true,
    );
    expect(notCarriedOf(doc, sk)).toEqual([{ kind: "trim", id: "tail" }]);
    expect(notCarriedOf(doc)).toEqual([{ kind: "trim", id: "tail" }]);
    const known: ScriptSkeleton = {
      ...sk,
      steps: sk.steps.map((s) =>
        s.do !== "pause" && s.actionId === "act-3"
          ? { ...s, finishMs: 400, zoomOutMs: null }
          : s,
      ),
    };
    expect(notCarriedOf(doc, known)).toEqual([]);
  });

  it("an author zoom on a click is notCarried; a click zoom is not; a sourceless anchor zoom is not", () => {
    const doc = scene();
    const base = doc.camera[0];
    // Premise: the fixture's zoom is sourceless, on an anchor, no point or end.
    expect(base?.source).toBeUndefined();
    expect(base?.point).toBeUndefined();
    expect(base?.end).toBeUndefined();
    const withZooms = {
      ...doc,
      edits: { ...doc.edits, masks: [] },
      camera: [
        base,
        { ...base, id: "cam-author", source: "author" },
        // A drag's generated zoom aims at a point and is still the camera's.
        {
          id: "cam-click",
          kind: "zoom",
          point: { x: 10, y: 10 },
          marker: { actionId: "act-2", offsetMs: 0 },
          end: { actionId: "act-2", offsetMs: 900 },
          source: "click",
        },
      ],
    } as SceneDocument;
    expect(notCarriedOf(withZooms)).toEqual([
      { kind: "zoom", id: "cam-author" },
    ]);
  });
});
