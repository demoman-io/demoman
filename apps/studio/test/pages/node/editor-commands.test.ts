import { MOTION_DEFAULTS, SceneDocumentSchema } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { applyCommand } from "../../../pages/src/editor/commands";

// A counter, not a uuid: a command's output has to be byte-comparable
// across runs or half the assertions below become snapshots of randomness.
function ids(): () => string {
  let n = 0;
  return () => `gen-${++n}`;
}

describe("applyCommand", () => {
  it("renames the scene", () => {
    const next = applyCommand(
      readonlyScene(),
      { kind: "rename", name: "Checkout walkthrough" },
      ids(),
    );
    expect(next.meta.name).toBe("Checkout walkthrough");
  });

  it("never mutates the input document", () => {
    const scene = readonlyScene();
    const before = JSON.stringify(scene);
    applyCommand(scene, { kind: "rename", name: "changed" }, ids());
    expect(JSON.stringify(scene)).toBe(before);
  });

  // FINDING 5. A replacement hangs on an ANCHOR, and an anchor outlives the
  // actions that used it — so `rehome` (which walks markers) never saw one.
  // With the replacements list gone, the step panel is the only place a
  // replacement can be edited, and a replacement whose steps have all left
  // the take has no step panel: it was still painted by `planCosmetics` and
  // by replay, with nothing anywhere an author could use to find or remove
  // it.
});

describe("action-track semantics", () => {
  // This used to author `scale: 1` rather than delete, because deleting handed
  // the beat straight back to the auto-camera that filled every click no
  // authored event covered. Nothing refills it now, so removing a zoom can
  // mean what it says.
  it("removes the camera event when a zoom is cleared", () => {
    const zoomed = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-3", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-checkout" },
        scale: 1.8,
      },
      ids(),
    );
    expect(zoomed.camera).toHaveLength(1);

    const next = applyCommand(
      zoomed,
      { kind: "removeZoom", id: "gen-1" },
      ids(),
    );
    expect(next.camera).toEqual([]);
  });

  it("says so rather than authoring a zoom that does not zoom", () => {
    expect(() =>
      applyCommand(
        readonlyScene(),
        {
          kind: "addZoom",
          marker: { actionId: "act-3", offsetMs: 0 },
          target: { kind: "element", anchorId: "a-checkout" },
          scale: 1,
        },
        ids(),
      ),
    ).toThrow(/1:1 is not a zoom/);
  });

  it("sets a gap after an action", () => {
    const next = applyCommand(
      readonlyScene(),
      { kind: "setGap", afterActionId: "act-1", durationMs: 250 },
      ids(),
    );
    expect(next.edits.gaps).toEqual([
      { id: "gen-1", afterActionId: "act-1", durationMs: 250 },
    ]);
  });

  it("replaces rather than appends a second gap on the same action", () => {
    const once = applyCommand(
      readonlyScene(),
      { kind: "setGap", afterActionId: "act-1", durationMs: 250 },
      ids(),
    );
    const twice = applyCommand(
      once,
      { kind: "setGap", afterActionId: "act-1", durationMs: 900 },
      ids(),
    );
    expect(twice.edits.gaps).toHaveLength(1);
    expect(twice.edits.gaps[0]).toMatchObject({
      id: "gen-1",
      durationMs: 900,
    });
  });

  // The whole reason `Gap.durationMs` is `nonnegative` where
  // `Hold.durationMs` is `positive`: zero is how an author says "cut the dead
  // air here", and it has to be distinguishable from "use what was recorded".
  it("keeps a zero gap, which is not the same as no gap", () => {
    const next = applyCommand(
      readonlyScene(),
      { kind: "setGap", afterActionId: "act-1", durationMs: 0 },
      ids(),
    );
    expect(next.edits.gaps).toHaveLength(1);
    expect(next.edits.gaps[0]?.durationMs).toBe(0);
  });

  // Shift+Delete. One command rather than a `deleteAction` followed by a
  // `setGap`, because two dispatches would put two entries on the undo stack
  // for one keystroke — and a half-undo would leave a pause belonging to a
  // step that is back on the timeline.

  it("clearGap removes the entry, restoring the recorded duration", () => {
    const set = applyCommand(
      readonlyScene(),
      { kind: "setGap", afterActionId: "act-1", durationMs: 0 },
      ids(),
    );
    const cleared = applyCommand(
      set,
      { kind: "clearGap", afterActionId: "act-1" },
      ids(),
    );
    expect(cleared.edits.gaps).toEqual([]);
  });

  // Unlike clearCamera, removal is right here: nothing auto-generates a gap,
  // so clearing a beat that carries none is not an error — but it must not
  // leave one behind either.
  it("leaves an action with no gap alone when it is cleared", () => {
    const next = applyCommand(
      readonlyScene(),
      { kind: "clearGap", afterActionId: "act-1" },
      ids(),
    );
    expect(next.edits.gaps).toEqual([]);
  });

  it("refuses, by name, a gap after the last step", () => {
    // `planScene` pairs each action with the NEXT one, so a gap after the
    // final step is never read. Authoring one would show the author a number
    // in the inspector that the render ignores — a success the failure is
    // indistinguishable from.
    expect(() =>
      applyCommand(
        readonlyScene(),
        { kind: "setGap", afterActionId: "act-3", durationMs: 250 },
        ids(),
      ),
    ).toThrow(/last step/);
  });
});

