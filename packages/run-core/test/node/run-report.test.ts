import type { Degradation, MadeFromStep } from "@demoman/compositor";
import { type AuthoredStep, reasonSentence } from "@demoman/replay-engine";
import {
  BRANDING_DEFAULTS,
  CURSOR_DEFAULTS,
  type DemoScript,
  type SceneDocument,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { NOT_CHECKED } from "../../../replay-engine/test/helpers/film";
import {
  type BuildArgs,
  buildRunReport,
  clickNotDeliveredDetail,
  HIDDEN_TEXT,
  prVerdict,
  type ReplayRefusal,
  type RunReport,
  verdictLine,
  type WalkResultLike,
} from "../../src/replay/report.js";

/**
 * `RunReport`'s three rules (CLAUDE.md's "report before you forgive",
 * applied at `docs/superpowers/specs/2026-09-26-agent-door-and-editor-
 * removal-design.md` §2):
 *
 * 1. `outcome` is not derived from `steps`.
 * 2. `verdict.kind: "matches"` is unreachable without a `madeFrom` record.
 * 3. The verdict line is written from `outcome` first.
 *
 * Fixtures below are hand-built rather than run through `runAuthored`
 * (Task 6's job, exercised in `packages/replay-engine/test/node/
 * authored.test.ts`) — this file is about what `buildRunReport` does with
 * the shape `runAuthored` hands it, not about producing that shape.
 */

// ---- scene / script / madeFrom fixtures ---------------------------------

function anchorFixture(i: number): SceneDocument["anchors"][number] {
  return {
    id: `anchor${i}`,
    fingerprint: {
      stableId: `stable-${i}`,
      role: null,
      accessibleName: null,
      textContent: null,
      treePath: null,
      boundingRect: null,
      imagePatchRef: null,
      dataKey: null,
    },
    resolution: {
      url: "https://app.example.com/",
      actionIndex: i - 1,
      entryState: i === 1,
      strategy: "stableId",
      failureReason: null,
      candidates: 1,
    },
  };
}

function clickAction(i: number): SceneDocument["actions"][number] {
  return {
    id: `a${i}`,
    anchorId: `anchor${i}`,
    timestamp: i * 1000,
    marker: `click:anchor${i}`,
    kind: "click",
    button: "left",
  };
}

/** A `SceneDocument` with `steps` click actions, `a1..aN`, each naming its
 *  own anchor `anchor1..anchorN` — the document a fully-authored script of
 *  the same length would produce. */
function sceneOf(steps: number): SceneDocument {
  return {
    schemaVersion: 15,
    meta: {
      id: "scene-run-report-fixture",
      name: "run report fixture",
      createdAt: "2026-09-27T00:00:00.000Z",
      toolchain: {
        resolverVersion: "1.0.0",
        compositorVersion: null,
        captureVersion: null,
      },
      capture: {
        originUrl: "https://app.example.com/",
        originClass: "development",
        buildSha: null,
        buildShaSource: null,
        viewport: { width: 1280, height: 800 },
        dpr: 2,
        mode: "authored",
      },
    },
    anchors: Array.from({ length: steps }, (_, i) => anchorFixture(i + 1)),
    actions: Array.from({ length: steps }, (_, i) => clickAction(i + 1)),
    camera: [],
    edits: {
      masks: [],
      holds: [],
      gaps: [],
      splits: [],
      removed: [],
    },
    sideChannels: {
      network: [],
      consoleExcerpt: [],
      urlTrace: [],
      uncoveredOrigins: [],
    },
    flags: { mutating: false, hoverSensitive: false },
    branding: BRANDING_DEFAULTS,
    cursor: CURSOR_DEFAULTS,
    canvas: { aspect: "16:9" },
  };
}

/** The script `sceneOf(steps)` would be authored from: `steps` clicks, each
 *  naming the matching anchor's `stableId`. */
function scriptOf(steps: number): DemoScript {
  return {
    scriptVersion: 1,
    name: "run report fixture",
    target: "https://app.example.com/",
    steps: Array.from({ length: steps }, (_, i) => ({
      do: "click" as const,
      on: { stableId: `stable-${i + 1}` },
    })),
  };
}

/** `madeFromFor(scriptOf(n))` is a COMPLETE, matching provenance record for
 *  all `n` steps — every `actionId` and `kind` lines up with `sceneOf(n)`'s
 *  own actions by construction. Callers that want a run stopped partway
 *  still get this full record on purpose (test 1): that mismatch between
 *  what `madeFrom` claims and what the run actually reached is the trap
 *  `outcome` has to survive. */
function madeFromFor(script: DemoScript): MadeFromStep[] {
  return script.steps.map((step, i) => ({
    actionId: `a${i + 1}`,
    kind: step.do,
    anchorId: `anchor${i + 1}`,
    text: null,
    cut: false,
  }));
}

function authoredStep(
  i: number,
  overrides: Partial<AuthoredStep> = {},
): AuthoredStep {
  return {
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
    ...overrides,
  };
}

// ---- run / walk / BuildArgs fixtures -------------------------------------

function baseRun(): BuildArgs["run"] {
  return {
    id: "run-1",
    startedAt: 0,
    target: "https://app.example.com/",
    executor: "cli",
    script: { name: "run report fixture", scriptVersion: 1, steps: 9 },
  };
}

/** A walk result: reason, completed, total, bundle, degradations — see
 *  `WalkResultLike`. `bundle: null` throughout this file: nothing here
 *  asserts on `frames.spans`/`frames.keyframes`, and a bundle fixture would
 *  cost every case here a `FrameBundle`'s full shape for no assertion that
 *  reads it. */
function completeWalk(steps: number): WalkResultLike {
  return {
    reason: null,
    completed: steps,
    total: steps,
    bundle: null,
    degradations: [],
    storageRefused: false,
    counters: { encodeShrunkSpans: 0 },
  };
}

/** A finished run's args: `steps` steps, all matching. */
function complete(): BuildArgs {
  const n = 3;
  const script = scriptOf(n);
  return {
    ...NOT_CHECKED,
    run: baseRun(),
    walk: completeWalk(n),
    steps: Array.from({ length: n }, (_, i) => authoredStep(i + 1)),
    scene: sceneOf(n),
    madeFrom: madeFromFor(script),
    look: {
      branding: "defaultKit",
      kit: { name: "Dark" },
      brandKitError: null,
      wallpaperError: null,
    },
  };
}

/** A refused run's args: policy stopped it before anything ran. */
function refused(reason: ReplayRefusal): BuildArgs {
  return {
    ...NOT_CHECKED,
    run: baseRun(),
    refused: { reason },
    scene: sceneOf(0),
    madeFrom: null,
    look: {
      branding: "defaultKit",
      kit: { name: "Dark" },
      brandKitError: null,
      wallpaperError: null,
    },
  };
}

// ---------------------------------------------------------------------------

describe("RunReport film and recording", () => {
  const film = { unavailable: "noTake" } as const;
  const recording = { unavailable: "recordingDeleted" } as const;

  it("copies film and recording through verbatim, walked and refused", () => {
    const walked = buildRunReport({ ...complete(), film, recording });
    expect(walked.video).toEqual(film);
    expect(walked.recording).toEqual(recording);
    const turnedAway = buildRunReport({
      ...refused("settingOff"),
      film,
      recording,
    });
    expect(turnedAway.video).toEqual(film);
    expect(turnedAway.recording).toEqual(recording);
  });
});

describe("RunReport", () => {
  it("reports a stopped run as stopped, and never as a match", () => {
    const script = scriptOf(9);
    const scene = sceneOf(9);
    // Premise: the provenance record is complete, so a verdict derived from
    // it alone would say "matches" — which is what makes this test able to
    // fail. `outcome` has to win.
    const madeFrom = madeFromFor(script);
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: {
        reason: "anchorNotRendered",
        completed: 4,
        total: 9,
        bundle: null,
        degradations: [],
        storageRefused: false,
        counters: { encodeShrunkSpans: 0 },
      },
      // Only the 4 steps the run actually attempted — the docblock on
      // `AuthoredStep` is explicit that a run stopped at step 4 of 9 has
      // four records, not nine and not one, and every one of them
      // succeeded (a non-null marker), so a correct implementation cannot
      // reach "stopped" by noticing a null marker in this list — it has to
      // read `walk`.
      steps: [1, 2, 3, 4].map((i) => authoredStep(i)),
      scene,
      madeFrom,
    });

    expect(report.provenance.madeFrom).toHaveLength(9);
    expect(report.outcome).toBe("stopped");
    expect(report.verdict.kind).not.toBe("matches");
    // "after", not "at". `at.index` is `walk.completed` — four steps
    // SUCCEEDED — so the old "Stopped at step 4 of 9" named step 4 while
    // `at.label` (asserted just below) names step 5, the one that failed.
    // The production change that reddens this: putting the preposition back.
    expect(verdictLine(report)).toMatch(/stopped after step 4 of 9/i);
    // And the label, which nothing asserted before this wave — which is
    // exactly why the number and the word could disagree with it unnoticed.
    // `sceneOf(9)` holds an action at index 4, so this is the DOCUMENT-named
    // path: `failedPerformedStep` names `actions[4]`, the fifth step.
    expect(report.stopped?.at.label).toBe("click stable-5");
    expect(report.stopped?.at.index).toBe(4);
  });

  /**
   * This door's commonest failure, and the one `at.label` used to give up on:
   * a capture that resolved nothing commits no action, so
   * `scene.actions.length === walk.completed`, `failedPerformedStep` finds
   * nothing at that index and answers null — and the label became "(no single
   * step to name)", whose own comment defines it as "the stop cannot be pinned
   * to one of its steps". It can: `steps`' last record IS the step that
   * failed, and it carries its script index and its verbatim intent.
   *
   * Premise, asserted below rather than assumed, because the whole case turns
   * on it: the document holds exactly `completed` actions (four), so nothing
   * sits at index 4 for the document-named path to find. A fixture that
   * quietly grew a fifth action would send this down the other branch and the
   * label assertion would be measuring the wrong mechanism.
   *
   * The production change that reddens this: dropping the `lastAttempted`
   * clause in `buildStopped`, which puts "(no single step to name)" back.
   */
  it("names the step from the script when the document holds no action for it", () => {
    const scene = sceneOf(4);
    // Four that succeeded, and the fifth: resolved nothing, so no action, no
    // anchor, no marker — the record the run wrote for the step it was on.
    const steps = [
      ...[1, 2, 3, 4].map((i) => authoredStep(i)),
      authoredStep(5, {
        step: { do: "click", on: { role: "button", name: "Pay now" } },
        anchorId: null,
        actionId: null,
        marker: null,
        rect: null,
        strategy: "broken",
        failureReason: "unresolved",
        pageUrl: "https://app.example.com/",
      }),
    ];
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: {
        reason: "unresolvedAnchor",
        completed: 4,
        total: 9,
        bundle: null,
        degradations: [],
        storageRefused: false,
        counters: { encodeShrunkSpans: 0 },
      },
      steps,
      scene,
      madeFrom: null,
    });

    // The premise.
    expect(scene.actions).toHaveLength(4);
    expect(report.stopped?.at.index).toBe(4);

    const label = report.stopped?.at.label ?? "";
    expect(label).not.toMatch(/no single step/);
    // The script index, counted the way an author counts, and the intent
    // verbatim — both from the record the run wrote, neither derived from the
    // count.
    expect(label).toContain("script step 5");
    expect(label).toContain("click");
    expect(label).toContain("Pay now");
  });

  /**
   * The other half of the same label: with NO take at all there is no step to
   * name, and the wave's instruction was to leave that path alone because it
   * is already honest. Asserted so a future fix of the branch above cannot
   * quietly make this one claim a step either — `steps` is empty here, so a
   * `lastAttempted` that forgot its own null check would have nothing to read.
   */
  it("says no step can be named when no video was assembled", () => {
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: {
        reason: "debuggerUnavailable",
        completed: 0,
        total: 3,
        bundle: null,
        degradations: [],
        storageRefused: false,
        counters: { encodeShrunkSpans: 0 },
      },
      steps: [],
      scene: null,
      madeFrom: null,
    });
    expect(report.stopped?.at.label).toMatch(/no video was assembled/);
    // And the line agrees with the count rather than claiming step 1 was
    // attempted, which is what `at.index + 1` would have printed here.
    expect(verdictLine(report)).toMatch(/stopped after step 0 of 3/i);
    // No step was attempted, so no script step is named (review focus 4).
    expect(report.stopped?.at.scriptStep).toBeNull();
  });

  // A report.json written before DEM-61 has no script step: it reads as it
  // did, never "script step undefined".
  it("a report from before the script-step numbering reads as it did", () => {
    const report = buildRunReport({
      ...complete(),
      walk: { ...completeWalk(3), reason: "anchorNotRendered", completed: 1 },
    });
    const old = {
      ...report,
      stopped: {
        ...(report.stopped as NonNullable<typeof report.stopped>),
        at: { index: 1, of: 3, label: "x" },
      },
    } as unknown as typeof report;
    expect(prVerdict(old).clause).toBe("stopped after step 1 of 3");
    expect(verdictLine(old)).toMatch(/^Stopped after step 1 of 3: /);
  });

  // Review (Minor 3): no video assembled, yet a step was attempted. The
  // label names the step the number names, never "no step can be named".
  it("with no video, the label names the script step the sentence does", () => {
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: {
        ...baseRun(),
        script: { name: "run report fixture", scriptVersion: 1, steps: 3 },
      },
      walk: {
        reason: "unresolvedAnchor",
        completed: 0,
        total: 3,
        bundle: null,
        degradations: [],
        storageRefused: false,
        counters: { encodeShrunkSpans: 0 },
      },
      steps: [
        authoredStep(1, {
          actionId: null,
          anchorId: null,
          marker: null,
          failureReason: "unresolved",
        }),
      ],
      scene: null,
      madeFrom: null,
    });
    expect(report.stopped?.at.scriptStep).toBe(1);
    expect(report.stopped?.at.label).toMatch(/^script step 1: /);
    expect(verdictLine(report)).toMatch(/^Stopped at script step 1 of 3: /);
  });

  // DEM-61 (Helpdesk, 2026-11-06): "Stopped after step 2 of 4" counted the
  // actions that succeeded, while the label in the same answer said "script
  // step 4". One numbering: the script's own steps, pauses counted.
  it("a stop names the script step it stopped on, counting pauses", () => {
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: {
        ...baseRun(),
        script: { name: "run report fixture", scriptVersion: 1, steps: 6 },
      },
      walk: {
        reason: "unresolvedAnchor",
        completed: 2,
        total: 5,
        bundle: null,
        degradations: [],
        storageRefused: false,
        counters: { encodeShrunkSpans: 0 },
      },
      // Script steps 1 and 3 performed (step 2 is a pause, with no record),
      // and step 4 resolved nothing.
      steps: [
        authoredStep(1),
        authoredStep(3, { actionId: "a2" }),
        authoredStep(4, {
          actionId: null,
          anchorId: null,
          marker: null,
          failureReason: "unresolved",
        }),
      ],
      scene: sceneOf(2),
      madeFrom: null,
    });
    // Premise: two actions succeeded, so the old line said "after step 2".
    expect(report.stopped?.at.index).toBe(2);
    expect(report.stopped?.at.label).toMatch(/^script step 4: /);
    expect(report.stopped?.at.scriptStep).toBe(4);
    expect(report.stopped?.at.scriptSteps).toBe(6);
    expect(verdictLine(report)).toMatch(/^Stopped at script step 4 of 6: /);
    expect(prVerdict(report).clause).toBe("stopped at script step 4 of 6");
  });

  it("is diverged-with-a-reason, never matched, with no provenance record", () => {
    const report = buildRunReport({ ...complete(), madeFrom: null });
    expect(report.verdict.kind).toBe("diverged");
    expect(report.verdict.diverged).toHaveLength(1);
    const [first] = report.verdict.diverged;
    expect(first).toMatchObject({ kind: "unverifiable" });
    // Never an empty list: "they match" and "I cannot tell" are different
    // answers (spec §2, rule 2).
    if (first?.kind === "unverifiable") {
      expect(first.reason).toBeTruthy();
    }
  });

  it("carries a refusal's own routes, so the agent learns the one move that clears it", () => {
    const report = buildRunReport({ ...refused("settingOff"), madeFrom: null });
    expect(report.outcome).toBe("refused");
    expect(report.refused?.reason).toBe("settingOff");
    expect(report.refused?.routes.map((r) => r.kind)).toContain(
      "enableMutatingReplay",
    );
  });

  // --- positive control: "matches" is reachable ---------------------------
  //
  // Every case above is diverged or unverifiable. Without this, a
  // `buildVerdict` that always forced "diverged" would pass every test in
  // this file — this is the case that fails if it does.
  it("reports a match when the run completed and the film corresponds to the whole script", () => {
    const n = 5;
    const script = scriptOf(n);
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: completeWalk(n),
      steps: Array.from({ length: n }, (_, i) => authoredStep(i + 1)),
      scene: sceneOf(n),
      madeFrom: madeFromFor(script),
    });
    expect(report.outcome).toBe("complete");
    expect(report.verdict.kind).toBe("matches");
    expect(report.verdict.diverged).toHaveLength(0);
    expect(verdictLine(report)).toMatch(/matches/i);
  });

  // The frames are part of the film. A run whose steps all matched but whose
  // motion was partly refused used to read "the film matches every step",
  // word for word what a clean run says — found on the author's first real
  // run, 2026-09-28, with `surfaceMismatch` in `frames.degradations` and
  // nothing on the line.
  it("says what the film did not keep, after a match that is otherwise clean", () => {
    const n = 5;
    const script = scriptOf(n);
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: {
        ...completeWalk(n),
        degradations: [
          { kind: "surfaceMismatch", startMs: 3000, endMs: 5000, note: "x" },
          { kind: "surfaceMismatch", startMs: 7000, endMs: 8000, note: "y" },
        ],
      },
      steps: Array.from({ length: n }, (_, i) => authoredStep(i + 1)),
      scene: sceneOf(n),
      madeFrom: madeFromFor(script),
    });
    // Premise: the steps matched, so what changes the line is the frames.
    expect(report.verdict.kind).toBe("matches");
    expect(report.frames.degradations).toEqual([
      "surfaceMismatch",
      "surfaceMismatch",
    ]);
    const line = verdictLine(report);
    expect(line).toMatch(/^Complete: the video matches every step/);
    expect(line).toContain("not everything was kept");
    expect(line).toContain("surfaceMismatch");
    // Once per kind, not once per stretch.
    expect(line.split("surfaceMismatch")).toHaveLength(2);
  });

  // Red when a screen refresh cannot compare is said as frames lost: the
  // video is intact, and "not everything was kept" sent readers after
  // nothing (close review 4). The control beside it: a real loss in the same
  // run is still said as one.
  it("says the page screens' kinds in a sentence of their own, never as frames lost", () => {
    const n = 3;
    const script = scriptOf(n);
    const build = (kinds: Degradation["kind"][]) =>
      buildRunReport({
        ...NOT_CHECKED,
        run: baseRun(),
        walk: {
          ...completeWalk(n),
          degradations: kinds.map((kind) => ({
            kind,
            startMs: 0,
            endMs: 1,
            note: "x",
          })),
        },
        steps: Array.from({ length: n }, (_, i) => authoredStep(i + 1)),
        scene: sceneOf(n),
        madeFrom: madeFromFor(script),
      });
    const screens = build([
      "stepUnsettled",
      "stepSettleFailed",
      "requestNotWaited",
    ]);
    expect(screens.verdict.kind).toBe("matches");
    expect(screens.frames.degradations).toHaveLength(3);
    const line = verdictLine(screens);
    expect(line).toMatch(/^Complete: the video matches every step/);
    expect(line).not.toContain("not everything was kept");
    expect(line).toContain("The video is intact, but for refresh:");
    for (const kind of [
      "stepUnsettled",
      "stepSettleFailed",
      "requestNotWaited",
    ])
      expect(line).toContain(`(${kind})`);
    const both = verdictLine(build(["stepUnsettled", "surfaceMismatch"]));
    const lost = /But not everything was kept: ([^.]*)\./.exec(both)?.[1];
    expect(lost, both).toContain("(surfaceMismatch)");
    expect(lost, both).not.toContain("stepUnsettled");
    expect(both).toContain("(stepUnsettled)");
    // Beside a loss the video is not intact, and the line must not say so.
    expect(both).not.toContain("The video is intact");
    expect(both).toContain(" For refresh: ");
    // A hold left on is about the video: a loss, never "intact".
    const held = verdictLine(build(["stepUnsettled", "pageHoldNotReleased"]));
    expect(held).toContain("But not everything was kept:");
    expect(held).toContain("(pageHoldNotReleased)");
    expect(held).not.toContain("The video is intact");
    expect(prVerdict(build(["pageHoldNotReleased"])).clause).toMatch(
      /with notes$/,
    );
  });

  // The sentence is pinned whole: since 2026-09-30 a landing is either a
  // take's recorded rect or a script's hand-written `landing`, and a wording
  // that says "recorded" is false for the second.
  it("says a scroll was centred because its landing was off screen, true for a written landing too", () => {
    const n = 2;
    const script = scriptOf(n);
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: {
        ...completeWalk(n),
        degradations: [
          {
            kind: "scrollLandingOffscreen",
            startMs: 100,
            endMs: 100,
            note: "x",
          },
        ],
      },
      steps: Array.from({ length: n }, (_, i) => authoredStep(i + 1)),
      scene: sceneOf(n),
      madeFrom: madeFromFor(script),
    });
    // Premise: the steps matched, so the clause is the frames' alone.
    expect(report.verdict.kind).toBe("matches");
    const line = verdictLine(report);
    expect(line).toContain(
      "a scroll's landing would have left its target off screen, so the page was centred on it instead (scrollLandingOffscreen)",
    );
    expect(line).not.toMatch(/recorded landing/);
  });

  it("says when the frame store refused frames during the run", () => {
    const n = 2;
    const script = scriptOf(n);
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: { ...completeWalk(n), storageRefused: true },
      steps: Array.from({ length: n }, (_, i) => authoredStep(i + 1)),
      scene: sceneOf(n),
      madeFrom: madeFromFor(script),
    });
    expect(report.frames.storageRefused).toBe(true);
    expect(verdictLine(report)).toContain("storageRefused");
  });

  it("says it on a stopped run too", () => {
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: {
        reason: "unresolvedAnchor",
        completed: 1,
        total: 2,
        bundle: null,
        degradations: [
          { kind: "encodeRefused", startMs: 0, endMs: 10, note: "x" },
        ],
        storageRefused: false,
        counters: { encodeShrunkSpans: 0 },
      },
      steps: [authoredStep(1)],
      scene: sceneOf(1),
      madeFrom: null,
    });
    expect(report.outcome).toBe("stopped");
    expect(verdictLine(report)).toMatch(/^Stopped/);
    expect(verdictLine(report)).toContain("encodeRefused");
  });

  // The control: a clean run's line is exactly what it always was.
  it("adds nothing to the line when every frame was kept", () => {
    const n = 5;
    const script = scriptOf(n);
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: completeWalk(n),
      steps: Array.from({ length: n }, (_, i) => authoredStep(i + 1)),
      scene: sceneOf(n),
      madeFrom: madeFromFor(script),
    });
    expect(verdictLine(report)).toBe(
      "Complete: the video matches every step the script asked for.",
    );
    expect(report.frames.shrunkSpans).toBe(0);
  });

  // A span the encoder refused at its opening size and kept smaller: said in
  // `frames`, where bridge:check prints it, and not on the line — nothing
  // was lost, so "not everything was kept" would be false.
  it("carries the spans the encoder kept only by shrinking them", () => {
    const n = 3;
    const script = scriptOf(n);
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: { ...completeWalk(n), counters: { encodeShrunkSpans: 2 } },
      steps: Array.from({ length: n }, (_, i) => authoredStep(i + 1)),
      scene: sceneOf(n),
      madeFrom: madeFromFor(script),
    });
    expect(report.frames.shrunkSpans).toBe(2);
    expect(verdictLine(report)).toBe(
      "Complete: the video matches every step the script asked for.",
    );
  });

  // --- the comparator's own kinds ------------------------------------------

  it("reports a text divergence when the film types something the script did not ask for", () => {
    const scene: SceneDocument = {
      ...sceneOf(0),
      anchors: [anchorFixture(1)],
      actions: [
        {
          id: "a1",
          anchorId: "anchor1",
          timestamp: 100,
          marker: "type:anchor1",
          kind: "type",
          text: "checkout",
          redacted: false,
        },
      ],
    };
    const madeFrom: MadeFromStep[] = [
      {
        actionId: "a1",
        kind: "type",
        anchorId: "anchor1",
        text: "something else",
        cut: false,
      },
    ];
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: completeWalk(1),
      steps: [authoredStep(1, { marker: "type:anchor1" })],
      scene,
      madeFrom,
    });
    expect(report.verdict.kind).toBe("diverged");
    expect(report.verdict.diverged).toContainEqual({
      kind: "text",
      actionId: "a1",
      wanted: "checkout",
      got: "something else",
    });
  });

  it("reports a missing divergence when the script names a step the film has no record of", () => {
    const scene = sceneOf(2);
    const madeFrom: MadeFromStep[] = [
      {
        actionId: "a1",
        kind: "click",
        anchorId: "anchor1",
        text: null,
        cut: false,
      },
      // a2 never made it into the film.
    ];
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: completeWalk(2),
      steps: [authoredStep(1), authoredStep(2)],
      scene,
      madeFrom,
    });
    expect(report.verdict.kind).toBe("diverged");
    const missing = report.verdict.diverged.find((d) => d.kind === "missing");
    expect(missing).toMatchObject({ kind: "missing", actionId: "a2" });
    if (missing?.kind === "missing") {
      expect(missing.reason).toBeTruthy();
    }
  });

  it("reports an element divergence when the run resolved by a weaker strategy than the script named", () => {
    const scene = sceneOf(1);
    const madeFrom = madeFromFor(scriptOf(1));
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: completeWalk(1),
      steps: [
        authoredStep(1, {
          step: { do: "click", on: { role: "button", name: "Checkout" } },
          strategy: "text",
          candidates: 4,
        }),
      ],
      scene,
      madeFrom,
    });
    expect(report.verdict.kind).toBe("diverged");
    expect(report.verdict.diverged).toContainEqual({
      kind: "element",
      actionId: "a1",
      wanted: { role: "button", name: "Checkout" },
      strategy: "text",
      candidates: 4,
    });
  });

  // A position is a target shape of its own (a derived scroll). Before
  // `targetStrategy`, the comparator read every shape that was not a stableId
  // or a role as `text`, so a step asking for a position and resolving by one
  // was reported as settling for less than it asked.
  it("does not call a position target that resolved by its position a divergence", () => {
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: completeWalk(1),
      steps: [
        authoredStep(1, {
          step: { do: "scrollTo", on: { treePath: "body:1/main:1/div:3" } },
          strategy: "treePath",
          candidates: 1,
        }),
      ],
      scene: sceneOf(1),
      madeFrom: madeFromFor(scriptOf(1)),
    });
    expect(report.verdict.diverged.filter((d) => d.kind === "element")).toEqual(
      [],
    );
  });

  it("names a position step by its position when it stops there", () => {
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: {
        reason: "unresolvedAnchor",
        completed: 1,
        total: 2,
        bundle: null,
        degradations: [],
        storageRefused: false,
        counters: { encodeShrunkSpans: 0 },
      },
      // One step that ran, and the second, which resolved nothing — so the
      // document holds no action for it and the label has to come from the
      // script, as in "names the step from the script…" above.
      steps: [
        authoredStep(1),
        authoredStep(2, {
          step: { do: "scrollTo", on: { treePath: "body:1/main:1/div:3" } },
          anchorId: null,
          actionId: null,
          marker: null,
          rect: null,
          strategy: "broken",
          failureReason: "unresolved",
          pageUrl: "https://app.example.com/",
        }),
      ],
      scene: sceneOf(1),
      madeFrom: null,
    });
    // Premise: the stop is at the step the document has no action for.
    expect(report.stopped?.at.index).toBe(1);
    const label = report.stopped?.at.label ?? "";
    expect(label).toContain('treePath "body:1/main:1/div:3"');
    expect(label).not.toContain("undefined");
  });

  // A run that produced no take at all — the agent door's two cases, a policy
  // refusal and a run that performed no step. `scene: null` is the fact rather
  // than a missing argument, and the verdict has to say it cannot tell.
  it("never reads as a match when the run produced no video", () => {
    // Premise: a COMPLETE walk and a COMPLETE provenance record, so every
    // other input says "clean run". Only the absent take can make this
    // diverge, which is what makes the test able to fail.
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: completeWalk(3),
      steps: Array.from({ length: 3 }, (_, i) => authoredStep(i + 1)),
      scene: null,
      madeFrom: madeFromFor(scriptOf(3)),
    });
    expect(report.verdict.kind).toBe("diverged");
    expect(report.verdict.diverged).toHaveLength(1);
    const only = report.verdict.diverged[0];
    expect(only?.kind).toBe("unverifiable");
    if (only?.kind === "unverifiable") expect(only.reason).toBeTruthy();
    // And the stop, where there is one, names no step rather than naming the
    // wrong one: there is no document to index into.
    const stopped = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: {
        reason: "unresolvedAnchor",
        completed: 0,
        total: 3,
        bundle: null,
        degradations: [],
        storageRefused: false,
        counters: { encodeShrunkSpans: 0 },
      },
      steps: [],
      scene: null,
      madeFrom: null,
    });
    expect(stopped.stopped?.at).toEqual({
      index: 0,
      of: 3,
      scriptStep: null,
      scriptSteps: 9,
      label: "(no video was assembled, so no step can be named)",
    });
  });

  // `notStored` leads the line, ahead of even a clean "complete": whatever the
  // run has to say about itself, the library does not hold it.
  it("says the take is not in the library before it says anything about the run", () => {
    const clean = complete();
    // Premise: without `notStored` this exact report prints as a clean match —
    // so the clause below is the only thing that can change the line.
    expect(verdictLine(buildRunReport(clean))).toMatch(/^Complete: the video/);

    const line = verdictLine(
      buildRunReport({
        ...clean,
        takeId: null,
        notStored: [{ what: "take", error: "QuotaExceededError" }],
      }),
    );
    expect(line).toMatch(/^The run's video did not reach the library/);
    expect(line).toContain("QuotaExceededError");
    // What the run itself had to say still follows it, rather than replacing
    // it: the frames exist, and that is what the author acts on next.
    expect(line).toContain("Complete:");
  });

  // Complete AND a reason: the case `statusOf`'s docblock names — every step
  // performed, and then the bundle could not be stored. The line has to say so.
  // Before 2026-09-27 the complete clause printed only the verdict, so the
  // reason was dropped and this read as an ordinary clean run.
  it("names the reason of a run that finished and still failed", () => {
    const clean = complete();
    // Premise: the same run WITHOUT a reason prints as a clean match, so the
    // reason is the only thing that can change the line.
    expect(verdictLine(buildRunReport(clean))).toMatch(/^Complete: the video/);

    const report = buildRunReport({
      ...clean,
      // Every step performed — `replayOutcome(3, 3)` is "complete" — and a
      // reason beside it.
      walk: { ...completeWalk(3), reason: "portFailure" },
    });
    expect(report.outcome).toBe("complete");
    expect(report.stopped?.reason).toBe("portFailure");
    const line = verdictLine(report);
    expect(line).toMatch(/^Complete, but:/);
    expect(line).toContain(reasonSentence("portFailure"));
  });

  // `stopped.detail` is what the host actually saw, and it PRINTS in place of
  // the reason's shared sentence — which for one reason is outright wrong at the
  // agent door (`noActions`' sentence talks about cut steps).
  it("prints what the host saw instead of the reason's shared sentence", () => {
    const detail =
      "every step in this script is a pause, which performs nothing";
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: { ...completeWalk(0), reason: "noActions" },
      steps: [],
      scene: null,
      madeFrom: null,
      detail,
    });
    expect(report.stopped?.detail).toBe(detail);
    // Both are in the report: the category for whoever wants it, the specific
    // truth for whoever reads the line.
    expect(report.stopped?.sentence).toBe(reasonSentence("noActions"));
    const line = verdictLine(report);
    expect(line).toContain(detail);
    expect(line).not.toContain(reasonSentence("noActions"));
  });

  // The other half of the same field: a take that DID land, whose record did
  // not. The author can open it; something about it is missing.
  it("tells a lost record apart from a lost take", () => {
    const line = verdictLine(
      buildRunReport({
        ...complete(),
        takeId: "scene-run-report-fixture",
        notStored: [{ what: "status", error: "the write was refused" }],
      }),
    );
    expect(line).toMatch(/^The run's video is in the library/);
    expect(line).toContain("status (the write was refused)");
  });

  // Launch C: a session the run could not write back is not part of the
  // take's record — the take is whole — so the line says what did not land.
  it("says a session that was not written back, without calling the take incomplete", () => {
    const line = verdictLine(
      buildRunReport({
        ...complete(),
        takeId: "scene-run-report-fixture",
        notStored: [{ what: "session", error: "EACCES: permission denied" }],
      }),
    );
    expect(line).toMatch(
      /^The run's video is in the library, but the site's session could not be saved back/,
    );
    expect(line).toContain("session (EACCES: permission denied)");
    expect(line).not.toContain("part of its record");
    // Beside a lost record, the record's clause still leads.
    const both = verdictLine(
      buildRunReport({
        ...complete(),
        takeId: "scene-run-report-fixture",
        notStored: [
          { what: "status", error: "the write was refused" },
          { what: "session", error: "EACCES" },
        ],
      }),
    );
    expect(both).toMatch(
      /^The run's video is in the library, but part of its record is not/,
    );
    expect(both).toContain("session (EACCES)");
  });
});

