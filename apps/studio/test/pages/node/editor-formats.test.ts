import { describe, expect, it } from "vitest";
import {
  aspectNote,
  deliverableTitle,
  exportLabel,
  FILE_TYPE_TITLES,
  FILE_TYPES,
  fileFacts,
  sizeReadout,
  takeMeta,
} from "../../../pages/src/editor/formats";

describe("export copy", () => {
  it("labels every file type, and never says Render", () => {
    expect(exportLabel(["mp4"])).toBe("Export MP4");
    expect(exportLabel(["gif"])).toBe("Export GIF");
    expect(exportLabel(["stills"])).toBe("Export PNG stills");
    for (const text of [
      ...FILE_TYPES.map((t) => exportLabel([t])),
      ...Object.values(FILE_TYPE_TITLES),
    ]) {
      expect(text).not.toMatch(/render/i);
    }
  });

  // Red if a press of several names only one file, or names stills in full
  // after another file ("Export MP4 + PNG stills" outgrows the button).
  it("names every ticked file on the button, stills short after the first", () => {
    expect(exportLabel(["mp4", "gif", "stills"])).toBe(
      "Export MP4 + GIF + stills",
    );
    expect(exportLabel(["gif", "stills"])).toBe("Export GIF + stills");
    // Nothing ticked: the button is disabled and the line under it says why.
    expect(exportLabel([])).toBe("Export");
  });

  // Each row's own file: GIF is smaller than the MP4, so one line for both
  // would describe a file nobody makes.
  it("says each file row's length and size", () => {
    const hd = { width: 1920, height: 1080 };
    expect(fileFacts("mp4", 24_400, hd)).toBe("0:24 · 1920 × 1080");
    expect(fileFacts("gif", 61_000, { width: 800, height: 450 })).toBe(
      "1:01 · 800 × 450",
    );
    // A still has no length; it has one file per step.
    expect(fileFacts("stills", 61_000, hd)).toBe("one per step · 1920 × 1080");
  });

  it("names the deliverable the logo notes talk about", () => {
    expect(deliverableTitle("mp4", "16:9")).toBe("Landscape video");
    expect(deliverableTitle("mp4", "9:16")).toBe("Vertical video");
    expect(deliverableTitle("gif", "9:16")).toBe("Vertical GIF");
    expect(deliverableTitle("stills", "16:9")).toBe("PNG stills");
  });

  it("says where the aspect is set, and what 9:16 does", () => {
    expect(aspectNote("16:9")).toBe("16:9, set under the preview");
    expect(aspectNote("9:16")).toBe(
      "9:16, set under the preview — the camera follows each step",
    );
  });

  it("names the Auto deliverables, and says what Auto does", () => {
    expect(deliverableTitle("mp4", "auto")).toBe("Video");
    expect(deliverableTitle("gif", "auto")).toBe("GIF");
    expect(deliverableTitle("stills", "auto")).toBe("PNG stills");
    expect(aspectNote("auto")).toBe(
      "Auto, set under the preview — the video takes the recording's shape",
    );
  });

  // Red if the readout drops the spacing the spec's copy fixes. The
  // files' sizes are on their rows (`fileFacts`).
  it("reads out the recording's size", () => {
    expect(sizeReadout({ width: 1512, height: 820 })).toBe(
      "Recording 1512 × 820",
    );
  });
});

describe("takeMeta", () => {
  const meta = (over: Partial<Parameters<typeof takeMeta>[0]> = {}) =>
    takeMeta({
      durationMs: 9_400,
      fileType: "mp4",
      target: { width: 1920, height: 1080 },
      hasFrames: true,
      ...over,
    });

  it("reads the take's length and the video's size for the header", () => {
    expect(meta()).toBe("0:09 · 1920 × 1080");
    expect(
      meta({ durationMs: 75_000, target: { width: 1080, height: 1920 } }),
    ).toBe("1:15 · 1080 × 1920");
  });

  // Red if the header floors the way the transport clock does: the
  // Recordings card rounds, so a 9.6s take read 0:09 here and 0:10 there,
  // and a 400ms take read 0:00, which reads as empty.
  it("rounds the length the way the Recordings card does", () => {
    expect(meta({ durationMs: 9_600 })).toBe("0:10 · 1920 × 1080");
    expect(meta({ durationMs: 400 })).toBe("0:01 · 1920 × 1080");
  });

  it("gives stills a size and no length", () => {
    expect(meta({ fileType: "stills" })).toBe("PNG stills · 1920 × 1080");
  });

  // The line is always on screen, so it must not show a ready take's
  // reading for a take that cannot be exported.
  it("says when there is nothing to export", () => {
    expect(meta({ hasFrames: false })).toBe("No frames to export");
    expect(meta({ durationMs: 0 })).toBe("Nothing left to export");
  });
});