describe("setZoomRange", () => {
  it("moves an existing zoom's lead-in without touching its level", () => {
    const scene = {
      ...readonlyScene(),
      camera: [
        {
          id: "cam-1",
          kind: "zoom" as const,
          anchorId: "a-checkout",
          marker: { actionId: "act-3", offsetMs: -350 },
          scale: 1.6,
        },
      ],
    };
    const next = applyCommand(
      scene,
      {
        kind: "setZoomRange",
        id: "cam-1",
        start: { actionId: "act-3", offsetMs: -900 },
        end: null,
      },
      ids(),
    );
    expect(next.camera[0]?.marker.offsetMs).toBe(-900);
    expect(next.camera[0]?.scale).toBe(1.6);
    expect(next.camera[0]?.id).toBe("cam-1");
  });

  it("refuses to move a lead-in on a zoom that does not exist", () => {
    expect(() =>
      applyCommand(
        readonlyScene(),
        {
          kind: "setZoomRange",
          id: "cam-none",
          start: { actionId: "act-3", offsetMs: -200 },
          end: null,
        },
        ids(),
      ),
    ).toThrow(/unknown zoom/);
  });
});

describe("setCursor", () => {
  it("changes only the cursor field it names", () => {
    const scene = readonlyScene();
    const next = applyCommand(
      scene,
      { kind: "setCursor", patch: { style: "dark" } },
      ids(),
    );
    expect(next.cursor).toEqual({ ...scene.cursor, style: "dark" });
  });

  it("accepts several cursor fields at once", () => {
    const scene = readonlyScene();
    const next = applyCommand(
      scene,
      { kind: "setCursor", patch: { hidden: true, motionBlur: 0 } },
      ids(),
    );
    expect(next.cursor.hidden).toBe(true);
    expect(next.cursor.motionBlur).toBe(0);
    expect(next.cursor.style).toBe(scene.cursor.style);
  });
});

describe("setMotion", () => {
  it("writes the whole block from the defaults on the first edit", () => {
    const scene = readonlyScene();
    // Premise: the fixture has no block, so this is the first write.
    expect(scene.motion).toBeUndefined();
    const next = applyCommand(
      scene,
      { kind: "setMotion", patch: { smoothness: 0.9 } },
      ids(),
    );
    expect(next.motion).toEqual({ ...MOTION_DEFAULTS, smoothness: 0.9 });
    expect(() => SceneDocumentSchema.parse(next)).not.toThrow();
  });

  it("changes only the field it names on a block that exists", () => {
    const scene = {
      ...readonlyScene(),
      motion: { smoothness: 0.2, blur: 0.1, follow: true },
    };
    const next = applyCommand(
      scene,
      { kind: "setMotion", patch: { follow: false } },
      ids(),
    );
    expect(next.motion).toEqual({ smoothness: 0.2, blur: 0.1, follow: false });
    // The cursor is a different block and stays put.
    expect(next.cursor).toEqual(scene.cursor);
  });

  it("refuses a value the schema does not allow", () => {
    expect(() =>
      applyCommand(
        readonlyScene(),
        { kind: "setMotion", patch: { blur: 1.5 } },
        ids(),
      ),
    ).toThrow();
  });
});

describe("setBranding", () => {
  it("applies the patch to the document's branding", () => {
    const scene = readonlyScene();
    const next = applyCommand(
      scene,
      {
        kind: "setBranding",
        patch: { background: { kind: "solid", color: "#1b2a4a" } },
      },
      ids(),
    );
    expect(next.branding.background).toEqual({
      kind: "solid",
      color: "#1b2a4a",
    });
  });

  it("refuses a patch the schema refuses, rather than storing it", () => {
    const scene = readonlyScene();
    expect(
      () =>
        applyCommand(
          scene,
          {
            kind: "setBranding",
            patch: { background: { kind: "solid", color: "rgb(1,2,3)" } },
          },
          ids(),
        ),
      // The schema's own complaint, about the colour — not any throw: an
      // unrecognised patch shape also throws, for a different reason.
    ).toThrow(/color/);
  });
});

