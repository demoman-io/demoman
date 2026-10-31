import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cursorEntryPoint, madeFromOf } from "@demoman/compositor";
import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  DemoScriptSchema,
  MOTION_DEFAULTS,
  type SceneAction,
  type SceneAnchor,
  type SceneBranding,
  type SceneDocument,
  SceneDocumentSchema,
  type ScriptStep,
  type StrategyName,
  scriptFromTake,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  type AuthoredDeps,
  assembleAuthored,
  authoredTotal,
  type CaptureFailure,
  cameraInputs,
  createAuthoredRun,
  type IntentCapture,
  unwaitedActions,
} from "../../src/authored.js";
import { reasonSentence } from "../../src/explain.js";
import type {
  Clock,
  Rect,
  ReplayCounters,
  ReplayResult,
  ReplayStopReason,
  ResolveReport,
} from "../../src/types.js";
import type { WalkSource, WalkStep } from "../../src/walk.js";

/**
 * The authored source and the assembler, driven directly.
 *
 * There is no fake CDP/page/encoder/store harness in this package — its own
 * `test/` held one file, `node/dist-loads.test.ts` — and everything under test
 * here is orchestration around injected dependencies. So these tests pull the
 * async generator themselves with a fake `captureResolved` and a fake clock,
 * and `walkThrough` below reproduces only the contract the source has with the
 * walk. `runAuthored` end to end is the extension's integration lane (Task 8)
 * plus the author's manual pass.
 */

const VIEWPORT = { width: 1000, height: 800 };
const PAGE = "https://app.test/";
const OTHER_PAGE = "https://app.test/login";

/** A brand kit no default could be mistaken for. */
const KIT: SceneBranding = {
  background: { kind: "solid", color: "#ff00aa" },
  logo: null,
  padding: 0.13,
};

/** A clock whose every reading is later than the last, so a stamp taken from
 *  it is checkable and a stamp taken from anything else is visible. */
function fakeClock(): Clock & { at(): number } {
  let t = 10_000;
  return {
    now: () => {
      t += 1;
      return t;
    },
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    at: () => t,
  };
}

/**
 * A port the source must not touch. Every property access throws, so a source
 * that reached for CDP, the store or the encoder would fail loudly here rather
 * than pass against a silent stub.
 */
function forbiddenPort<T>(name: string): T {
  return new Proxy(
    {},
    {
      get: () => {
        throw new Error(`the authored source must not touch deps.${name}`);
      },
    },
  ) as T;
}

interface ScriptedCapture {
  strategy?: StrategyName;
  candidates?: number;
  /** Set to answer with no anchor. */
  failureReason?: CaptureFailure;
  /** What the page said about the field; absent: the port did not check. */
  credentialField?: boolean | null;
}

interface FakeCaptures {
  captureResolved: AuthoredDeps["captureResolved"];
  /** Every intent this was asked about, in order. */
  calls: AnchorIntent[];
  /** Every answer it gave, so a test can assert its own premise. */
  answers: IntentCapture[];
}

function fakeCaptures(opts: {
  captures?: ScriptedCapture[];
  /** From this call on (0-based), the page reports a different URL. */
  navigatesAwayAfterCall?: number;
}): FakeCaptures {
  const calls: AnchorIntent[] = [];
  const answers: IntentCapture[] = [];
  return {
    calls,
    answers,
    captureResolved: (intent) => {
      const n = calls.length;
      calls.push(intent);
      const scripted = opts.captures?.[n] ?? {};
      const strategy = scripted.strategy ?? "roleName";
      const candidates = scripted.candidates ?? 1;
      // The page THIS attempt happened on, whether it succeeded or not — which
      // is the whole point of the expired-session case: the target does not
      // exist on the new page, so the FAILURE is the only thing that can carry
      // the URL.
      const url =
        opts.navigatesAwayAfterCall !== undefined &&
        n >= opts.navigatesAwayAfterCall
          ? OTHER_PAGE
          : PAGE;
      const answer = ((): IntentCapture => {
        if (scripted.failureReason === "pageSilent") {
          // No reply at all, so nothing to carry a page in — exactly what
          // `askPageToCapture` constructs on a refused send or a timeout.
          return {
            anchor: null,
            failureReason: "pageSilent",
            intentResolution: null,
            pageUrl: null,
          };
        }
        if (scripted.failureReason === "pageFaulted") {
          // The page answered that its own agent threw. There is no intent
          // resolution, because the work that would have produced one threw
          // before producing anything — the page's real reply carries `null`
          // here too, and inventing a `strategy: "broken"` would be a
          // measurement nobody made. The page URL IS carried: the page
          // answered, so it knows where it was.
          return {
            anchor: null,
            failureReason: "pageFaulted",
            intentResolution: null,
            pageUrl: url,
          };
        }
        if (scripted.failureReason !== undefined) {
          return {
            anchor: null,
            failureReason: scripted.failureReason,
            intentResolution: {
              strategy,
              candidates,
              // `unresolved` is the ladder's terminal verdict rather than a
              // `FailureReasonName`, so the intent's own resolution carries no
              // reason for it. Every other value here IS one.
              failureReason:
                scripted.failureReason === "unresolved"
                  ? null
                  : scripted.failureReason,
            },
            pageUrl: url,
            ...(scripted.credentialField === undefined
              ? {}
              : { credentialField: scripted.credentialField }),
          };
        }
        const anchor: SceneAnchor = {
          id: intent.id,
          fingerprint: {
            ...intent.fingerprint,
            treePath: `body>main>button(${n + 1})`,
            boundingRect: {
              x: 20 + n * 10,
              y: 100 + n * 40,
              width: 90,
              height: 30,
            },
          },
          resolution: {
            url,
            // What `captureForIntent` writes: the page has no step index for a
            // freshly authored anchor. The run is what fills it in.
            actionIndex: 0,
            entryState: false,
            strategy,
            failureReason: null,
            candidates,
          },
        };
        // Null on success, as the extension sends it: `anchor.resolution.url`
        // is the same observation, read off the element that was found.
        return {
          anchor,
          failureReason: null,
          intentResolution: { strategy, candidates, failureReason: null },
          pageUrl: null,
          ...(scripted.credentialField === undefined
            ? {}
            : { credentialField: scripted.credentialField }),
        };
      })();
      answers.push(answer);
      return Promise.resolve(answer);
    },
  };
}

/** A target that stays absent past the 10 s wait (about 67 polls at 150 ms). */
function absent(extra: Partial<ScriptedCapture> = {}): ScriptedCapture[] {
  return Array.from({ length: 100 }, () => ({
    failureReason: "unresolved" as const,
    ...extra,
  }));
}

function fakeDeps(opts: {
  clock: Clock;
  captureResolved: AuthoredDeps["captureResolved"];
}): AuthoredDeps {
  let n = 0;
  return {
    cdp: forbiddenPort("cdp"),
    page: forbiddenPort("page"),
    encoder: forbiddenPort("encoder"),
    store: forbiddenPort("store"),
    clock: opts.clock,
    mayReplay: true,
    captureResolved: opts.captureResolved,
    newId: (prefix) => {
      n += 1;
      return `${prefix}-${n}`;
    },
    sceneId: "take-1",
    createdAt: "2026-09-27T09:00:00.000Z",
    viewport: VIEWPORT,
    startingBranding: KIT,
    cameraFor: (actions: SceneAction[]) => ({
      camera: actions
        .filter((a) => a.kind === "click" && a.anchorId !== null)
        .map((a, i) => ({
          id: `zoom-${i + 1}`,
          kind: "zoom" as const,
          anchorId: a.anchorId as string,
          marker: { actionId: a.id, offsetMs: 0 },
          scale: 2,
        })),
      zoomsSkipped: [],
    }),
  };
}

