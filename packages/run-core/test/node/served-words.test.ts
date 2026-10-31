// packages/run-core/test/node/served-words.test.ts
import { describe, expect, it } from "vitest";
import type { RunReport } from "../../src/replay/report.js";
import {
  SERVED_REASON,
  servedExportReport,
  servedFlowsAnswer,
  servedReason,
  servedRefusal,
  servedRunReport,
} from "../../src/served-words.js";

// biome-ignore lint/suspicious/noExplicitAny: a served answer is untyped JSON, read by path.
type Served = Record<string, any>;

/** Every key anywhere in `v`, so a test can say an old key is gone. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (typeof v === "object" && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
}

const stored = (over: Record<string, unknown> = {}): RunReport =>
  ({
    run: { script: { takeId: "scene-1-a" } },
    outcome: "complete",
    stopped: { reason: "takeNotFound", sentence: "s" },
    notStored: [
      { what: "take", error: "e1" },
      { what: "video", error: "e2" },
      { what: "status", error: "e3" },
    ],
    videoVersion: {
      id: "flow-1",
      name: "Create an invoice",
      version: 3,
      created: false,
    },
    steps: [],
    provenance: { takeId: "scene-1-a", bundleId: "b", madeFrom: [] },
    video: { unavailable: "noTake" },
    recording: { recordingTakeId: "scene-0", steps: [], notInRecording: [] },
    ...over,
  }) as unknown as RunReport;

describe("the words served to agents (spec 2026-10-30 flows-and-bulk-delete §2)", () => {
  it("SERVED_REASON is the spec's table", () => {
    expect(SERVED_REASON).toEqual({
      videoRequired: "flowRequired",
      videoNotFound: "flowNotFound",
      videoUnreadable: "flowUnreadable",
      videoUnwritable: "flowUnwritable",
      videoNameInvalid: "flowNameInvalid",
      unknownVideo: "unknownFlow",
      versionExpired: "videoExpired",
      takeNotFound: "videoNotFound",
      takeUnreadable: "videoUnreadable",
      takeBusy: "videoBusy",
      noTakeId: "noVideoId",
    });
  });

  it("servedReason maps once, never chains, and leaves an unknown reason alone", () => {
    // takeNotFound becomes videoNotFound, which must not then become flowNotFound.
    expect(servedReason("takeNotFound")).toBe("videoNotFound");
    expect(servedReason("videoNotFound")).toBe("flowNotFound");
    expect(servedReason("alreadyRunning")).toBe("alreadyRunning");
  });

  it("serves a run report in the new words", () => {
    const input = stored();
    // Premise: the fixture carries every old key the map renames.
    expect(
      [...keysOf(input)]
        .filter((k) => ["takeId", "videoVersion"].includes(k))
        .sort(),
    ).toEqual(["takeId", "videoVersion"]);
    const out = servedRunReport(input) as Served;
    expect(out.provenance).toEqual({
      videoId: "scene-1-a",
      bundleId: "b",
      madeFrom: [],
    });
    expect(out.run.script).toEqual({ videoId: "scene-1-a" });
    expect(out.flow).toEqual({
      id: "flow-1",
      name: "Create an invoice",
      video: 3,
      created: false,
    });
    expect(out.stopped.reason).toBe("videoNotFound");
    expect(out.notStored.map((n: { what: string }) => n.what)).toEqual([
      "video",
      "flow",
      "status",
    ]);
    expect(out.video).toEqual({ unavailable: "noVideo" });
    expect(out.recording).toEqual({
      recordingVideoId: "scene-0",
      steps: [],
      notInRecording: [],
    });
    const keys = keysOf(out);
    expect(keys.has("takeId")).toBe(false);
    expect(keys.has("videoVersion")).toBe(false);
    // The stored report is not touched.
    expect(input.provenance.takeId).toBe("scene-1-a");
  });

  it("serves an old report without videoVersion", () => {
    const out = servedRunReport(
      stored({
        videoVersion: undefined,
        provenance: { takeId: null, bundleId: null, madeFrom: [] },
        run: { script: { name: "s", scriptVersion: 5, steps: 2 } },
      }),
    ) as Served;
    expect(out.flow).toBeUndefined();
    expect("videoVersion" in out).toBe(false);
    expect(out.provenance.videoId).toBeNull();
    expect(out.run.script).toEqual({ name: "s", scriptVersion: 5, steps: 2 });
  });

  it("serves an export report", () => {
    expect(
      servedExportReport({
        outcome: "saved",
        takeId: "scene-1-a",
        warnings: { videoId: "flow-1", logo: null },
      }),
    ).toEqual({
      outcome: "saved",
      videoId: "scene-1-a",
      warnings: { flowId: "flow-1", logo: null },
    });
    expect(
      servedExportReport({
        outcome: "refusedBeforeExport",
        reason: "versionExpired",
        detail: "d",
      }),
    ).toEqual({
      outcome: "refusedBeforeExport",
      reason: "videoExpired",
      detail: "d",
    });
  });

  it("serves the export report an attach answer carries", () => {
    const out = servedExportReport({
      outcome: "attached",
      export: {
        outcome: "saved",
        takeId: "scene-1-a",
        warnings: { videoId: "flow-1" },
      },
    }) as Served;
    expect(out.export).toEqual({
      outcome: "saved",
      videoId: "scene-1-a",
      warnings: { flowId: "flow-1" },
    });
  });

  it("serves a flows answer", () => {
    const answer = {
      videos: [
        {
          id: "flow-1",
          name: "Create an invoice",
          versions: 3,
          current: {
            version: 3,
            takeId: "scene-3",
            recordedAt: "t",
            expired: false,
          },
          exports: [
            {
              takeId: "scene-3",
              path: "/x.mp4",
              fileType: "mp4",
              exists: true,
            },
            { takeId: "scene-2", unreadable: "why" },
          ],
        },
      ],
      file: { takeId: "scene-3", version: 3, current: true, expired: false },
      outsideFlows: [{ takeId: "scene-9", name: "n", createdAt: "t" }],
      unreadable: [],
      deferred: null,
    };
    const out = servedFlowsAnswer(answer) as Served;
    expect(out.flows[0]).toEqual({
      id: "flow-1",
      name: "Create an invoice",
      videos: 3,
      current: {
        number: 3,
        videoId: "scene-3",
        recordedAt: "t",
        expired: false,
      },
      exports: [
        { videoId: "scene-3", path: "/x.mp4", fileType: "mp4", exists: true },
        { videoId: "scene-2", unreadable: "why" },
      ],
    });
    expect(out.file).toEqual({
      videoId: "scene-3",
      number: 3,
      current: true,
      expired: false,
    });
    expect(out.outsideFlows).toEqual([
      { videoId: "scene-9", name: "n", createdAt: "t" },
    ]);
    expect("videos" in out).toBe(false);
    expect(
      (
        servedFlowsAnswer({
          videos: [],
          file: { takeId: "s", notInVideo: "why" },
        }) as Served
      ).file,
    ).toEqual({ videoId: "s", notInFlow: "why" });
  });

  it("serves a run refused before it ran: reason, field and the flows it matched", () => {
    expect(
      servedRefusal({
        outcome: "refusedBeforeRun",
        reason: "videoRequired",
        detail: "d",
        field: "video",
        matches: [
          { id: "f", name: "n", versions: 2, current: null, exports: [] },
        ],
      }),
    ).toEqual({
      outcome: "refusedBeforeRun",
      reason: "flowRequired",
      detail: "d",
      field: "flow",
      matches: [{ id: "f", name: "n", videos: 2, current: null, exports: [] }],
    });
    const holder = {
      id: "f",
      name: "n",
      versions: 1,
      current: { version: 1, takeId: "scene-1" },
      exports: [{ takeId: "scene-1", path: "/x.mp4" }],
    };
    expect(
      servedRefusal({
        outcome: "refusedBeforeRun",
        reason: "nameTaken",
        detail: "d",
        field: "video",
        holder,
      }).holder,
    ).toEqual({
      id: "f",
      name: "n",
      videos: 1,
      current: { number: 1, videoId: "scene-1" },
      exports: [{ videoId: "scene-1", path: "/x.mp4" }],
    });
  });
});