// DEM-108. Red if verdictLine drops `videoVersion.otherRepo`: the run page,
// the PR line and the agent's summary would not say the flow is another
// repo's.
describe("a flow joined from another repo, on the line", () => {
  it("says so after the run's own clause, and says nothing when it is not", () => {
    const clean = buildRunReport(complete());
    const said =
      "this flow belongs to github.com/a/b; this video was recorded from github.com/a/c";
    const line = verdictLine({
      ...clean,
      videoVersion: { id: "f", name: "F", created: false, otherRepo: said },
    });
    expect(line).toBe(`${verdictLine(clean)} Note: ${said}.`);
    expect(
      verdictLine({
        ...clean,
        videoVersion: { id: "f", name: "F", created: false },
      }),
    ).toBe(verdictLine(clean));
  });
});

describe("the look on the line", () => {
  it("names an unreadable kit after the run's own clause", () => {
    const report = buildRunReport({
      ...complete(),
      look: {
        branding: "defaults",
        kit: null,
        brandKitError:
          "Your brand kit could not be read, so this video uses the default background: storage refused the read: boom",
        wallpaperError: null,
      },
    });
    const line = verdictLine(report);
    expect(line).toContain("Your brand kit could not be read");
    expect(line).toContain("boom");
    // The run's own verdict is still there, ahead of it.
    expect(line.indexOf(verdictLine(buildRunReport(complete())))).toBe(0);
  });

  // Red if lookClause drops `wallpaperError` (ruling R19): the default
  // kit's image is not the take's own, and the summary would not say so.
  it("names a default kit's image the take could not own, after the run's own clause", () => {
    const said =
      "Your default brand kit's image could not be copied into this video, which keeps the kit's path to it: The image /x/gone.png could not be read (ENOENT)";
    const report = buildRunReport({
      ...complete(),
      look: {
        branding: "defaultKit",
        kit: { name: "Photo" },
        brandKitError: null,
        wallpaperError: said,
      },
    });
    const line = verdictLine(report);
    expect(line).toContain(`${said}.`);
    expect(line.indexOf(verdictLine(buildRunReport(complete())))).toBe(0);
    expect(prVerdict(report).clause).toBe("matches all 3 steps, with notes");
  });

  it("says nothing about the look when there is no fault", () => {
    const clean = buildRunReport(complete());
    const noKit = buildRunReport({
      ...complete(),
      look: {
        branding: "defaults",
        kit: null,
        brandKitError: null,
        wallpaperError: null,
      },
    });
    expect(verdictLine(noKit)).toBe(verdictLine(clean));
  });

  it("carries the look into the report as given, and null for a re-shoot", () => {
    expect(buildRunReport(complete()).look).toEqual({
      branding: "defaultKit",
      kit: { name: "Dark" },
      brandKitError: null,
      wallpaperError: null,
    });
    expect(buildRunReport({ ...complete(), look: null }).look).toBeNull();
  });
});

