// packages/run-core/test/node/export-report-edited.test.ts
import { describe, expect, it } from "vitest";
import { exportVerdict, reportForSave } from "../../src/export/report.js";

// The arguments of a plain saved export, as `export-report.test.ts`'s first
// `reportForSave` case passes them, so only the new field differs.
const savedArgs = () => ({
  fileType: "mp4" as const,
  takeId: "t1",
  file: {
    ref: "t1:a.mp4",
    name: "a.mp4",
    byteLength: 10,
    contentType: "video/mp4",
    detailViolations: [],
  },
  saved: {
    kind: "saved" as const,
    downloadId: null,
    savedAs: "a.mp4",
    path: "/x/a.mp4",
  },
  aspect: "16:9" as const,
  target: { width: 1920, height: 1080, fps: 60 },
});

describe("an export of a take edited after recording", () => {
  it("says which step, what it was and is, and names the re-record of its video", () => {
    // Red: build the call from the take id — `run({ takeId })`, which run
    // refuses (videoRequired).
    const VIDEO = "0b5d2a6e-1c3f-4e8a-9b7d-2f4c6a8e0b1d";
    const edited = [
      { actionId: "ac-7", what: "text" as const, was: "Lumen", now: "Maple" },
    ];
    const report = reportForSave({
      ...savedArgs(),
      editedSinceRecorded: edited,
      videoId: VIDEO,
    });
    expect(report.outcome).toBe("saved");
    const line = exportVerdict(report);
    expect(line).toMatch(/1 step was edited after recording/);
    expect(line).toContain(`ac-7: "Lumen" → "Maple"`);
    expect(line).toContain(`run({ video: { id: "${VIDEO}" } }) re-records it`);
    expect(line).not.toContain("takeId");
    // A take in no video (or one whose video will not read) names the shape.
    for (const videoId of [null, undefined]) {
      const none = exportVerdict(
        reportForSave({
          ...savedArgs(),
          editedSinceRecorded: edited,
          ...(videoId === undefined ? {} : { videoId }),
        }),
      );
      expect(none).toContain("re-record it with run's video: { id }");
      expect(none).not.toContain("takeId");
    }
  });

  it("says a target edit shows the step as recorded", () => {
    const line = exportVerdict(
      reportForSave({
        ...savedArgs(),
        editedSinceRecorded: [{ actionId: "ac-2", what: "target" }],
      }),
    );
    expect(line).toContain(
      "ac-2: its target changed; the video shows the step as recorded",
    );
  });

  it("says a kind change was filmed as the old step, and names derive, not the re-film it refuses", () => {
    const line = exportVerdict(
      reportForSave({
        ...savedArgs(),
        editedSinceRecorded: [
          { actionId: "ac-4", what: "kind", was: "type", now: "click" },
        ],
      }),
    );
    expect(line).toContain(
      "ac-4: its step changed from type to click; the video shows the step as recorded — derive this take, check the step, and run the draft",
    );
    expect(line).not.toMatch(/re-records? it/);
  });

  it("names derive, not the re-film, when a later step's kind changed", () => {
    const line = exportVerdict(
      reportForSave({
        ...savedArgs(),
        editedSinceRecorded: [
          { actionId: "ac-7", what: "text", was: "Lumen", now: "Maple" },
          { actionId: "ac-4", what: "kind", was: "type", now: "click" },
        ],
      }),
    );
    // Premise: the first entry said whole is the text one.
    expect(line).toContain(`ac-7: "Lumen" → "Maple"`);
    expect(line).toMatch(/2 steps were edited after recording/);
    expect(line).toContain(
      "ac-4's step changed from type to click, so derive this take, check the step, and run the draft",
    );
    expect(line).not.toMatch(/re-records? it/);
  });

  // Text overlays left with schema 12 (spec split-tool): nothing draws an
  // edited value over the field, so the video always shows what was typed.
  it("says the video still shows the old text for a typed-text edit", () => {
    const line = exportVerdict(
      reportForSave({
        ...savedArgs(),
        editedSinceRecorded: [
          { actionId: "ac-7", what: "text", was: "Lumen", now: "Maple" },
        ],
      }),
    );
    expect(line).toContain(
      `ac-7: "Lumen" → "Maple"; the video still shows the old text`,
    );
    expect(line).not.toMatch(/field shows the new text/);
  });

  it("says what the schema 12 migration removed from the take", () => {
    const note =
      "2 text overlays were removed from this take: the video shows the text that was recorded.";
    const report = reportForSave({ ...savedArgs(), migration: [note] });
    expect(report.outcome === "saved" && report.warnings.migration).toEqual([
      note,
    ]);
    expect(exportVerdict(report)).toContain(
      "2 text overlays were removed from this take: the video shows the text that was recorded",
    );
    // Control: without the note the sentence says nothing of overlays.
    expect(exportVerdict(reportForSave(savedArgs()))).not.toMatch(/overlay/);
  });

  it("says a re-film leaves the take's masks behind, only when it has some and was edited", () => {
    const edited = [
      { actionId: "ac-7", what: "text" as const, was: "Lumen", now: "Maple" },
    ];
    const two = exportVerdict(
      reportForSave({ ...savedArgs(), editedSinceRecorded: edited, masks: 2 }),
    );
    expect(two).toContain("a re-recording leaves its 2 masks behind");
    const one = exportVerdict(
      reportForSave({ ...savedArgs(), editedSinceRecorded: edited, masks: 1 }),
    );
    expect(one).toContain("a re-recording leaves its 1 mask behind");
    const none = exportVerdict(
      reportForSave({ ...savedArgs(), editedSinceRecorded: edited, masks: 0 }),
    );
    expect(none).toMatch(/edited after recording/);
    expect(none).not.toMatch(/mask/);
    const untouched = exportVerdict(
      reportForSave({ ...savedArgs(), editedSinceRecorded: [], masks: 2 }),
    );
    expect(untouched).not.toMatch(/mask/);
  });

  it("says an added step is not in the video", () => {
    const line = exportVerdict(
      reportForSave({
        ...savedArgs(),
        editedSinceRecorded: [{ actionId: "ac-5", what: "added" }],
      }),
    );
    expect(line).toContain(
      "ac-5: added after recording; it is not in the video",
    );
  });

  it("says a removed step is still in the video", () => {
    const line = exportVerdict(
      reportForSave({
        ...savedArgs(),
        editedSinceRecorded: [{ actionId: "ac-6", what: "removed" }],
      }),
    );
    expect(line).toContain(
      "ac-6: removed after recording; the video still shows it",
    );
  });

  it("says nothing of edits for an untouched take", () => {
    const clean = exportVerdict(
      reportForSave({ ...savedArgs(), editedSinceRecorded: [] }),
    );
    expect(clean).not.toMatch(/edited after recording/);
    // Premise: the clean line is the plain saved sentence.
    expect(clean).toMatch(/^Saved /);
  });
});

describe("the target check on an export", () => {
  // Red if the reason leaves the report, or reaches the sentence: the
  // person cannot act on it (author, 2026-10-20).
  it("keeps a script.json that could not be read in the field, out of the sentence", () => {
    const report = reportForSave({
      ...savedArgs(),
      targetCheck: { unreadable: "script.json has no name" },
    });
    if (report.outcome !== "saved") throw new Error("expected a saved report");
    expect(report.warnings.targetCheck).toEqual({
      unreadable: "script.json has no name",
    });
    expect(exportVerdict(report)).not.toMatch(/script\.json/);
  });

  it("says nothing for a take with no skeleton, but the field records it", () => {
    const report = reportForSave({ ...savedArgs(), targetCheck: "noSkeleton" });
    if (report.outcome !== "saved") throw new Error("expected a saved report");
    // Premise: the field is there for the caller, not only the summary.
    expect(report.warnings.targetCheck).toBe("noSkeleton");
    expect(exportVerdict(report)).not.toMatch(/script\.json/);
  });
});
