import { validateBundle } from "@demoman/compositor";
import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  type SceneAnchor,
} from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
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
  runAuthored,
  SCROLL_MARKER,
  SETTLE_MS,
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
function fakeHeld(o: { look?: () => number; moved?: (now: number) => void }) {
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
    networkSpans: () => NETWORK.map((s) => ({ ...s })),
    unpinned: () => UNPINNED.map((u) => ({ ...u })),
    ignoredConnections: () => [...IGNORED],
    sleep: async (ms) => {
      const end = now + ms;
      for (;;) {
        const next =
          (Math.floor(now / HELD_FRAME_MS + 1e-6) + 1) * HELD_FRAME_MS;
        if (next > end + 1e-6) break;
        now = next;
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
  } = {},
) {
  const cdp = createCdpFake();
  let clicks = 0;
  let loadingUntil: number | null = null;
  const held = fakeHeld({
    ...(opts.stillBetweenActs === true ? { look: () => clicks } : {}),
    moved: (now) => {
      if (loadingUntil !== null && now >= loadingUntil) {
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
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => {
    if (opts.realDelayMs !== undefined) await delay();
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
      if (clicks === 1 && opts.loadAfterFirstClickMs !== undefined) {
        loadingUntil = held.clock.now() + opts.loadAfterFirstClickMs;
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
  return { result, cdp, frames: held.frames, store, progress, journeys, push };
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
    // And the first step's rest is the opening one, from the walk's start.
    expect(first.approachSourceTimeMs ?? 0, evidence).toBeCloseTo(OPENING, 6);
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
    expect(scrollEnd - actEnd, evidence).toBeCloseTo(BASE, 6);
    expect((far.approachSourceTimeMs ?? 0) - scrollEnd, evidence).toBeCloseTo(
      ARRIVE,
      6,
    );
    expect((far.approachSourceTimeMs ?? 0) - actEnd, evidence).toBeCloseTo(
      BASE + ARRIVE,
      6,
    );
  });

  it("returns no pacing plan and a held bundle", async () => {
    const { result, progress } = await run([click("a")]);
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
