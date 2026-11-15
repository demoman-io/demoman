import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  type SceneAnchor,
} from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
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
  HELD_FRAME_MS,
  runAuthored,
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
const NETWORK = [{ startMs: 400, endMs: 900, label: "POST /api/chat" }];
const UNPINNED = [{ atMs: 40, what: "spin on div: refused" }];
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

/** A distinct frame each time: a marker-only JPEG with its count after it. */
const frameBytes = (n: number): Uint8Array => {
  const head = decodeBase64(fakeScreenshotBase64());
  const bytes = new Uint8Array(head.length + 2);
  bytes.set(head);
  bytes[head.length] = n >> 8;
  bytes[head.length + 1] = n & 0xff;
  return bytes;
};

/** A held clock with no browser behind it: `sleep` moves page time and
 *  files one frame per `HELD_FRAME_MS` on the grid, as the real one does. */
function fakeHeld() {
  let now = 0;
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
          bytes: frameBytes(frames.length + 1),
          width: 1280,
          height: 800,
        };
        frames.push(frame);
        for (const listener of listeners) await listener(frame);
      }
      now = end;
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
  } = {},
) {
  const cdp = createCdpFake();
  const held = fakeHeld();
  const delay = () =>
    new Promise<void>((resolve) => setTimeout(resolve, opts.realDelayMs ?? 0));
  /** stableId by anchor id, so "b" can sit 400 px right of "a". */
  const stableOf = new Map<string, string>();
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => {
    if (opts.realDelayMs !== undefined) await delay();
    if (method === "DOM.getBoxModel") {
      const anchorId = String(params?.objectId ?? "").split(":")[1] ?? "";
      const reply = (await send(method, params)) as {
        model: { border: number[]; content: number[] };
      };
      if (stableOf.get(anchorId) !== "b") return reply;
      const right = (q: number[]) =>
        q.map((v, i) => (i % 2 === 0 ? v + 400 : v));
      return {
        model: {
          border: right(reply.model.border),
          content: right(reply.model.content),
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
  let n = 0;
  const deps: AuthoredDeps = {
    cdp,
    page,
    encoder: {
      openSpan: vi.fn(),
      push: vi.fn(async () => undefined),
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
      stableOf.set(intent.id, String(intent.fingerprint.stableId));
      return intent.fingerprint.stableId === "gone"
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
  return { result, cdp, frames: held.frames, store, progress, journeys };
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
  });

const markerOf = (result: AuthoredResult, index: number) => {
  const id = result.steps[index]?.actionId;
  const marker = result.bundle?.markers.find((m) => m.actionId === id);
  if (marker === undefined) throw new Error(evidenceOf(result));
  return marker;
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
    expect(methods).not.toContain("Page.screencastFrameAck");
  });

  // Red if the walk sleeps SETTLE_MS instead of the arrive, sleeps no rest,
  // or still waits the act out before the rest.
  it("plays the planned rest and arrive as page time", async () => {
    const { result, journeys, progress } = await run([click("a"), click("b")]);
    const evidence = `${evidenceOf(result, progress)} ${JSON.stringify(journeys)}`;
    expect(result.outcome, evidence).toBe("complete");
    const first = markerOf(result, 0);
    const second = markerOf(result, 1);
    // Premise: the second click travels, on a journey a whole number of
    // frames long (the path is played a frame at a time).
    const journeyMs = journeys.at(-1) ?? 0;
    expect(journeyMs, evidence).toBeGreaterThan(0);
    const frames = journeyMs / HELD_FRAME_MS;
    const playedJourney = Math.ceil(frames - 1e-6) * HELD_FRAME_MS;
    const actEnd = first.actEndSourceTimeMs;
    expect(actEnd, evidence).toBeDefined();
    const rest = RULES.restBefore({
      first: false,
      pauseMs: 0,
      roomMs: 0,
      journeyMs,
    });
    expect(rest).toBe(BASE);
    expect(ARRIVE).not.toBe(SETTLE_MS);
    expect(second.sourceTimeMs - (actEnd ?? 0), evidence).toBeCloseTo(
      rest + playedJourney + ARRIVE,
      6,
    );
    // The journey sets off once the rest is over.
    expect(
      (second.approachSourceTimeMs ?? 0) - (actEnd ?? 0),
      evidence,
    ).toBeCloseTo(rest, 6);
    // And the first step's rest is the opening one, from the opening still.
    expect(first.approachSourceTimeMs ?? 0, evidence).toBeCloseTo(
      HELD_FRAME_MS + OPENING,
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
    expect(result.bundle?.networkSpans).toEqual(NETWORK);
    const said = (kind: string) =>
      result.bundle?.degradations
        .filter((d) => d.kind === kind)
        .map((d) => d.note);
    expect(said("animationUnpinned")).toEqual(UNPINNED.map((u) => u.what));
    expect(said("connectionIgnored")).toEqual(IGNORED);
    // The tail is played: the take runs its planned tail past the last act.
    expect(TAIL).not.toBe(TAKE_TAIL_MS);
    const last = markerOf(result, 0);
    expect(
      (result.bundle?.keyframes.at(-1)?.sourceTimeMs ?? 0) -
        (last.actEndSourceTimeMs ?? 0),
      evidence,
    ).toBeCloseTo(TAIL, 6);
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
      .filter((f) => f.sourceTimeMs <= marker.sourceTimeMs + 1e-6)
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
