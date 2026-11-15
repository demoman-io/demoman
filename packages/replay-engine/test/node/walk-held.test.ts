import { validateBundle } from "@demoman/compositor";
import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  type SceneAnchor,
} from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import { HELD_SCROLL_MS } from "../../src/constants.js";
import { HELD_FRAME_MS } from "../../src/held-clock.js";
import type {
  AuthoredDeps,
  AuthoredResult,
  EngineDeps,
  HeldClock,
  HeldFrame,
  PageAgent,
  ReplayProgress,
  RoomPolicy,
} from "../../src/index.js";
import {
  decodeBase64,
  HELD_SCROLL_MARKER,
  HELD_SCROLL_STEP,
  runAuthored,
  SCROLL_MARKER,
  SETTLE_MS,
  STEP_SETTLE_MARKER,
  TAKE_TAIL_MS,
} from "../../src/index.js";
import type { BeatRules } from "../../src/walk.js";
import { createCdpFake, fakeScreenshotBase64 } from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";

/**
 * The walk on a held page clock (held-clock spec §1-§3): the held clock is
 * its clock, its frames are the take's, and the beat plan is played as page
 * time rather than handed to the renderer.
 */

const PAGE = "https://app.example.com/";
/** Not SETTLE_MS (300), so an arrive played as the settle is told apart. */
const ARRIVE = 400;
const BASE = 700;
const OPENING = 800;
/** Not TAKE_TAIL_MS, the floor an unplanned walk records, so the two are told apart. */
const TAIL = 1700;
/** The held clock's time when the walk starts: not 0, so the walk's own
 *  time (from its start) and the clock's are told apart. */
const START = 5000;
/** On the clock's time, as `HeldClock` answers them. */
const NETWORK = [
  { startMs: START + 400, endMs: START + 900, label: "POST /api/chat" },
];
const UNPINNED = [{ atMs: START + 40, what: "spin on div: refused" }];
const IGNORED = ["GET /poll"];

const restBefore = vi.fn<BeatRules["restBefore"]>(
  ({ first, pauseMs }) => (first ? OPENING : BASE) + pauseMs,
);
const RULES: BeatRules = {
  restBefore,
  afterScroll: () => ARRIVE,
  actMs: () => 0,
  tailMs: ({ pauseMs }) => TAIL + pauseMs,
  arriveMs: ARRIVE,
};

/** Never zooms: the rests stay the base, and the act end is the verb's. */
const ROOM: RoomPolicy = {
  neededMs: () => 0,
  returnShortMs: () => 0,
  arrives: () => "return",
  zooms: () => false,
  settledAfterMs: (heldUntil) => heldUntil,
};

/** A frame: a marker-only JPEG with `n` after it. */
const frameBytes = (n: number): Uint8Array => {
  const head = decodeBase64(fakeScreenshotBase64());
  const bytes = new Uint8Array(head.length + 2);
  bytes.set(head);
  bytes[head.length] = n >> 8;
  bytes[head.length + 1] = n & 0xff;
  return bytes;
};

/** A held clock with no browser behind it: `sleep` moves page time and
 *  files one frame per `HELD_FRAME_MS` on the grid, as the real one does.
 *  `look` is what the page shows (default: a new picture every frame);
 *  `moved` is told the time after every frame and every sleep. */
function fakeHeld(o: {
  look?: () => number;
  moved?: (now: number) => void;
  network: { startMs: number; endMs: number; label: string }[];
  /** The page call each captured frame makes (the pin): a page's answer
   *  sent before it arrives before it, as on one CDP session. */
  roundTrip?: () => Promise<unknown>;
}) {
  let now = START;
  const listeners: ((frame: HeldFrame) => Promise<void>)[] = [];
  const frames: HeldFrame[] = [];
  const clock: HeldClock = {
    now: () => now,
    hold: async () => undefined,
    rehold: async () => undefined,
    onFrame: (listener) => {
      listeners.push(listener);
    },
    networkSpans: () => o.network.map((s) => ({ ...s })),
    unpinned: () => UNPINNED.map((u) => ({ ...u })),
    ignoredConnections: () => [...IGNORED],
    sleep: async (ms) => {
      const end = now + ms;
      for (;;) {
        const next =
          (Math.floor(now / HELD_FRAME_MS + 1e-6) + 1) * HELD_FRAME_MS;
        if (next > end + 1e-6) break;
        now = next;
        await o.roundTrip?.();
        if (listeners.length === 0)
          throw new Error("a frame was captured with no frame listener");
        const frame = {
          sourceTimeMs: now,
          bytes: frameBytes(o.look?.() ?? frames.length + 1),
          width: 1280,
          height: 800,
        };
        frames.push(frame);
        for (const listener of listeners) await listener(frame);
        o.moved?.(now);
      }
      now = end;
      o.moved?.(now);
    },
  };
  return { clock, frames };
}

const anchorFor = (intent: AnchorIntent): SceneAnchor => ({
  id: intent.id,
  fingerprint: {
    ...intent.fingerprint,
    boundingRect: { x: 10, y: 20, width: 100, height: 40 },
  },
  resolution: {
    url: PAGE,
    actionIndex: 0,
    entryState: false,
    strategy: "stableId",
    failureReason: null,
    candidates: 1,
  },
});