describe("clickNotDeliveredDetail", () => {
  it("says where the click went and the move", () => {
    expect(
      clickNotDeliveredDetail(
        "the click was sent to (60, 40), the press arrived at (40, 27) and the release arrived at (40, 27), so the page never saw a click on its target",
      ),
    ).toBe(
      "the click was sent to (60, 40), the press arrived at (40, 27) and the release arrived at (40, 27), so the page never saw a click on its target — the browser put the click somewhere other than where it was sent, so that step did not happen; nothing in the script is wrong: run it again, and say so if it repeats",
    );
  });

  // Second review, Minor 8: a refused store is a second fact, said after.
  it("says a store that also refused the take after the move, not inside it", () => {
    const detail = clickNotDeliveredDetail(
      "the click was sent to (60, 40), so the page never saw a click on its target; bundle not persisted: quota exceeded",
    );
    expect(detail).toMatch(
      /say so if it repeats\. Also, the take could not be stored: quota exceeded$/,
    );
    expect(detail).not.toMatch(/bundle not persisted/);
  });

  // Review 2026-10-13, #1: a type whose unconfirmed click left focus off its
  // field may be aimed at something that is not the field, which fails the
  // same way on every run — so it is not sent round to run it again as if
  // the browser were to blame.
  it("sends a type whose field never took focus to its target, not to a re-run", () => {
    const note =
      "the type's click could not be confirmed (the target was moving as it was measured) and its field did not hold focus, so nothing was typed";
    const detail = clickNotDeliveredDetail(note);
    expect(detail.startsWith(note)).toBe(true);
    expect(detail).toMatch(/is not itself the text field/);
    expect(detail).not.toMatch(/nothing in the script is wrong/);
  });
});

