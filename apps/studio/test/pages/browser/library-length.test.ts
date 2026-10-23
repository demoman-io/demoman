import {
  composeForTarget,
  createImageFrameSource,
  detectKeyframeMotion,
  type FrameImage,
  planScene,
  resolvePlan,
} from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { frameOf, targetFor } from "../../../pages/src/editor/jobs";
import { editedLength, formatLength } from "../../../pages/src/library/length";

/**
 * The thumbnail's duration badge: the length the export will run.
 *
 * In the browser lane because the keyframe-motion probe draws into an
 * `OffscreenCanvas`, which the node lane does not have.
 */

/** A flat keyframe. Black or white, so the motion probe's verdict between
 *  two of them is never near its threshold. */
function flat(colour: "#000" | "#fff" | "#888"): FrameImage {
  const canvas = new OffscreenCanvas(64, 40);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 64, 40);
  return {
    image: canvas.transferToImageBitmap(),
    width: 64,
    height: 40,
    sourceTimeMs: 0,
  };
}

/** Keyframes that alternate black and white: every uncovered gap moves. */
const moving = async (ref: string) =>
  flat(ref === "k-0" || ref === "k-2" ? "#000" : "#fff");
/** Every keyframe the same grey: nothing between them moves. */
const still = async (_ref: string) => flat("#888");

const capture = proceduralBundle({ source: "capture" });

const withEdits = (edits: Partial<SceneDocument["edits"]>): SceneDocument => {
  const scene = readonlyScene();
  return { ...scene, edits: { ...scene.edits, ...edits } };
};

const ms = async (
  scene: SceneDocument,
  load = still,
  bundle = capture,
): Promise<number> => {
  const length = await editedLength(scene, bundle, load);
  if (length.kind !== "measured") {
    throw new Error(`expected a length, got ${JSON.stringify(length)}`);
  }
  return length.ms;
};

describe("editedLength", () => {
  it("is the length after the author's removed pieces, not the recording's", async () => {
    // Premise: the fixture's recording runs 9s of source, and act-2 is a
    // step whose stretch (3.2s to 9s) a cut removes.
    const last = capture.keyframes.at(-1)?.sourceTimeMs;
    expect(last).toBe(9000);
    const uncut = await ms(withEdits({}));
    const cut = await ms(
      withEdits({
        removed: [
          {
            id: "c",
            start: { actionId: "act-2", sourceOffsetMs: 0 },
            end: { actionId: "act-3", sourceOffsetMs: 0 },
          },
        ],
      }),
    );
    expect(uncut).toBeGreaterThanOrEqual(9000);
    expect(cut).toBeLessThan(uncut - 5000);
  });

  // The production change that reddens it: dropping `hints`, or computing
  // them for no take at all.
  it("counts keyframe motion where an authored gap makes it length", async () => {
    const gapped = withEdits({
      gaps: [{ id: "g", afterActionId: "act-1", durationMs: 0 }],
    });
    expect(await ms(gapped, moving)).toBeGreaterThan(
      (await ms(gapped, still)) + 1000,
    );
  });

  // The other half of the skip in `editedLength`: without a gap, the motion
  // the probe would find changes nothing, so it is never decoded. Measured
  // straight through `resolvePlan` with the strongest hints there can be —
  // the whole take in motion — so this goes red the day the timeline
  // starts retiming motion somewhere a gap is not.
  it("needs no motion probe on a take without gaps", () => {
    const everything = [{ startMs: 0, endMs: 9000 }];
    for (const scene of [
      withEdits({}),
      withEdits({
        removed: [
          {
            id: "c",
            start: { actionId: "act-2", sourceOffsetMs: 0 },
            end: { actionId: "act-3", sourceOffsetMs: 0 },
          },
        ],
      }),
      withEdits({ trim: { head: { actionId: "act-1", offsetMs: 0 } } }),
    ]) {
      for (const bundle of [capture, proceduralBundle()]) {
        const plan = planScene(scene);
        const span = (hints: { startMs: number; endMs: number }[]) => {
          const { startMs, endMs } = resolvePlan(
            plan,
            bundle,
            scene,
            hints,
          ).range;
          return endMs - startMs;
        };
        expect(span(everything)).toBe(span([]));
      }
    }
  });

  it("decodes nothing for a take without gaps", async () => {
    let loads = 0;
    await ms(withEdits({}), async (ref) => {
      loads++;
      return still(ref);
    });
    expect(loads).toBe(0);
  });

  it("closes every keyframe it decoded", async () => {
    const opened: ImageBitmap[] = [];
    await ms(
      withEdits({ gaps: [{ id: "g", afterActionId: "act-1", durationMs: 0 }] }),
      async (ref) => {
        const frame = await moving(ref);
        opened.push(frame.image as ImageBitmap);
        return frame;
      },
    );
    // Premise: the probe did decode something to close.
    expect(opened.length).toBeGreaterThan(0);
    // A closed ImageBitmap reports zero dimensions.
    for (const bitmap of opened) expect(bitmap.width).toBe(0);
  });

  // `editedLength` stops at `resolvePlan`; the render goes on through
  // `composeForTarget`, whose `framedPlan` reframes camera intents per
  // target. The length must be the same whichever file is exported.
  it("matches the range every export target composes", async () => {
    const scene = withEdits({
      removed: [
        {
          id: "c",
          start: { actionId: "act-2", sourceOffsetMs: 0 },
          end: { actionId: "act-3", sourceOffsetMs: 0 },
        },
      ],
      gaps: [{ id: "g", afterActionId: "act-1", durationMs: 700 }],
    });
    const length = await ms(scene, moving);
    const plan = planScene(scene);
    const hints = await detectKeyframeMotion(
      capture,
      createImageFrameSource(capture, moving),
      plan.retiming.motionDiffThreshold,
    );
    for (const [fileType, aspect] of [
      ["mp4", "16:9"],
      ["mp4", "9:16"],
      ["gif", "16:9"],
    ] as const) {
      const { range } = composeForTarget({
        plan,
        bundle: capture,
        scene,
        target: targetFor(fileType, aspect, capture, frameOf(scene)),
        hints,
      }).resolved;
      expect(range.endMs - range.startMs, `${fileType} ${aspect}`).toBe(length);
    }
  });

  // The production change that reddens it: dropping the range check, so a
  // trim whose ends crossed reads as a length — a badge on a take the
  // export refuses outright.
  it("has nothing to show when the trim leaves no frames", async () => {
    const crossed = withEdits({
      trim: {
        head: { actionId: "act-3", offsetMs: 0 },
        tail: { actionId: "act-1", offsetMs: 0 },
      },
    });
    expect(await editedLength(crossed, capture, still)).toEqual({
      kind: "nothing",
      reason: "its trim leaves no frames",
    });
  });
});

describe("formatLength", () => {
  it("writes a length the way a player does", () => {
    expect(formatLength(5000)).toBe("0:05");
    expect(formatLength(84_000)).toBe("1:24");
    expect(formatLength(9600)).toBe("0:10");
    expect(formatLength(3_723_000)).toBe("1:02:03");
    // A take with frames in it is never 0:00.
    expect(formatLength(120)).toBe("0:01");
  });
});