const report = (step: WalkStep): ResolveReport => ({
  anchorId: step.action.anchorId ?? "",
  strategy: "roleName",
  resolved: true,
  failureReason: null,
});

/**
 * The walk, reduced to what it does TO a source.
 *
 * Not the walk, and it reproduces exactly one thing: the contract
 * `createAuthoredRun`'s docblock names, in `walk.ts`'s order:
 *
 * - a wait whose condition is not met breaks (`failWaitAt`); one that is met
 *   is put to the step's `onConditionMet` BEFORE it is counted, and a reason
 *   from it breaks the loop with that reason and the wait uncounted;
 * - a positioned step gets `onResolved` with the rect the walk measured after
 *   scrolling, and can still fail after it (`failAfterResolvedAt`, standing
 *   for a throw from `dispatchPath`, the shot or the verb) — a break with the
 *   step uncounted;
 * - only a counted step is followed by another pull, and `for await` finalizes
 *   the generator at its `yield` on every break, without resuming it.
 *
 * `reason` is the reason the double stopped for, so a test can tell which of
 * those breaks it was.
 */
async function walkThrough(
  source: WalkSource,
  opts: {
    /** The rect the walk re-measures after scrolling; null stands for a step
     *  the walk could not locate, which breaks the loop before `onResolved`. */
    scrolledRect?: (step: WalkStep, index: number) => Rect | null;
    /** The 0-based walk step whose wait times out. */
    failWaitAt?: number;
    /** The 0-based walk step that throws after `onResolved`. */
    failAfterResolvedAt?: number;
  } = {},
): Promise<{
  pulled: WalkStep[];
  completed: number;
  reason: ReplayStopReason | null;
}> {
  const pulled: WalkStep[] = [];
  let completed = 0;
  let reason: ReplayStopReason | null = null;
  for await (const step of source.steps()) {
    const index = pulled.length;
    pulled.push(step);
    if (step.action.kind === "waitFor") {
      if (opts.failWaitAt === index) {
        reason = "waitTimeout";
        break;
      }
      const refused = (await step.onConditionMet?.()) ?? null;
      if (refused !== null) {
        reason = refused;
        break;
      }
      completed += 1;
      continue;
    }
    // `??` would be wrong here: null is the answer this stands for, not the
    // absence of one.
    const rect = opts.scrolledRect
      ? opts.scrolledRect(step, index)
      : { x: 300, y: 200 + index * 50, width: 100, height: 40 };
    if (rect === null) {
      reason = "unresolvedAnchor";
      break;
    }
    await step.onResolved?.(rect, report(step));
    if (opts.failAfterResolvedAt === index) {
      reason = "portFailure";
      break;
    }
    completed += 1;
  }
  return { pulled, completed, reason };
}

/**
 * A finished walk, for the assembler. Only two fields of it are read, and both
 * are given values nothing else in this file could produce: `dpr: 3` is not
 * `REPLAY_DPR`, so a document reporting 3 got it from the run's counters.
 */
function walkedStub(over: Partial<ReplayResult> = {}): ReplayResult {
  const counters = { dpr: 3, viewportWidth: VIEWPORT.width } as ReplayCounters;
  return {
    bundle: null,
    outcome: "complete",
    completed: 0,
    total: 0,
    lastCompletedActionId: null,
    reason: null,
    degradations: [],
    storageRefused: false,
    hoverSensitive: false,
    counters,
    ...over,
  };
}

interface Driven {
  run: ReturnType<typeof createAuthoredRun>;
  captures: FakeCaptures;
  walk: Awaited<ReturnType<typeof walkThrough>>;
  deps: AuthoredDeps;
}

async function drive(
  script: DemoScript,
  opts: {
    captures?: ScriptedCapture[];
    navigatesAwayAfterCall?: number;
    failWaitAt?: number;
    failAfterResolvedAt?: number;
    scrolledRect?: (step: WalkStep, index: number) => Rect | null;
  } = {},
): Promise<Driven> {
  const clock = fakeClock();
  const captures = fakeCaptures(opts);
  const deps = fakeDeps({ clock, captureResolved: captures.captureResolved });
  const run = createAuthoredRun(script, deps, VIEWPORT);
  const walk = await walkThrough(run.source, opts);
  return { run, captures, walk, deps };
}

function assemble(
  script: DemoScript,
  driven: Driven,
  walked: ReplayResult = walkedStub(),
): ReturnType<typeof assembleAuthored> {
  return assembleAuthored(script, {
    sceneId: driven.deps.sceneId,
    createdAt: driven.deps.createdAt,
    viewport: VIEWPORT,
    actions: driven.run.actions,
    anchors: driven.run.anchors,
    walked,
    startingBranding: driven.deps.startingBranding,
    camera: driven.deps.cameraFor(driven.run.actions, VIEWPORT, () => 1),
  });
}

const script = (steps: DemoScript["steps"], name = "A script"): DemoScript => ({
  scriptVersion: 1,
  name,
  target: PAGE,
  steps,
});

const oneStepScript = (): DemoScript =>
  script([{ do: "click", on: { role: "button", name: "Checkout" } }]);

const fiveStepScript = (): DemoScript =>
  script(
    ["One", "Two", "Three", "Four", "Five"].map((name) => ({
      do: "click" as const,
      on: { role: "button", name },
    })),
  );