describe("setAspect", () => {
  it("sets the canvas aspect and nothing else", () => {
    const scene = readonlyScene();
    expect(scene.canvas.aspect).toBe("16:9");
    const next = applyCommand(
      scene,
      { kind: "setAspect", aspect: "9:16" },
      ids(),
    );
    expect(next.canvas).toEqual({ aspect: "9:16" });
    // Whole-document equality, not identity: `applyCommand` re-parses the
    // scene, which clones every array.
    expect(next).toEqual({ ...scene, canvas: { aspect: "9:16" } });
  });

  it("switches a 16:9 demo to Auto and nothing else", () => {
    const scene = readonlyScene();
    expect(scene.canvas.aspect).toBe("16:9");
    const next = applyCommand(
      scene,
      { kind: "setAspect", aspect: "auto" },
      ids(),
    );
    expect(next).toEqual({ ...scene, canvas: { aspect: "auto" } });
  });
});

// Spec 2026-10-22 split-tool.
describe("split, removePiece and restorePiece", () => {
  const point = (actionId: string, sourceOffsetMs: number) => ({
    actionId,
    sourceOffsetMs,
  });

  it("splits twice, removes the middle, and restores it", () => {
    const newId = ids();
    let scene = readonlyScene();
    scene = applyCommand(
      scene,
      { kind: "split", at: point("act-1", 1000) },
      newId,
    );
    scene = applyCommand(
      scene,
      { kind: "split", at: point("act-2", 500) },
      newId,
    );
    const splits = scene.edits.splits;
    expect(splits.map((s) => s.at)).toEqual([
      point("act-1", 1000),
      point("act-2", 500),
    ]);
    scene = applyCommand(
      scene,
      {
        kind: "removePiece",
        start: point("act-1", 1000),
        end: point("act-2", 500),
      },
      newId,
    );
    const [removed] = scene.edits.removed;
    expect(removed).toMatchObject({
      start: point("act-1", 1000),
      end: point("act-2", 500),
    });
    if (removed === undefined) throw new Error("nothing removed");
    scene = applyCommand(
      scene,
      { kind: "restorePiece", id: removed.id },
      newId,
    );
    expect(scene.edits.removed).toEqual([]);
    expect(scene.edits.splits).toEqual(splits);
  });

  it("refuses to remove the whole take", () => {
    expect(() =>
      applyCommand(
        readonlyScene(),
        { kind: "removePiece", start: null, end: null },
        ids(),
      ),
    ).toThrow(/nothing/);
  });

  it("refuses a split on a step the take does not have", () => {
    expect(() =>
      applyCommand(
        readonlyScene(),
        { kind: "split", at: point("act-9", 0) },
        ids(),
      ),
    ).toThrow(/act-9/);
  });

  it("moves one end of a removed range and leaves the other", () => {
    const scene = applyCommand(
      {
        ...readonlyScene(),
        edits: {
          ...readonlyScene().edits,
          removed: [
            { id: "r1", start: point("act-2", 0), end: point("act-2", 900) },
          ],
        },
      },
      { kind: "setRemovedEdge", id: "r1", start: point("act-2", 400) },
      ids(),
    );
    expect(scene.edits.removed).toEqual([
      { id: "r1", start: point("act-2", 400), end: point("act-2", 900) },
    ]);
  });

  it("refuses to move a range that is not there, or onto a missing step", () => {
    const scene = {
      ...readonlyScene(),
      edits: {
        ...readonlyScene().edits,
        removed: [{ id: "r1", start: point("act-2", 0), end: null }],
      },
    };
    expect(() =>
      applyCommand(
        scene,
        { kind: "setRemovedEdge", id: "r-9", end: null },
        ids(),
      ),
    ).toThrow(/r-9/);
    expect(() =>
      applyCommand(
        scene,
        { kind: "setRemovedEdge", id: "r1", end: point("act-9", 0) },
        ids(),
      ),
    ).toThrow(/act-9/);
    expect(() =>
      applyCommand(
        scene,
        { kind: "setRemovedEdge", id: "r1", start: null },
        ids(),
      ),
    ).toThrow(/nothing/);
  });

  it("refuses to restore a piece that is not removed", () => {
    expect(() =>
      applyCommand(readonlyScene(), { kind: "restorePiece", id: "r-9" }, ids()),
    ).toThrow(/r-9/);
  });
});