async function run(
  steps: DemoScript["steps"],
  opts: {
    /** Real ms every CDP call and page resolve takes: a slower machine. */
    realDelayMs?: number;
    recording?: EngineDeps["recording"];
    encoder?: Partial<EngineDeps["encoder"]>;
    /** The page changes only when clicked, so frames repeat between acts. */
    stillBetweenActs?: boolean;
    /** The first click starts a load that runs this long in page time: the
     *  step's settle waits it out. */
    loadAfterFirstClickMs?: number;
    /** That load waits on the server: the clock reports it as network time,
     *  as a real held clock does for a stretch it followed real time. */
    loadIsNetwork?: boolean;
    /** Network stretches the clock reports, on its own time. */
    network?: { startMs: number; endMs: number; label: string }[];
    /** A request that opens 100 ms of page time after the first click and
     *  closes this much later, reported as network time when page time
     *  reaches it: inside the next step's rest. */
    networkInRestMs?: number;
    /** The same request, opening 100 ms after the walk's scroll ends:
     *  inside the scrolled step's after-scroll. */
    networkAfterScrollMs?: number;
    /** The step-settle probe waits on the page's timers: it answers only
     *  once this much page time has passed since it was asked (null: never). */
    settleAnswersAfterMs?: number | null;
    /** The click's read answers only once this much page time has passed
     *  (a click that navigated to another site). */
    clickReadAnswersAfterMs?: number;
    /** The first click starts a document load no `Page.frameStartedLoading`
     *  announces, this long in page time: the document says "loading", and
     *  Chrome holds a pointer move sent meanwhile until it has loaded. */
    unannouncedLoadMs?: number;
    /** While that load runs, asking the document fails (it is leaving, or
     *  the next one is not there yet). */
    documentUnreachableWhileLoading?: boolean;
  } = {},
) {
  const cdp = createCdpFake();
  let clicks = 0;
  /** When the unannounced load after the first click ends, in page time. */
  let loadedAt: number | null = null;
  const loading = () => loadedAt !== null && held.clock.now() < loadedAt;
  let loadingUntil: number | null = null;
  const network = [...(opts.network ?? [])];
  let restRequestAt: number | null = null;
  /** Settle probes waiting on page time, answered as it passes. */
  const settleWaiters: { due: number; answer: () => void }[] = [];
  const held = fakeHeld({
    ...(opts.stillBetweenActs === true ? { look: () => clicks } : {}),
    roundTrip: () => cdp.send("Runtime.evaluate", { expression: "0" }),
    network,
    moved: (now) => {
      if (restRequestAt !== null && now >= restRequestAt) {
        network.push({
          startMs: restRequestAt,
          endMs:
            restRequestAt +
            (opts.networkInRestMs ?? opts.networkAfterScrollMs ?? 0),
          label: "GET /beacon",
        });
        restRequestAt = null;
      }
      for (const w of settleWaiters.filter((w) => now >= w.due)) {
        settleWaiters.splice(settleWaiters.indexOf(w), 1);
        w.answer();
      }
      if (loadingUntil === null) return;
      const open = network.at(-1);
      if (opts.loadIsNetwork === true && open !== undefined)
        open.endMs = Math.min(now, loadingUntil);
      if (now >= loadingUntil) {
        loadingUntil = null;
        cdp.emit("Page.frameStoppedLoading", { frameId: "top" });
      }
    },
  });
  const delay = () =>
    new Promise<void>((resolve) => setTimeout(resolve, opts.realDelayMs ?? 0));
  /** stableId by anchor id: "b" sits 400 px right of "a", and "far" 2000 px
   *  below the fold until the walk scrolls to it. */
  const stableOf = new Map<string, string>();
  let belowFold = false;
  /** Each step of the walk's own scroll, as asked of the page, and the
   *  objects the plan and its steps were asked of. */
  const scrollSteps: number[] = [];
  const scrollAsked: { plan: string[]; steps: string[] } = {
    plan: [],
    steps: [],
  };
  const send = cdp.send.bind(cdp);
  /** How each settle probe was sent. */
  const probeSends: unknown[] = [];
  cdp.send = async (method, params, options) => {
    if (opts.realDelayMs !== undefined) await delay();
    if (
      method === "Runtime.evaluate" &&
      /__demomanStepSettle|__demomanSettlePaint/.test(
        String(params?.expression ?? ""),
      )
    )
      probeSends.push(options);
    if (
      method === "Runtime.callFunctionOn" &&
      String(params?.functionDeclaration ?? "").includes(HELD_SCROLL_MARKER)
    ) {
      scrollAsked.plan.push(String(params?.objectId));
      return {
        result: { type: "object", value: { movedPx: belowFold ? 2000 : 0 } },
      };
    }
    const expression = String(params?.expression ?? "");
    if (
      method === "Runtime.callFunctionOn" &&
      params?.functionDeclaration === HELD_SCROLL_STEP
    ) {
      const p = Number(
        (params.arguments as { value?: unknown }[] | undefined)?.[0]?.value,
      );
      scrollSteps.push(p);
      scrollAsked.steps.push(String(params.objectId));
      if (p === 1) belowFold = false;
      if (p === 1 && opts.networkAfterScrollMs !== undefined)
        restRequestAt = held.clock.now() + 100;
      return { result: { type: "undefined" } };
    }
    if (method === "Runtime.evaluate" && expression === "document.readyState") {
      if (loading() && opts.documentUnreachableWhileLoading === true)
        throw new Error("Cannot find context with specified id");
      return {
        result: { type: "string", value: loading() ? "loading" : "complete" },
      };
    }
    if (
      loading() &&
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseMoved"
    ) {
      return new Promise((resolve) =>
        settleWaiters.push({
          due: loadedAt ?? 0,
          answer: () => resolve(send(method, params)),
        }),
      );
    }
    if (
      opts.clickReadAnswersAfterMs !== undefined &&
      method === "Runtime.callFunctionOn" &&
      String(params?.functionDeclaration ?? "").includes("this.read()")
    ) {
      const after = opts.clickReadAnswersAfterMs;
      return new Promise((resolve) =>
        settleWaiters.push({
          due: held.clock.now() + after,
          answer: () => resolve(send(method, params)),
        }),
      );
    }
    if (
      method === "Runtime.evaluate" &&
      expression.includes(STEP_SETTLE_MARKER) &&
      opts.settleAnswersAfterMs !== undefined
    ) {
      const after = opts.settleAnswersAfterMs;
      if (after === null) return new Promise<never>(() => undefined);
      return new Promise((resolve) =>
        settleWaiters.push({
          due: held.clock.now() + after,
          answer: () => resolve(send(method, params)),
        }),
      );
    }
    if (
      method === "Runtime.callFunctionOn" &&
      String(params?.functionDeclaration ?? "").includes(SCROLL_MARKER)
    ) {
      belowFold = false;
      return {
        result: { type: "object", value: { settled: true, movedPx: 2000 } },
      };
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseReleased"
    ) {
      clicks++;
      if (clicks === 1 && opts.unannouncedLoadMs !== undefined)
        loadedAt = held.clock.now() + opts.unannouncedLoadMs;
      if (clicks === 1 && opts.networkInRestMs !== undefined)
        restRequestAt = held.clock.now() + 100;
      if (clicks === 1 && opts.loadAfterFirstClickMs !== undefined) {
        const from = held.clock.now();
        loadingUntil = from + opts.loadAfterFirstClickMs;
        if (opts.loadIsNetwork === true)
          network.push({ startMs: from, endMs: from, label: "GET /slow" });
        cdp.emit("Page.frameStartedLoading", { frameId: "top" });
      }
    }
    if (method === "DOM.getBoxModel") {
      const anchorId = String(params?.objectId ?? "").split(":")[1] ?? "";
      const reply = (await send(method, params)) as {
        model: { border: number[]; content: number[] };
      };
      const stable = stableOf.get(anchorId);
      const dx = stable === "b" ? 400 : 0;
      const dy = stable === "far" && belowFold ? 2000 : 0;
      const move = (q: number[]) =>
        q.map((v, i) => v + (i % 2 === 0 ? dx : dy));
      return {
        model: {
          border: move(reply.model.border),
          content: move(reply.model.content),
        },
      };
    }
    return send(method, params);
  };
  const page: PageAgent = {
    resolve: async (anchors) => {
      if (opts.realDelayMs !== undefined) await delay();
      return anchors.map((a) => {
        const found = a.fingerprint.stableId !== "gone";
        return {
          anchorId: a.id,
          strategy: found ? ("stableId" as const) : ("broken" as const),
          resolved: found,
          failureReason: null,
        };
      });
    },
  };
  const store = createMemoryFrameStore();
  const progress: ReplayProgress[] = [];
  const push = vi.fn(async () => undefined);
  let n = 0;
  const deps: AuthoredDeps = {
    cdp,
    page,
    encoder: {
      openSpan: vi.fn(),
      push,
      closeSpan: vi.fn(async () => null),
      queueDepth: () => 0,
      heapFraction: () => 0.1,
      ...opts.encoder,
    } as EngineDeps["encoder"],
    store,
    clock: {
      now: () => {
        throw new Error("the real clock was read on a held take");
      },
      sleep: async () => {
        throw new Error("the real clock was slept on a held take");
      },
    },
    held: held.clock,
    mayReplay: true,
    recording: opts.recording ?? "continuous",
    beats: RULES,
    onProgress: (p) => progress.push(p),
    captureResolved: async (intent) => {
      if (opts.realDelayMs !== undefined) await delay();
      const stable = String(intent.fingerprint.stableId);
      stableOf.set(intent.id, stable);
      if (stable === "far") belowFold = true;
      return stable === "gone"
        ? {
            anchor: null,
            failureReason: "unresolved",
            intentResolution: null,
            pageUrl: null,
          }
        : {
            anchor: anchorFor(intent),
            failureReason: null,
            intentResolution: {
              strategy: "stableId",
              candidates: 1,
              failureReason: null,
            },
            pageUrl: null,
          };
    },
    newId: (prefix) => `${prefix}-${++n}`,
    sceneId: "held",
    createdAt: "2026-11-15T09:00:00.000Z",
    viewport: { width: 1280, height: 800 },
    startingBranding: BRANDING_DEFAULTS,
    roomFor: () => ROOM,
    cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
  };
  restBefore.mockClear();
  const result = await runAuthored(
    { scriptVersion: 8, name: "held", target: PAGE, steps },
    deps,
  );
  const journeys = restBefore.mock.calls.map(([i]) => i.journeyMs);
  return {
    result,
    cdp,
    frames: held.frames,
    store,
    progress,
    journeys,
    push,
    scrollSteps,
    scrollAsked,
    probeSends,
  };
}