describe("the authored source and its assembler", () => {
  // film-check spec §1 (review focus 4): a take that opens on a scroll has no
  // journey before its first travelling step; that step starts from the
  // cursor's entry point, not from the scroll's anchor.
  it("starts the first travelling step from the entry point when a scroll opens the take", async () => {
    const driven = await drive(
      script([
        { do: "scrollTo", on: { stableId: "b" } },
        { do: "click", on: { stableId: "c" } },
      ]),
    );
    const [scroll, click] = driven.walk.pulled;
    const entry = cursorEntryPoint(
      { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 },
      VIEWPORT,
    );
    // The premise: two steps, and the entry point is neither the scroll's
    // centre (350, 220 + 50) nor anywhere a planner reading the scroll as a
    // stop could have put the start.
    expect(driven.walk.pulled.map((p) => p.action.kind)).toEqual([
      "scrollTo",
      "click",
    ]);
    expect(entry).not.toEqual({ x: 350, y: 220 });
    expect(entry).not.toEqual({ x: 350, y: 270 });

    expect(scroll?.segment).toBeUndefined();
    expect(
      click?.segment?.fromActionId,
      JSON.stringify(click?.segment),
    ).toBeNull();
    expect(click?.segment?.from, JSON.stringify(click?.segment)).toEqual(entry);
  });

  it("a press step needs no target and commits an action of kind press", async () => {
    const driven = await drive(
      script([
        { do: "press", key: "Enter" },
        { do: "click", on: { stableId: "c" }, at: { x: 0.25, y: 0.5 } },
      ]),
    );
    const [press, click] = driven.walk.pulled;
    expect(driven.walk.pulled.map((p) => p.action.kind)).toEqual([
      "press",
      "click",
    ]);
    expect(press?.target).toBeNull();
    expect(press?.action).toMatchObject({ key: "Enter", anchorId: null });
    expect(press?.segment).toBeUndefined();
    expect(driven.run.actions.map((a) => a.kind)).toEqual(["press", "click"]);
    // The click's spot is on the action, and the cursor is aimed at it: the
    // premise is a box whose spot is not its centre.
    const box = driven.captures.answers[0]?.anchor?.fingerprint
      .boundingRect as Rect;
    expect(box.width).toBeGreaterThan(0);
    expect(click?.action).toMatchObject({ at: { x: 0.25, y: 0.5 } });
    expect(click?.segment?.to, JSON.stringify(click?.segment)).toEqual({
      x: box.x + 0.25 * box.width,
      y: box.y + 0.5 * box.height,
    });
  });

  // A derived scroll carries where the author's scroll stopped; the walk can
  // only aim at it if the step it pulls carries it too. `synthesize` stays
  // rect-less — the landing is intent, not a measurement the run made.
  it("hands the walk a scroll's landing, and no rect it did not measure", async () => {
    const driven = await drive(
      script([
        { do: "scrollTo", on: { stableId: "b" }, landing: { top: 280 } },
        { do: "scrollTo", on: { stableId: "c" } },
        { do: "click", on: { stableId: "d" } },
      ]),
      // The rect the walk measures, deliberately not the landing's 280, so
      // the action's rect below can only have come from the measurement.
      { scrolledRect: () => ({ x: 300, y: 64, width: 100, height: 40 }) },
    );
    const [landed, centred, click] = driven.walk.pulled;
    // The premise: three steps pulled, the first two scrolls.
    expect(driven.walk.pulled.map((p) => p.action.kind)).toEqual([
      "scrollTo",
      "scrollTo",
      "click",
    ]);

    expect(landed?.landing).toEqual({ top: 280 });
    expect(landed?.action.rect).toEqual({
      x: 300,
      y: 64,
      width: 100,
      height: 40,
    });
    expect(centred?.landing).toBeUndefined();
    expect(click?.landing).toBeUndefined();
  });

  // film-check spec §1: a scroll is not a cursor stop, and the move after it
  // starts where the last travelling step left the cursor.
  it("plans no cursor move to a scroll, and plans the next one from before it", async () => {
    const driven = await drive(
      script([
        { do: "click", on: { stableId: "a" } },
        { do: "scrollTo", on: { stableId: "b" } },
        { do: "click", on: { stableId: "c" } },
      ]),
    );
    const [first, scroll, last] = driven.walk.pulled;
    // The premise: three steps, measured at three distinct places, so "from
    // the first click" and "from the scroll" are different points.
    expect(driven.walk.pulled.map((p) => p.action.kind)).toEqual([
      "click",
      "scrollTo",
      "click",
    ]);
    expect(first).toBeDefined();

    expect(scroll?.segment).toBeUndefined();
    // The first click was measured at y 200..240, the scroll at 250..290.
    expect(last?.segment?.from).toEqual({ x: 350, y: 220 });
    expect(last?.segment?.fromActionId).toBe(first?.action.id);
  });

  it("assembles a document whose anchors record what resolution measured", async () => {
    const authored = script([
      { do: "click", on: { role: "button", name: "Checkout" } },
      { do: "type", into: { stableId: "email" }, text: "ada@test" },
    ]);
    const driven = await drive(authored, {
      captures: [
        { strategy: "roleName", candidates: 2 },
        { strategy: "stableId", candidates: 1 },
      ],
    });

    // Premise, asserted: the page was asked once per resolving step, each
    // intent carried the ONE strategy its script step named, and the answers
    // it gave are the values below. An assembler that built anchors from the
    // script instead would never have called it, and could not have produced
    // `candidates: 2` from a script that says nothing about candidates.
    expect(driven.captures.calls).toHaveLength(2);
    expect(driven.captures.calls[0]?.fingerprint.role).toBe("button");
    expect(driven.captures.calls[0]?.fingerprint.stableId).toBeNull();
    expect(driven.captures.calls[1]?.fingerprint.stableId).toBe("email");
    expect(driven.captures.answers[0]?.anchor?.resolution.candidates).toBe(2);
    // And the page reported no step index for either, so an index below that
    // names the step is the RUN's own measurement.
    expect(driven.captures.answers[1]?.anchor?.resolution.actionIndex).toBe(0);

    const { document, error } = assemble(authored, driven);
    expect(error).toBeNull();
    expect(document).not.toBeNull();

    const [first, second] = document?.anchors ?? [];
    expect(first?.resolution.strategy).toBe("roleName");
    expect(first?.resolution.candidates).toBe(2);
    expect(second?.resolution.strategy).toBe("stableId");
    expect(first?.resolution.actionIndex).toBe(0);
    expect(second?.resolution.actionIndex).toBe(1);

    // A real v7 document, not a shape that merely looks like one.
    expect(SceneDocumentSchema.safeParse(document).success).toBe(true);
    expect(document?.meta.capture.mode).toBe("authored");
    // From the run's own counters, which is why the stub says 3.
    expect(document?.meta.capture.dpr).toBe(3);
    expect(document?.meta.capture.originClass).toBe("development");
  });

  // One intent per shape, each carrying that shape's field and nothing else.
  // Before `targetStrategy`, anything not a stableId or a role fell through to
  // `textContent: target.text` — so a `treePath` target would have asked the
  // page for an element whose text is undefined.
  it("asks the page with exactly the one strategy each target shape names", async () => {
    const authored = script([
      { do: "click", on: { stableId: "pay" } },
      { do: "click", on: { role: "button", name: "Pay" } },
      { do: "click", on: { text: "Pay" } },
      { do: "scrollTo", on: { treePath: "body:1/main:1/div:3" } },
    ]);
    const driven = await drive(authored, {
      captures: [
        { strategy: "stableId" },
        { strategy: "roleName" },
        { strategy: "text" },
        { strategy: "treePath" },
      ],
    });
    const set = (i: number): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(driven.captures.calls[i]?.fingerprint ?? {}).filter(
          ([, v]) => v !== null,
        ),
      );
    expect(driven.captures.calls).toHaveLength(4);
    expect(set(0)).toEqual({ stableId: "pay" });
    expect(set(1)).toEqual({ role: "button", accessibleName: "Pay" });
    expect(set(2)).toEqual({ textContent: "Pay" });
    expect(set(3)).toEqual({ treePath: "body:1/main:1/div:3" });
  });

  it("records no signal on a hover, because it witnessed no hover changing the page", async () => {
    const authored = script([
      { do: "click", on: { role: "button", name: "Pay" } },
      { do: "hover", on: { text: "Total" } },
    ]);
    const driven = await drive(authored);

    // Premise: `MoveTo.signal` is a field the schema really does accept, so its
    // absence below is this file's choice and not an impossibility. (A click's
    // `button` is a different matter: the SCRIPT format no longer has one —
    // see `scene-schema/test/script.test.ts` — so there is nothing here to
    // decline to copy.)
    const [click, hover] = driven.run.actions;
    expect(
      SceneDocumentSchema.safeParse({
        ...(assemble(authored, driven).document as SceneDocument),
        actions: [click, { ...hover, signal: "style" }],
      }).success,
    ).toBe(true);

    expect(click?.kind).toBe("click");
    expect(click && "button" in click).toBe(false);
    expect(hover?.kind).toBe("moveTo");
    expect(hover && "signal" in hover).toBe(false);
  });

  it("stamps strictly ascending timestamps across a pause and three load-present steps", async () => {
    // Premise: EVERY target is present on the page from the first instant —
    // the exact shape of 2026-09-26's bug, where a readiness wait stamped at
    // the moment its element appeared landed at the take's origin, stopped the
    // log ascending, and made `planScene` count the same dead air twice. The
    // wait is not first, so a stamp taken from anything but the clock lands
    // BEFORE the step above it. Asserted below the run, because a fixture that
    // quietly stopped supplying the elements would satisfy this trivially.
    const authored = script([
      { do: "click", on: { role: "button", name: "Go" } },
      { do: "waitFor", on: { text: "Ready" }, until: "visible" },
      { do: "pause", ms: 50 },
      { do: "click", on: { role: "button", name: "Finish" } },
    ]);
    const driven = await drive(authored);

    // The premise: three resolving steps, three capture calls, every one of
    // them answered with an anchor on its FIRST attempt — so the wait's
    // element was present before the wait, not found after it.
    expect(driven.captures.calls).toHaveLength(3);
    expect(driven.captures.answers.every((a) => a.anchor !== null)).toBe(true);

    const stamps = driven.run.actions.map((a) => a.timestamp);
    // Three actions, not four: `pause` is a duration and enters no log.
    expect(stamps).toHaveLength(3);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1] as number);
    }
    // And the pause is IN the axis: the gap across it is at least its own 50ms.
    expect(
      (stamps[2] as number) - (stamps[1] as number),
    ).toBeGreaterThanOrEqual(50);
    expect(stamps[0]).toBeGreaterThanOrEqual(0);
  });

  it("stops with a tie, not with 'gone', when a target matches several elements", async () => {
    const authored = oneStepScript();
    const driven = await drive(authored, {
      captures: [
        { strategy: "ambiguous", candidates: 4, failureReason: "ambiguousTie" },
      ],
    });

    // Premise: the page ANSWERED and resolved nothing — a populated intent
    // resolution with no anchor. That is a different fact from silence, and
    // the next test is the other side of it.
    expect(driven.captures.answers[0]?.anchor).toBeNull();
    expect(driven.captures.answers[0]?.intentResolution).not.toBeNull();

    expect(driven.run.stop()).toBe("ambiguousAnchor");
    expect(driven.walk.completed).toBe(0);
    // The number is the evidence the author acts on, and the document cannot
    // carry it: no step was performed, so there is no take.
    expect(assemble(authored, driven).document).toBeNull();
    const step = driven.run.steps[0];
    expect(step?.candidates).toBe(4);
    expect(step?.strategy).toBe("ambiguous");
    expect(step?.failureReason).toBe("ambiguousTie");
    expect(step?.anchorId).toBeNull();
  });

  it("a click waits for a target that renders 2 s late", async () => {
    // 150 ms polls from t=0: 14 misses reach 2100 ms of fake time, then it renders.
    const driven = await drive(oneStepScript(), {
      captures: [...absent().slice(0, 14), {}],
    });

    // Premise: it was absent for at least 2 s of the injected clock, then present.
    expect(
      driven.captures.answers.slice(0, 14).every((a) => a.anchor === null),
    ).toBe(true);
    expect(driven.captures.answers[14]?.anchor).not.toBeNull();
    expect(
      (driven.deps.clock as ReturnType<typeof fakeClock>).at() - 10_000,
    ).toBeGreaterThanOrEqual(2000);

    expect(driven.run.stop()).toBeNull();
    expect(driven.walk.completed).toBe(1);
  });

  it("a click stops with unresolvedAnchor after 10 s when the target never comes", async () => {
    const driven = await drive(oneStepScript(), { captures: absent() });

    expect(driven.run.stop()).toBe("unresolvedAnchor");
    // Premise: it asked many times and gave up on the clock, not on a count.
    expect(driven.captures.calls.length).toBeGreaterThan(50);
    expect(driven.captures.calls.length).toBeLessThan(100);
    expect(
      (driven.deps.clock as ReturnType<typeof fakeClock>).at() - 10_000,
    ).toBeGreaterThanOrEqual(10_000);
  });

  it("an ambiguous target stops at once, without waiting", async () => {
    const driven = await drive(oneStepScript(), {
      captures: [
        { strategy: "ambiguous", candidates: 4, failureReason: "ambiguousTie" },
      ],
    });

    expect(driven.run.stop()).toBe("ambiguousAnchor");
    expect(driven.captures.calls).toHaveLength(1);
    expect(
      (driven.deps.clock as ReturnType<typeof fakeClock>).at() - 10_000,
    ).toBeLessThan(1000);
  });

  it("a drag waits for its end target as for its start", async () => {
    const driven = await drive(
      script([
        {
          do: "drag",
          from: { on: { role: "button", name: "Card" } },
          to: { on: { role: "button", name: "Lane" } },
        } as never,
      ]),
      {
        captures: [
          {},
          { failureReason: "unresolved" },
          { failureReason: "unresolved" },
          {},
        ],
      },
    );

    expect(driven.captures.answers[1]?.anchor).toBeNull();
    expect(driven.captures.answers[3]?.anchor).not.toBeNull();
    expect(driven.captures.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps a silent page apart from a page that answered and found nothing", async () => {
    const driven = await drive(oneStepScript(), {
      captures: [{ failureReason: "pageSilent" }],
    });

    // Premise: no intent resolution at all, which is the one case no reply can
    // carry a reason for.
    expect(driven.captures.answers[0]?.intentResolution).toBeNull();

    expect(driven.run.stop()).toBe("pageSilent");
    const step = driven.run.steps[0];
    expect(step?.strategy).toBeNull();
    expect(step?.candidates).toBeNull();
    expect(step?.failureReason).toBe("pageSilent");
  });

  /**
   * And a page that FAULTED apart from both of those. Three answers, three
   * stop reasons, three different things to tell the author: check the app is
   * up (`pageSilent`), re-record the step (`unresolvedAnchor`), and look at
   * that page's own console (`pageFaulted`).
   *
   * The production change that reddens this: dropping `case "pageFaulted"`
   * from `stopForResolveFailure`, whose `default` is `unresolvedAnchor` — a
   * fault would then tell the author to re-record a step whose element may
   * still be there.
   */
  it("keeps a page that threw apart from a silent one and from a gone element", async () => {
    const driven = await drive(oneStepScript(), {
      captures: [{ failureReason: "pageFaulted" }],
    });

    // Premise: the page ANSWERED (so the URL is carried) and carried no intent
    // resolution, because the work that would have produced one threw.
    expect(driven.captures.answers[0]?.pageUrl).not.toBeNull();
    expect(driven.captures.answers[0]?.intentResolution).toBeNull();

    expect(driven.run.stop()).toBe("pageFaulted");
    expect(driven.run.stop()).not.toBe("pageSilent");
    expect(driven.run.stop()).not.toBe("unresolvedAnchor");
    const step = driven.run.steps[0];
    expect(step?.failureReason).toBe("pageFaulted");
    expect(step?.strategy).toBeNull();
    expect(step?.candidates).toBeNull();
    expect(step?.anchorId).toBeNull();
    // And the reason has a sentence of its own rather than printing raw:
    // `reasonSentence`'s fallback is the identifier, so a reason added without
    // a `REASON_TEXT` entry would read `Stopped: pageFaulted`.
    expect(reasonSentence("pageFaulted")).not.toBe("pageFaulted");
    expect(reasonSentence("pageFaulted")).toMatch(/threw/i);
  });

  it("reports that the page went somewhere else, rather than four missing elements", async () => {
    const authored = fiveStepScript();
    const driven = await drive(authored, { navigatesAwayAfterCall: 1 });

    // Premise: the second capture SUCCEEDED — it found an element and reported
    // it on a different page. So the stop below is a comparison between two
    // measurements, not a resolve failure wearing a different name.
    expect(driven.captures.answers[1]?.anchor).not.toBeNull();
    expect(driven.captures.answers[0]?.anchor?.resolution.url).toBe(PAGE);
    expect(driven.captures.answers[1]?.anchor?.resolution.url).toBe(OTHER_PAGE);

    expect(driven.run.stop()).toBe("pageWentElsewhere");
    expect(driven.walk.completed).toBe(1);
    // Two attempted steps, not five failures — and the second names the page
    // the run found itself on, which is what the author acts on.
    expect(driven.run.steps).toHaveLength(2);
    expect(driven.run.steps[1]?.pageUrl).toBe(OTHER_PAGE);
    expect(driven.run.steps[1]?.failureReason).toBeNull();
    // The step that never performed contributed no anchor and no action, so
    // the take holds exactly the one step the film shows.
    const { document } = assemble(authored, driven);
    expect(document?.anchors).toHaveLength(1);
    expect(document?.actions).toHaveLength(1);
  });

  const signInThenWait = (): DemoScript =>
    script([
      { do: "click", on: { role: "button", name: "Sign in" } },
      { do: "waitFor", on: { text: "Dashboard" }, until: "visible" },
      { do: "click", on: { role: "button", name: "New" } },
    ]);

  it("says the session went to another page, not that four elements are missing", async () => {
    // The expired-session shape, and the one `pageWentElsewhere` exists for:
    // the first step performs, the app redirects to a sign-in page, and the
    // script's remaining targets do not exist there at all — so every capture
    // FAILS and there is no anchor to compare pages with. The page the failure
    // itself happened on is the only witness.
    const authored = fiveStepScript();
    const driven = await drive(authored, {
      captures: [{}, ...absent()],
      navigatesAwayAfterCall: 1,
    });

    // Premise: the second capture produced NO anchor, and reported the page it
    // failed on — a different one from where the first step ran.
    expect(driven.captures.answers[1]?.anchor).toBeNull();
    expect(driven.captures.answers[1]?.pageUrl).toBe(OTHER_PAGE);
    expect(driven.captures.answers[0]?.anchor?.resolution.url).toBe(PAGE);
    // Premise: it failed once and was not retried (waiting cannot help on a
    // page the script is not on), so no anchor ever reached the page comparison.
    expect(driven.captures.calls).toHaveLength(2);
    expect(
      driven.captures.answers.every((a, i) => i === 0 || a.anchor === null),
    ).toBe(true);

    // Not `unresolvedAnchor`, which would send the author to re-record a step
    // that is fine, and not four of them.
    expect(driven.run.stop()).toBe("pageWentElsewhere");
    expect(driven.run.steps).toHaveLength(2);
    expect(driven.run.steps[1]?.pageUrl).toBe(OTHER_PAGE);
    expect(driven.walk.completed).toBe(1);
  });

  it("still says the element is gone when the page did not change", async () => {
    // The control for the case above: same failure, same script, same
    // everything except the page — which is what the reason turns on.
    const driven = await drive(fiveStepScript(), {
      captures: [{}, ...absent()],
    });

    expect(driven.captures.answers[1]?.pageUrl).toBe(PAGE);
    expect(driven.run.stop()).toBe("unresolvedAnchor");
  });

  it("does not claim a page change when the page never answered", async () => {
    // A silent page carries no URL, so there is nothing to compare — and
    // guessing a page change from silence would be exactly the fabrication
    // this door refuses. `pageSilent` stands.
    const driven = await drive(fiveStepScript(), {
      captures: [{}, { failureReason: "pageSilent" }],
      navigatesAwayAfterCall: 1,
    });

    expect(driven.captures.answers[1]?.pageUrl).toBeNull();
    expect(driven.run.stop()).toBe("pageSilent");
  });

  it("adopts the page a waitFor lands on, so a deliberate navigation is not a stop", async () => {
    // The realistic ordering: the page changes DURING the wait. The wait's own
    // first capture (call 1) still sees the old page, and the call after it
    // (call 2) is the first on the new one.
    const driven = await drive(signInThenWait(), {
      captures: [{}, { failureReason: "notInTree" }, {}, {}],
      navigatesAwayAfterCall: 2,
    });

    // Premise: the wait's element was NOT there before the wait and WAS there
    // after it, on a different page from the one the click ran on. That is the
    // navigation the script asked for.
    expect(driven.captures.answers[1]?.anchor).toBeNull();
    expect(driven.captures.answers[0]?.anchor?.resolution.url).toBe(PAGE);
    expect(driven.captures.answers[2]?.anchor?.resolution.url).toBe(OTHER_PAGE);

    expect(driven.run.stop()).toBeNull();
    expect(driven.walk.completed).toBe(3);
    expect(driven.run.actions).toHaveLength(3);
  });

  it("does not adopt a page from an element that was already there before the wait", async () => {
    // The shape that used to halt the run: "Dashboard" exists on the OLD page
    // too — a nav link — so the wait's first capture succeeds against the page
    // the click was leaving. That says nothing about where the page ended up,
    // so the run defers to the next capture rather than adopting it.
    const driven = await drive(signInThenWait(), { navigatesAwayAfterCall: 2 });

    // Premise: the wait resolved on its FIRST attempt, on the old page, and
    // the step after it resolves on a different one.
    expect(driven.captures.calls).toHaveLength(3);
    expect(driven.captures.answers[1]?.anchor?.resolution.url).toBe(PAGE);
    expect(driven.captures.answers[2]?.anchor?.resolution.url).toBe(OTHER_PAGE);

    // No stop: the author wrote the wait, and telling them to add the
    // `waitForLoad` they already wrote names no action they can take.
    expect(driven.run.stop()).toBeNull();
    expect(driven.run.actions).toHaveLength(3);
  });

  it("refuses a click it cannot dispatch instead of quietly clicking left", async () => {
    // `ScriptStepSchema` has no `button` and refuses one, so this is a step
    // only a caller that skipped the parse could hand over — which is exactly
    // what the backstop is for. The parse-time half is
    // `scene-schema/test/script.test.ts`; this is the second line.
    const looseClick = {
      do: "click",
      on: { role: "button", name: "Row" },
      button: "right",
    } as unknown as ScriptStep;
    const authored = script([
      { do: "click", on: { role: "button", name: "Row" } },
      looseClick,
    ]);
    const driven = await drive(authored);

    expect(driven.run.stop()).toBe("unperformableStep");
    // The refused step resolved nothing: the run did not even ask the page.
    expect(driven.captures.calls).toHaveLength(1);
    expect(driven.run.actions).toHaveLength(1);
    expect(driven.walk.completed).toBe(1);
  });

  it("captures a wait's element after the wait when it was not there before", async () => {
    const authored = script([
      { do: "waitFor", on: { text: "Ready" }, until: "visible" },
      { do: "click", on: { role: "button", name: "Go" } },
    ]);
    // The first attempt finds nothing; the second, after the wait, finds it.
    const driven = await drive(authored, {
      captures: [{ failureReason: "notInTree" }, {}, {}],
    });

    // Premise: the element really was absent on the first attempt and present
    // on the second, which is the whole shape this covers.
    expect(driven.captures.answers[0]?.anchor).toBeNull();
    expect(driven.captures.answers[1]?.anchor).not.toBeNull();
    expect(driven.captures.calls).toHaveLength(3);

    expect(driven.run.stop()).toBeNull();
    expect(driven.run.actions).toHaveLength(2);
    expect(driven.run.anchors).toHaveLength(2);
    const [wait] = driven.run.actions;
    expect(wait?.kind).toBe("waitFor");
    expect(wait?.anchorId).toBe(driven.run.anchors[0]?.id);
    // Stamped when the wait STARTED, which is what keeps the log ascending.
    expect(
      (wait?.timestamp ?? -1) < (driven.run.actions[1]?.timestamp ?? -1),
    ).toBe(true);
  });

  it("refuses a wait whose element is not there after it, before the walk counts it", async () => {
    const authored = script([
      { do: "click", on: { role: "button", name: "Save" } },
      { do: "waitFor", on: { text: "Saved" }, until: "visible" },
      { do: "click", on: { role: "button", name: "Next" } },
    ]);
    // The click's capture finds it; the wait's capture finds nothing before
    // the wait and nothing after it.
    const driven = await drive(authored, {
      captures: [
        {},
        { failureReason: "notInTree" },
        { failureReason: "notInTree" },
      ],
    });

    // Premise: the wait was captured on both sides of it and found neither
    // time, and the walk did pull it (and nothing after it).
    expect(driven.captures.calls).toHaveLength(3);
    expect(driven.captures.answers[1]?.anchor).toBeNull();
    expect(driven.captures.answers[2]?.anchor).toBeNull();
    expect(driven.walk.pulled).toHaveLength(2);

    // The source refused the wait through the walk's own hook, so the walk
    // stopped with the source's reason and never counted the wait.
    expect(driven.run.stop()).toBe("anchorNotRendered");
    expect(driven.walk.reason).toBe(driven.run.stop());
    expect(driven.walk.completed).toBe(1);
    // And the take holds exactly what the walk counted.
    expect(driven.run.actions.map((a) => a.kind)).toEqual(["click"]);
    expect(driven.run.steps[1]?.actionId).toBeNull();
    expect(driven.run.steps[1]?.marker).toBeNull();
  });

  it("commits nothing for a step that failed after the walk resolved it", async () => {
    const authored = script([
      { do: "click", on: { role: "button", name: "One" } },
      { do: "click", on: { role: "button", name: "Two" } },
    ]);
    const measured = { x: 640, y: 480, width: 120, height: 44 };
    const driven = await drive(authored, {
      scrolledRect: () => measured,
      failAfterResolvedAt: 1,
    });

    // Premise: the walk pulled and resolved the second click — the source was
    // handed its measured rect — and then stopped before counting it.
    expect(driven.walk.pulled).toHaveLength(2);
    expect(driven.walk.reason).toBe("portFailure");
    expect(driven.walk.completed).toBe(1);
    const captured =
      driven.captures.answers[1]?.anchor?.fingerprint.boundingRect;
    expect(captured).toBeDefined();
    expect(captured).not.toEqual(measured);

    // A step the walk never performed is not in the take.
    expect(driven.run.actions).toHaveLength(1);
    expect(driven.run.anchors).toHaveLength(1);
    expect(driven.run.madeFrom).toHaveLength(1);
    expect(driven.run.steps[1]?.actionId).toBeNull();
    expect(driven.run.steps[1]?.marker).toBeNull();
    // Its record keeps the page's rect: the walk's was never committed.
    expect(driven.run.steps[1]?.rect).toEqual(captured);
  });

  it("commits nothing for a wait the walk gave up on", async () => {
    const authored = script([
      { do: "waitFor", on: { text: "Ready" }, until: "visible" },
      { do: "click", on: { role: "button", name: "Go" } },
    ]);
    const driven = await drive(authored, { failWaitAt: 0 });

    // Premise: the walk did pull the wait and did not come back for the click.
    expect(driven.walk.pulled).toHaveLength(1);
    expect(driven.walk.completed).toBe(0);
    // So no action reached the document, and there is no take.
    expect(driven.run.actions).toHaveLength(0);
    expect(assemble(authored, driven).document).toBeNull();
    // And the wait's record names no marker: the walk broke before recording
    // one, so there is nothing for an identifier here to point at.
    expect(driven.run.steps[0]?.marker).toBeNull();
    // The walk owns this reason (`waitTimeout`); the source claims none.
    expect(driven.run.stop()).toBeNull();
  });

  it("commits nothing for a step the walk could not locate", async () => {
    const authored = script([
      { do: "click", on: { role: "button", name: "One" } },
      { do: "click", on: { role: "button", name: "Two" } },
    ]);
    const driven = await drive(authored, {
      scrolledRect: (_step, index) =>
        index === 1 ? null : { x: 1, y: 2, width: 3, height: 4 },
    });

    // Premise: the page DID capture an anchor for the second step, and the
    // walk then failed to locate it — so a missing second action proves the
    // commit waits for the walk's own measurement.
    expect(driven.captures.answers[1]?.anchor).not.toBeNull();
    expect(driven.run.actions).toHaveLength(1);
    expect(driven.run.anchors).toHaveLength(1);
    // The evidence the page gave is still on the record for that step.
    expect(driven.run.steps).toHaveLength(2);
    expect(driven.run.steps[1]?.actionId).toBeNull();
    expect(driven.run.steps[1]?.strategy).toBe("roleName");
    // And no marker: a marker names something the take HAS, and the walk broke
    // before it recorded one for this step. An identifier here would be one
    // Task 7 could not join to any action or any frame.
    expect(driven.run.steps[1]?.marker).toBeNull();
    // The step it DID perform has one.
    expect(driven.run.steps[0]?.marker).toBe("click:an-1");
  });

  it("writes the rect the walk measured, not the one the page captured", async () => {
    const authored = oneStepScript();
    const measured = { x: 640, y: 480, width: 120, height: 44 };
    const driven = await drive(authored, { scrolledRect: () => measured });

    // Premise: the page's own rect is a DIFFERENT one, so the assertion below
    // distinguishes the two sources.
    const captured =
      driven.captures.answers[0]?.anchor?.fingerprint.boundingRect;
    expect(captured).not.toEqual(measured);

    expect(driven.run.actions[0]?.rect).toEqual(measured);
    expect(driven.run.steps[0]?.rect).toEqual(measured);
    // The anchor keeps the first sighting's rect, as every other take does.
    expect(driven.run.anchors[0]?.fingerprint.boundingRect).toEqual(captured);
  });

  it("hands the walk the anchor it captured, not the intent that found it", async () => {
    const driven = await drive(oneStepScript());

    // Premise: the intent names one strategy and no tree path, and the anchor
    // the page captured from the element it found names one. The walk reads
    // that path for the frame hops that decide which execution context to look
    // in, so handing it the intent would send it to the top document for an
    // element inside an iframe.
    expect(driven.captures.calls[0]?.fingerprint.treePath).toBeNull();
    const captured = driven.captures.answers[0]?.anchor;
    expect(captured?.fingerprint.treePath).not.toBeNull();

    expect(driven.walk.pulled[0]?.target?.fingerprint.treePath).toBe(
      captured?.fingerprint.treePath,
    );
    // Same id either way, which is what the page parks the element under.
    expect(driven.walk.pulled[0]?.target?.id).toBe(
      driven.captures.calls[0]?.id,
    );
  });

  it("declares exactly as many steps as the source yields", async () => {
    const authored = script([
      { do: "click", on: { role: "button", name: "One" } },
      { do: "pause", ms: 20 },
      { do: "waitForLoad" },
      { do: "click", on: { role: "button", name: "Two" } },
    ]);
    const driven = await drive(authored);

    // `WalkConfig.total` is what `outcome` and every progress report are
    // measured against, so a source that yields a different number than it
    // declared misreports how far the run got.
    expect(authoredTotal(authored)).toBe(3);
    expect(driven.walk.pulled).toHaveLength(3);
    expect(driven.walk.completed).toBe(3);
    // Premise: the script really did contain a pause, so the 4-vs-3 is this
    // rule and not a miscount.
    expect(authored.steps).toHaveLength(4);
  });

  it("names two navigation waits apart", async () => {
    const authored = script([
      { do: "click", on: { role: "button", name: "One" } },
      { do: "waitForLoad" },
      { do: "click", on: { role: "button", name: "Two" } },
      { do: "waitForLoad" },
    ]);
    const driven = await drive(authored);

    const markers = driven.run.actions.map((a) => a.marker);
    expect(new Set(markers).size).toBe(markers.length);
    expect(markers).toContain("waitFor:document");
    expect(markers).toContain("waitFor:document#2");
  });

  it("records the log the frames were made from, by the compositor's own rule", async () => {
    const authored = script([
      { do: "click", on: { role: "button", name: "Pay" } },
      { do: "type", into: { stableId: "email" }, text: "ada@test" },
      { do: "waitForLoad" },
    ]);
    const driven = await drive(authored);
    const { document } = assemble(authored, driven);

    expect(document).not.toBeNull();
    // Written per step during the run, because an authored run has no document
    // until the walk is over — and equal, field for field, to what
    // `madeFromOf` reads off the finished one. This is what keeps the two
    // copies of that rule from drifting in silence.
    expect(driven.run.madeFrom).toEqual(
      madeFromOf(document as NonNullable<typeof document>),
    );
    expect(driven.run.madeFrom.map((m) => m.text)).toEqual([
      null,
      "ada@test",
      null,
    ]);
  });

  it("tags the take mutating, because no network log was collected", async () => {
    const authored = oneStepScript();
    const driven = await drive(authored);
    const { document } = assemble(authored, driven);

    // Fails closed, `finalize`'s rule: with no log we cannot know the run was
    // read-only, and guessing is the failure that double-submits a checkout.
    expect(document?.flags.mutating).toBe(true);
    expect(document?.sideChannels.network).toEqual([]);
    expect(document?.sideChannels.urlTrace).toEqual([]);
  });

  it("carries the walk's own hover verdict rather than the script's intent", async () => {
    const authored = script([{ do: "hover", on: { text: "Total" } }]);
    const driven = await drive(authored);

    // A script asking for a hover is not evidence that hovering changes the
    // page: the walk measures a repaint and says so.
    expect(assemble(authored, driven).document?.flags.hoverSensitive).toBe(
      false,
    );
    expect(
      assemble(authored, driven, walkedStub({ hoverSensitive: true })).document
        ?.flags.hoverSensitive,
    ).toBe(true);
  });

  it("assembles no take from a run that performed nothing, and says nothing failed to assemble", async () => {
    const authored = oneStepScript();
    const driven = await drive(authored, {
      captures: absent(),
    });
    const { document, error } = assemble(authored, driven);

    expect(driven.run.stop()).toBe("unresolvedAnchor");
    // A document with no performed step is not a take — and `error` is null
    // because nothing was refused: the two reasons a document can be absent
    // have to be tellable apart.
    expect(document).toBeNull();
    expect(error).toBeNull();
  });

  it("reports a take the schema refuses instead of handing back a silent null", async () => {
    const authored = oneStepScript();
    const driven = await drive(authored);
    // A duplicate anchor id is the shape the schema's own uniqueness check
    // exists for, and one an id generator that repeated itself would produce.
    const anchors = [
      ...driven.run.anchors,
      driven.run.anchors[0] as SceneAnchor,
    ];
    const { document, error } = assembleAuthored(authored, {
      sceneId: "take-1",
      createdAt: driven.deps.createdAt,
      viewport: VIEWPORT,
      actions: driven.run.actions,
      anchors,
      walked: walkedStub(),
      startingBranding: driven.deps.startingBranding,
      camera: driven.deps.cameraFor(driven.run.actions, VIEWPORT, () => 1),
    });

    expect(document).toBeNull();
    expect(error).toContain("duplicate anchor id");
    expect(error).toContain("1 performed step");
  });

  it("dresses the take from the script's look, and from the defaults otherwise", async () => {
    const plain = oneStepScript();
    const plainRun = await drive(plain);
    expect(assemble(plain, plainRun).document?.canvas.aspect).toBe("auto");
    expect(assemble(plain, plainRun).document?.cursor.hidden).toBe(false);

    const dressed: DemoScript = {
      ...oneStepScript(),
      look: { canvas: { aspect: "9:16" } },
    };
    const dressedRun = await drive(dressed);
    expect(assemble(dressed, dressedRun).document?.canvas.aspect).toBe("9:16");
  });
});

