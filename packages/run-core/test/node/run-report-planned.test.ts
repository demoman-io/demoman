import type { MadeFromStep } from "@demoman/compositor";
import type { AuthoredStep } from "@demoman/replay-engine";
import {
  BRANDING_DEFAULTS,
  CURSOR_DEFAULTS,
  type SceneDocument,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { NOT_CHECKED } from "../../../replay-engine/test/helpers/film";
import {
  type BuildArgs,
  buildRunReport,
  plannedUnplacedNote,
  verdictLine,
  type WalkResultLike,
} from "../../src/replay/report.js";

// A planned beat that could not be placed is a degradation of the video whose
// sentence names the step it sits before (spec 2026-11-13, Part 3). The
// report's own fixtures live in run-report.test.ts; this is the least that
// `buildRunReport` needs to say it.

const step = (i: number): AuthoredStep => ({
  index: i - 1,
  step: { do: "click", on: { stableId: `stable-${i}` } },
  anchorId: `anchor${i}`,
  actionId: `a${i}`,
  strategy: "stableId",
  candidates: 1,
  failureReason: null,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  marker: `click:anchor${i}`,
  pageUrl: null,
});

const walk: WalkResultLike = {
  reason: null,
  completed: 3,
  total: 3,
  bundle: null,
  degradations: [],
  storageRefused: false,
  counters: { encodeShrunkSpans: 0 },
};

const madeFrom: MadeFromStep[] = [1, 2, 3].map((i) => ({
  actionId: `a${i}`,
  kind: "click",
  anchorId: `anchor${i}`,
  text: null,
  cut: false,
}));

const film = (unplacedBeatSteps?: (string | null)[]): BuildArgs["film"] => ({
  summary: {
    inside: 0,
    atEdge: 0,
    cutOff: 0,
    outOfFrame: 0,
    strayArrival: 0,
    detour: 0,
    longStill: 0,
  },
  steps: [],
  journeys: [],
  noCursor: false,
  finalFrame: { settled: true },
  pacing: "planned",
  plannedMs: 5000,
  recordedMs: 12000,
  ...(unplacedBeatSteps === undefined
    ? {}
    : { unplacedBeats: unplacedBeatSteps.length, unplacedBeatSteps }),
});

const reportOf = (video: BuildArgs["film"]) =>
  buildRunReport({
    ...NOT_CHECKED,
    film: video,
    run: {
      id: "run-1",
      startedAt: 0,
      target: "https://app.example.com/",
      executor: "cli",
      script: { name: "planned", scriptVersion: 1, steps: 3 },
    },
    walk,
    steps: [step(1), step(2), step(3)],
    // The scene is read only for what the verdict names; it carries no steps
    // of its own here.
    scene: {
      actions: [],
      edits: { trim: undefined },
      branding: BRANDING_DEFAULTS,
      cursor: CURSOR_DEFAULTS,
    } as unknown as SceneDocument,
    madeFrom,
    look: {
      branding: "defaultKit",
      kit: { name: "Dark" },
      brandKitError: null,
      wallpaperError: null,
    },
  });

describe("a planned beat that could not be placed", () => {
  it("is a degradation whose sentence names the step it sits before, in the planned wording", () => {
    // Red if `unplacedBeatsOf` or `degradationsOf` goes (no entry, no kind),
    // or if `framesClause` stops choosing the planned sentence.
    const video = film(["a2"]);
    // Premise: the film really carries one unplaced beat, before a2.
    expect(video).toMatchObject({
      unplacedBeats: 1,
      unplacedBeatSteps: ["a2"],
    });
    const report = reportOf(video);
    expect(report.frames.degradations).toEqual(["pacingUnplaced"]);
    const at = 'script step 2: click stableId "stable-2"';
    expect(report.frames.unplacedBeats).toEqual([
      { step: at, note: plannedUnplacedNote(at) },
    ]);
    expect(plannedUnplacedNote(at)).toBe(
      'the planned pause before script step 2: click stableId "stable-2" could not be placed, so that stretch plays as it was recorded and the video is not the planned length',
    );
    const line = verdictLine(report);
    expect(line).toContain(`${plannedUnplacedNote(at)} (pacingUnplaced)`);
    // Not the recorded-pause sentence, which speaks of a pause nobody recorded.
    expect(line).not.toContain("a pause could not be placed on its step");
  });

  it("names the end of the video for an unplaced tail", () => {
    // Red if `unplacedBeatsOf`'s `actionId === null` branch goes.
    const report = reportOf(film([null]));
    expect(report.frames.unplacedBeats?.[0]?.step).toBe("the end of the video");
  });

  it("adds nothing to a take with every beat placed, or with no plan", () => {
    // Red if `degradationsOf` adds the kind whatever the film says.
    const placed = reportOf(film());
    expect(placed.frames.degradations).toEqual([]);
    expect(placed.frames).not.toHaveProperty("unplacedBeats");
    const recorded = reportOf(NOT_CHECKED.film);
    expect(recorded.frames.degradations).toEqual([]);
    expect(recorded.frames).not.toHaveProperty("unplacedBeats");
  });
});
