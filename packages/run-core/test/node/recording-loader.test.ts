import type { AuthoredStep } from "@demoman/replay-engine";
import { describe, expect, it, vi } from "vitest";
import { framesOf, takeOf } from "../../../replay-engine/test/helpers/film";
import { linksOf, loadRecording, recordingForRun } from "../../src/index.js";

describe("loadRecording", () => {
  const take = takeOf(["click"]);
  const frames = framesOf({ source: "capture" });

  it("loads the take and its capture bundle", async () => {
    const loaded = await loadRecording("s-1", {
      getScene: async () => take,
      getCaptureBundle: async () => frames,
    });
    expect(loaded).toEqual({ ok: true, scene: take, bundle: frames });
  });

  it("tells a deleted take from a take with no frames", async () => {
    expect(
      await loadRecording("s-1", {
        getScene: async () => null,
        getCaptureBundle: async () => frames,
      }),
    ).toEqual({ ok: false, report: { unavailable: "recordingDeleted" } });
    expect(
      await loadRecording("s-1", {
        getScene: async () => take,
        getCaptureBundle: async () => null,
      }),
    ).toEqual({ ok: false, report: { unavailable: "noRecordingFrames" } });
  });

  // A refused read is a fault: said in the field AND on the Errors list.
  it("carries the store's own error, and logs it at error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = await loadRecording("s-1", {
      getScene: async () => take,
      getCaptureBundle: async () => {
        throw new Error("QuotaExceededError: the store said no");
      },
    });
    expect(loaded).toEqual({
      ok: false,
      report: {
        unavailable: "recordingUnreadable",
        error: "QuotaExceededError: the store said no",
      },
    });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("does not log a deleted take, which is not a fault", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadRecording("s-1", {
      getScene: async () => null,
      getCaptureBundle: async () => frames,
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("linksOf", () => {
  // spec §6: `recorded` survives derive, run and report. Derive is Task 6's
  // test; this is the run half — the engine carries the script step verbatim
  // as `AuthoredStep.step`, and this is the one place that reads it back.
  it("pairs each performed step with its recorded action, and lists the agent's own", () => {
    const step = (index: number, actionId: string | null, recorded?: string) =>
      ({
        index,
        step: {
          do: "click",
          on: { stableId: `s${index}` },
          ...(recorded ? { recorded } : {}),
        },
        actionId,
        anchorId: null,
        strategy: null,
        candidates: null,
        failureReason: null,
        rect: null,
        marker: null,
        pageUrl: null,
      }) as unknown as AuthoredStep;
    const { links, unlinked } = linksOf([
      step(0, "ac-1", "act-1"),
      step(1, "ac-2"),
      step(2, null, "act-3"),
    ]);
    expect(links).toEqual([{ runActionId: "ac-1", recordedActionId: "act-1" }]);
    expect(unlinked).toEqual(["ac-2"]);
  });
});

describe("recordingForRun", () => {
  it("says the run named no recording, and says the run had no film", () => {
    const run = { scene: null, bundle: null, links: [], unlinked: [] };
    expect(recordingForRun({ loaded: null, run })).toEqual({
      unavailable: "noRecording",
    });
    const loaded = {
      ok: true as const,
      scene: takeOf(["click"]),
      bundle: framesOf({ source: "capture" }),
    };
    expect(recordingForRun({ loaded, run })).toEqual({
      unavailable: "noRunVideo",
    });
  });
});