// A re-run of a take whose camera the author tuned came back on the
// defaults: `look` had no `motion`, so `scriptFromTake` dropped it and the
// assembler had nowhere to read one from (2026-10-09 review).
describe("a take's camera motion survives a derive and a re-run", () => {
  const TUNED = { smoothness: 0.2, blur: 0, follow: false };

  it("keeps the take's motion block from take to script to the new take", async () => {
    // Premise: the tuned block is not the defaults, so a document that fell
    // back to them could not pass for one that kept it.
    expect(TUNED).not.toEqual(MOTION_DEFAULTS);
    const take = SceneDocumentSchema.parse({
      ...JSON.parse(
        readFileSync(
          join(
            __dirname,
            "..",
            "..",
            "..",
            "scene-schema",
            "fixtures",
            "readonly-scene.json",
          ),
          "utf8",
        ),
      ),
      motion: TUNED,
    });
    const derived = scriptFromTake(take);
    if (derived.outcome !== "derived") {
      throw new Error(`expected derived, got ${derived.outcome}`);
    }
    const parsed = DemoScriptSchema.safeParse(derived.draft);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    const rerun = parsed.data;
    // Premise: the re-run performs steps, so the assembler has a take to make.
    expect(rerun.steps.length).toBeGreaterThan(0);

    const { document, error } = assemble(rerun, await drive(rerun));
    expect(error).toBeNull();
    expect(document?.motion).toEqual(TUNED);
  });

  it("writes no motion block for a script that names none", async () => {
    const plain = oneStepScript();
    expect(plain.look, "premise: the script names no look").toBeUndefined();
    const { document } = assemble(plain, await drive(plain));
    expect(document).not.toBeNull();
    expect(document?.motion).toBeUndefined();
  });
});

