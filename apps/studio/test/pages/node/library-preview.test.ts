// apps/studio/test/pages/node/library-preview.test.ts
import type { KeyframeEntry } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import {
  advanceFrame,
  applyPreviewState,
  PREVIEW_FRAME_CAP,
  previewFromBundle,
  previewText,
  sampleKeyframes,
} from "../../../pages/src/library/preview";

const kf = (i: number): KeyframeEntry => ({
  sourceTimeMs: i * 100,
  ref: `kf:${i}`,
  width: 800,
  height: 600,
  actionId: `a${i}`,
  byteLength: 1000,
});

describe("sampleKeyframes", () => {
  it("caps a long take at PREVIEW_FRAME_CAP frames, keeping the first and the last", () => {
    const frames = sampleKeyframes(
      Array.from({ length: 40 }, (_, i) => kf(i)),
      PREVIEW_FRAME_CAP,
    );
    expect(frames).toHaveLength(PREVIEW_FRAME_CAP);
    expect(frames.at(0)?.ref).toBe("kf:0");
    expect(frames.at(-1)?.ref).toBe("kf:39");
  });

  it("spaces the sampled frames evenly rather than taking the first n", () => {
    const frames = sampleKeyframes(
      Array.from({ length: 40 }, (_, i) => kf(i)),
      4,
    );
    expect(frames.map((f) => f.ref)).toEqual([
      "kf:0",
      "kf:13",
      "kf:26",
      "kf:39",
    ]);
  });

  it("returns every keyframe, in order, when the take is shorter than the cap", () => {
    const frames = sampleKeyframes([kf(0), kf(1), kf(2)], PREVIEW_FRAME_CAP);
    expect(frames.map((f) => f.ref)).toEqual(["kf:0", "kf:1", "kf:2"]);
  });

  it("never repeats a keyframe, so a short take does not cycle through duplicates", () => {
    const frames = sampleKeyframes([kf(0), kf(1)], PREVIEW_FRAME_CAP);
    expect(new Set(frames.map((f) => f.ref)).size).toBe(frames.length);
  });
});

describe("previewFromBundle", () => {
  const bundle = (keyframes: KeyframeEntry[]) => ({ keyframes });

  it("is ready with sampled frames when the bundle has keyframes", () => {
    const state = previewFromBundle(bundle([kf(0), kf(1)]));
    expect(state).toEqual({
      kind: "ready",
      frames: [
        { ref: "kf:0", sourceTimeMs: 0 },
        { ref: "kf:1", sourceTimeMs: 100 },
      ],
    });
  });

  it("separates a missing bundle from a bundle carrying no keyframes", () => {
    expect(previewFromBundle(null).kind).toBe("noBundle");
    expect(previewFromBundle(bundle([])).kind).toBe("noKeyframes");
  });
});

describe("previewText", () => {
  it("says nothing over a ready preview — the picture is the report", () => {
    expect(previewText({ kind: "ready", frames: [] })).toBeNull();
  });

  it("gives every outcome that is not a preview its own sentence", () => {
    const texts = [
      previewText({ kind: "loading" }),
      previewText({ kind: "noBundle" }),
      previewText({ kind: "noKeyframes" }),
      previewText({ kind: "failed", reason: "db closed" }),
    ];
    // Four distinct outcomes must not read alike: a bundle that was never
    // stored, one stored empty, a read that threw, and a read still running
    // are four different facts about this demo.
    expect(new Set(texts).size).toBe(4);
    for (const t of texts) expect(t).toBeTruthy();
  });

  it("carries the failure's own reason rather than a bare 'unavailable'", () => {
    expect(previewText({ kind: "failed", reason: "db closed" })).toContain(
      "db closed",
    );
  });
});

describe("advanceFrame", () => {
  it("wraps back to the first frame so the flipbook loops", () => {
    expect(advanceFrame(6, 8)).toBe(7);
    expect(advanceFrame(7, 8)).toBe(0);
  });

  it("stays put on a take with a single keyframe", () => {
    expect(advanceFrame(0, 1)).toBe(0);
  });

  it("stays put when there is nothing to show", () => {
    expect(advanceFrame(0, 0)).toBe(0);
  });
});

describe("applyPreviewState", () => {
  const box = (): HTMLElement => {
    const div = document.createElement("div");
    div.setAttribute("data-preview", "");
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-preview-canvas", "");
    canvas.hidden = true;
    const note = document.createElement("p");
    note.setAttribute("data-preview-note", "");
    div.append(canvas, note);
    return div;
  };

  const canvasOf = (b: HTMLElement) =>
    b.querySelector("[data-preview-canvas]") as HTMLCanvasElement;
  const noteOf = (b: HTMLElement) =>
    b.querySelector("[data-preview-note]") as HTMLElement;

  it("shows the canvas and says nothing once a preview is ready", () => {
    const b = box();
    applyPreviewState(b, { kind: "ready", frames: [] });
    expect(canvasOf(b).hidden).toBe(false);
    expect(noteOf(b).textContent).toBe("");
  });

  it("hides the canvas and names the reason when there is no preview", () => {
    const b = box();
    applyPreviewState(b, { kind: "failed", reason: "db closed" });
    expect(canvasOf(b).hidden).toBe(true);
    expect(noteOf(b).textContent).toContain("db closed");
  });

  it("takes down a stale reason when a later state succeeds", () => {
    const b = box();
    applyPreviewState(b, { kind: "noBundle" });
    applyPreviewState(b, { kind: "ready", frames: [] });
    expect(noteOf(b).textContent).toBe("");
    expect(canvasOf(b).hidden).toBe(false);
  });
});
