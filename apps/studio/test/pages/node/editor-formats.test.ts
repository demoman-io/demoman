import { LANDSCAPE_1080P } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import {
  aspectNote,
  deliverableTitle,
  EXPORT_LABELS,
  exportSummary,
  FILE_TYPE_TITLES,
  sizeReadout,
  takeMeta,
} from "../../../pages/src/editor/formats";

describe("export copy", () => {
  it("labels every file type, and never says Render", () => {
    expect(EXPORT_LABELS).toEqual({
      mp4: "Export MP4",
      gif: "Export GIF",
      stills: "Export PNG stills",
    });
    for (const text of [
      ...Object.values(EXPORT_LABELS),
      ...Object.values(FILE_TYPE_TITLES),
    ]) {
      expect(text).not.toMatch(/render/i);
    }
  });

  // The file's size is the readout's (`sizeReadout`, spec 2026-10-06 §3),
  // beside it in the same box; said twice it was said two ways.
  it("sums up the file: type and length", () => {
    expect(exportSummary("mp4", 24_400)).toBe("MP4 · 0:24");
    expect(exportSummary("mp4", 61_000)).toBe("MP4 · 1:01");
    // A still has no length; it has one file per step.
    expect(exportSummary("stills", 61_000)).toBe("PNG stills · one per step");
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

  // Red if the readout reports the target in place of the recording, or
  // drops the spacing the spec's copy fixes.
  it("reads out the recording's size and the video's", () => {
    expect(
      sizeReadout(
        { width: 1512, height: 820 },
        { ...LANDSCAPE_1080P, width: 1920, height: 1042 },
      ),
    ).toBe("Recording 1512 × 820 · Video 1920 × 1042");
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
