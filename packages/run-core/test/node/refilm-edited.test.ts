// packages/run-core/test/node/refilm-edited.test.ts
import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { editedSinceRecorded, targetCheckOf } from "../../src/refilm/edited.js";
import {
  anchorDigest,
  type ScriptSkeleton,
} from "../../src/refilm/skeleton.js";
import { scene as fixture } from "./refilm-fixture.js";

describe("editedSinceRecorded", () => {
  it("is empty for a take nobody touched", () => {
    const doc = fixture();
    expect(editedSinceRecorded(doc, madeFromOf(doc), { kind: "none" })).toEqual(
      [],
    );
  });

  it("is empty for a take nobody touched, with its own skeleton's digests compared", () => {
    const doc = fixture();
    const anchors = new Map(doc.anchors.map((a) => [a.id, a]));
    // What a CLI run of this take would save: every action, its own digest.
    const sk: ScriptSkeleton = {
      skeletonVersion: 1,
      name: doc.meta.name,
      scriptVersion: 1,
      viewport: null,
      device: null,
      look: null,
      steps: doc.actions.map((a) => {
        const anchor =
          a.anchorId === null ? undefined : anchors.get(a.anchorId);
        return {
          do: "click" as const,
          actionId: a.id,
          anchorDigest:
            anchor === undefined ? null : anchorDigest(anchor.fingerprint),
        };
      }),
    };
    // Premise: digests were saved, so the comparison below really runs.
    expect(
      sk.steps.filter((s) => s.do !== "pause" && s.anchorDigest !== null)
        .length,
    ).toBeGreaterThan(1);
    expect(
      editedSinceRecorded(doc, madeFromOf(doc), { kind: "ok", skeleton: sk }),
    ).toEqual([]);
  });

  it("names a typed-text edit with what it was and is", () => {
    const doc = fixture();
    const t = doc.actions.find((a) => a.kind === "type");
    if (t === undefined || t.kind !== "type")
      throw new Error("fixture has no type step");
    const edited = {
      ...doc,
      actions: doc.actions.map((a) =>
        a.id === t.id ? { ...a, text: "Maple" } : a,
      ),
    } as SceneDocument;
    expect(
      editedSinceRecorded(edited, madeFromOf(doc), { kind: "none" }),
    ).toEqual([{ actionId: t.id, what: "text", was: t.text, now: "Maple" }]);
  });

  it("names a removed action and an added one, in that order, and nothing else", () => {
    const doc = fixture();
    const gone = doc.actions[0];
    if (gone === undefined) throw new Error("fixture has no actions");
    const edited = {
      ...doc,
      actions: [...doc.actions.slice(1), { ...gone, id: "ac-new" }],
    } as SceneDocument;
    // Scene actions first (the added one), then the removed ones.
    expect(
      editedSinceRecorded(edited, madeFromOf(doc), { kind: "none" }),
    ).toEqual([
      { actionId: "ac-new", what: "added" },
      { actionId: gone.id, what: "removed" },
    ]);
  });

  it("names a same-id kind change, not a text or target edit", () => {
    const doc = fixture();
    const t = doc.actions.find((a) => a.kind === "type");
    if (t === undefined) throw new Error("fixture has no type step");
    // Premise: the frames recorded this id as a type step.
    const filmed = madeFromOf(doc).find((m) => m.actionId === t.id);
    expect(filmed?.kind).toBe("type");
    const edited = {
      ...doc,
      actions: doc.actions.map((a) =>
        a.id === t.id ? { ...a, kind: "click" } : a,
      ),
    } as SceneDocument;
    expect(
      editedSinceRecorded(edited, madeFromOf(doc), { kind: "none" }),
    ).toEqual([{ actionId: t.id, what: "kind", was: "type", now: "click" }]);
  });

  // Review Focus 3: same anchorId, edited fingerprint — invisible to madeFrom.
  it("names a fingerprint edit through the skeleton's digest", () => {
    const doc = fixture();
    const acting = doc.actions.find((a) => a.anchorId !== null);
    if (acting === undefined || acting.anchorId === null)
      throw new Error("fixture has no anchored action");
    const anchor = doc.anchors.find((a) => a.id === acting.anchorId);
    if (anchor === undefined) throw new Error("fixture anchor missing");
    const sk: ScriptSkeleton = {
      skeletonVersion: 1,
      name: "x",
      scriptVersion: 1,
      viewport: null,
      device: null,
      look: null,
      steps: [
        {
          do: "click",
          actionId: acting.id,
          anchorDigest: anchorDigest(anchor.fingerprint),
        },
      ],
    };
    const edited = {
      ...doc,
      anchors: doc.anchors.map((a) =>
        a.id === anchor.id
          ? {
              ...a,
              fingerprint: { ...a.fingerprint, stableId: "edited-by-hand" },
            }
          : a,
      ),
    } as SceneDocument;
    // Premise: madeFrom alone sees nothing.
    expect(
      editedSinceRecorded(edited, madeFromOf(doc), { kind: "none" }),
    ).toEqual([]);
    expect(
      editedSinceRecorded(edited, madeFromOf(doc), {
        kind: "ok",
        skeleton: sk,
      }),
    ).toEqual([{ actionId: acting.id, what: "target" }]);
  });

  it("names a digest whose anchor is gone from the scene as a target edit", () => {
    const doc = fixture();
    const acting = doc.actions.find((a) => a.anchorId !== null);
    if (acting === undefined || acting.anchorId === null)
      throw new Error("fixture has no anchored action");
    const anchor = doc.anchors.find((a) => a.id === acting.anchorId);
    if (anchor === undefined) throw new Error("fixture anchor missing");
    const sk: ScriptSkeleton = {
      skeletonVersion: 1,
      name: "x",
      scriptVersion: 1,
      viewport: null,
      device: null,
      look: null,
      steps: [
        {
          do: "click",
          actionId: acting.id,
          anchorDigest: anchorDigest(anchor.fingerprint),
        },
      ],
    };
    const edited = {
      ...doc,
      anchors: doc.anchors.filter((a) => a.id !== anchor.id),
    } as SceneDocument;
    // Premise: the anchor really is gone, and the action still names it.
    expect(edited.anchors.some((a) => a.id === anchor.id)).toBe(false);
    expect(edited.actions.find((a) => a.id === acting.id)?.anchorId).toBe(
      anchor.id,
    );
    expect(
      editedSinceRecorded(edited, madeFromOf(doc), {
        kind: "ok",
        skeleton: sk,
      }),
    ).toEqual([{ actionId: acting.id, what: "target" }]);
  });

  it("answers null with no record to compare against", () => {
    const doc = fixture();
    expect(editedSinceRecorded(doc, null, { kind: "none" })).toBeNull();
  });
});

describe("targetCheckOf", () => {
  it("is checked for a readable skeleton", () => {
    const sk: ScriptSkeleton = {
      skeletonVersion: 1,
      name: "x",
      scriptVersion: 1,
      viewport: null,
      device: null,
      look: null,
      steps: [],
    };
    expect(targetCheckOf({ kind: "ok", skeleton: sk })).toBe("checked");
  });

  it("is noSkeleton for a take with no skeleton", () => {
    expect(targetCheckOf({ kind: "none" })).toBe("noSkeleton");
  });

  it("carries the error of an unreadable skeleton", () => {
    expect(
      targetCheckOf({ kind: "unreadable", error: "script.json has no name" }),
    ).toEqual({
      unreadable: "script.json has no name",
    });
  });
});
