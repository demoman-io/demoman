// apps/studio/test/pages/node/export-flow.test.ts
import { describe, expect, it } from "vitest";
import {
  applyExportEvent,
  type ExportFlow,
  IDLE_EXPORT,
} from "../../../pages/src/editor/export-flow";
import type { SaveView } from "../../../pages/src/editor/export-run";

const pressed: ExportFlow = {
  run: { phase: "encoding", done: 0, total: 0 },
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
