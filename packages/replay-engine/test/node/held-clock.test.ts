import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRANT_EXPIRY_TIMEOUT_MS,
  HELD_FRAMES_SCRIPT,
} from "../../src/held-clock.js";
import {
  createHeldClock,
  HELD_FRAME_MS,
  type HeldFrame,
  type NetworkWatch,
  PIN_ANIMATIONS,
} from "../../src/index.js";
import type { CdpSession } from "../../src/types.js";

const START = Date.parse("2026-11-15T12:00:00Z");

function setup(
  o: {
    waiting?: (real: number) => boolean;
    captureMs?: number;
    policy?: (
      params: Record<string, unknown>,
    ) => "expire" | "silent" | "refuse";
    listen?: boolean;
    /** What the page answers the pin with (default: nothing it could not pin). */
    pin?: (heldMs: number) => unknown;
    /** What the network watch says it stopped counting. */
    ignored?: string[];
    /** The real time the wait ended, once it has (`NetworkWatch.quietSince`). */
    quietSince?: (real: number) => number | null;
  } = {},
) {
  const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  const policies: Record<string, unknown>[] = [];
  const log: string[] = [];
  const pins: { source: string; arg: number }[] = [];
  let real = 0;
  let shots = 0;
  const cdp: CdpSession = {
    async send(method, params = {}) {
      if (method !== "Emulation.setVirtualTimePolicy") return {};
      policies.push(params);
      // As Chrome answers (measured 2026-11-15, apps/runner/compare/held-probe-basics.mjs).
      if (params.policy === "pause" && params.budget !== undefined)
        throw new Error("Can only specify budget for non-Pause policy");
      const answer = o.policy?.(params) ?? "expire";
      if (answer === "refuse") throw new Error("Target closed");
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
    labels: () => ["POST /api/chat"],
    ignored: () => o.ignored ?? [],
    quietSince: () => o.quietSince?.(real) ?? null,
    stop() {},
  };
  const clock = createHeldClock({
    cdp,
    network,
    realNow: () => real,
    capture: async () => {
      log.push("capture");
      real += o.captureMs ?? 0;
      return { bytes: new Uint8Array([++shots]), width: 2, height: 1 };
    },
    evaluate: async (source, arg) => {
      log.push(`pin ${arg}`);
      pins.push({ source, arg });
      return o.pin ? o.pin(arg) : [];
    },
  });
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
  return { clock, frames, policies, budgets, log, pins, listeners, advance };
}

const times = (frames: HeldFrame[]) => frames.map((f) => f.sourceTimeMs);
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
    expect(log).toEqual(
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
    // The stretch's first grant takes the 1 ms floor; each after is the 200 ms
    // the capture before it took, the last cut at 1000.
    expect(times(frames)).toEqual([1, 201, 401, 601, 801, 1000]);
    expect(budgets()).toEqual([1, 200, 200, 200, 200, 199]);
    expect(clock.now()).toBe(1000);
    expect(clock.networkSpans()).toEqual([
      { startMs: 0, endMs: 1000, label: "POST /api/chat" },
    ]);
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
    expect(budgets()).toHaveLength(3 + 6); // premise: three held grants first
    expect(budgets().slice(3, 5)).toEqual([1, 200]);
    expect(times(frames).slice(3, 5)).toEqual([101, 301]);
  });

  it("keeps one stretch for a wait that runs across sleeps", async () => {
    const { clock, frames } = setup({ waiting: () => true, captureMs: 200 });
    await clock.hold(START);
    await clock.sleep(100 / 3);
    await clock.sleep(1000 / 3);
    expect(frames.length).toBeGreaterThan(2); // premise: both sleeps waited
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
    expect(times(frames).slice(0, 2)).toEqual([1, 201]);
    const held = frames.slice(2);
    expect(held).toHaveLength(24); // frames 7..30 of the grid
    expect(held.every((f) => onGrid(f.sourceTimeMs))).toBe(true);
    expect(held[0]?.sourceTimeMs).toBeCloseTo(7 * HELD_FRAME_MS, 6);
    expect(
      budgets()
        .slice(2)
        .every((b) => b <= HELD_FRAME_MS + 1e-9),
    ).toBe(true);
    expect(clock.networkSpans()).toEqual([
      { startMs: 0, endMs: 201, label: "POST /api/chat" },
    ]);
  });

  // Fix round 1, finding 3: the old page of a navigation to another site
  // answers no page call until the new one commits, so the server's wait
  // can end while a frame is being taken. The stretch follows it to its end.
  it("follows a wait that ended while a frame was taken, to its end", async () => {
    const { clock, frames, budgets } = setup({
      waiting: (real) => real < 300,
      quietSince: (real) => (real >= 300 ? 300 : null),
      captureMs: 200,
    });
    await clock.hold(START);
    await clock.sleep(1000);
    // Premise: the wait ended during the second frame's capture (real 200-400).
    expect(times(frames).slice(0, 2)).toEqual([1, 201]);
    // The stretch lasts the wait's 300 ms of real time, the 1 ms floor in it.
    expect(budgets().slice(0, 3)).toEqual([1, 200, 99]);
    expect(clock.networkSpans()).toEqual([
      { startMs: 0, endMs: 300, label: "POST /api/chat" },
    ]);
    // Then the held grid again.
    const after = frames.slice(3);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((f) => onGrid(f.sourceTimeMs))).toBe(true);
  });

  it("names the connections the network watch stopped counting", () => {
    const { clock } = setup({ ignored: ["GET /poll"] });
    expect(clock.ignoredConnections()).toEqual(["GET /poll"]);
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
      /could not pin the page's animations at 33\.3\d* ms.*Execution context was destroyed/,
    );
    expect(frames).toHaveLength(0);
  });

  it("says so when the pin answers no list", async () => {
    const { clock } = setup({ pin: () => undefined });
    await clock.hold(START);
    await expect(clock.sleep(100)).rejects.toThrow(/not a list/);
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
  const pinner = (list: unknown[], window: object = {}) =>
    new Function(
      "document",
      "DocumentTimeline",
      "window",
      `return (${PIN_ANIMATIONS})`,
    )({ getAnimations: () => list }, DocumentTimeline, window) as (
      heldMs: number,
    ) => string[];

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
      HELD_FRAMES_SCRIPT,
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