describe("a step whose typed text is hidden", () => {
  it("reports HIDDEN_TEXT where the agent's value was, and says why", () => {
    const hidden = authoredStep(1, {
      step: { do: "type", into: { stableId: "pw" }, text: "hunter2-demo" },
      textHidden: "credentialField",
    });
    const plain = authoredStep(2, {
      step: { do: "type", into: { stableId: "nick" }, text: "visible-demo" },
    });
    const report = buildRunReport({
      ...NOT_CHECKED,
      run: baseRun(),
      walk: {
        reason: "anchorNotRendered",
        completed: 1,
        total: 2,
        bundle: null,
        degradations: [],
        storageRefused: false,
        counters: { encodeShrunkSpans: 0 },
      },
      steps: [hidden, plain],
      scene: sceneOf(1),
      madeFrom: null,
    });
    expect(report.steps[0]?.textHidden).toBe("credentialField");
    expect(report.steps[0]?.intent).toMatchObject({ text: HIDDEN_TEXT });
    expect(JSON.stringify(report)).not.toContain("hunter2-demo");
    // Positive control: an unhidden type step keeps its text.
    expect(report.steps[1]?.intent).toMatchObject({ text: "visible-demo" });
    expect(report.steps[1]?.textHidden).toBeUndefined();
  });
});