describe("a take's starting look comes from the caller", () => {
  it("takes the caller's branding when the script names none", async () => {
    const authored = script([{ do: "click", on: { stableId: "go" } }]);
    expect(authored.look, "premise: the script names no look").toBeUndefined();
    const { document } = assemble(authored, await drive(authored));
    expect(KIT).not.toEqual(BRANDING_DEFAULTS); // premise: the kit is not the default
    expect(document?.branding).toEqual(KIT);
  });

  it("starts an agent's take on the Auto frame when the script names no canvas", async () => {
    const authored = script([{ do: "click", on: { stableId: "go" } }]);
    expect(authored.look, "premise: the script names no look").toBeUndefined();
    const { document } = assemble(authored, await drive(authored));
    expect(document?.canvas).toEqual({ aspect: "auto" });
  });

  it("keeps the script's own branding over the caller's", async () => {
    const own: SceneBranding = {
      background: { kind: "solid", color: "#00aa55" },
      logo: null,
      padding: 0.08,
    };
    const authored = {
      ...script([{ do: "click", on: { stableId: "go" } }]),
      look: { branding: own },
    };
    const { document } = assemble(authored, await drive(authored));
    expect(document?.branding).toEqual(own);
  });

  it("carries the camera the caller computed from the performed actions", async () => {
    const authored = script([{ do: "click", on: { stableId: "go" } }]);
    const driven = await drive(authored);
    expect(
      driven.run.actions.filter((a) => a.kind === "click"),
      "premise: the run performed a click",
    ).toHaveLength(1);
    const { document } = assemble(authored, driven);
    expect(document?.camera).toEqual(
      driven.deps.cameraFor(driven.run.actions, VIEWPORT, () => 1).camera,
    );
    expect(document?.camera).toHaveLength(1);
  });

  // The take notes read the skips off the document, so an agent's take has
  // to carry them as a recorded one does. Red without the `zoomsSkipped`
  // spread in `assembleAuthored`: the camera arrives and the reasons do not.
  it("carries the clicks the caller's camera left out, with their reasons", async () => {
    const authored = script([
      { do: "click", on: { stableId: "go" } },
      { do: "click", on: { stableId: "go" } },
    ]);
    const driven = await drive(authored);
    const [first, second] = driven.run.actions;
    if (!first || !second)
      throw new Error("premise: the run performed two clicks");
    const plan = {
      camera: driven.deps.cameraFor([first], VIEWPORT, () => 1).camera,
      zoomsSkipped: [
        {
          actionId: second.id,
          reason: "sameTarget" as const,
          afterActionId: first.id,
          gapMs: 300,
        },
      ],
    };
    const { document, error } = assembleAuthored(authored, {
      sceneId: driven.deps.sceneId,
      createdAt: driven.deps.createdAt,
      viewport: VIEWPORT,
      actions: driven.run.actions,
      anchors: driven.run.anchors,
      walked: walkedStub(),
      startingBranding: driven.deps.startingBranding,
      camera: plan,
    });
    expect(error).toBeNull();
    expect(document?.camera).toHaveLength(1);
    expect(document?.zoomsSkipped).toEqual(plan.zoomsSkipped);
  });
});

