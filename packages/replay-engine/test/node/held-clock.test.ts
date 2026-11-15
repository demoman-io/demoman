import { afterEach, describe, expect, it, vi } from "vitest";
import { GRANT_EXPIRY_TIMEOUT_MS } from "../../src/held-clock.js";
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
    ignored: () => [],
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
  return { clock, frames, policies, budgets, log, pins, listeners };
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
    expect(policies.every((p) => p.policy === "pause")).toBe(true);
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
    // The first grant has no real time behind it yet (the 1 ms floor); each
    // after is the 200 ms the capture before it took, the last cut at 1000.
    expect(times(frames)).toEqual([1, 201, 401, 601, 801, 1000]);
    expect(budgets()).toEqual([1, 200, 200, 200, 200, 199]);
    expect(clock.now()).toBe(1000);
    expect(clock.networkSpans()).toEqual([
      { startMs: 0, endMs: 1000, label: "POST /api/chat" },
    ]);
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

  it("refuses to move a clock it has not held", async () => {
    const { clock, policies } = setup();
    await expect(clock.sleep(100)).rejects.toThrow(/before hold/);
    expect(policies).toHaveLength(0);
  });
});

describe("PIN_ANIMATIONS", () => {
  const animation = (endTime: number) => ({
    currentTime: null as number | null,
    paused: false,
    finishes: 0,
    effect: { getComputedTiming: () => ({ endTime }) },
    pause() {
      this.paused = true;
    },
    finish() {
      this.finishes++;
    },
  });

  it("starts an animation at the held time it is first seen, and finishes it at its end", () => {
    const list: ReturnType<typeof animation>[] = [];
    const pin = new Function("document", `return (${PIN_ANIMATIONS})`)({
      getAnimations: () => list,
    }) as (heldMs: number) => void;
    const fade = animation(300);
    const spinner = animation(Number.POSITIVE_INFINITY);
    list.push(fade);
    pin(100);
    expect([fade.paused, fade.currentTime]).toEqual([true, 0]);
    list.push(spinner);
    pin(200);
    expect([fade.currentTime, spinner.currentTime]).toEqual([100, 0]);
    pin(400);
    expect(fade.finishes).toBe(1);
    expect(spinner.currentTime).toBe(200);
    pin(500);
    expect(fade.finishes).toBe(1);
    expect(spinner.currentTime).toBe(300);
  });
});