describe("prVerdict", () => {
  const CLEAN = /^Complete: the video matches every step/;
  const clean = () => buildRunReport(complete());
  // Each row of the short form's table, built from the clean report by
  // changing only the field that row reads.
  const rows: [string, RunReport, string][] = [
    [
      "notStored, even over a refusal",
      {
        ...buildRunReport(refused("settingOff")),
        notStored: [{ what: "status", error: "QuotaExceededError" }],
      },
      "the run's record is incomplete",
    ],
    [
      // verdictLine says the take is in the library and only the site's
      // session was not saved back, so the record is not incomplete.
      "a session that was not saved back",
      buildRunReport({
        ...complete(),
        notStored: [{ what: "session", error: "EACCES" }],
      }),
      "matches all 3 steps, with notes",
    ],
    ["refused", buildRunReport(refused("settingOff")), "refused: settingOff"],
    [
      "stopped",
      buildRunReport({
        ...complete(),
        walk: { ...completeWalk(3), reason: "anchorNotRendered", completed: 1 },
      }),
      // The record of the action it stopped on is script step 2 (DEM-61).
      "stopped at script step 2 of 9",
    ],
    [
      "complete with a stop reason",
      buildRunReport({
        ...complete(),
        walk: { ...completeWalk(3), reason: "portFailure" },
      }),
      "finished, but did not end cleanly",
    ],
    [
      "diverged",
      {
        ...clean(),
        verdict: {
          kind: "diverged",
          diverged: [
            { kind: "missing", actionId: "a1", reason: "x" },
            { kind: "missing", actionId: "a2", reason: "y" },
          ],
        },
      },
      "2 steps not shown as scripted",
    ],
    [
      "a degradation",
      buildRunReport({
        ...complete(),
        walk: {
          ...completeWalk(3),
          degradations: [
            { kind: "surfaceMismatch", startMs: 0, endMs: 1, note: "x" },
          ],
        },
      }),
      "matches all 3 steps, with notes",
    ],
    [
      "storageRefused",
      buildRunReport({
        ...complete(),
        walk: { ...completeWalk(3), storageRefused: true },
      }),
      "matches all 3 steps, with notes",
    ],
    [
      // The video is whole: a screen refresh cannot compare is said in the
      // details, never as a note on the video (close review 4).
      "screens refresh cannot compare",
      buildRunReport({
        ...complete(),
        walk: {
          ...completeWalk(3),
          degradations: [
            { kind: "stepUnsettled", startMs: 0, endMs: 1, note: "x" },
            { kind: "requestNotWaited", startMs: 0, endMs: 1, note: "y" },
          ],
        },
      }),
      "matches all 3 steps",
    ],
    [
      "an unreadable brand kit",
      buildRunReport({
        ...complete(),
        look: {
          branding: "defaults",
          kit: null,
          brandKitError: "kit boom",
          wallpaperError: null,
        },
      }),
      "matches all 3 steps, with notes",
    ],
  ];

  for (const [name, report, clause] of rows) {
    it(`${name} → "${clause}", with the whole line as its details`, () => {
      // Premise: the fixture is not the clean run.
      expect(verdictLine(report)).not.toBe(verdictLine(clean()));
      expect(prVerdict(report)).toEqual({
        clause,
        details: verdictLine(report),
      });
    });
  }

  it("a clean match → the step count, and no details", () => {
    const report = clean();
    expect(report.steps).toHaveLength(3);
    expect(verdictLine(report)).toMatch(CLEAN);
    expect(verdictLine(report)).not.toContain("But not everything");
    expect(prVerdict(report)).toEqual({
      clause: "matches all 3 steps",
      details: null,
    });
  });
});