describe("typing into a credential field", () => {
  const typing = () =>
    script([{ do: "type", into: { stableId: "pw" }, text: "hunter2-demo" }]);

  it("stores the action redacted with no text, while the walk still types it", async () => {
    const authored = typing();
    const driven = await drive(authored, {
      captures: [{ credentialField: true }],
    });
    // Premise: the page said this field is a credential.
    expect(driven.captures.answers[0]?.credentialField).toBe(true);
    // The walk is still handed the value to type.
    expect(driven.walk.pulled[0]?.text).toBe("hunter2-demo");
    const action = driven.run.actions[0];
    expect(action).toMatchObject({ kind: "type", text: null, redacted: true });
    expect(driven.run.madeFrom[0]?.text).toBeNull();
    expect(driven.run.steps[0]?.textHidden).toBe("credentialField");
    const { document } = assemble(authored, driven);
    expect(JSON.stringify(document)).not.toContain("hunter2-demo");
  });

  it("hides it too when the page could not say, and says why", async () => {
    const driven = await drive(typing(), {
      captures: [{ credentialField: null }],
    });
    // Premise: the page answered "could not tell", not nothing.
    expect(driven.captures.answers[0]?.credentialField).toBeNull();
    expect(driven.run.actions[0]).toMatchObject({ text: null, redacted: true });
    expect(driven.run.steps[0]?.textHidden).toBe("credentialUnchecked");
  });

  it("keeps an ordinary field's text, and a port that does not check keeps today's behaviour", async () => {
    for (const credentialField of [false, undefined]) {
      const driven = await drive(typing(), {
        captures: [credentialField === undefined ? {} : { credentialField }],
      });
      expect(driven.run.actions[0]).toMatchObject({
        text: "hunter2-demo",
        redacted: false,
      });
      expect(driven.run.steps[0]?.textHidden ?? null).toBeNull();
    }
  });

  it("hides a type step whose capture failed, when the port checks", async () => {
    const driven = await drive(typing(), {
      captures: absent({ credentialField: null }),
    });
    // Premise: the capture found nothing, so no action was written for it.
    expect(driven.captures.answers[0]?.anchor).toBeNull();
    expect(driven.captures.answers[0]?.credentialField).toBeNull();
    expect(driven.run.actions).toHaveLength(0);
    expect(driven.run.steps[0]?.textHidden).toBe("credentialUnchecked");
  });

  it("leaves a failed type step's text alone when the port does not check", async () => {
    const driven = await drive(typing(), { captures: absent() });
    expect(driven.captures.answers[0]?.anchor).toBeNull();
    // Premise: it stayed failed to the end, so the step never performed.
    expect(driven.captures.answers.every((a) => a.anchor === null)).toBe(true);
    expect(driven.run.actions).toHaveLength(0);
    expect(driven.captures.answers[0]?.credentialField).toBeUndefined();
    expect(driven.run.steps[0]?.textHidden ?? null).toBeNull();
  });

  it("hides a credential step that then stops the run on another page", async () => {
    const driven = await drive(
      script([
        { do: "click", on: { role: "button", name: "Next" } },
        { do: "type", into: { stableId: "pw" }, text: "hunter2-demo" },
      ]),
      { navigatesAwayAfterCall: 1, captures: [{}, { credentialField: true }] },
    );
    // Premise: the second capture succeeded on a different page, so the run
    // stopped at the page comparison, after the capture.
    expect(driven.captures.answers[1]?.anchor?.resolution.url).toBe(OTHER_PAGE);
    expect(driven.run.stop()).toBe("pageWentElsewhere");
    expect(driven.run.steps[1]?.textHidden).toBe("credentialField");
  });
});