const evidenceOf = (result: AuthoredResult, progress: ReplayProgress[] = []) =>
  JSON.stringify({
    outcome: result.outcome,
    reason: result.reason,
    failed: progress.filter((p) => p.state === "failed").map((p) => p.note),
    markers: result.bundle?.markers,
    keyframes: result.bundle?.keyframes.map((k) => [
      k.sourceTimeMs,
      k.actionId,
    ]),
    screens: result.bundle?.pageScreens?.map((s) => s.sourceTimeMs),
  });

const markerOf = (result: AuthoredResult, index: number) => {
  const id = result.steps[index]?.actionId;
  const marker = result.bundle?.markers.find((m) => m.actionId === id);
  if (marker === undefined) throw new Error(evidenceOf(result));
  return marker;
};

/** A counted step's act end; throws with the evidence when it has none. */
const actEndOf = (result: AuthoredResult, index: number): number => {
  const end = markerOf(result, index).actEndSourceTimeMs;
  if (end === undefined) throw new Error(evidenceOf(result));
  return end;
};

const click = (stableId: string) =>
  ({ do: "click", on: { stableId } }) as const;

describe("the walk on a held clock", () => {
  it("starts no screencast and no recorder", async () => {
    const { result, cdp, frames, progress } = await run([click("a")]);
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    // Premise: the take was filmed, on held frames.
    expect(frames.length, evidence).toBeGreaterThan(0);
    const methods = cdp.calls.map((c) => c.method);
    expect(methods).not.toContain("Page.startScreencast");
    expect(methods).not.toContain("Page.stopScreencast");
  });

  // Red if the walk sleeps SETTLE_MS instead of the arrive, sleeps no rest,
  // or plays the journey past its planned length.
  it("plays the planned rest and arrive as page time", async () => {
    const { result, journeys, progress } = await run([click("a"), click("b")]);
    const evidence = `${evidenceOf(result, progress)} ${JSON.stringify(journeys)}`;
    expect(result.outcome, evidence).toBe("complete");
    const first = markerOf(result, 0);
    const second = markerOf(result, 1);
    // Premise: the second click travels, on a journey that is not a whole
    // number of frames (so one played a frame at a time overruns it).
    const journeyMs = journeys.at(-1) ?? 0;
    expect(journeyMs, evidence).toBeGreaterThan(0);
    const frames = journeyMs / HELD_FRAME_MS;
    expect(Math.abs(frames - Math.round(frames)), evidence).toBeGreaterThan(
      0.01,
    );
    const actEnd = actEndOf(result, 0);
    const rest = RULES.restBefore({
      first: false,
      pauseMs: 0,
      roomMs: 0,
      journeyMs,
    });
    expect(rest).toBe(BASE);
    expect(ARRIVE).not.toBe(SETTLE_MS);
    expect(second.sourceTimeMs - actEnd, evidence).toBeCloseTo(
      rest + journeyMs + ARRIVE,
      6,
    );
    // The journey sets off once the rest is over.
    expect((second.approachSourceTimeMs ?? 0) - actEnd, evidence).toBeCloseTo(
      rest,
      6,
    );
    // And the first step's rest is the opening one, from the opening frame:
    // the load and settle before it are not in the video.
    const opening = result.bundle?.keyframes[0]?.sourceTimeMs ?? Number.NaN;
    expect((first.approachSourceTimeMs ?? 0) - opening, evidence).toBeCloseTo(
      OPENING,
      6,
    );
  });

  // Red if the pause plays on top of the rest that already counts it: the
  // source sleeping it with the rest slept whole. (The source sleeping it
  // alone is absorbed: the rest is slept as what is left since the act.)
  it("plays a scripted pause once", async () => {
    const { result, progress } = await run([
      click("a"),
      { do: "pause", ms: 500 },
      click("b"),
    ]);
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    expect(
      (markerOf(result, 1).approachSourceTimeMs ?? 0) - actEndOf(result, 0),
      evidence,
    ).toBeCloseTo(BASE + 500, 6);
  });

  it("plays a closing pause once, in the tail", async () => {
    const { result, progress } = await run([
      click("a"),
      { do: "pause", ms: 500 },
    ]);
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    expect(
      (result.bundle?.keyframes.at(-1)?.sourceTimeMs ?? 0) -
        actEndOf(result, 0),
      evidence,
    ).toBeCloseTo(TAIL + 500, 6);
  });

  // Red if the rest is slept whole after a settle that already played page
  // time since the act ended.
  it("counts the page time a step's settle played toward the next rest", async () => {
    const { result, journeys, progress } = await run([click("a"), click("b")], {
      loadAfterFirstClickMs: 300,
    });
    const evidence = `${evidenceOf(result, progress)} ${JSON.stringify(journeys)}`;
    expect(result.outcome, evidence).toBe("complete");
    const actEnd = actEndOf(result, 0);
    // Premise: the settle after the first click waited the load out.
    const screen = result.bundle?.pageScreens?.[1]?.sourceTimeMs ?? 0;
    expect(screen - actEnd, evidence).toBeGreaterThanOrEqual(300);
    const journeyMs = journeys.at(-1) ?? 0;
    const second = markerOf(result, 1);
    expect((second.approachSourceTimeMs ?? 0) - actEnd, evidence).toBeCloseTo(
      BASE,
      6,
    );
    expect(second.sourceTimeMs - actEnd, evidence).toBeCloseTo(
      BASE + journeyMs + ARRIVE,
      6,
    );
  });

  // Red if the source sleeps the pause (authored.ts): a settle longer than
  // the pause leaves the rest's remainder to tell the two apart. The load
  // is page time here, not network time, so it counts toward the rest.
  it("plays a scripted pause once after a settle longer than it", async () => {
    const { result, progress } = await run(
      [click("a"), { do: "pause", ms: 500 }, click("b")],
      { loadAfterFirstClickMs: 1000 },
    );
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const actEnd = actEndOf(result, 0);
    // Premise: the settle after the first click played 1000 ms of page time.
    const screen = result.bundle?.pageScreens?.[1]?.sourceTimeMs ?? 0;
    expect(screen - actEnd, evidence).toBeGreaterThanOrEqual(1000);
    expect(
      (markerOf(result, 1).approachSourceTimeMs ?? 0) - actEnd,
      evidence,
    ).toBeCloseTo(BASE + 500, 6);
  });

  // As above, for a closing pause: the load (page time) runs past the tail.
  it("plays a closing pause once after a settle longer than the tail", async () => {
    const { result, progress } = await run(
      [click("a"), { do: "pause", ms: 500 }],
      {
        loadAfterFirstClickMs: 2000,
      },
    );
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const actEnd = actEndOf(result, 0);
    // Premise: the settle played more than the tail.
    const screen = result.bundle?.pageScreens?.[1]?.sourceTimeMs ?? 0;
    expect(screen - actEnd, evidence).toBeGreaterThan(TAIL);
    expect(
      (result.bundle?.keyframes.at(-1)?.sourceTimeMs ?? 0) - actEnd,
      evidence,
    ).toBeCloseTo(TAIL + 500, 6);
  });

  // Network time is the server's, played on top of the plan (spec §2): a
  // rest is counted only on page time. Red if the rest absorbs it. The wait
  // begins at the click, and the click's read (one frame, fix round 1,
  // finding 3) is played inside it, before the act ends: so all is measured
  // from the click.
  it.each([
    ["shorter", 300],
    ["longer", 1000],
  ])("plays the whole rest after a network wait %s than it", async (_, n) => {
    const { result, journeys, progress } = await run([click("a"), click("b")], {
      loadAfterFirstClickMs: n,
      loadIsNetwork: true,
    });
    const evidence = `${evidenceOf(result, progress)} ${JSON.stringify(journeys)}`;
    expect(result.outcome, evidence).toBe("complete");
    const clickAt = markerOf(result, 0).sourceTimeMs;
    // Premise: the clock reports the wait as network time, from the click on,
    // and the act ended inside it.
    expect(result.bundle?.networkSpans, evidence).toEqual([
      { startMs: clickAt, endMs: clickAt + n, label: "GET /slow" },
    ]);
    expect(actEndOf(result, 0), evidence).toBeGreaterThan(clickAt);
    const journeyMs = journeys.at(-1) ?? 0;
    const second = markerOf(result, 1);
    expect((second.approachSourceTimeMs ?? 0) - clickAt, evidence).toBeCloseTo(
      BASE + n,
      6,
    );
    expect(second.sourceTimeMs - clickAt, evidence).toBeCloseTo(
      BASE + n + journeyMs + ARRIVE,
      6,
    );
  });

  // Review of Task 9, finding 3: a request that opens and closes inside a
  // rest is played on top of it, so the rest's held part is as planned.
  // Red if the rest is slept once, as it was when it began.
  it("plays the whole rest around a request inside it", async () => {
    // The same walk with a request that closes as it opens: the control.
    const rest = async (ms: number) => {
      const { result, progress } = await run([click("a"), click("b")], {
        networkInRestMs: ms,
      });
      const evidence = evidenceOf(result, progress);
      expect(result.outcome, evidence).toBe("complete");
      const approach = markerOf(result, 1).approachSourceTimeMs ?? 0;
      return {
        evidence,
        beacon: result.bundle?.networkSpans?.[0],
        actEnd: actEndOf(result, 0),
        approach,
        fromClick: approach - markerOf(result, 0).sourceTimeMs,
      };
    };
    const without = await rest(0);
    const withIt = await rest(300);
    // Premise: the request is network time, after the act and before the
    // next step's approach.
    expect(withIt.beacon?.label, withIt.evidence).toBe("GET /beacon");
    expect(withIt.beacon?.startMs ?? 0, withIt.evidence).toBeGreaterThan(
      withIt.actEnd,
    );
    expect(withIt.beacon?.endMs ?? 0, withIt.evidence).toBeLessThan(
      withIt.approach,
    );
    // Its 300 ms come on top of the rest, which keeps its held part.
    expect(withIt.fromClick - without.fromClick, withIt.evidence).toBeCloseTo(
      300,
      6,
    );
  });

  it("plays the whole tail after a network wait", async () => {
    const { result, progress } = await run([click("a")], {
      loadAfterFirstClickMs: 1000,
      loadIsNetwork: true,
    });
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const clickAt = markerOf(result, 0).sourceTimeMs;
    expect(result.bundle?.networkSpans?.[0]?.startMs, evidence).toBe(clickAt);
    expect(
      (result.bundle?.keyframes.at(-1)?.sourceTimeMs ?? 0) - clickAt,
      evidence,
    ).toBeCloseTo(1000 + TAIL, 6);
  });

  // Red if the rest of a step reached by scrolling is played after the
  // scroll, or the after-scroll before it.
  it("rests before the scroll and plays the after-scroll after it", async () => {
    const { result, progress } = await run([click("a"), click("far")]);
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const actEnd = actEndOf(result, 0);
    const far = markerOf(result, 1);
    // Premise: the approach scrolled.
    expect(far.scrollEndSourceTimeMs, evidence).toBeDefined();
    const scrollEnd = far.scrollEndSourceTimeMs ?? 0;
    // The rest, then the walk's own scroll.
    expect(scrollEnd - actEnd, evidence).toBeCloseTo(BASE + HELD_SCROLL_MS, 6);
    expect((far.approachSourceTimeMs ?? 0) - scrollEnd, evidence).toBeCloseTo(
      ARRIVE,
      6,
    );
    expect((far.approachSourceTimeMs ?? 0) - actEnd, evidence).toBeCloseTo(
      BASE + HELD_SCROLL_MS + ARRIVE,
      6,
    );
  });

  // Review of Task 9 round 1, minor: the after-scroll is a rest too.
  it("plays the whole after-scroll around a request inside it", async () => {
    const afterScroll = async (ms: number) => {
      const { result, progress } = await run([click("a"), click("far")], {
        networkAfterScrollMs: ms,
      });
      const evidence = evidenceOf(result, progress);
      expect(result.outcome, evidence).toBe("complete");
      const far = markerOf(result, 1);
      return {
        evidence,
        beacon: result.bundle?.networkSpans?.[0],
        scrollEnd: far.scrollEndSourceTimeMs ?? Number.NaN,
        fromScrollEnd:
          (far.approachSourceTimeMs ?? 0) - (far.scrollEndSourceTimeMs ?? 0),
      };
    };
    const without = await afterScroll(0);
    const withIt = await afterScroll(300);
    // Premise: the request is network time inside the after-scroll.
    expect(withIt.beacon?.startMs ?? 0, withIt.evidence).toBeGreaterThan(
      withIt.scrollEnd,
    );
    expect(
      withIt.fromScrollEnd - without.fromScrollEnd,
      withIt.evidence,
    ).toBeCloseTo(300, 6);
  });

  // Review of Task 9 round 1, minor: report before you forgive.
  it("says a rest it cut short because the page waited the whole time", async () => {
    const { result, progress } = await run([click("a"), click("b")], {
      networkInRestMs: 100_000,
    });
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const cut = (result.bundle?.degradations ?? []).filter(
      (d) => d.kind === "pacingUnplaced",
    );
    // The rest before the second click, and the tail: the request never ends.
    expect(cut, evidence).toHaveLength(2);
    for (const d of cut) expect(d.note, evidence).toMatch(/cut \d+ ms short/);
  });

  it("returns no pacing plan and a held bundle", async () => {
    const { result, progress } = await run([click("a")], { network: NETWORK });
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    expect(result.pacing).toBeUndefined();
    expect(result.bundle?.clock).toBe("held");
    expect(result.bundle?.timing).toBe("real");
    // On the walk's time, from its start.
    expect(result.bundle?.networkSpans).toEqual([
      { startMs: 400, endMs: 900, label: "POST /api/chat" },
    ]);
    const said = (kind: string) =>
      result.bundle?.degradations
        .filter((d) => d.kind === kind)
        .map((d) => [d.startMs, d.note]);
    expect(said("animationUnpinned")).toEqual([[40, UNPINNED[0]?.what]]);
    expect(said("connectionIgnored")).toEqual([[0, IGNORED[0]]]);
    // The tail is played: the take runs its planned tail past the last act.
    expect(TAIL).not.toBe(TAKE_TAIL_MS);
    expect(
      (result.bundle?.keyframes.at(-1)?.sourceTimeMs ?? 0) -
        actEndOf(result, 0),
      evidence,
    ).toBeCloseTo(TAIL, 6);
  });

  it("files frames that repeat between acts as holds, in order", async () => {
    const { result, frames, push, progress } = await run(
      [click("a"), click("b")],
      { stillBetweenActs: true },
    );
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const bundle = result.bundle;
    if (bundle === null) throw new Error(evidence);
    // Premise: holds formed: repeated frames were not pushed as motion, and
    // stills no step asked for were filed for them.
    expect(push.mock.calls.length, evidence).toBeLessThan(frames.length);
    expect(
      bundle.keyframes.filter((k) => k.actionId === null).length,
      evidence,
    ).toBeGreaterThan(2);
    expect(() => validateBundle(bundle)).not.toThrow();
    const times = bundle.keyframes.map((k) => k.sourceTimeMs);
    expect(times, evidence).toEqual([...times].sort((a, b) => a - b));
  });

  it("a waitFor that never resolves fails at the same held time", async () => {
    const steps: DemoScript["steps"] = [
      click("a"),
      { do: "waitFor", on: { stableId: "gone" }, until: "visible" },
    ];
    const t0 = Date.now();
    const fast = await run(steps);
    const t1 = Date.now();
    const slow = await run(steps, { realDelayMs: 2 });
    const t2 = Date.now();
    const evidence = `${evidenceOf(fast.result, fast.progress)} ${evidenceOf(slow.result, slow.progress)}`;
    expect(fast.result.reason, evidence).toBe("waitTimeout");
    expect(slow.result.reason, evidence).toBe("waitTimeout");
    // Premise: the slow run really took longer in real time.
    expect(t2 - t1 - (t1 - t0), evidence).toBeGreaterThan(100);
    expect(slow.result.bundle?.markers, evidence).toEqual(
      fast.result.bundle?.markers,
    );
    expect(slow.result.counters.durationMs, evidence).toBe(
      fast.result.counters.durationMs,
    );
    expect(slow.frames.length, evidence).toBe(fast.frames.length);
  });

  it("a step's still is the held frame", async () => {
    const { result, cdp, frames, store, progress } = await run([click("a")]);
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const shots = cdp.calls.filter(
      (c) =>
        c.method === "Page.captureScreenshot" && c.params.format === "jpeg",
    );
    expect(shots).toEqual([]);
    const marker = markerOf(result, 0);
    const still = result.bundle?.keyframes.find(
      (k) => k.actionId === marker.actionId,
    );
    expect(still, evidence).toBeDefined();
    const latest = frames
      .filter((f) => f.sourceTimeMs - START <= marker.sourceTimeMs + 1e-6)
      .at(-1);
    // Premise: a frame had been captured before the step's still.
    expect(latest, evidence).toBeDefined();
    expect(await store.load(still?.ref ?? "")).toEqual(latest?.bytes);
  });

  it("says a held frame it could not file, and stops", async () => {
    const { result, progress } = await run([click("a")], {
      encoder: {
        push: vi.fn(async () => {
          throw new Error("disk full");
        }),
      },
    });
    expect(result.reason).toBe("portFailure");
    expect(progress.filter((p) => p.state === "failed").at(-1)?.note).toMatch(
      /held frame at [\d.]+ ms could not be filed \(disk full\)/,
    );
  });

  it("refuses a held clock on a sampled recording", async () => {
    await expect(run([click("a")], { recording: "sampled" })).rejects.toThrow(
      /held clock.*continuous recording/,
    );
  });
});