describe("a typed field that does not hold its text", () => {
  /** `complete()` with step 1 turned into a `type` of "4800" whose field
   *  read back as `value`. The scene and madeFrom agree on the text, so the
   *  only thing that can diverge is the read-back. */
  function typedInto(value: string, holds: boolean): BuildArgs {
    const args = complete();
    if (!("walk" in args)) throw new Error("the fixture is a walked run");
    const [first, ...rest] = args.scene?.actions ?? [];
    const scene = {
      ...args.scene,
      actions: [
        {
          id: "a1",
          anchorId: "anchor1",
          timestamp: 1000,
          marker: "type:anchor1",
          kind: "type" as const,
          text: "4800",
          redacted: false,
        },
        ...rest,
      ],
    } as SceneDocument;
    expect(first?.kind, "the fixture replaces a click").toBe("click");
    return {
      ...args,
      scene,
      madeFrom: (args.madeFrom ?? []).map((m, i) =>
        i === 0 ? { ...m, kind: "type", text: "4800" } : m,
      ),
      steps: args.steps.map((s, i) =>
        i === 0
          ? {
              ...s,
              step: {
                do: "type" as const,
                into: { stableId: "amount" },
                text: "4800",
              },
              fieldHolds: { value, holds },
            }
          : s,
      ),
    };
  }

  it("the verdict line names a field that does not hold its text", () => {
    const report = buildRunReport(typedInto("", false));
    expect(report.verdict.kind).toBe("diverged");
    expect(report.verdict.diverged).toEqual([
      { kind: "fieldDoesNotHold", actionId: "a1", wanted: "4800", value: "" },
    ]);
    const line = verdictLine(report);
    expect(line).toContain("step 1");
    expect(line).toContain('"4800"');
    expect(line).toContain("fieldDoesNotHold");
    expect(report.steps[0]?.fieldHolds).toEqual({ value: "", holds: false });
  });

  it("says so when the step behind the divergence cannot be found", () => {
    const built = buildRunReport(typedInto("", false));
    const report = { ...built, steps: [] };
    const line = verdictLine(report);
    // The premise: the divergence is still there to be named.
    expect(built.verdict.diverged[0]?.kind).toBe("fieldDoesNotHold");
    expect(line).toContain("a step typed");
    expect(line).not.toContain("step 0");
  });

  it("a field that holds its text leaves the verdict a match", () => {
    const report = buildRunReport(typedInto("4,800", true));
    expect(report.steps[0]?.fieldHolds).toEqual({
      value: "4,800",
      holds: true,
    });
    expect(report.verdict.kind).toBe("matches");
  });

  it("carries loadSeen false onto the step and leaves the verdict alone", () => {
    const args = complete();
    if (!("walk" in args)) throw new Error("the fixture is a walked run");
    const report = buildRunReport({
      ...args,
      steps: args.steps.map((s, i) =>
        i === 0 ? { ...s, loadSeen: false } : s,
      ),
    });
    expect(report.steps[0]?.loadSeen).toBe(false);
    expect(report.verdict.kind).toBe("matches");
  });

  // DEM-173: a `type` whose last key was never seen painted is said on the
  // step, so the report does not read as a step whose value showed.
  it("carries lastKeyPaint onto the step", () => {
    const args = complete();
    if (!("walk" in args)) throw new Error("the fixture is a walked run");
    const unconfirmed = "the page drew no frame within 1000 ms of the last key";
    const report = buildRunReport({
      ...args,
      steps: args.steps.map((s, i) =>
        i === 0 ? { ...s, lastKeyPaint: { unconfirmed } } : s,
      ),
    });
    expect(report.steps[0]?.lastKeyPaint).toEqual({ unconfirmed });
  });
});