// Spec 2026-10-19 (unhurried beats): the take's zooms are decided on time
// with the room the replay added taken out, so waiting never makes a zoom.
describe("unwaitedActions", () => {
  const act = (id: string, timestamp: number) =>
    ({ id, kind: "click", timestamp }) as unknown as SceneAction;

  it("takes out every room added up to and including each step's own", () => {
    const actions = [act("a", 1000), act("b", 4000), act("c", 5000)];
    const out = unwaitedActions(actions, [
      { actionId: "a", sourceTimeMs: 1000 },
      { actionId: "b", sourceTimeMs: 4000, roomMs: 1500 },
      { actionId: "c", sourceTimeMs: 5000, roomMs: 400 },
    ]);
    expect(out.map((a) => [a.id, a.timestamp])).toEqual([
      ["a", 1000],
      ["b", 2500],
      ["c", 3100],
    ]);
  });

  it("leaves the take's own actions as they were", () => {
    const actions = [act("a", 4000)];
    unwaitedActions(actions, [
      { actionId: "a", sourceTimeMs: 4000, roomMs: 900 },
    ]);
    expect(actions[0]?.timestamp).toBe(4000);
  });
});

// Final review I1 (2026-10-19): the page's zoom at a click is read on the
// clock the transforms were recorded on, the real one, while the zoom
// decision reads the un-waited time.
describe("cameraInputs", () => {
  it("reads the page's zoom at a click's real time, not its un-waited one", () => {
    const click = {
      id: "c",
      kind: "click",
      timestamp: 5000,
    } as unknown as SceneAction;
    const { actions, scaleAt } = cameraInputs(
      [click],
      [{ actionId: "c", sourceTimeMs: 5000, roomMs: 1500 }],
      [
        { sourceTimeMs: 0, scale: 1, offsetX: 0, offsetY: 0 },
        { sourceTimeMs: 4000, scale: 0.4, offsetX: 0, offsetY: 0 },
      ],
    );
    // Premise: the un-waited time falls before the page that zoomed out.
    expect(actions[0]?.timestamp).toBe(3500);
    expect(scaleAt(actions[0] as SceneAction)).toBe(0.4);
  });
});