describe("the walk's own scroll on a held clock", () => {
  // R5: Chrome's smooth scroll runs on its real clock; the walk plays it.
  it("plays the corrective scroll one step a frame, eased, and lands it", async () => {
    const { result, progress, scrollSteps, scrollAsked, frames } = await run([
      click("a"),
      click("far"),
    ]);
    const evidence = `${evidenceOf(result, progress)} ${scrollSteps.join(",")}`;
    expect(result.outcome, evidence).toBe("complete");
    const n = Math.ceil(HELD_SCROLL_MS / HELD_FRAME_MS - 1e-6);
    expect(scrollSteps, evidence).toHaveLength(n);
    expect(scrollSteps.at(-1), evidence).toBe(1);
    // Each step asked of the target the plan was made on, so in its own
    // frame (fix round 1, finding 4), never of the top document.
    const target = scrollAsked.plan.at(-1);
    expect(target, evidence).toBeDefined();
    expect(new Set(scrollAsked.steps), evidence).toEqual(new Set([target]));
    // Eased: slow at both ends, so the first step is short of a linear one.
    expect(scrollSteps[0] ?? 1, evidence).toBeLessThan(1 / n);
    expect(
      [...scrollSteps].sort((a, b) => a - b),
      evidence,
    ).toEqual(scrollSteps);
    // One captured frame a step: the scroll ends where its last frame is.
    const far = markerOf(result, 1);
    const scrollEnd = far.scrollEndSourceTimeMs ?? Number.NaN;
    const filmed = frames.map((f) => f.sourceTimeMs - START);
    const during = filmed.filter(
      (t) => t > scrollEnd - HELD_SCROLL_MS + 1e-6 && t <= scrollEnd + 1e-6,
    );
    expect(during, evidence).toHaveLength(n);
  });
});