describe("RunReport opening, trim and zoom notes", () => {
  const timing = (markerMs: number, startMs: number, finishMs: number) => ({
    markerMs,
    startMs,
    finishMs,
    zoomOutMs: null,
  });

  /** waitForLoad, a 500 ms pause, then a click whose marker is at 2000 ms.
   *  Load 800 + waitForLoad 700 + pause 500 = 2000: the parts sum. */
  function opening(over: {
    clickMarkerMs?: number;
    trim?: DemoScript["trim"];
    trimClamped?: { side: "start"; askedMs: number; keptMs: number };
    trimUnplaced?: ("start" | "end")[];
    scene?: SceneDocument;
    steps?: AuthoredStep[];
  }): BuildArgs {
    const base = complete();
    if (!("walk" in base)) throw new Error("the fixture is a walked run");
    const script: DemoScript = {
      scriptVersion: 1,
      name: "opening",
      target: "https://app.example.com/",
      steps: [
        { do: "waitForLoad" },
        { do: "pause", ms: 500 },
        { do: "click", on: { stableId: "stable-1" } },
      ],
      ...(over.trim === undefined ? {} : { trim: over.trim }),
    };
    return {
      ...base,
      script,
      scene: over.scene ?? sceneOf(1),
      madeFrom: madeFromFor(scriptOf(1)),
      walk: {
        ...completeWalk(2),
        ...(over.trimClamped === undefined
          ? {}
          : { trimClamped: over.trimClamped }),
        ...(over.trimUnplaced === undefined
          ? {}
          : { trimUnplaced: over.trimUnplaced }),
      },
      steps: over.steps ?? [
        authoredStep(0, {
          index: 0,
          step: { do: "waitForLoad" },
          anchorId: null,
          actionId: null,
          timing: timing(1500, -700, 0),
        }),
        authoredStep(1, {
          index: 2,
          timing: timing(over.clickMarkerMs ?? 2000, -100, 300),
        }),
      ],
    };
  }

  it("opening breaks down load, a waitForLoad and a pause", () => {
    const report = buildRunReport(opening({}));
    expect(report.opening?.ms).toBe(2000);
    expect(report.opening?.spentOn).toEqual([
      { kind: "load", ms: 800 },
      { kind: "waitForLoad", ms: 700 },
      { kind: "pause", ms: 500 },
    ]);
    // The breakdown cannot silently omit time.
    const sum = report.opening?.spentOn.reduce((t, p) => t + p.ms, 0);
    expect(
      Math.abs((sum ?? 0) - (report.opening?.ms ?? 0)),
    ).toBeLessThanOrEqual(1);
    expect(report.opening?.unaccountedMs).toBeUndefined();
    expect(report.opening?.shown).toBeUndefined();
  });

  it("a leading pause is its own part and not also load", () => {
    const base = complete();
    if (!("walk" in base)) throw new Error("walked");
    // The click's start (marker 2000, start 0) already contains the sleep.
    const report = buildRunReport({
      ...base,
      script: {
        scriptVersion: 1,
        name: "opening",
        target: "https://app.example.com/",
        steps: [
          { do: "pause", ms: 500 },
          { do: "click", on: { stableId: "stable-1" } },
        ],
      },
      scene: sceneOf(1),
      madeFrom: madeFromFor(scriptOf(1)),
      walk: completeWalk(1),
      steps: [authoredStep(1, { index: 1, timing: timing(2000, 0, 300) })],
    });
    expect(report.opening?.spentOn).toEqual([
      { kind: "load", ms: 1500 },
      { kind: "pause", ms: 500 },
    ]);
    expect(report.opening?.unaccountedMs).toBeUndefined();
  });

  it("does not say mostly when unaccounted time outweighs every part", () => {
    const report = buildRunReport(opening({ clickMarkerMs: 6000 }));
    expect(report.opening?.unaccountedMs).toBe(4000);
    const line = verdictLine(report);
    expect(line).toContain("the video spends 6.0 s before the first step");
    expect(line).not.toContain("mostly");
  });

  it("an opening the parts do not cover says how much is left", () => {
    const report = buildRunReport(opening({ clickMarkerMs: 2600 }));
    expect(report.opening?.ms).toBe(2600);
    expect(report.opening?.unaccountedMs).toBe(600);
  });

  it("a long opening is in the summary and names its largest part", () => {
    const report = buildRunReport(
      opening({
        clickMarkerMs: 4200,
        steps: [
          authoredStep(0, {
            index: 0,
            step: { do: "waitForLoad" },
            anchorId: null,
            actionId: null,
            timing: timing(3700, -700, 0),
          }),
          authoredStep(1, { index: 2, timing: timing(4200, -100, 300) }),
        ],
      }),
    );
    expect(report.opening?.ms).toBe(4200);
    expect(report.opening?.unaccountedMs).toBeUndefined();
    expect(verdictLine(report)).toContain(
      "the video spends 4.2 s before the first step (mostly loading); trim.start shortens it",
    );
  });

  it("a short one is not", () => {
    expect(verdictLine(buildRunReport(opening({})))).not.toContain(
      "before the first step",
    );
  });

  it("a failure sentence still leads a long opening", () => {
    const built = opening({ clickMarkerMs: 4200 });
    if (!("walk" in built)) throw new Error("walked");
    const report = buildRunReport({
      ...built,
      walk: { ...built.walk, completed: 1, reason: "anchorNotRendered" },
    });
    expect(report.opening?.ms).toBe(4200);
    expect(verdictLine(report)).toMatch(/^Stopped/);
  });

  it("a trim.start that applies says how much of the opening the video keeps", () => {
    const report = buildRunReport(
      opening({ clickMarkerMs: 4200, trim: { start: { ms: 1000 } } }),
    );
    expect(report.opening?.shown).toBe(1000);
    expect(verdictLine(report)).not.toContain("trim.start shortens it");
  });

  it("a clamped start trim is reported in words", () => {
    const report = buildRunReport(
      opening({
        trim: { start: { ms: 4000, step: 3 } },
        trimClamped: { side: "start", askedMs: 4000, keptMs: 1200 },
      }),
    );
    expect(report.opening?.shown).toBe(1200);
    expect(report.trimNotes).toEqual([
      "trim.start asked for 4000 ms before step 3 and the video holds 1200 ms; it starts at the beginning",
    ]);
  });

  it("an end trim whose step never ran says so", () => {
    const report = buildRunReport(
      opening({
        trim: { end: { ms: 500, step: 3 } },
        trimUnplaced: ["end"],
        steps: [],
      }),
    );
    expect(report.trimNotes).toEqual([
      "trim.end names step 3, which never ran, so the end is not trimmed",
    ]);
  });

  it("an end trim past what the run filmed says so", () => {
    const report = buildRunReport(
      opening({ trim: { end: { ms: 500, step: 3 } }, trimUnplaced: ["end"] }),
    );
    expect(report.trimNotes).toEqual([
      "trim.end lies past what the run filmed, so the end is not trimmed",
    ]);
  });

  it("a start trim whose step never ran says so", () => {
    const report = buildRunReport(
      opening({
        trim: { start: { ms: 500, step: 3 } },
        trimUnplaced: ["start"],
        steps: [],
      }),
    );
    expect(report.trimNotes).toEqual([
      "trim.start names step 3, which never ran, so the start is not trimmed",
    ]);
  });

  it("an asked scale on a skipped click is reported per step", () => {
    const scene: SceneDocument = {
      ...sceneOf(2),
      zoomsSkipped: [
        {
          actionId: "a2",
          reason: "tooClose",
          afterActionId: "a1",
          gapMs: 400,
          askedScale: 1.6,
        },
        { actionId: "a1", reason: "off" },
      ],
    };
    const base = complete();
    if (!("walk" in base)) throw new Error("walked");
    const report = buildRunReport({
      ...base,
      scene,
      steps: [authoredStep(1), authoredStep(2)],
    });
    expect(report.zoomNotes).toHaveLength(1);
    expect(report.zoomNotes?.[0]?.step).toBe(2);
    expect(report.zoomNotes?.[0]?.sentence).toMatch(
      /^asked for 1\.6x, but no zoom on click a2: too close to the previous zoom/,
    );
  });
});
