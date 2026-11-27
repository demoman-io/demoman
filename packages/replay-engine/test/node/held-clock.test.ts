import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRANT_EXPIRY_TIMEOUT_MS,
  HELD_EPS_MS,
  HELD_FRAMES_SCRIPT,
  SECOND_READ_MS,
  WALK_GAP_CREDIT_MS,
} from "../../src/held-clock.js";
import {
  createHeldClock,
  HELD_FRAME_MS,
  type HeldFrame,
  heldFramesScript,
  type NetworkWatch,
  PIN_ANIMATIONS,
  pinAnimationsScript,
} from "../../src/index.js";
import type { CdpSession } from "../../src/types.js";

const START = Date.parse("2026-11-15T12:00:00Z");

function setup(
  o: {
    waiting?: (real: number) => boolean;
    /** Real time each capture takes; or by capture, from 0. */
    captureMs?: number | ((shot: number) => number);
    /** Real time each grant takes before Chrome says it expired. */
    grantMs?: number;
    policy?: (
      params: Record<string, unknown>,
    ) => "expire" | "silent" | "refuse";
    listen?: boolean;
    /** What the page answers the pin with (default: nothing it could not pin). */
    pin?: (heldMs: number, source: string) => unknown;
    /** The screenshot's answer, in place of a frame at once. */
    shot?: () => Promise<{ bytes: Uint8Array; width: number; height: number }>;
    /** What the browser answers `Target.getTargetInfo` with. */
    targetInfo?: () => Promise<unknown>;
    scrubUrl?: (url: string) => string;
    /** The connections the network watch counts (`labels`). */
    labels?: string[];
    /** What the network watch says it stopped counting. */
    ignored?: string[];
    /** The real time the wait ended, once it has (`NetworkWatch.quietSince`). */
    quietSince?: (real: number) => number | null;
    /** The waits that began after a time, also those over
     *  (`NetworkWatch.waitsSince`), given the real time now. */
    waitsSince?: (
      sinceMs: number,
      real: number,
      pageMs?: number,
    ) => { from: number; page?: number; labels: string[] } | null;
    /** Whether a document's request is open (`NetworkWatch.loading`). */
    loading?: (real: number) => boolean;
    /** False: the test's sleeps are designed time unless it says
     *  `clock.waiting` itself. By default every sleep is a wait on the
     *  page, as before waits were told apart. */
    waits?: boolean;
    /** When data last arrived on a followed connection, given the real time. */
    followedDataAt?: (real: number) => number | null;
    /** When data last arrived on a followed connection outside the window. */
    outsideDataAt?: (real: number) => number | null;
    /** The clock's frame length (default: the clock's own, 30 fps). */
    frameMs?: number;
  } = {},
) {
  const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  const policies: Record<string, unknown>[] = [];
  const log: string[] = [];
  const pins: { source: string; arg: number; server: boolean }[] = [];
  const sent: string[] = [];
  let real = 0;
  let shots = 0;
  const cdp: CdpSession = {
    async send(method, params = {}) {
      sent.push(method);
      if (method === "Target.getTargetInfo")
        return (await o.targetInfo?.()) as Record<string, unknown>;
      if (method !== "Emulation.setVirtualTimePolicy") return {};
      policies.push(params);
      // As Chrome answers (measured 2026-11-15, apps/runner/compare/held-probe-basics.mjs).
      if (params.policy === "pause" && params.budget !== undefined)
        throw new Error("Can only specify budget for non-Pause policy");
      const answer = o.policy?.(params) ?? "expire";
      if (answer === "refuse") throw new Error("Target closed");
      if (answer === "expire" && params.budget !== undefined)
        real += o.grantMs ?? 0;
      if (answer === "expire" && params.budget !== undefined)
        queueMicrotask(() => {
          for (const h of handlers.get("Emulation.virtualTimeBudgetExpired") ??
            [])
            h({});
        });
      return {};
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    async detach() {},
  };
  const network: NetworkWatch = {
    waiting: () => o.waiting?.(real) ?? false,
    labels: () => o.labels ?? ["POST /api/chat"],
    ignored: () => o.ignored ?? [],
    quietSince: () => o.quietSince?.(real) ?? null,
    waitsSince: (sinceMs, pageMs) =>
      o.waitsSince?.(sinceMs, real, pageMs) ?? null,
    loading: () => o.loading?.(real) ?? false,
    follow: () => void log.push("follow"),
    followedDataAt: () => o.followedDataAt?.(real) ?? null,
    window: (since) => void log.push(`window ${since}`),
    outsideDataAt: () => o.outsideDataAt?.(real) ?? null,
    inFlight: () => 0,
    idle: async () => true,
    openedBefore: () => 0,
    stop() {},
  };
  const clock = createHeldClock({
    cdp,
    network,
    scale: 1,
    realNow: () => real,
    scrubUrl: o.scrubUrl,
    ...(o.frameMs === undefined ? {} : { frameMs: o.frameMs }),
    capture: async () => {
      log.push("capture");
      if (o.shot) return o.shot();
      real +=
        typeof o.captureMs === "function"
          ? o.captureMs(shots)
          : (o.captureMs ?? 0);
      return { bytes: new Uint8Array([++shots]), width: 2, height: 1 };
    },
    wait: async (ms) => {
      log.push(`wait ${ms}`);
      real += ms;
    },
    evaluate: async (source, arg, server) => {
      log.push(`pin ${arg}`);
      pins.push({ source, arg, server });
      const r = o.pin ? o.pin(arg, source) : [];
      // The pin answers { said, video }: a test's list is what it said.
      return source.startsWith("(v, server)") && Array.isArray(r)
        ? { said: r, video: false }
        : r;
    },
  });
  // A wait that never ends: every sleep of the test is inside it.
  if (o.waits !== false) void clock.waiting(() => new Promise(() => undefined));
  const frames: HeldFrame[] = [];
  if (o.listen !== false)
    clock.onFrame(async (f) => {
      frames.push(f);
    });
  const budgets = () =>
    policies.flatMap((p) =>
      p.budget === undefined ? [] : [p.budget as number],
    );
  const listeners = () =>
    [...handlers.values()].reduce((n, s) => n + s.size, 0);
  const advance = (ms: number) => {
    real += ms;
  };
  return {
    clock,
    frames,
    policies,
    budgets,
    log,
    pins,
    listeners,
    advance,
    sent,
  };
}

const times = (frames: HeldFrame[]) => frames.map((f) => f.sourceTimeMs);
/** A network watch's waits for `waitsSince`: each began at `from`, and is
 *  heard of at `at` (default `from`); a page's own request sent at `page`
 *  on the page's clock. */
const waitsOf =
  (...list: { from: number; at?: number; page?: number; labels: string[] }[]) =>
  (since: number, real: number, pageMs = Number.POSITIVE_INFINITY) => {
    const w = list.filter(
      (x) =>
        ((x.at ?? x.from) > since || (x.page ?? -Infinity) >= pageMs) &&
        real >= (x.at ?? x.from),
    );
    const [first] = w;
    const pages = w.flatMap((x) => (x.page === undefined ? [] : [x.page]));
    return first === undefined
      ? null
      : {
          from: Math.min(...w.map((x) => x.from)),
          ...(pages.length === w.length && { page: Math.min(...pages) }),
          labels: w.flatMap((x) => x.labels),
        };
  };
/** Times in frames of the grid, to six places. */
const inFrames = (list: number[]) =>
  list.map((ms) => Number((ms / HELD_FRAME_MS).toFixed(6)));
const onGrid = (ms: number) =>
  Math.abs(ms / HELD_FRAME_MS - Math.round(ms / HELD_FRAME_MS)) < 1e-6;

describe("createHeldClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures one frame per frame of page time", async () => {
    const { clock, frames, budgets, policies } = setup();
    await clock.hold(START);
    expect(policies[0]).toEqual({
      policy: "pause",
      initialVirtualTime: START / 1000,
    });
    await clock.sleep(1000);
    expect(frames).toHaveLength(30);
    frames.forEach((f, k) => {
      expect(f.sourceTimeMs).toBeCloseTo((k + 1) * HELD_FRAME_MS, 6);
      expect(f.bytes).toEqual(new Uint8Array([k + 1]));
      expect([f.width, f.height]).toEqual([2, 1]);
    });
    expect(clock.now()).toBe(1000);
    expect(budgets().reduce((a, b) => a + b, 0)).toBeCloseTo(1000, 6);
    expect(
      policies.filter((p) => p.budget !== undefined).map((p) => p.policy),
    ).toEqual(Array(30).fill("advance"));
  });

  // A repo that records at 60 fps. Red if any grant, or the
  // clock's grid, still steps 1000/30.
  it("advances page time by 1000/60 per frame at 60", async () => {
    const F60 = 1000 / 60;
    const { clock, frames, budgets } = setup({ frameMs: F60 });
    expect(clock.frameMs).toBe(F60);
    await clock.hold(START);
    await clock.sleep(1000);
    expect(budgets()).toHaveLength(60);
    expect(Math.abs(clock.now() - 1000)).toBeLessThan(HELD_EPS_MS);
    expect(frames).toHaveLength(60);
    frames.forEach((f, k) => {
      expect(f.sourceTimeMs).toBeCloseTo((k + 1) * F60, 6);
    });
    // Positive control: the default clock, 30 grants to the same second.
    const thirty = setup();
    expect(thirty.clock.frameMs).toBe(HELD_FRAME_MS);
    await thirty.clock.hold(START);
    await thirty.clock.sleep(1000);
    expect(thirty.budgets()).toHaveLength(30);
    expect(Math.abs(thirty.clock.now() - 1000)).toBeLessThan(HELD_EPS_MS);
  });

  // The stretch's grid, and the pin the clock runs, are the
  // clock's frame.
  it("follows the server on its own frame's grid, and pins with its frame's script", async () => {
    const F60 = 1000 / 60;
    const { clock, frames, pins } = setup({
      frameMs: F60,
      waiting: () => true,
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(1000);
    // Premise: it followed the server for several frames.
    expect(frames.length).toBeGreaterThan(3);
    expect(frames[0]?.sourceTimeMs).toBeCloseTo(F60, 6);
    for (const f of frames)
      expect(
        Math.abs(f.sourceTimeMs / F60 - Math.round(f.sourceTimeMs / F60)),
      ).toBeLessThan(1e-6);
    expect(pinAnimationsScript(F60)).not.toBe(PIN_ANIMATIONS);
    expect(pins.length).toBe(frames.length);
    expect(pins.every((p) => p.source === pinAnimationsScript(F60))).toBe(true);
  });

  // Chrome's clock falls behind per grant (whole µs), and 60
  // fps grants twice as often. Read through the page time a look asks the
  // network watch for waits sent since (`waitsSince`'s `pageMs`): a wait the
  // page sent 0.17 ms behind the look, 4 s in, counts at 60 and not at 30.
  // Red at 60 while the slack is a 30 fps grant's.
  it("allows the page's clock to fall behind per grant, at 60 as at 30", async () => {
    const LAG = 0.17;
    /** How far behind its look the last ask allowed. A look stands on the
     *  frame grid, and the slack is well under a frame, so the look is the
     *  grid's frame at or after the ask. */
    const slackAt = async (frameMs: number) => {
      const asked: number[] = [];
      const s = setup({
        frameMs,
        waitsSince: (_since, _real, pageMs) => {
          if (pageMs !== undefined) asked.push(pageMs);
          return null;
        },
      });
      await s.clock.hold(START);
      await s.clock.sleep(4000);
      const pageMs = asked.at(-1) ?? Number.NaN;
      // Premise: a look asked by page time near the end of the 4 s.
      expect(pageMs, String(frameMs)).toBeGreaterThan(3900);
      const slack = Math.ceil(pageMs / frameMs) * frameMs - pageMs;
      // Premise: under a frame, so the look is the one found above.
      expect(slack, String(frameMs)).toBeLessThan(frameMs / 2);
      return slack;
    };
    expect(await slackAt(1000 / 60)).toBeGreaterThan(LAG);
    // Positive control: at 30 the same lag is past the slack, as measured.
    expect(await slackAt(HELD_FRAME_MS)).toBeLessThan(LAG);
  });

  it("refuses a frame length that is not a positive number", () => {
    for (const frameMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => setup({ frameMs }), String(frameMs)).toThrow(
        /frame of page time/,
      );
  });

  // A new renderer (a navigation to another site) takes Chrome's last
  // policy: paused at the held time, never a grant's (measured 2026-11-15).
  it("leaves the clock paused at the held time after every grant", async () => {
    const { clock, policies } = setup();
    await clock.hold(START);
    await clock.sleep(100);
    const grants = policies.flatMap((p, i) =>
      p.budget === undefined ? [] : [i],
    );
    expect(grants).toHaveLength(3); // premise: three grants
    let heldMs = 0;
    for (const i of grants) {
      heldMs += policies[i]?.budget as number;
      expect(policies[i + 1]?.policy).toBe("pause");
      expect(policies[i + 1]?.initialVirtualTime).toBeCloseTo(
        (START + heldMs) / 1000,
        9,
      );
    }
  });

  it("says so when Chrome refuses to pause after a grant", async () => {
    const { clock, frames } = setup({
      policy: (p) =>
        p.initialVirtualTime !== undefined &&
        p.initialVirtualTime !== START / 1000
          ? "refuse"
          : "expire",
    });
    await clock.hold(START);
    await expect(clock.sleep(100)).rejects.toThrow(
      /could not hold the page's clock.*Target closed/,
    );
    expect(frames).toHaveLength(0);
  });

  it("carries fractions between sleeps", async () => {
    const { clock, frames } = setup();
    await clock.hold(START);
    for (let i = 0; i < 3; i++) await clock.sleep(10);
    expect(frames).toHaveLength(0);
    await clock.sleep(10);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.sourceTimeMs).toBeCloseTo(HELD_FRAME_MS, 6);
    expect(clock.now()).toBe(40);
  });

  it("pins animations before every capture", async () => {
    const { clock, frames, log, pins } = setup();
    await clock.hold(START);
    await clock.sleep(100);
    expect(frames).toHaveLength(3);
    expect(log.filter((l) => !l.startsWith("window"))).toEqual(
      frames.flatMap((f) => [`pin ${f.sourceTimeMs}`, "capture"]),
    );
    expect(pins.every((p) => p.source === PIN_ANIMATIONS)).toBe(true);
  });

  it("follows real time while the page waits on the server", async () => {
    const { clock, frames, budgets } = setup({
      waiting: () => true,
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(1000);
    // The stretch's first frame is the next of the grid, its real time
    // waited. Each after is the frame where real time will be when it is
    // taken, a capture (200 ms, six frames) later: frame 13 is taken at real
    // 433. The last runs past the sleep's end, as real time does.
    expect(inFrames(times(frames))).toEqual([1, 13, 19, 25, 31]);
    expect(inFrames(budgets())).toEqual([1, 12, 6, 6, 6]);
    expect(inFrames([clock.now()])).toEqual([31]);
    expect(clock.networkSpans()).toEqual([
      { startMs: 0, endMs: clock.now(), label: "POST /api/chat" },
    ]);
  });

  // Task 9: a stretch the walk sleeps through a frame at a time, each frame
  // taking longer to capture than the sleep, played the server's 1800 ms
  // stream in 839 ms when every sleep stopped at its own end.
  it("keeps up with real time across sleeps shorter than a capture", async () => {
    const { clock, frames } = setup({ waiting: () => true, captureMs: 50 });
    await clock.hold(START);
    for (let i = 0; i < 30; i++) await clock.sleep(HELD_FRAME_MS);
    // A frame a sleep, each the frame of the grid at or before the real
    // time it is taken: 50 ms captures are one frame, then two. Thirty
    // sleeps of a frame are 46 frames of page time, the real time.
    expect(frames).toHaveLength(30);
    expect(inFrames(times(frames)).slice(0, 4)).toEqual([1, 4, 5, 7]);
    expect(inFrames([clock.now()])).toEqual([46]);
  });

  it("never stamps a frame before its real time", async () => {
    const { clock, frames, log } = setup({
      waiting: () => true,
      captureMs: 10,
    });
    await clock.hold(START);
    await clock.sleep(200);
    // Captures of 10 ms: each frame of the grid waits for its real time.
    expect(inFrames(times(frames))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(log.filter((l) => l.startsWith("wait"))).toHaveLength(6);
  });

  it("credits no real time from before a stretch's first grant", async () => {
    const { clock, frames, budgets, advance } = setup({
      waiting: (real) => real >= 5000,
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(100);
    expect(frames).toHaveLength(3); // premise: held frames before the wait
    advance(5000); // the walk's own work: finding a target, a click
    await clock.sleep(1000);
    expect(budgets()).toHaveLength(3 + 5); // premise: three held grants first
    // The stretch's first frame is where real time is when it is taken, a
    // capture after the wait was seen: 200 ms, none of the 5000 before.
    expect(inFrames(budgets().slice(3, 5))).toEqual([6, 6]);
    expect(inFrames(times(frames).slice(3, 5))).toEqual([9, 15]);
  });

  // Task 9: a click's request was open while the walk finished the click,
  // and the stream's first chunk landed in that time; the next one came
  // 100 ms early in the video.
  it("begins a stretch when the page began waiting, not when the walk saw it", async () => {
    const { clock, frames, budgets, advance } = setup({
      waiting: (real) => real >= 5500,
      waitsSince: waitsOf({ from: 5500, labels: ["POST /api/chat"] }),
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(100);
    expect(frames).toHaveLength(3); // premise: held frames before the wait
    advance(5000); // the walk's own work; the page waits from its last 100 ms
    // A sleep of a frame, as the walk's are: the stretch's first frame is
    // still where real time is.
    await clock.sleep(HELD_FRAME_MS);
    await clock.sleep(1000);
    // From 5500 (frame 3) to the frame's capture at 5800: frame 12.
    expect(inFrames(budgets().slice(3, 5))).toEqual([9, 6]);
    expect(inFrames(times(frames).slice(3, 5))).toEqual([12, 18]);
  });

  // Review of Task 9, M5: a request already open when the clock is held.
  it("credits no real time from before the hold", async () => {
    const { clock, budgets, advance } = setup({
      waiting: () => true,
      waitsSince: waitsOf({ from: 500, labels: ["GET /"] }),
      captureMs: 200,
    });
    advance(1000); // the page's request opened at real 500, before the hold
    await clock.hold(START);
    await clock.sleep(HELD_FRAME_MS);
    expect(inFrames(budgets())).toEqual([1]);
  });

  // Review of Task 9 round 1, finding A: one rule dates a wait's start,
  // whichever branch sees it. A wait that began inside a grant began where
  // that grant started; clamped to the grant's end, a stream's first 400 ms
  // played in one frame on a slow machine.
  it("dates a wait that began inside a grant from that grant's start", async () => {
    // Grants take 200 ms (a page slow to answer): the third runs real
    // 800-1000, from frame 2. The page began waiting at 805, inside it.
    const { clock, budgets } = setup({
      waiting: (real) => real >= 805,
      waitsSince: waitsOf({ from: 805, labels: ["POST /api/chat"] }),
      captureMs: 200,
      grantMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(100);
    // Premise: three held grants, the third the sleep's last; its frame is
    // not taken (the page was waiting by its end), and the stretch's first
    // is, before the sleep returns.
    expect(budgets()).toHaveLength(4);
    // The stretch: frame 2 at real 805. Its first frame is taken at
    // 1000 + 400 (a grant and a capture): 595 ms on, frame 19 (16 past 3).
    // Dated from the grant's end instead (frame 3 at 1000): frame 15.
    expect(inFrames(budgets()).slice(3, 4)).toEqual([16]);
  });

  // Review of Task 9 round 1, finding A: the frame of the grant the page
  // began waiting in showed the stream's first chunks at the grant's time,
  // a capture early on a slow machine.
  it("takes the frame of a grant the page began waiting in as the stretch's first", async () => {
    const { clock, frames } = setup({
      // Grants and captures take 200 ms each; the fourth grant runs real
      // 1200-1400, and the page begins waiting at 1300, inside it.
      waiting: (real) => real >= 1300,
      waitsSince: waitsOf({ from: 1300, labels: ["POST /api/chat"] }),
      captureMs: 200,
      grantMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(100);
    expect(frames).toHaveLength(3); // premise: three held frames first
    await clock.sleep(1000);
    // No frame at 4 (real 1400, the grant's end): the stretch's first is
    // taken at real 1800, 500 ms after the wait began at frame 3: frame 18.
    expect(inFrames(times(frames)).slice(0, 4)).toEqual([1, 2, 3, 18]);
  });

  // CI ubuntu (fix round 2): the request was sent inside the click's
  // grant, its word heard after it; dated by when it was heard, that
  // grant's frame counted as held.
  it("dates a wait heard after a grant by when it was sent, inside it", async () => {
    const { clock } = setup({
      // The fourth grant runs real 1200-1400 from frame 3; the request is
      // sent at 1300 and heard at 1450, after the grant, during its capture.
      waiting: (real) => real >= 1450,
      waitsSince: waitsOf({ from: 1300, at: 1450, labels: ["GET /there"] }),
      captureMs: 200,
      grantMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(100);
    await clock.sleep(1000);
    // The stretch begins at frame 3, where the grant it was sent in began.
    expect(inFrames(clock.networkSpans().map((s) => s.startMs))).toEqual([3]);
  });

  // Nylon's click sent its fetch inside the grant after it, at the
  // grant's start or 10 ms in as Chrome had it, and its word came 1 ms
  // either side of the grant's end. By real time the stretch began at the
  // click or a frame later: the rest of the video stood a frame apart.
  it.each([
    [0, 600],
    [0, 601],
    [10, 600],
    [10, 601],
  ])(
    "dates a page's own request sent %i ms into a grant from the grant's start, heard at %i",
    async (into, at) => {
      // Captures take 200 ms: three designed frames end at real 600, held 100.
      const { clock } = setup({
        waits: false,
        waiting: (real) => real >= at,
        waitsSince: waitsOf({
          from: at,
          at,
          page: 100 + into, // the page's clock: held ms
          labels: ["GET /invoices/1041"],
        }),
        captureMs: 200,
      });
      await clock.hold(START);
      await clock.sleep(100);
      // The click lands at held 100; the click's read looks (real 600) and
      // grants a frame, in which the fetch is sent; then the step waits.
      await clock.sleep(HELD_FRAME_MS);
      await clock.waiting(() => clock.sleep(1000));
      expect(inFrames(clock.networkSpans().map((s) => s.startMs))).toEqual([3]);
    },
  );

  // A page's request sent while it stood at the held time, after the grant,
  // began there, not at the grant's start.
  it("dates a page's own request sent after a grant from where it stopped", async () => {
    const { clock } = setup({
      waits: false,
      waiting: (real) => real >= 600,
      waitsSince: waitsOf({
        from: 600,
        page: 100,
        labels: ["GET /a"],
      }),
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(100);
    await clock.waiting(() => clock.sleep(1000));
    expect(inFrames(clock.networkSpans().map((s) => s.startMs))).toEqual([3]);
  });

  // Review of Task 9 round 1, finding C: a call of the walk's that waited
  // out its 30 s deadline while a request was open became 30 s of the
  // server's wait in the video.
  it("credits the walk's own stuck time to the server only up to a bound", async () => {
    const { clock, frames, advance } = setup({
      waiting: () => true,
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(100);
    const before = clock.now();
    expect(frames.length).toBeGreaterThan(0); // premise: a stretch is open
    advance(30_000); // a call of the walk's that got no answer
    await clock.sleep(HELD_FRAME_MS);
    // At most the bound, the capture and a frame on.
    expect(clock.now() - before).toBeLessThanOrEqual(
      WALK_GAP_CREDIT_MS + 200 + HELD_FRAME_MS,
    );
    expect(clock.now() - before).toBeGreaterThanOrEqual(WALK_GAP_CREDIT_MS);
  });

  // Review of Task 9 round 2, finding 1: a wait dated hours before the
  // look that heard it (a fetch stamped on the page's held clock) moved the
  // page 10 h in one grant on CI.
  it("credits a wait from no earlier than the look before it was heard", async () => {
    const { clock } = setup({
      waiting: (real) => real >= 650,
      waitsSince: waitsOf({
        from: -36_000_000,
        at: 650,
        labels: ["POST /answer"],
      }),
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(100);
    await clock.sleep(1000);
    const spans = clock.networkSpans();
    expect(spans).toHaveLength(1); // premise: the wait was seen
    // Credited from the look before it was heard (real 600): the sleep's
    // second and a capture at most, not 10 h.
    expect(
      (spans[0]?.endMs ?? 0) - (spans[0]?.startMs ?? 0),
    ).toBeLessThanOrEqual(1200);
  });

  // Review of Task 9 round 2, finding 3: the frame of a held grant the page
  // was waiting at the end of was skipped; when the wait ended before the
  // next look, under a frame long, no stretch replaced it.
  // Review of Task 9 round 3: the skipped grant was the sleep's last, so the
  // sleep returned with its frame untaken; the walk then changed the page
  // (a scroll step) before the next sleep took it, or never did after the
  // walk's last sleep. Each one-frame sleep must return with its frame.
  it.each([
    ["the fourth", 1400],
    ["the last", 2200],
  ])(
    "takes a skipped frame before its sleep returns, in %s sleep",
    async (_, end) => {
      let seen = false;
      const { clock, frames } = setup({
        // The same beacon, inside that one-frame sleep's grant (each runs
        // 200 ms of real time, ending at a multiple of 400 less 200).
        waiting: (real) => {
          if (real >= end && !seen) {
            seen = true;
            return true;
          }
          return false;
        },
        quietSince: (real) => (real >= end ? end + 5 : null),
        waitsSince: waitsOf({
          from: end - 10,
          at: end,
          labels: ["GET /beacon"],
        }),
        captureMs: 200,
        grantMs: 200,
      });
      await clock.hold(START);
      const taken: number[] = [];
      for (let i = 0; i < 6; i++) {
        await clock.sleep(HELD_FRAME_MS);
        taken.push(frames.length);
      }
      expect(seen).toBe(true); // premise: the check saw the beacon
      expect(taken).toEqual([1, 2, 3, 4, 5, 6]);
      expect(inFrames(times(frames))).toEqual([1, 2, 3, 4, 5, 6]);
      expect(clock.networkSpans()).toEqual([]);
    },
  );

  it("takes a skipped frame when its wait leaves no stretch", async () => {
    let seen = false;
    const { clock, frames } = setup({
      // A beacon sent at 1390 inside the fourth grant (real 1200-1400) and
      // answered at 1405: the check after the grant sees it, the next look
      // does not.
      waiting: (real) => {
        if (real >= 1400 && !seen) {
          seen = true;
          return true;
        }
        return false;
      },
      quietSince: (real) => (real >= 1400 ? 1405 : null),
      waitsSince: waitsOf({ from: 1390, at: 1400, labels: ["GET /beacon"] }),
      captureMs: 200,
      grantMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(100);
    await clock.sleep(100);
    expect(seen).toBe(true); // premise: the check saw the beacon
    expect(clock.networkSpans()).toEqual([]);
    // Every frame of the grid, the fourth too.
    expect(inFrames(times(frames))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps one stretch for a wait that runs across sleeps", async () => {
    const { clock, frames } = setup({ waiting: () => true, captureMs: 200 });
    await clock.hold(START);
    await clock.sleep(100 / 3);
    await clock.sleep(1000 / 3);
    expect(frames.length).toBeGreaterThanOrEqual(2); // premise: both sleeps waited
    expect(clock.networkSpans()).toEqual([
      { startMs: 0, endMs: clock.now(), label: "POST /api/chat" },
    ]);
  });

  it("holds again when the wait ends", async () => {
    const { clock, frames, budgets } = setup({
      waiting: (real) => real < 400,
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(1000);
    // Premise: the page waited for the first two frames, then not.
    expect(inFrames(times(frames).slice(0, 2))).toEqual([1, 13]);
    const held = frames.slice(2);
    expect(held).toHaveLength(17); // frames 14..30 of the grid
    expect(held.every((f) => onGrid(f.sourceTimeMs))).toBe(true);
    expect(held[0]?.sourceTimeMs).toBeCloseTo(14 * HELD_FRAME_MS, 6);
    expect(
      budgets()
        .slice(2)
        .every((b) => b <= HELD_FRAME_MS + 1e-9),
    ).toBe(true);
    expect(clock.networkSpans()).toEqual([
      { startMs: 0, endMs: 13 * HELD_FRAME_MS, label: "POST /api/chat" },
    ]);
  });

  // Fix round 1, finding 3: the old page of a navigation to another site
  // answers no page call until the new one commits, so the server's wait
  // can end while a frame is being taken. The stretch follows it to its end.
  it("follows a wait that ended while a frame was taken, to its end", async () => {
    const { clock, frames, budgets } = setup({
      waiting: (real) => real < 700,
      quietSince: (real) => (real >= 700 ? 700 : null),
      // The third capture takes 600 ms where the two before took 200: its
      // frame was granted to where real time would be after 200 (frame 19,
      // real 633), and the wait ended at 700, inside it.
      captureMs: (shot) => (shot === 2 ? 600 : 200),
    });
    await clock.hold(START);
    await clock.sleep(1000);
    // Premise: the third frame was taken past the wait's end (real 1033).
    expect(inFrames(times(frames).slice(0, 3))).toEqual([1, 13, 19]);
    // The stretch lasts the wait's 700 ms of real time: 21 frames.
    expect(inFrames(budgets().slice(0, 4))).toEqual([1, 12, 6, 2]);
    expect(inFrames(clock.networkSpans().map((s) => s.endMs))).toEqual([21]);
    // Then the held grid again.
    const after = frames.slice(3);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((f) => onGrid(f.sourceTimeMs))).toBe(true);
  });

  // The author's ruling, 2026-11-16: the video follows the server
  // only while the script waits on the page. Red if a sleep outside a wait
  // follows an open connection (a 5 s video ran 76 s on a page with a
  // stream), or one inside a wait does not.
  it("follows the server only inside a wait on the page", async () => {
    const { clock, frames } = setup({
      waits: false,
      waiting: () => true,
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(10 * HELD_FRAME_MS);
    // Designed time: a frame a frame, whatever is open, and no stretch.
    expect(inFrames(times(frames))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(clock.networkSpans()).toEqual([]);
    await clock.waiting(() => clock.sleep(2 * HELD_FRAME_MS));
    // The wait: real time (200 ms a capture, 6 frames), from where it began.
    expect(clock.networkSpans().map((s) => s.startMs)).toEqual([
      10 * HELD_FRAME_MS,
    ]);
    // One frame, past the sleep's end: where real time was at its capture.
    const inWait = inFrames(times(frames).slice(10));
    expect(inWait).toHaveLength(1);
    expect(inWait[0]).toBeGreaterThan(12);
    // And designed time again after it.
    const before = frames.length;
    await clock.sleep(3 * HELD_FRAME_MS);
    expect(frames.length - before).toBe(3);
  });

  // CI macOS, 2026-11-16: frames owed when a wait on the page ended were
  // played on the way out, page time added by how long the server took, and
  // "the same video twice" stood a frame apart. Red if designed time, or
  // leaving a wait, plays a finished wait's owed frames.
  it("drops what a wait heard over is owed when the wait on the page ends", async () => {
    const { clock, frames, advance } = setup({
      waits: false,
      waiting: (real) => real < 300,
      quietSince: (real) => (real >= 300 ? 300 : null),
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.waiting(async () => {
      await clock.sleep(HELD_FRAME_MS);
      advance(200);
      // Premise: the wait is over and the stretch ends short of it.
      expect(clock.owing()).toBe(true);
    });
    const at = clock.now();
    const before = frames.length;
    await clock.sleep(2 * HELD_FRAME_MS);
    expect(clock.now() - at).toBeCloseTo(2 * HELD_FRAME_MS, 6);
    expect(frames.length - before).toBe(2);
    expect(inFrames(clock.networkSpans().map((s) => s.endMs))).toEqual([1]);
  });

  // Red if an answer landing in a pause is unsaid, or a connection the
  // script never waited on (a prefetch, a beacon) is said.
  it("says when data arrived in designed time on a connection it had followed", async () => {
    let dataAt: number | null = null;
    const { clock, advance } = setup({
      waits: false,
      waiting: () => true,
      followedDataAt: () => dataAt,
    });
    await clock.hold(START);
    await clock.sleep(3 * HELD_FRAME_MS);
    expect(clock.unpaced()).toBeNull();
    advance(50);
    dataAt = 40;
    await clock.sleep(HELD_FRAME_MS);
    expect(clock.unpaced()).toBe(3 * HELD_FRAME_MS);
  });

  // Only the first unpaced time is kept, so one in the
  // opening, which the video leaves out, hid a later one it shows. Red if
  // the take's start keeps the opening's, or forgets one after it.
  it("says unpaced data from the take's start, not the opening's", async () => {
    let dataAt: number | null = null;
    const { clock, advance } = setup({
      waits: false,
      waiting: () => true,
      followedDataAt: () => dataAt,
    });
    await clock.hold(START);
    await clock.sleep(3 * HELD_FRAME_MS);
    advance(50);
    dataAt = 40;
    await clock.sleep(HELD_FRAME_MS);
    // Premise: the opening had unpaced data.
    expect(clock.unpaced()).toBe(3 * HELD_FRAME_MS);
    clock.startTake();
    expect(clock.unpaced()).toBeNull();
    await clock.sleep(HELD_FRAME_MS);
    advance(50);
    dataAt = 140;
    await clock.sleep(HELD_FRAME_MS);
    expect(clock.unpaced()).toBe(5 * HELD_FRAME_MS);
  });

  // Review, Session C: a stream's last chunk and its end inside one designed
  // frame went unsaid. Red if the note needs the connection still open.
  it("says an answer that finished in designed time, the connection already closed", async () => {
    let dataAt: number | null = null;
    const { clock, advance } = setup({
      waits: false,
      waiting: () => false,
      followedDataAt: () => dataAt,
    });
    await clock.hold(START);
    await clock.sleep(3 * HELD_FRAME_MS);
    advance(50);
    dataAt = 40;
    await clock.sleep(HELD_FRAME_MS);
    expect(clock.unpaced()).toBe(3 * HELD_FRAME_MS);
  });

  // Red if data the server's time already paced, in a wait's last grant,
  // is said by the designed sleep after the wait.
  it("does not say data that arrived inside a wait, once the wait is over", async () => {
    let dataAt: number | null = null;
    const { clock, advance } = setup({
      waits: false,
      waiting: () => false,
      followedDataAt: () => dataAt,
    });
    await clock.hold(START);
    await clock.waiting(async () => {
      await clock.sleep(HELD_FRAME_MS);
      advance(50);
      dataAt = 40;
    });
    await clock.sleep(2 * HELD_FRAME_MS);
    expect(clock.unpaced()).toBeNull();
  });

  // A step's settle leaves out requests it does not wait for, and
  // an answer arriving on one then landed where the machine put it. Red if
  // the left-out set outlives the wait, or that answer is unsaid.
  it("follows only a wait's window, and says data outside it", async () => {
    let dataAt: number | null = null;
    const { clock, advance, log } = setup({
      waits: false,
      outsideDataAt: () => dataAt,
    });
    await clock.hold(START);
    await clock.waiting(async () => {
      await clock.sleep(HELD_FRAME_MS);
      expect(clock.unpaced()).toBeNull();
      advance(50);
      dataAt = 40;
      await clock.sleep(HELD_FRAME_MS);
    }, 7);
    expect(log.filter((l) => l.startsWith("window"))).toEqual([
      "window 7",
      "window null",
    ]);
    expect(clock.unpaced()).toBe(HELD_FRAME_MS);
  });

  // Waits nest (a step's settle holds the page's answers to
  // reads), and an inner one is part of the outer. Red if an inner wait's
  // later window drops a request the outer still waits on, as it did for the
  // settle.
  it("follows the earliest window among nested waits", async () => {
    const { clock, log } = setup({ waits: false });
    await clock.hold(START);
    await clock.waiting(async () => {
      await clock.waiting(async () => {
        await clock.waiting(async () => undefined, 6000);
      }, 5000);
    }, 1000);
    expect(log.filter((l) => l.startsWith("window"))).toEqual([
      "window 1000",
      "window 1000",
      "window 1000",
      "window 1000",
      "window 1000",
      "window null",
    ]);
  });

  it("a wait with no lower bound follows everything", async () => {
    const { clock, log } = setup({ waits: false });
    await clock.hold(START);
    await clock.waiting(async () => undefined);
    await clock.waiting(async () => undefined, null);
    expect(log.filter((l) => l.startsWith("window"))).toEqual([
      "window null",
      "window null",
      "window null",
      "window null",
    ]);
  });

  it("answers pageOf as the wall time less the hold's epoch", async () => {
    const { clock } = setup({ waits: false });
    expect(() => clock.pageOf(START)).toThrow();
    await clock.hold(START);
    expect(clock.pageOf(START + 250)).toBe(250);
  });

  // A held settle counts no frame shot following the server. Red
  // if the page is not told which frames those are.
  it("tells the page which frames followed the server", async () => {
    const { clock, pins } = setup({
      waiting: (real) => real >= 40 && real < 140,
      quietSince: (real) => (real >= 140 ? 140 : null),
      waitsSince: waitsOf({ from: 40, labels: ["GET /a"] }),
      grantMs: 20,
    });
    await clock.hold(START);
    await clock.sleep(10 * HELD_FRAME_MS);
    const spans = clock.networkSpans();
    expect(spans.length).toBe(1);
    const inSpan = (ms: number) =>
      spans.some((s) => ms > s.startMs && ms <= s.endMs);
    // Premise: frames on both sides.
    expect(pins.some((p) => p.server)).toBe(true);
    expect(pins.some((p) => !p.server)).toBe(true);
    for (const p of pins) expect(p.server, `at ${p.arg}`).toBe(inSpan(p.arg));
  });

  // Session A, 2026-11-16: the walk plays frames while a document's request
  // is open, on the clock's word.
  it("owes while a document's request is open", async () => {
    const { clock, advance } = setup({ loading: (real) => real < 100 });
    await clock.hold(START);
    expect(clock.loading()).toBe(true);
    expect(clock.owing()).toBe(true);
    advance(100);
    expect(clock.loading()).toBe(false);
    expect(clock.owing()).toBe(false);
  });

  // Session A: a settle's quiet window, asked while the clock still owed a
  // wait's frames, ran inside them by as much as the machine made it.
  it("says it owes a wait heard over its frames, until they are played", async () => {
    const { clock, advance } = setup({
      waiting: (real) => real < 300,
      quietSince: (real) => (real >= 300 ? 300 : null),
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(HELD_FRAME_MS);
    advance(200);
    // Premise: the wait is over, and the stretch ends short of it.
    expect(clock.networkSpans()[0]?.endMs).toBeLessThan(300);
    expect(clock.owing()).toBe(true);
    await clock.sleep(HELD_FRAME_MS);
    expect(inFrames(clock.networkSpans().map((s) => s.endMs))).toEqual([9]);
    expect(clock.owing()).toBe(false);
  });

  // Task 9: the whole wait of a click to another site fell inside the one
  // grant after the click, between two looks, and was not in the video.
  it("follows a wait that began and ended between two looks", async () => {
    const { clock, frames } = setup({
      waiting: () => false,
      // It began at real 250 and ended at 340, both inside the second
      // frame's capture (real 200-400), so no look saw it.
      waitsSince: waitsOf({ from: 250, labels: ["GET /there"] }),
      quietSince: (real) => (real >= 340 ? 340 : null),
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(1000);
    // Premise: two held frames first.
    expect(inFrames(times(frames).slice(0, 2))).toEqual([1, 2]);
    // The page was stopped at frame 2 (real 200) the whole wait, so the
    // stretch runs from frame 2 for its 90 ms of real time, to the frame of
    // the grid at or after it.
    expect(
      clock
        .networkSpans()
        .map((s) => [...inFrames([s.startMs, s.endMs]), s.label]),
    ).toEqual([[2, 5, "GET /there"]]);
    expect(frames.slice(3).every((f) => onGrid(f.sourceTimeMs))).toBe(true);
  });

  // Review of Task 9, finding 1: a stretch's last grant overran its sleep,
  // and a quick refetch began and ended before the next look. It is one
  // more connection of the open stretch, not a second span over it.
  it("adds a wait between two looks to the stretch open up to it", async () => {
    const { clock } = setup({
      // The POST is open until real 300; the refetch runs 310-320.
      waiting: (real) => real < 300,
      quietSince: (real) => (real >= 320 ? 320 : null),
      waitsSince: waitsOf(
        { from: 0, labels: ["POST /api/chat"] },
        { from: 310, labels: ["GET /refetch"] },
      ),
      captureMs: 200,
    });
    await clock.hold(START);
    // A frame at a time, as the walk sleeps: the second grant catches up to
    // real 233 and ends the sleep there, past its own end; the third sleep's
    // look is the first after the refetch.
    for (let i = 0; i < 5; i++) await clock.sleep(HELD_FRAME_MS);
    // One stretch, naming both; the refetch's end (real 320) is inside its
    // last frame already, taken at real 433 (frame 13).
    expect(
      clock
        .networkSpans()
        .map((s) => [...inFrames([s.startMs, s.endMs]), s.label]),
    ).toEqual([[0, 13, "POST /api/chat, GET /refetch"]]);
  });

  // CI ubuntu, 2026-11-15 (fix round 1): a cross-site click's whole wait
  // fell inside one grant, and the next look saw the new page's favicon
  // already loading: a wait of its own, which hid the first.
  it("follows a wait that ended unseen when the next look sees another", async () => {
    const { clock } = setup({
      // GET /there 250-340, then the favicon from 360, both inside the
      // second frame's capture (real 200-400); the favicon ends at 700.
      waiting: (real) => real >= 360 && real < 700,
      quietSince: (real) => (real >= 700 ? 700 : null),
      waitsSince: waitsOf(
        { from: 250, labels: ["GET /there"] },
        { from: 360, labels: ["GET /favicon.ico"] },
      ),
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(1000);
    // One stretch from where the page stood when GET /there began (frame 2,
    // real 200), naming it; it runs the real time from 250 to 700.
    const [first, ...rest] = clock.networkSpans();
    expect(inFrames([first?.startMs ?? Number.NaN])).toEqual([2]);
    expect(first?.label).toContain("GET /there");
    expect(rest).toEqual([]);
    expect((first?.endMs ?? 0) - (first?.startMs ?? 0)).toBeGreaterThanOrEqual(
      450,
    );
  });

  it("names the connections the network watch stopped counting", () => {
    const { clock } = setup({ ignored: ["GET /poll"] });
    expect(clock.ignoredConnections()).toEqual(["GET /poll"]);
  });

  it("lets the page run until a read of it answers, taking no frame, and leaves it held", async () => {
    // A read of the page's storage answers nothing while its clock is paused
    // (measured 2026-11-15, apps/runner/compare/held-probe-storage.mjs).
    let answer: (v: string) => void = () => {};
    const read = new Promise<string>((r) => {
      answer = r;
    });
    const { clock, frames, policies, budgets } = setup({
      policy: (p) => {
        if (p.budget !== undefined && budgets().length === 3) answer("state");
        return "expire";
      },
    });
    await clock.hold(START);
    expect(await clock.through(read)).toBe("state");
    expect(budgets().length).toBe(3); // premise: it took grants to answer
    expect(frames).toEqual([]);
    expect(policies.at(-1)?.policy).toBe("pause");
  });

  // Measured 2026-11-16: a page left paused made the final still, rendered
  // beside it, take 7.2 s against 0.5 s. Red if the page is left held, or
  // left running the app at the free clock's pace.
  it("lets the page go: its clock runs free, and it is blanked at once", async () => {
    const { clock, policies, sent } = setup();
    await clock.hold(START);
    await clock.sleep(HELD_FRAME_MS);
    const before = sent.length;
    await clock.release();
    expect(policies.at(-1)).toEqual({ policy: "advance" });
    expect(sent.slice(before)).toEqual([
      "Emulation.setVirtualTimePolicy",
      "Page.navigate",
    ]);
  });

  // Review of 2026-11-16. Red if a read that never answers holds the run
  // for good, or a read that answered is thrown away because the page's
  // clock could no longer be moved.
  it("gives up, in words, on a read that never answers", async () => {
    const { clock } = setup();
    await clock.hold(START);
    await expect(clock.through(new Promise(() => {}))).rejects.toThrow(
      /did not answer a read of it within 15 s/,
    );
  });

  it("hands back a read that answers though the page's clock could no longer be moved", async () => {
    let answer: (v: string) => void = () => {};
    const read = new Promise<string>((r) => {
      answer = r;
    });
    const { clock } = setup({
      policy: (p) => {
        if (p.budget === undefined) return "expire";
        answer("state");
        return "refuse";
      },
    });
    await clock.hold(START);
    expect(await clock.through(read)).toBe("state");
  });

  it("hands on what a read failed with", async () => {
    const { clock } = setup();
    await clock.hold(START);
    await expect(
      clock.through(Promise.reject(new Error("closed"))),
    ).rejects.toThrow("closed");
  });

  it("rehold continues the same time", async () => {
    const { clock, policies } = setup();
    await clock.hold(START);
    await clock.sleep(500);
    await clock.rehold();
    expect(policies.at(-1)).toEqual({
      policy: "pause",
      initialVirtualTime: (START + 500) / 1000,
    });
    expect(clock.now()).toBe(500);
  });

  it("says so when Chrome refuses to hold the clock", async () => {
    const { clock } = setup({ policy: () => "refuse" });
    await expect(clock.hold(START)).rejects.toThrow(
      /could not hold the page's clock.*setVirtualTimePolicy.*Target closed/,
    );
  });

  it("says so when Chrome refuses a grant, and moves no time", async () => {
    const { clock, frames } = setup({
      policy: (p) => (p.budget === undefined ? "expire" : "refuse"),
    });
    await clock.hold(START);
    await expect(clock.sleep(100)).rejects.toThrow(
      /could not move the page's clock.*Target closed/,
    );
    expect(frames).toHaveLength(0);
    expect(clock.now()).toBe(0);
  });

  it("says so when a grant never expires, instead of hanging", async () => {
    vi.useFakeTimers();
    const { clock, frames, listeners } = setup({
      policy: (p) => (p.budget === undefined ? "expire" : "silent"),
    });
    await clock.hold(START);
    const slept = clock.sleep(100);
    const said = expect(slept).rejects.toThrow(
      /virtualTimeBudgetExpired.*15000 ms/,
    );
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS);
    await said;
    expect(frames).toHaveLength(0);
    expect(clock.now()).toBe(0);
    expect(listeners()).toBe(0);
  });

  // Default-readiness, 2026-11-18: a page spinning on performance.now()
  // never answers on a held clock. Red if the run hangs instead of saying so.
  it("says so when the page never answers a frame's read, instead of hanging", async () => {
    vi.useFakeTimers();
    const { clock, frames } = setup({
      pin: () => new Promise(() => undefined) as never,
    });
    await clock.hold(START);
    const said = expect(clock.sleep(100)).rejects.toThrow(
      /did not answer within 15 s.*the animation pin went unanswered, and a second read too: a script on it is still running.*DEMOMAN_HELD_CLOCK=0/,
    );
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS);
    await said;
    expect(frames).toHaveLength(0);
  });

  // Two CI refreshes stopped on the opening load with the loop
  // sentence, on pages with no loop. Red if a page that answers a second
  // read is still blamed for a loop, or the sentence leaves out which read
  // hung, where the browser had the page, or what the network watch saw.
  it("says a page that answers a second read runs no script, with which read hung and where the page was", async () => {
    vi.useFakeTimers();
    // The document's request closes as the page is asked again after the
    // retake: the sentence says the network as the read went unanswered.
    let asks = 0;
    const { clock, frames } = setup({
      pin: (_, source) => {
        if (source === PIN_ANIMATIONS) return [];
        asks++;
        return ["http://localhost:4402/board/web?key=SECRET", "interactive"];
      },
      shot: () => new Promise(() => undefined),
      targetInfo: async () => ({
        targetInfo: { url: "http://auth.example/sign-in/SECRET" },
      }),
      scrubUrl: (url) => url.replaceAll("SECRET", "[redacted]"),
      loading: () => asks < 2,
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(
      2 * (GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS),
    );
    await slept;
    const said = String(failed);
    // A frame after the first, which was taken again.
    expect(said).toMatch(
      /did not answer within 15 s during the opening, 67 ms into its load: its screenshot went unanswered when the frame was taken again a frame of page time later, the first read still unanswered, though the page answered a second read within 1000 ms \(at http:\/\/localhost:4402\/board\/web, document interactive\), so no script of it is running now; its document's request was open; the browser has it at http:\/\/auth\.example\/sign-in\/\[redacted\]$/,
    );
    expect(said).not.toMatch(/SECRET|loop|DEMOMAN_HELD_CLOCK/);
    expect(asks, "the page was asked again, after each read").toBe(2);
    expect(clock.failed()?.message).toBe((failed as Error).message);
    expect(frames).toHaveLength(0);
  });

  // The video's time starts at the opening still, after the
  // opening's load. Red if a stop after it says the clock's own time, which
  // runs ahead of the video by the opening.
  it("says a stop's time from the take's start, once it has one", async () => {
    vi.useFakeTimers();
    let hang = false;
    const { clock } = setup({
      pin: (_, source) =>
        source === PIN_ANIMATIONS
          ? []
          : ["http://localhost:4402/board/web", "complete"],
      shot: () =>
        hang
          ? new Promise(() => undefined)
          : Promise.resolve({
              bytes: new Uint8Array([1]),
              width: 2,
              height: 1,
            }),
    });
    await clock.hold(START);
    await clock.sleep(200);
    clock.startTake();
    await clock.sleep(100);
    hang = true;
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(
      2 * (GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS),
    );
    await slept;
    // Premise: the clock is 367 ms in, two frames into the hung sleep (the
    // second its retake's), and the take started at 200 of them.
    expect(clock.now()).toBeCloseTo(1100 / 3, 6);
    expect(String(failed)).toMatch(
      /did not answer within 15 s at 167 ms of the recording: its screenshot/,
    );
  });

  // Red if a branch of the sentence says the wrong thing: a second read
  // that fails, a browser that refuses or does not answer where the page
  // is, a page waiting on its server, and none the watch counts.
  it.each([
    {
      name: "a second read that fails, a browser that refuses",
      second: async () => {
        throw new Error("Execution context was destroyed");
      },
      target: async () => {
        throw new Error("Target closed");
      },
      labels: ["GET /api/me"],
      says: /its screenshot went unanswered, and a second read failed \(Execution context was destroyed\); it was waiting on GET \/api\/me; the browser did not say where it is \(Target closed\)$/,
    },
    {
      name: "a browser that does not answer, no request counted",
      second: () => ["about:blank", "complete"],
      target: () => new Promise(() => undefined),
      labels: [],
      says: /\(at about:blank, document complete\), so no script of it is running now; no request the network watch counts was open; the browser did not say where it is \(no answer within 1000 ms\)$/,
    },
    {
      name: "an answer with no address, a browser with none",
      second: () => undefined,
      target: async () => ({}),
      labels: [],
      says: /\(with no address\), so no script of it is running now; .*the browser did not say where it is \(no address\)$/,
    },
  ])("says $name", async ({ second, target, labels, says }) => {
    vi.useFakeTimers();
    let asked = false;
    const { clock, sent } = setup({
      pin: (_, source) => {
        if (source === PIN_ANIMATIONS) return [];
        asked = true;
        return second();
      },
      shot: () => new Promise(() => undefined),
      targetInfo: target,
      labels,
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    // A page that answers is taken again first.
    await vi.advanceTimersByTimeAsync(
      2 * (GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS),
    );
    await slept;
    expect(asked, "the page was asked again").toBe(true);
    expect(sent).toContain("Target.getTargetInfo");
    expect(String(failed)).toMatch(says);
    expect(String(failed)).not.toMatch(/loop|DEMOMAN_HELD_CLOCK/);
  });

  // Red if a throw while saying why leaves the run waiting for good.
  it("still stops, in words, when saying why throws", async () => {
    vi.useFakeTimers();
    const { clock } = setup({
      shot: () => new Promise(() => undefined),
      scrubUrl: () => {
        throw new Error("scrubber broke");
      },
      targetInfo: async () => ({ targetInfo: { url: "http://x.test/" } }),
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS);
    await slept;
    expect(String(failed)).toMatch(
      /its screenshot went unanswered, and saying why failed \(scrubber broke\)$/,
    );
    expect(clock.failed()).not.toBeNull();
  });

  // Red if a read that answers while the page is asked again still stops
  // the run: its held time never moved, so the take is the same.
  it("goes on when the frame's read answers while the page is asked again", async () => {
    vi.useFakeTimers();
    let asked = false;
    const { clock, frames, sent } = setup({
      pin: (_, source) => {
        if (source === PIN_ANIMATIONS) return [];
        asked = true;
        return new Promise(() => undefined);
      },
      shot: () =>
        new Promise((r) =>
          setTimeout(
            () => r({ bytes: new Uint8Array([1]), width: 2, height: 1 }),
            GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS / 2,
          ),
        ),
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(HELD_FRAME_MS).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS);
    await slept;
    expect(asked, "the page was asked again before the frame came").toBe(true);
    expect(sent).toContain("Target.getTargetInfo");
    expect(failed).toBeNull();
    expect(clock.failed()).toBeNull();
    expect(frames, "the frame the late screenshot answered").toHaveLength(1);
  });

  // CI's screenshot 33 ms into a redirect's sign-in page went
  // unanswered on a page that answered a second read, and the run stopped.
  // Red if such a frame stops the run, is filed at the time it was due
  // (its picture is a frame later), is filed twice when the first answers
  // late, or goes unsaid.
  it("takes a frame again a frame later when its screenshot goes unanswered on a page that answers", async () => {
    vi.useFakeTimers();
    let shots = 0;
    const { clock, frames, budgets } = setup({
      pin: (_, source) =>
        source === PIN_ANIMATIONS ? [] : ["http://x.test/login", "complete"],
      // The first never answers until long after its retake was filed.
      shot: () =>
        ++shots === 1
          ? new Promise((r) =>
              setTimeout(
                () => r({ bytes: new Uint8Array([9]), width: 2, height: 1 }),
                3 * GRANT_EXPIRY_TIMEOUT_MS,
              ),
            )
          : Promise.resolve({
              bytes: new Uint8Array([shots]),
              width: 2,
              height: 1,
            }),
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS);
    await slept;
    expect(failed).toBeNull();
    expect(clock.failed()).toBeNull();
    // The retake is the frame after; the sleep's last frame follows it.
    expect(inFrames(times(frames))).toEqual([2, 3]);
    expect(frames.map((f) => f.bytes[0])).toEqual([2, 3]);
    // Premise: the retake moved the page a frame on before it was taken.
    expect(budgets().map((b) => Number(b.toFixed(6)))).toEqual(
      [1, 1, 1].map((n) => Number((n * HELD_FRAME_MS).toFixed(6))),
    );
    expect(clock.retaken()).toHaveLength(1);
    expect(clock.retaken()[0]?.atMs).toBeCloseTo(HELD_FRAME_MS, 6);
    expect(clock.retaken()[0]?.what).toMatch(
      /its screenshot went unanswered, though the page answered a second read .*at http:\/\/x\.test\/login, document complete/,
    );
    // The first screenshot's late answer files nothing.
    await vi.advanceTimersByTimeAsync(3 * GRANT_EXPIRY_TIMEOUT_MS);
    expect(frames).toHaveLength(2);
  });

  /** A screenshot that never answers on the `hang`-th call, every other at
   *  once; and a page that answers a second read. */
  const hangsOnce = (hang: number) => {
    let shots = 0;
    return {
      pin: (_: number, source: string) =>
        source === PIN_ANIMATIONS ? [] : ["http://x.test/login", "complete"],
      shot: () =>
        ++shots === hang
          ? new Promise<never>(() => undefined)
          : Promise.resolve({
              bytes: new Uint8Array([shots]),
              width: 2,
              height: 1,
            }),
    };
  };

  // A retake on a sleep's last frame ran the clock a
  // frame past the sleep, and every later step a frame late. Red if the
  // next sleep does not owe that frame back.
  it("owes a retake's frame past a sleep's end back to the next sleep", async () => {
    vi.useFakeTimers();
    const { clock, frames } = setup(hangsOnce(3));
    await clock.hold(START);
    const slept = clock.sleep(100);
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS);
    await slept;
    // Premise: the third frame, at the sleep's end, was taken a frame on.
    expect(inFrames(times(frames))).toEqual([1, 2, 4]);
    expect(inFrames([clock.now()])).toEqual([4]);
    await clock.sleep(100);
    expect(inFrames(times(frames))).toEqual([1, 2, 4, 5, 6]);
    expect(inFrames([clock.now()])).toEqual([6]);
    await clock.sleep(100);
    expect(inFrames([clock.now()])).toEqual([9]);
  });

  // Red if the pin's own unanswered read stops the run rather than being
  // taken again: the catch around the pin rethrows the retake as it is.
  it("takes a frame again when its animation pin goes unanswered on a page that answers", async () => {
    vi.useFakeTimers();
    let pins = 0;
    const { clock, frames } = setup({
      pin: (_, source) =>
        source !== PIN_ANIMATIONS
          ? ["http://x.test/login", "complete"]
          : ++pins === 1
            ? (new Promise(() => undefined) as never)
            : [],
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS);
    await slept;
    expect(failed).toBeNull();
    expect(inFrames(times(frames))).toEqual([2, 3]);
    expect(clock.retaken().map((r) => r.what)).toEqual([
      expect.stringMatching(/the animation pin went unanswered, though/),
    ]);
  });

  // Red if a retake inside a server stretch ends the stretch at the frame it
  // missed: the retake's frame, a frame on, would start a stretch of its own.
  it("keeps a server stretch going through a retake", async () => {
    vi.useFakeTimers();
    const { clock, frames } = setup({ waiting: () => true, ...hangsOnce(2) });
    await clock.hold(START);
    const slept = clock.sleep(400);
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS);
    await slept;
    // Premise: a frame of the stretch was taken again.
    expect(clock.retaken()).toHaveLength(1);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(clock.networkSpans()).toEqual([
      { startMs: 0, endMs: clock.now(), label: "POST /api/chat" },
    ]);
  });

  // A first screenshot still pending can hold the
  // retake's behind it. Red if the stop does not say the first was pending.
  it("says the first read was still unanswered when its retake goes unanswered too", async () => {
    vi.useFakeTimers();
    const { clock } = setup({
      pin: (_, source) =>
        source === PIN_ANIMATIONS ? [] : ["http://x.test/login", "complete"],
      shot: () => new Promise(() => undefined),
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(
      2 * (GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS),
    );
    await slept;
    expect(String(failed)).toMatch(
      /its screenshot went unanswered when the frame was taken again a frame of page time later, the first read still unanswered, though the page answered/,
    );
  });

  /** Screenshots by call: `late` ones answer after 1.5 waits, `hung` ones
   *  never, the rest at once; byte 0 is the call's number. A page whose
   *  second read answers unless `silentFrom` (that read and after hang). */
  const shots = (o: {
    late: number[];
    hung: number[];
    silentFrom?: number;
  }) => {
    let n = 0;
    let reads = 0;
    /** Set once the harness exists: a late answer moves its real clock by
     *  the time it took, as a real machine's does. */
    let advance: (ms: number) => void = () => undefined;
    return {
      calls: () => n,
      tick: (a: (ms: number) => void) => {
        advance = a;
      },
      pin: (_: number, source: string) =>
        source === PIN_ANIMATIONS
          ? []
          : ++reads >= (o.silentFrom ?? Number.POSITIVE_INFINITY)
            ? (new Promise(() => undefined) as never)
            : ["http://x.test/invoices", "complete"],
      shot: () => {
        const k = ++n;
        const shot = { bytes: new Uint8Array([k]), width: 2, height: 1 };
        if (o.hung.includes(k)) return new Promise<never>(() => undefined);
        return o.late.includes(k)
          ? new Promise<typeof shot>((r) =>
              setTimeout(() => {
                advance(1.5 * GRANT_EXPIRY_TIMEOUT_MS);
                r(shot);
              }, 1.5 * GRANT_EXPIRY_TIMEOUT_MS),
            )
          : Promise.resolve(shot);
      },
    };
  };

  // On nylon's CI, 2026-11-24, the retake's screenshot went
  // unanswered too, after the first had answered late. A screenshot waits
  // for the next frame drawn, so the first's picture shows the page at the
  // held time it answered: here after the retake's grant, a frame on. Red
  // if the run stops there, if the picture is filed at another time than
  // the one it shows, or if it goes unsaid.
  it("stands the first screenshot's late picture in when its retake goes unanswered too", async () => {
    vi.useFakeTimers();
    const page = shots({ late: [1], hung: [2] });
    const { clock, frames, advance } = setup(page);
    page.tick(advance);
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(
      2 * (GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS),
    );
    await slept;
    expect(failed).toBeNull();
    expect(clock.failed()).toBeNull();
    // Premise: the first was taken again, and the retake was asked.
    expect(page.calls()).toBeGreaterThanOrEqual(2);
    // The first's picture, at the time it shows; then the sleep's last.
    expect(inFrames(times(frames))).toEqual([2, 3]);
    expect(frames.map((f) => f.bytes[0])).toEqual([1, 3]);
    // One frame, one note, saying both.
    expect(clock.retaken().map((r) => r.what)).toEqual([
      expect.stringMatching(
        /^the page did not answer .*its screenshot went unanswered, though the page answered a second read.*; then the retake's screenshot went unanswered too \(.*\), and the first picture, answered \d+ ms after it was asked, stands for the frame during the opening, 67 ms into its load$/,
      ),
    ]);
    // Premise and measure: the first answered late, by the time it took.
    const ms = Number(
      /answered (\d+) ms after it was asked/.exec(
        clock.retaken()[0]?.what ?? "",
      )?.[1],
    );
    expect(ms).toBeGreaterThanOrEqual(1.5 * GRANT_EXPIRY_TIMEOUT_MS);
  });

  // Red if the hangs it took reach the
  // stretch it is part of: the frame after it then jumps page time by the
  // late answer's real time (the latency read from them, or the retake's
  // hang followed as the server's).
  it("keeps a server stretch's pace through a stand-in", async () => {
    vi.useFakeTimers();
    const page = shots({ late: [2], hung: [3] });
    const { clock, frames, advance } = setup({ waiting: () => true, ...page });
    page.tick(advance);
    await clock.hold(START);
    const slept = clock.sleep(400);
    await vi.advanceTimersByTimeAsync(
      2 * (GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS),
    );
    await slept;
    // Premise: the second frame was stood in for.
    expect(clock.retaken()[0]?.what ?? "").toContain("stands for the frame");
    const at = times(frames);
    const said = JSON.stringify(at);
    // Every frame of the stretch a frame or so after the one before: none
    // jumps the 22.5 s the late answer took.
    for (let i = 1; i < at.length; i++)
      expect((at[i] ?? 0) - (at[i - 1] ?? 0), said).toBeLessThan(
        4 * HELD_FRAME_MS,
      );
  });

  // Red if a retake whose second read went
  // unanswered (a script, or a page gone) is stood in for: that is a stop.
  it("stands nothing in when the retake's second read goes unanswered", async () => {
    vi.useFakeTimers();
    const { clock } = setup(shots({ late: [1], hung: [2], silentFrom: 2 }));
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(
      2 * (GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS),
    );
    await slept;
    expect(String(failed)).toMatch(
      /its screenshot went unanswered when the frame was taken again a frame of page time later, and a second read too/,
    );
  });

  // Red if it is allowed more than once a
  // run: a page whose screenshots keep hanging would crawl on, 30 s a frame.
  it("stands a late picture in once a run, and stops the second time", async () => {
    vi.useFakeTimers();
    const page = shots({ late: [1, 4], hung: [2, 5] });
    const { clock } = setup(page);
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(400).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(
      4 * (GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS),
    );
    await slept;
    // Premise: the second hang was reached.
    expect(page.calls()).toBeGreaterThanOrEqual(5);
    expect(clock.retaken()).toHaveLength(2);
    expect(String(failed)).toMatch(
      /its screenshot went unanswered when the frame was taken again a frame of page time later, though the page answered/,
    );
  });

  // On a slow runner Chrome refused one capture outright ("Unable
  // to capture screenshot") and the run gave way. Red if one refusal stops
  // the run, is not said, or the frame is filed at the time it was refused;
  // red if a second refusal does not stop it.
  const refused = () =>
    Promise.reject(
      new Error(
        "Protocol error (Page.captureScreenshot): Unable to capture screenshot",
      ),
    );
  it("takes a refused screenshot again once, a frame later, and says so", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { clock, frames } = setup({
      shot: () =>
        ++n === 1
          ? refused()
          : Promise.resolve({
              bytes: new Uint8Array([n]),
              width: 2,
              height: 1,
            }),
    });
    await clock.hold(START);
    await clock.sleep(100);
    expect(clock.failed()).toBeNull();
    // The retake is the frame after; the sleep's last frame follows it.
    expect(inFrames(times(frames))).toEqual([2, 3]);
    expect(clock.retaken().map((r) => r.what)).toEqual([
      expect.stringMatching(
        /its screenshot was refused \(Protocol error \(Page\.captureScreenshot\): Unable to capture screenshot\), though the page answered a second read$/,
      ),
    ]);
  });
  // Red if a refusal on a page that does not answer a
  // second read (gone, crashed) is retaken: the run would then stop on a
  // clock that could not move, not on the refusal.
  it("stops on a refusal at once when the page does not answer a second read", async () => {
    vi.useFakeTimers();
    const { clock, budgets } = setup({
      pin: (_, source) =>
        source === PIN_ANIMATIONS
          ? []
          : (new Promise(() => undefined) as never),
      shot: refused,
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(SECOND_READ_MS + 10);
    await slept;
    expect(String(failed)).toMatch(/Unable to capture screenshot/);
    expect(clock.retaken()).toEqual([]);
    // No retake's grant: only the frame's own.
    expect(budgets()).toHaveLength(1);
  });
  it("stops when the retake of a refused screenshot is refused too", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { clock } = setup({
      shot: () =>
        ++n <= 2
          ? refused()
          : Promise.resolve({
              bytes: new Uint8Array([n]),
              width: 2,
              height: 1,
            }),
    });
    await clock.hold(START);
    let failed: unknown = null;
    await clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    expect(String(failed)).toMatch(/Unable to capture screenshot/);
    expect(clock.retaken()).toHaveLength(1);
  });

  // Red if a page that does not answer a second read is taken again: that
  // one runs a script, and a frame of page time more cannot end it.
  it("takes no frame again on a page that does not answer a second read", async () => {
    vi.useFakeTimers();
    const { clock, budgets } = setup({
      pin: (_, source) =>
        source === PIN_ANIMATIONS ? [] : new Promise(() => undefined),
      shot: () => new Promise(() => undefined),
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS + SECOND_READ_MS);
    await slept;
    expect(String(failed)).toMatch(/and a second read too/);
    expect(budgets()).toHaveLength(1);
    expect(clock.retaken()).toEqual([]);
  });

  // Review of 2026-11-16: a grant does not expire while a navigation waits
  // on its server. Red if a slow server is blamed on Chrome, or stops the
  // run while its answer is still arriving.
  it("waits a grant out while a navigation waits on its server, and says the server when it went quiet", async () => {
    vi.useFakeTimers();
    let loading = true;
    const { clock } = setup({
      policy: (p) => (p.budget === undefined ? "expire" : "silent"),
      waiting: () => loading,
      loading: () => loading,
      waitsSince: () => ({ from: 0, labels: ["GET /slow"] }),
    });
    await clock.hold(START);
    let failed: unknown = null;
    const slept = clock.sleep(100).catch((e: unknown) => {
      failed = e;
    });
    await vi.advanceTimersByTimeAsync(2 * GRANT_EXPIRY_TIMEOUT_MS);
    expect(failed, "still waited on while the page waits").toBeNull();
    loading = false;
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS);
    await slept;
    expect(String(failed)).toMatch(
      /waiting on its server \(GET \/slow\), which had not answered 15 s on/,
    );
    expect(String(failed)).not.toMatch(/Chrome/);
  });

  // Review of Session C: a connection that keeps sending (a fetch stream)
  // re-armed the bound for good, so a grant that never expired hung the run.
  it("stops a grant that never expires though a stream stays open, when no document is loading", async () => {
    vi.useFakeTimers();
    const { clock } = setup({
      policy: (p) => (p.budget === undefined ? "expire" : "silent"),
      waiting: () => true,
      loading: () => false,
      waitsSince: () => ({ from: 0, labels: ["GET /stream"] }),
    });
    await clock.hold(START);
    const said = expect(clock.sleep(100)).rejects.toThrow(
      /did not move.*15 s on/,
    );
    await vi.advanceTimersByTimeAsync(GRANT_EXPIRY_TIMEOUT_MS);
    await said;
  });

  it("a frame listener's failure comes out of sleep", async () => {
    const { clock } = setup();
    clock.onFrame(async () => {
      throw new Error("disk full");
    });
    await clock.hold(START);
    await expect(clock.sleep(100)).rejects.toThrow("disk full");
  });

  it("refuses a frame no listener would file", async () => {
    const { clock, log } = setup({ listen: false });
    await clock.hold(START);
    await expect(clock.sleep(100)).rejects.toThrow(/no frame listener/);
    expect(log).toContain("capture"); // premise: a frame was taken
  });

  it("records an animation the page could not pin, at its held time", async () => {
    const { clock, frames } = setup({
      pin: (heldMs) => (heldMs < 34 ? ["fade on div: boom"] : []),
    });
    await clock.hold(START);
    await clock.sleep(100);
    expect(frames).toHaveLength(3); // premise: the pin ran three times
    expect(clock.unpinned()).toEqual([
      { atMs: frames[0]?.sourceTimeMs, what: "fade on div: boom" },
    ]);
  });

  it("says so when the pin cannot run at all", async () => {
    const { clock, frames } = setup({
      pin: () => {
        throw new Error("Execution context was destroyed");
      },
    });
    await clock.hold(START);
    await expect(clock.sleep(100)).rejects.toThrow(
      /could not pin the page's animations during the opening, 33 ms into its load.*Execution context was destroyed/,
    );
    expect(frames).toHaveLength(0);
  });

  it("says so when the pin answers no list", async () => {
    const { clock } = setup({ pin: () => undefined });
    await clock.hold(START);
    await expect(clock.sleep(100)).rejects.toThrow(
      /answered undefined, not the animations it could not pin/,
    );
  });

  // Ahead of real time, an autoplaying video never had the data
  // to start, and stood on its first frame (compare/held-probe-video.mjs).
  it("lets no frame run ahead of real time while a video plays or waits to", async () => {
    const video = (from: number) =>
      setup({
        pin: (heldMs) => ({ said: [], video: heldMs >= from }) as never,
      });
    const quiet = video(Number.POSITIVE_INFINITY);
    await quiet.clock.hold(START);
    await quiet.clock.sleep(200);
    // Premise: with no video the clock waits no real time of its own.
    expect(quiet.log.filter((l) => l.startsWith("wait"))).toEqual([]);

    const { clock, log, frames } = video(2 * HELD_FRAME_MS - 1e-6);
    await clock.hold(START);
    await clock.sleep(200);
    expect(times(frames).length).toBeGreaterThan(4); // premise: frames after it
    // Seen at frame 2: every grant after it waits its frame out in real time.
    const waits = log
      .filter((l) => l.startsWith("wait"))
      .map((l) => Number(l.slice(5)));
    expect(waits.length).toBe(frames.length - 2);
    for (const w of waits) expect(w).toBeCloseTo(HELD_FRAME_MS, 6);
  });

  // Review of 2026-11-19: real time the clock fell behind was caught up by
  // grants with no wait, which play the video in slow motion. Red if more
  // than the one grant after a slow capture goes unwaited.
  it("skips real time it fell behind once, and paces the frames after it", async () => {
    const { clock, log, frames } = setup({
      pin: () => ({ said: [], video: true }) as never,
      captureMs: (shot) => (shot === 3 ? 200 : 0),
    });
    await clock.hold(START);
    await clock.sleep(300);
    // Premise: a slow capture, with frames after it.
    expect(frames.length).toBeGreaterThan(6);
    const waits = log
      .filter((l) => l.startsWith("wait"))
      .map((l) => Number(l.slice(5)));
    // From the first frame on, every grant waits but the one after the
    // 200 ms capture, and each waits one frame.
    expect(waits.length).toBe(frames.length - 2);
    for (const w of waits) expect(w).toBeCloseTo(HELD_FRAME_MS, 6);
  });

  it("refuses to move a clock it has not held", async () => {
    const { clock, policies } = setup();
    await expect(clock.sleep(100)).rejects.toThrow(/before hold/);
    expect(policies).toHaveLength(0);
  });
});

describe("PIN_ANIMATIONS", () => {
  class DocumentTimeline {}
  const animation = (
    endTime: unknown,
    extra: Record<string, unknown> = {},
  ) => ({
    currentTime: null as number | null,
    playState: "running",
    paused: false,
    finishes: 0,
    timeline: new DocumentTimeline() as object,
    effect: {
      getComputedTiming: () => ({ endTime }),
      target: { tagName: "DIV" },
    },
    pause() {
      this.paused = true;
      this.playState = "paused";
    },
    finish() {
      this.finishes++;
      this.playState = "finished";
    },
    ...extra,
  });
  const pinner = (list: unknown[], window: object = {}) => {
    const pin = new Function(
      "document",
      "DocumentTimeline",
      "window",
      "getComputedStyle",
      `return (${PIN_ANIMATIONS})`,
    )(
      { getAnimations: () => list, querySelectorAll: () => [] },
      DocumentTimeline,
      window,
      () => ({ animationName: "", animationPlayState: "running" }),
    ) as (heldMs: number) => { said: string[] };
    return (heldMs: number) => pin(heldMs).said;
  };

  /** The pin over one <video>, with what it answers whole. */
  const videoPin = (video: object) =>
    new Function(
      "document",
      "DocumentTimeline",
      "window",
      `return (${PIN_ANIMATIONS})`,
    )(
      {
        getAnimations: () => [],
        querySelectorAll: (s: string) => (s === "video" ? [video] : []),
      },
      DocumentTimeline,
      {},
    ) as (heldMs: number) => { said: string[]; video: boolean };

  // An autoplaying video short of the data to play through waits
  // to start; the clock paces it, and one that never starts is said.
  it("answers a video waiting to start, and says one that waited 3 s", () => {
    const waiting = {
      paused: true,
      ended: false,
      autoplay: true,
      played: { length: 0 },
      readyState: 3,
      networkState: 2, // NETWORK_LOADING
      error: null as object | null,
      currentTime: 0,
    };
    const pin = videoPin(waiting);
    const answers = Array.from({ length: 100 }, (_, k) => pin(k * 33));
    expect(answers.every((a) => a.video)).toBe(true);
    expect(answers.flatMap((a, k) => a.said.map((w) => `${k}: ${w}`))).toEqual([
      "89: a video waited 3 s for its data and had not started playing",
    ]);
    // Paused by the page, never asked to play, or not fetching (a broken
    // source, one Chrome stopped loading): no pace, nothing said.
    for (const paused of [
      { ...waiting, played: { length: 1 } },
      { ...waiting, autoplay: false },
      { ...waiting, readyState: 4 },
      { ...waiting, error: { code: 4 } },
      { ...waiting, networkState: 1 },
    ])
      expect(videoPin(paused)(0)).toEqual({ said: [], video: false });
  });

  // The waits are times, so at 60 fps they count twice the pins.
  // Red if the script built for a frame length counts 30 fps pins.
  it("says a video that waited 3 s, and one stopped for half a second, at any frame length", () => {
    const pinOf = (frameMs: number, video: object) =>
      new Function(
        "document",
        "DocumentTimeline",
        "window",
        `return (${pinAnimationsScript(frameMs)})`,
      )(
        {
          getAnimations: () => [],
          querySelectorAll: (s: string) => (s === "video" ? [video] : []),
        },
        DocumentTimeline,
        {},
      ) as (heldMs: number) => { said: string[]; video: boolean };
    const waiting = () => ({
      paused: true,
      ended: false,
      autoplay: true,
      played: { length: 0 },
      readyState: 3,
      networkState: 2,
      error: null,
      currentTime: 0,
    });
    const stopped = () => ({
      paused: false,
      ended: false,
      currentTime: 1,
      duration: 4,
      readyState: 2,
      networkState: 2,
      buffered: { length: 0 },
    });
    /** The pin numbers (from 1) each sentence was said at. */
    const saidAt = (frameMs: number, video: object, n: number) => {
      const pin = pinOf(frameMs, video);
      return Array.from({ length: n }, (_, k) =>
        pin((k + 1) * frameMs).said.map((w) => `${k + 1}: ${w}`),
      ).flat();
    };
    for (const [frameMs, pins] of [
      [1000 / 30, 90],
      [1000 / 60, 180],
    ] as const) {
      expect(saidAt(frameMs, waiting(), 200), String(frameMs)).toEqual([
        `${pins}: a video waited 3 s for its data and had not started playing`,
      ]);
      expect(
        saidAt(frameMs, stopped(), 200).filter((w) => w.includes("stopped")),
        String(frameMs),
      ).toEqual([
        `${pins / 6}: a video stopped on one frame while playing (at 1.00 s of 4.00, readyState 2, buffered to 0.00 s, networkState 2)`,
      ]);
    }
  });

  // Review of 2026-11-19: a video that played kept the playing entry, with
  // no wait count, so its wait for a new source was never said.
  it("says a video that played and then waits on a new source", () => {
    const clip = {
      paused: false,
      ended: false,
      autoplay: true,
      played: { length: 1 },
      readyState: 4,
      networkState: 1,
      error: null,
      currentTime: 0,
    };
    const pin = videoPin(clip);
    // Premise: it was seen playing first.
    expect(pin(0)).toEqual({
      said: ["a playing video runs on its own clock: it was not held"],
      video: true,
    });
    // The page sets a new src: nothing played of it, and it loads.
    Object.assign(clip, {
      paused: true,
      played: { length: 0 },
      readyState: 1,
      networkState: 2,
    });
    const said = Array.from({ length: 95 }, (_, k) =>
      pin((k + 1) * 33),
    ).flatMap((a) => a.said);
    expect(said).toEqual([
      "a video waited 3 s for its data and had not started playing",
    ]);
  });

  // A page that replaced querySelectorAll stopped every held run
  // ("could not pin the page's animations ... hostile page").
  it("finds the page's videos with the querySelectorAll the page started with", () => {
    const video = { paused: false, ended: false, currentTime: 0 };
    const document = {
      getAnimations: () => [],
      querySelectorAll: (s: string) => (s === "video" ? [video] : []),
    };
    const window: Record<string, unknown> = {
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
      frames: [],
    };
    window.parent = window;
    new Function("window", "document", HELD_FRAMES_SCRIPT)(window, document);
    document.querySelectorAll = () => {
      throw new Error("hostile page");
    };
    const pin = new Function(
      "document",
      "DocumentTimeline",
      "window",
      `return (${PIN_ANIMATIONS})`,
    )(document, DocumentTimeline, window) as (heldMs: number) => unknown;
    expect(pin(40)).toEqual({
      said: ["a playing video runs on its own clock: it was not held"],
      video: true,
    });
  });

  // R4: one page call a frame, the page's animation frames before the pin.
  it("runs the page's animation frames before it pins", () => {
    const order: string[] = [];
    const fade = animation(300, {
      pause() {
        order.push("pin");
      },
    });
    const said = pinner([fade], {
      __demomanFlushFrames: (v: number) => {
        order.push(`frames at ${v}`);
        return [
          "a frame from https://x.example runs its animations on its own clock: they were not held",
        ];
      },
    })(40);
    expect(order).toEqual(["frames at 40", "pin"]);
    // What the frames could not hold is answered with what the pin could not.
    expect(said).toEqual([
      "a frame from https://x.example runs its animations on its own clock: they were not held",
    ]);
  });

  it("starts an animation at the held time it is first seen, and finishes it at its end", () => {
    const list: ReturnType<typeof animation>[] = [];
    const pin = pinner(list);
    const fade = animation(300);
    const spinner = animation(Number.POSITIVE_INFINITY);
    list.push(fade);
    expect(pin(100)).toEqual([]);
    expect([fade.paused, fade.currentTime]).toEqual([true, 0]);
    list.push(spinner);
    pin(200);
    expect([fade.currentTime, spinner.currentTime]).toEqual([100, 0]);
    pin(400);
    expect(fade.finishes).toBe(1);
    expect(spinner.currentTime).toBe(200);
    expect(pin(500)).toEqual([]);
    expect(fade.finishes).toBe(1);
    expect(spinner.currentTime).toBe(300);
  });

  it("pins a finished animation again when the page plays it again", () => {
    const fade = animation(300);
    const pin = pinner([fade]);
    pin(100);
    pin(400);
    expect([fade.finishes, fade.playState]).toEqual([1, "finished"]);
    fade.playState = "running"; // the page's play(): back to its start
    fade.currentTime = 0;
    pin(600);
    expect([fade.playState, fade.currentTime]).toEqual(["paused", 0]);
    pin(700);
    expect(fade.currentTime).toBe(100);
    pin(1000);
    expect(fade.finishes).toBe(2);
  });

  it("leaves a scroll-driven animation to the scroll", () => {
    const scrolled = animation({ unit: "percent" }, { timeline: {} });
    expect(pinner([scrolled])(100)).toEqual([]);
    expect([scrolled.paused, scrolled.currentTime, scrolled.finishes]).toEqual([
      false,
      null,
      0,
    ]);
  });

  it("names an animation it cannot pin, once, and pins the rest", () => {
    const bad = animation(300, { animationName: "fade" });
    Object.defineProperty(bad, "currentTime", {
      set() {
        throw new TypeError("currentTime must be a percentage");
      },
    });
    const stuck = animation(100, {
      id: "rate0",
      finish() {
        throw new Error("InvalidStateError: playbackRate is 0");
      },
    });
    const good = animation(Number.POSITIVE_INFINITY, {
      transitionProperty: "opacity",
    });
    const pin = pinner([bad, stuck, good]);
    expect(pin(0)).toEqual(["fade on div: currentTime must be a percentage"]);
    expect(good.currentTime).toBe(0);
    expect(pin(200)).toEqual([
      "rate0 on div: InvalidStateError: playbackRate is 0",
    ]);
    expect(pin(300)).toEqual([]);
    expect(good.currentTime).toBe(300);
  });
});

describe("HELD_FRAMES_SCRIPT", () => {
  const F = 1000 / 30;
  /** A document started at held time `startMs`, with Chrome's own animation
   *  frames (which never fire here) and `performance.now()` read `jitter` ms
   *  off, as Chrome's 100 µs clamp does differently each run. */
  function page(
    o: {
      startMs?: number;
      jitter?: number;
      frames?: object[];
      elements?: object[];
      parent?: object;
      /** The page script (default: the 30 fps one). */
      script?: string;
    } = {},
  ) {
    let heldMs = 0;
    const native: unknown[] = [];
    const reported: unknown[] = [];
    const window: Record<string, unknown> = {
      requestAnimationFrame: (cb: unknown) => native.push(cb),
      cancelAnimationFrame: () => undefined,
      frames: o.frames ?? [],
    };
    window.parent = o.parent ?? window;
    new Function(
      "window",
      "performance",
      "reportError",
      "document",
      "location",
      o.script ?? HELD_FRAMES_SCRIPT,
    )(
      window,
      { now: () => heldMs - (o.startMs ?? 0) + (o.jitter ?? 0) },
      (e: unknown) => reported.push(e),
      { querySelectorAll: () => o.elements ?? [] },
      { href: "http://127.0.0.1:3000/" },
    );
    const raf = window.requestAnimationFrame as (
      cb: (t: number) => void,
    ) => number;
    const cancel = window.cancelAnimationFrame as (id: number) => void;
    const flushAt = (v: number) => {
      heldMs = v;
      return (window.__demomanFlushFrames as (v: number) => string[])(v);
    };
    return { window, raf, cancel, flushAt, native, reported };
  }

  /** The script run on a window that already has its scroll functions. */
  function pageWith(window: Record<string, unknown>) {
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => undefined;
    window.frames = [];
    window.parent = window;
    new Function(
      "window",
      "performance",
      "reportError",
      "document",
      "location",
      HELD_FRAMES_SCRIPT,
    )(window, { now: () => 0 }, () => undefined, {}, { href: "http://x/" });
    return {
      scrollTo: (o: { top: number; behavior?: string }) =>
        (window.scrollTo as (o: unknown) => void).call(window, o),
      flushAt: (v: number) =>
        (window.__demomanFlushFrames as (v: number) => string[])(v),
    };
  }

  it("runs the page's frame callbacks once per frame, on the document's held clock", () => {
    const p = page({ startMs: 10 * F });
    const seen: number[] = [];
    p.raf((t) => seen.push(t));
    p.raf((t) => seen.push(t + 0.5));
    expect(seen).toEqual([]);
    p.flushAt(11 * F);
    expect(seen[0]).toBeCloseTo(F, 9);
    expect(seen[1]).toBeCloseTo(F + 0.5, 9);
    p.flushAt(12 * F);
    expect(seen).toHaveLength(2);
    expect(p.native).toEqual([]); // premise: Chrome's own was never asked
  });

  // The page's frame is the clock's. A document started on a
  // frame of 60 that is not one of 30 reads its start on 60's grid only if
  // the script steps the frame it was built for.
  it("puts the document's start on the grid of the frame it was built for", () => {
    const F60 = 1000 / 60;
    expect(HELD_FRAMES_SCRIPT).toBe(heldFramesScript(HELD_FRAME_MS));
    expect(heldFramesScript(F60)).toContain(`const FRAME = ${F60};`);
    const startAt = (script: string) => {
      const p = page({ startMs: 3 * F60, jitter: 0.3, script });
      const seen: number[] = [];
      p.raf((t) => seen.push(t));
      p.flushAt(6 * F60);
      return seen[0];
    };
    expect(startAt(heldFramesScript(F60))).toBeCloseTo(3 * F60, 9);
    // Positive control: the 30 fps script snaps the same start to 33.3 ms.
    expect(startAt(HELD_FRAMES_SCRIPT)).toBeCloseTo(6 * F60 - F, 9);
  });

  // Fix round 1, finding 5: a callback's timestamp is the same number in
  // every run, whatever Chrome's clamp read for performance.now().
  it("hands every run the same timestamps, however performance.now() jitters", () => {
    const run = (jitter: number) => {
      const p = page({ startMs: 10 * F, jitter });
      const seen: number[] = [];
      const loop = (t: number) => {
        seen.push(t);
        p.raf(loop);
      };
      p.raf(loop);
      for (let k = 11; k <= 40; k++) p.flushAt(k * F);
      return seen;
    };
    const one = run(0.1);
    const two = run(-0.1);
    expect(one).toHaveLength(30); // premise: thirty frames ran
    expect(two).toEqual(one);
    expect(one[29]).toBeCloseTo(30 * F, 9);
  });

  it("runs a frame a callback asks for on the next frame, not this one", () => {
    const p = page();
    const seen: number[] = [];
    const loop = (t: number) => {
      seen.push(t);
      p.raf(loop);
    };
    p.raf(loop);
    p.flushAt(F);
    p.flushAt(2 * F);
    expect(seen).toHaveLength(2);
    expect((seen[1] ?? 0) - (seen[0] ?? 0)).toBeCloseTo(F, 9);
  });

  it("cancels a frame, also one due in the frame being run", () => {
    const p = page();
    const seen: string[] = [];
    let second = 0;
    p.raf(() => {
      seen.push("a");
      p.cancel(second);
    });
    second = p.raf(() => seen.push("b"));
    const third = p.raf(() => seen.push("c"));
    p.cancel(third);
    p.flushAt(F);
    expect(seen).toEqual(["a"]);
  });

  it("reports a callback that throws, and runs the rest", () => {
    const p = page();
    const seen: string[] = [];
    const boom = new Error("boom");
    p.raf(() => {
      throw boom;
    });
    p.raf(() => seen.push("after"));
    p.flushAt(F);
    expect(seen).toEqual(["after"]);
    expect(p.reported).toEqual([boom]);
  });

  it("runs its own frames' frames at the same held time", () => {
    const ran: number[] = [];
    const child = {
      __demomanFlushFrames: (v: number) => {
        ran.push(v);
        return [];
      },
    };
    const p = page({ frames: [child] });
    expect(p.flushAt(3 * F)).toEqual([]);
    expect(ran).toEqual([3 * F]);
  });

  // Fix round 1, finding 1: a frame of another origin kept in this renderer
  // is said, once, by the address its element names.
  // The author's ruling, 2026-11-16: smooth scrolling is off on a held
  // clock, and nothing said an app's own smooth scroll showed as a jump.
  // Red if it is not said, said twice, or said for a scroll that is not
  // smooth or moved nothing.
  it("says a smooth scroll the page asked for, once, when it moved", () => {
    const w: Record<string, unknown> & {
      scrollY: number;
      scrollTo: (o: { top: number; behavior?: string }) => void;
    } = { scrollX: 0, scrollY: 0, scrollTo: () => undefined };
    const scrolled: number[] = [];
    w.scrollTo = (o) => {
      scrolled.push(o.top);
      w.scrollY = o.top;
    };
    const q = pageWith(w);
    q.scrollTo({ top: 300, behavior: "instant" });
    q.scrollTo({ top: 300, behavior: "smooth" });
    expect(q.flushAt(F)).toEqual([]);
    q.scrollTo({ top: 900, behavior: "smooth" });
    expect(scrolled).toEqual([300, 300, 900]);
    expect(q.flushAt(2 * F)).toEqual([
      "the page asked for a smooth scroll, which the held clock does not play: it showed as a jump",
    ]);
    q.scrollTo({ top: 0, behavior: "smooth" });
    expect(q.flushAt(3 * F)).toEqual([]);
  });

  it("names a frame it cannot reach, once", () => {
    const foreign = {
      get __demomanFlushFrames(): never {
        throw new Error("SecurityError: cross-origin");
      },
    };
    const sandboxed = {
      get __demomanFlushFrames(): never {
        throw new Error("SecurityError: sandboxed");
      },
    };
    const p = page({
      frames: [foreign, sandboxed],
      elements: [
        {
          contentWindow: foreign,
          getAttribute: () => "http://127.0.0.1:6006/chart",
        },
        { contentWindow: sandboxed, getAttribute: () => null },
      ],
    });
    expect(p.flushAt(F)).toEqual([
      "a frame from http://127.0.0.1:6006 runs its animations on its own clock: they were not held",
      "a sandboxed frame runs its animations on its own clock: they were not held",
    ]);
    expect(p.flushAt(2 * F)).toEqual([]);
  });

  // Fix round 1, finding 1: no one would run such a frame's queue, so it
  // keeps Chrome's own frames rather than freezing.
  it("leaves Chrome's own frames to a frame whose parent it cannot reach", () => {
    const parent = {
      get document(): never {
        throw new Error("SecurityError: cross-origin");
      },
    };
    const p = page({ parent });
    expect(p.window.__demomanFlushFrames).toBeUndefined();
    p.raf(() => undefined);
    expect(p.native).toHaveLength(1);
  });

  // Fix round 2: a frame inside one that kept Chrome's frames is reachable
  // from its parent, but no queue of its would ever be run there.
  it("leaves Chrome's own frames to a frame whose parent runs no queue", () => {
    const p = page({ parent: {} });
    expect(p.window.__demomanFlushFrames).toBeUndefined();
    p.raf(() => undefined);
    expect(p.native).toHaveLength(1);
  });

  it("keeps Chrome's own frames for Demoman's probes", () => {
    const p = page();
    (p.window.__demomanRaf as (cb: unknown) => void)("probe");
    expect(p.native).toEqual(["probe"]);
  });

  it("installs once a document", () => {
    const p = page();
    const raf = p.window.requestAnimationFrame;
    new Function(
      "window",
      "performance",
      "reportError",
      "document",
      "location",
      HELD_FRAMES_SCRIPT,
    )(p.window, { now: () => 0 }, () => undefined, {}, {});
    expect(p.window.requestAnimationFrame).toBe(raf);
  });
});