describe("in-page waits on a held clock", () => {
  // R3: the step-settle probe waits on the page's timers, which move only
  // as page time is played.
  it("plays page time until the settle probe answers", async () => {
    const { result, progress } = await run([click("a")], {
      settleAnswersAfterMs: 500,
    });
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const screens = result.bundle?.pageScreens ?? [];
    const marker = markerOf(result, 0);
    const after = screens.find((s) => s.after === 1);
    // The screen after the click waited out the probe's 500 ms of page time.
    expect(
      (after?.sourceTimeMs ?? 0) - (marker.actEndSourceTimeMs ?? 0),
      evidence,
    ).toBeGreaterThanOrEqual(500);
    expect(after?.unsettled, evidence).toBeUndefined();
  });

  it("says a settle probe that never answers, at its bound in page time", async () => {
    const { result, progress } = await run([click("a")], {
      settleAnswersAfterMs: null,
    });
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const said = (result.bundle?.degradations ?? []).filter(
      (d) => d.kind === "stepSettleFailed",
    );
    expect(said.map((d) => d.note).join(" "), evidence).toMatch(
      /had not answered after \d+ ms of page time/,
    );
  });

  // Fix round 1, finding 2: bounded in page time by the walk, never cut by
  // the real-time answer deadline at whatever page time a machine reached.
  it("sends its probes free of the real-time deadline", async () => {
    const { result, progress, probeSends } = await run([click("a")]);
    const evidence = evidenceOf(result, progress);
    expect(probeSends.length, evidence).toBeGreaterThanOrEqual(3);
    for (const sent of probeSends)
      expect(sent, evidence).toEqual({ unbounded: true });
  });

  it("files no frame from before the opening", async () => {
    const { result, frames, progress } = await run([click("a")]);
    const evidence = evidenceOf(result, progress);
    const opening = result.bundle?.keyframes[0]?.sourceTimeMs ?? Number.NaN;
    // Premise: page time was played, and a frame captured, before it.
    expect(frames[0]?.sourceTimeMs ?? Number.NaN, evidence).toBeLessThan(
      START + opening,
    );
    for (const k of result.bundle?.keyframes ?? [])
      expect(k.sourceTimeMs, evidence).toBeGreaterThanOrEqual(opening);
    for (const s of result.bundle?.motionSpans ?? [])
      expect(s.startMs, evidence).toBeGreaterThanOrEqual(opening);
  });
});

