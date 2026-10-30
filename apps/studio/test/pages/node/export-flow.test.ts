// apps/studio/test/pages/node/export-flow.test.ts
import { describe, expect, it } from "vitest";
import {
  applyExportEvent,
  type ExportFlow,
  IDLE_EXPORT,
  pressedExport,
} from "../../../pages/src/editor/export-flow";
import type { SaveView } from "../../../pages/src/editor/export-run";
import type { ExportEvent } from "../../../pages/src/platform/types";

const pressed: ExportFlow = {
  run: { phase: "encoding", done: 0, total: 0 },
  files: [],
  save: null,
  error: null,
};

const SAVED: Extract<SaveView, { kind: "saved" }> = {
  kind: "saved",
  names: ["a.mp4"],
  byteLength: 10,
  reveal: null,
  summary: null,
  outputRefs: [],
};

describe("applyExportEvent", () => {
  // Red if a queue or progress event from a job this page is not waiting on
  // moves the button: a finished page would read "Queued…" again.
  it("moves the run only while this page's press waits", () => {
    expect(
      applyExportEvent(pressed, { kind: "queued", jobId: "j", position: 2 }),
    ).toEqual({
      flow: { ...pressed, run: { phase: "queued", position: 2 } },
      effect: "render",
    });
    expect(
      applyExportEvent(pressed, {
        kind: "rendering",
        jobId: "j",
        done: 3,
        total: 9,
      }),
    ).toEqual({
      flow: { ...pressed, run: { phase: "encoding", done: 3, total: 9 } },
      effect: "progress",
    });
    for (const event of [
      { kind: "queued", jobId: "j", position: 1 },
      { kind: "rendering", jobId: "j", done: 1, total: 2 },
    ] as const) {
      expect(applyExportEvent(IDLE_EXPORT, event)).toEqual({
        flow: IDLE_EXPORT,
        effect: "none",
      });
    }
  });

  // Red if a failed output's line replaces the one before it, or if the
  // job's own `failed` detail drops what the outputs said.
  it("keeps every failure line, and a null detail adds none", () => {
    const one = applyExportEvent(pressed, {
      kind: "fileFailed",
      jobId: "j",
      line: "a.gif: too large",
    });
    expect(one).toEqual({
      flow: { ...pressed, error: "a.gif: too large" },
      effect: "none",
    });
    const two = applyExportEvent(one.flow, {
      kind: "failed",
      jobId: "j",
      detail: "the encoder stopped",
    });
    expect(two).toEqual({
      flow: {
        run: { phase: "idle" },
        files: [],
        save: null,
        error: "a.gif: too large; the encoder stopped",
      },
      effect: "render",
    });
    expect(
      applyExportEvent(one.flow, { kind: "failed", jobId: "j", detail: null })
        .flow.error,
    ).toBe("a.gif: too large");
  });

  // Red if the summary stops riding on the outcome row, or the button is
  // not given back.
  it("puts the save and its summary on the outcome row and frees the button", () => {
    expect(
      applyExportEvent(
        { ...pressed, run: { phase: "saving" } },
        {
          kind: "saved",
          jobId: "j",
          save: SAVED,
          summary: "Saved, but small.",
        },
      ),
    ).toEqual({
      flow: {
        run: { phase: "idle" },
        files: [],
        save: { ...SAVED, summary: "Saved, but small." },
        error: null,
      },
      effect: "render",
    });
    expect(
      applyExportEvent(pressed, { kind: "saving", jobId: "j" }).flow.run,
    ).toEqual({ phase: "saving" });
  });

  it("asks for a re-list when the take's outputs changed", () => {
    expect(applyExportEvent(IDLE_EXPORT, { kind: "outputsChanged" })).toEqual({
      flow: IDLE_EXPORT,
      effect: "relist",
    });
  });
});

describe("applyExportEvent, one press of several files", () => {
  const apply = (flow: ExportFlow, ...events: ExportEvent[]) =>
    events.reduce((f, e) => applyExportEvent(f, e).flow, flow);
  const three = pressedExport(["mp4", "gif", "stills"]);

  // Red if the jobs' ids are matched to files in any order but the one
  // they were started in, or if a later file's `queued` (it arrives while
  // the first file renders) moves the button back to "Queued".
  it("names each job's file in start order, and only the current file moves the run", () => {
    const flow = apply(
      three,
      { kind: "queued", jobId: "a", position: 0 },
      { kind: "rendering", jobId: "a", done: 2, total: 10 },
      { kind: "queued", jobId: "b", position: 1 },
    );
    expect(flow.files.map((f) => f.jobId)).toEqual(["a", "b", null]);
    expect(flow.run).toEqual({ phase: "encoding", done: 2, total: 10 });
  });

  // Red if the first file's save frees the button while two files are
  // still to come, or if one file's save replaces the one before it.
  it("keeps the button until the last file, and says every save as one", () => {
    const mid = apply(
      three,
      { kind: "queued", jobId: "a", position: 0 },
      { kind: "queued", jobId: "b", position: 1 },
      { kind: "queued", jobId: "c", position: 2 },
      { kind: "saved", jobId: "a", save: SAVED, summary: "Saved a." },
    );
    expect(mid.run).toEqual({ phase: "encoding", done: 0, total: 0 });
    expect(mid.files.map((f) => f.ended)).toEqual(["saved", null, null]);

    const end = apply(
      mid,
      {
        kind: "saved",
        jobId: "b",
        save: { ...SAVED, names: ["a.gif"], byteLength: 5 },
        summary: "Saved b.",
      },
      { kind: "failed", jobId: "c", detail: "The render failed." },
    );
    expect(end.run).toEqual({ phase: "idle" });
    expect(end.files.map((f) => f.ended)).toEqual(["saved", "saved", "failed"]);
    expect(end.save).toEqual({
      ...SAVED,
      names: ["a.mp4", "a.gif"],
      byteLength: 15,
      summary: "Saved a. Saved b.",
    });
    // Which file failed, since the press made more than one.
    expect(end.error).toBe("PNG stills: The render failed.");
  });

  // Red if a press of one starts naming its file in the failure line.
  it("says a lone file's failure as it always did", () => {
    const flow = apply(pressedExport(["gif"]), {
      kind: "failed",
      jobId: "a",
      detail: "The render failed.",
    });
    expect(flow.error).toBe("The render failed.");
    expect(flow.files).toEqual([
      { fileType: "gif", jobId: "a", ended: "failed" },
    ]);
  });
});