// Code review 2026-10-20 (R6): the walk decides whether a click zooms on a
// predicted time and the page zoom it read then; the take re-decided on the
// marker minus room and the zoom at the marker, which can differ by tens of
// ms near MIN_ZOOM_GAP_MS. The take now decides on what the walk decided on.
describe("cameraInputs, given the walk's decisions", () => {
  it("hands the take the time and scale each click was decided on", () => {
    const click = {
      id: "c",
      kind: "click",
      timestamp: 5000,
    } as unknown as SceneAction;
    const type = {
      id: "t",
      kind: "type",
      timestamp: 3000,
    } as unknown as SceneAction;
    const { actions, scaleAt } = cameraInputs(
      [type, click],
      [
        { actionId: "t", sourceTimeMs: 3000 },
        { actionId: "c", sourceTimeMs: 5000, roomMs: 1500 },
      ],
      [{ sourceTimeMs: 0, scale: 1, offsetX: 0, offsetY: 0 }],
      new Map([["c", { unwaitedMs: 3480, scale: 0.4 }]]),
    );
    // Premise: marker minus room would say otherwise.
    expect(5000 - 1500).not.toBe(3480);
    expect(actions.map((a) => [a.id, a.timestamp])).toEqual([
      ["t", 3000],
      ["c", 3480],
    ]);
    expect(scaleAt(actions[1] as SceneAction)).toBe(0.4);
    expect(scaleAt(actions[0] as SceneAction)).toBe(1);
  });
});