describe("a click's read on a held clock", () => {
  // Review of Task 9 round 1, finding C (round 2, finding 2): the hover
  // renewal's move after a navigating click, held by Chrome until the new
  // document loads, waited out its 30 s answer deadline with no page time
  // played. The load is played first, until the document says it is
  // complete, then the move is sent. Red if it is sent while the document
  // loads: it never answers.
  it.each([
    ["says it is loading", false],
    ["cannot be asked", true],
  ])(
    "plays a load no frameStartedLoading announced before the hover renewal, while the document %s",
    async (_, unreachable) => {
      const { result, progress } = await run([click("a"), click("b")], {
        unannouncedLoadMs: 400,
        documentUnreachableWhileLoading: unreachable,
      });
      const evidence = evidenceOf(result, progress);
      expect(result.outcome, evidence).toBe("complete");
      // Nothing said of the hover: it was renewed (the fake's standing
      // degradations are the clock's, from its fixtures).
      expect(
        (result.bundle?.degradations ?? []).filter((d) =>
          d.note.includes("hover"),
        ),
        evidence,
      ).toEqual([]);
    },
    10_000,
  );

  // Fix round 1, finding 3: a click that navigates to another site is read
  // only once the new page commits; that wait is played as page time, so a
  // server's wait is in the video. Red if the read is awaited unplayed.
  it("plays page time while the page that was clicked does not answer", async () => {
    const { result, progress, frames } = await run([click("a")], {
      clickReadAnswersAfterMs: 400,
    });
    const evidence = evidenceOf(result, progress);
    expect(result.outcome, evidence).toBe("complete");
    const marker = markerOf(result, 0);
    expect(
      (marker.actEndSourceTimeMs ?? 0) - marker.sourceTimeMs,
      evidence,
    ).toBeGreaterThanOrEqual(400);
    // Premise: frames were captured while the read waited.
    const during = frames.filter(
      (f) =>
        f.sourceTimeMs - START > marker.sourceTimeMs &&
        f.sourceTimeMs - START <= marker.sourceTimeMs + 400,
    );
    expect(during.length, evidence).toBeGreaterThanOrEqual(11);
  });
});
