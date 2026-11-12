import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import type { EngineDeps, PageAgent } from "../../src/index.js";
import {
  createInputGate,
  PAGE_CAPTURE_HOLD,
  PAGE_CAPTURE_RELEASE,
  runReplay,
  STEP_REQUEST_CAP_MS,
  STEP_SETTLE_MARKER,
  STILL_DRAIN_MS,
} from "../../src/index.js";
import { ECHO_WINDOW_MS } from "../../src/step-settle.js";
import {
  type CdpFake,
  createCdpFake,
  fakeScreenshotBase64,
} from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { scene } from "../helpers/replay-scene";

/**
 * Every way a step's settle and page screen can fail, against the fake CDP:
 * each says what happened on the screen and as a `stepUnsettled` (the page's
 * own doing) or a `stepSettleFailed` (this machine's), and none fails the
 * take (CLAUDE.md, "Report before you forgive").
 */

type Send = CdpFake["send"];

function deps(over: Partial<EngineDeps> = {}): EngineDeps & { cdp: CdpFake } {
  const cdp = createCdpFake();
  const page: PageAgent = {
    resolve: async (anchors) =>
      anchors.map((a) => ({
        anchorId: a.id,
        strategy: "stableId" as const,
        resolved: true,
        failureReason: null,
      })),
  };
  let clock = 0;
  return {
    page,
    encoder: {
      openSpan: vi.fn(),
      push: vi.fn(async () => undefined),
      closeSpan: vi.fn(async () => null),
      queueDepth: () => 0,
      heapFraction: () => 0.1,
    },
    store: createMemoryFrameStore(),
    clock: {
      now: () => (clock += 10),
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
    mayReplay: true,
    madeFrom: madeFromOf(scene()),
    recording: "continuous",
    ...over,
    cdp,
  };
}

/** Replaces the fake's answer to the calls `pick` claims. */
function intercept(
  d: { cdp: CdpFake },
  pick: (method: string, params: Record<string, unknown>) => boolean,
  answer: Send,
): void {
  const send = d.cdp.send.bind(d.cdp);
  d.cdp.send = async (method, params = {}) =>
    pick(method, params) ? answer(method, params) : send(method, params);
}

const isEval =
  (expression: string) => (m: string, p: Record<string, unknown>) =>
    m === "Runtime.evaluate" && p.expression === expression;
const isPng = (m: string, p: Record<string, unknown>) =>
  m === "Page.captureScreenshot" && p.format === "png";

async function screensOf(d: EngineDeps & { cdp: CdpFake }) {
  const result = await runReplay(scene(), d);
  const screens = result.bundle?.pageScreens ?? [];
  const said = result.degradations.filter(
    (x) =>
      x.kind === "stepUnsettled" ||
      x.kind === "stepSettleFailed" ||
      x.kind === "pageHoldNotReleased",
  );
  const evidence = JSON.stringify({ screens, said, reason: result.reason });
  // Every case: the take completes and has its three screens (the opening
  // and one after each of the two clicks), each said once.
  expect(result.outcome, evidence).toBe("complete");
  expect(result.reason, evidence).toBeNull();
  expect(
    screens.map((s) => s.after),
    evidence,
  ).toEqual([0, 1, 2]);
  return { result, screens, said, evidence };
}

/** The kind each step's settle was said as, in order. */
const kinds = (said: { kind: string }[]) => [
  ...new Set(said.map((x) => x.kind)),
];

describe("a step's page screen, when something fails", () => {
  it("settles and captures cleanly against the fake (the control)", async () => {
    const { screens, said, evidence } = await screensOf(deps());
    expect(said, evidence).toEqual([]);
    expect(
      screens.every((s) => s.unsettled === undefined && s.ref !== ""),
      evidence,
    ).toBe(true);
  });

  it("says requests could not be watched when Network.enable is refused", async () => {
    const d = deps();
    intercept(
      d,
      (m) => m === "Network.enable",
      async () => {
        throw new Error("Network domain refused");
      },
    );
    const { screens, said, evidence } = await screensOf(d);
    for (const s of screens) {
      expect(s.unsettled, evidence).toBe(
        "requests could not be watched (Network domain refused)",
      );
      // The screen itself was still taken.
      expect(s.ref, evidence).not.toBe("");
    }
    expect(said, evidence).toHaveLength(3);
    expect(said[0]?.note, evidence).toMatch(/^the opening page: requests/);
    // Red if a refused Network domain is said as the page's: refresh would
    // not record again, and would blame the page.
    expect(kinds(said), evidence).toEqual(["stepSettleFailed"]);
  });

  it("says the page screen could not be taken when the hold throws in the page", async () => {
    const d = deps();
    intercept(d, isEval(PAGE_CAPTURE_HOLD), async () => ({
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "TypeError: getAnimations is broken" },
      },
    }));
    const { screens, said, evidence } = await screensOf(d);
    for (const s of screens) {
      expect(s.unsettled, evidence).toBe(
        "the page screen could not be taken (TypeError: getAnimations is broken)",
      );
      expect(s.ref, evidence).toBe("");
    }
    expect(kinds(said), evidence).toEqual(["stepSettleFailed"]);
  });

  // Red if a caret the hold could not hide is compared: it blinks, so the
  // same page reads changed (DEM-139).
  it("says so when a focused field's caret could not be hidden", async () => {
    const d = deps();
    intercept(d, isEval(PAGE_CAPTURE_HOLD), async () => ({
      result: {
        type: "object",
        value: {
          held: 0,
          caretShown: true,
          x: 0,
          y: 0,
          width: 1280,
          height: 800,
          dpr: 3,
        },
      },
    }));
    const { screens, said, evidence } = await screensOf(d);
    // The page's own: a caret it shows whatever the hold asks.
    expect(kinds(said), evidence).toEqual(["stepUnsettled"]);
    for (const s of screens) {
      expect(s.unsettled, evidence).toBe(
        "a focused field's caret could not be hidden",
      );
      // The screen itself was still taken.
      expect(s.ref, evidence).not.toBe("");
    }
  });

  it("says so when the hold answers nothing readable", async () => {
    const d = deps();
    intercept(d, isEval(PAGE_CAPTURE_HOLD), async () => ({
      result: { type: "undefined" },
    }));
    const { screens, evidence } = await screensOf(d);
    expect(screens[1]?.unsettled, evidence).toBe(
      "the page screen could not be taken (the capture hold answered with nothing readable)",
    );
  });

  it("says the page screen could not be taken when the capture is refused", async () => {
    const d = deps();
    intercept(d, isPng, async () => {
      throw new Error("Unable to capture screenshot");
    });
    const { screens, said, evidence } = await screensOf(d);
    expect(screens[2]?.unsettled, evidence).toBe(
      "the page screen could not be taken (Unable to capture screenshot)",
    );
    expect(said, evidence).toHaveLength(3);
    expect(kinds(said), evidence).toEqual(["stepSettleFailed"]);
    // The release still ran after each refused capture.
    const releases = d.cdp.calls.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        c.params.expression === PAGE_CAPTURE_RELEASE,
    );
    expect(releases, evidence).toHaveLength(3);
  });

  // Red when the capture is awaited with no bound of its own: a covered
  // window's screenshot never answers, and the walk sat on it for the
  // answer deadline's 30 s instead of the still line's bound (close
  // review 2). Only the deadline is a real timer, so only it is faked.
  it("gives up on a page screen whose capture never answers, puts the hold back, and goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const d = deps();
      let pngs = 0;
      let hung = false;
      const send = d.cdp.send.bind(d.cdp);
      d.cdp.send = async (method, params = {}) => {
        if (isPng(method, params) && ++pngs === 2) {
          hung = true;
          return new Promise(() => undefined);
        }
        return send(method, params);
      };
      let finished = false;
      const running = screensOf(d).finally(() => {
        finished = true;
      });
      for (let i = 0; i < 100 && !finished; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      const { screens, said, evidence } = await running;
      expect(hung, evidence).toBe(true); // the premise: a capture never answered
      expect(screens[1]?.unsettled, evidence).toBe(
        `the page screen could not be taken (Page.captureScreenshot got no answer from the browser in ${STILL_DRAIN_MS / 1000} s)`,
      );
      expect(screens[1]?.ref, evidence).toBe("");
      // The others were taken, and the hold was put back every time.
      expect(screens[0]?.ref, evidence).not.toBe("");
      expect(screens[2]?.ref, evidence).not.toBe("");
      const releases = d.cdp.calls.filter(
        (c) =>
          c.method === "Runtime.evaluate" &&
          c.params.expression === PAGE_CAPTURE_RELEASE,
      );
      expect(releases, evidence).toHaveLength(3);
      expect(kinds(said), evidence).toEqual(["stepSettleFailed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the caret may not have been put back when the release fails, as about the video", async () => {
    const d = deps();
    intercept(d, isEval(PAGE_CAPTURE_RELEASE), async () => {
      throw new Error("Cannot find context with specified id");
    });
    const { screens, said, evidence } = await screensOf(d);
    // The video after the step is what may be wrong, so it is not a
    // screens-only kind refresh forgives; the screen itself was taken.
    expect(kinds(said), evidence).toEqual(["pageHoldNotReleased"]);
    expect(
      said.find((s) => s.kind === "pageHoldNotReleased")?.note,
      evidence,
    ).toContain(
      "the caret and held animations may not have been put back (Cannot find context with specified id)",
    );
    expect(screens[1]?.unsettled, evidence).toBeUndefined();
    expect(screens[1]?.ref, evidence).toBe("ps:scene-1:1");
  });

  it("says the page screen could not be taken when the store refuses it", async () => {
    const d = deps();
    d.store.putPageScreen = async () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const { screens, evidence } = await screensOf(d);
    expect(screens[0]?.unsettled, evidence).toBe(
      "the page screen could not be taken (ENOSPC: no space left on device)",
    );
  });

  it("says the cap ran out on requests, and asks the page nothing it had no time for", async () => {
    const d = deps();
    intercept(
      d,
      (m) => m === "Network.enable",
      async () => {
        // A fetch that never answers, from the first page on.
        queueMicrotask(() =>
          d.cdp.emit("Network.requestWillBeSent", {
            requestId: "poll",
            type: "Fetch",
          }),
        );
        return {};
      },
    );
    const { result, screens, said, evidence } = await screensOf(d);
    expect(screens[0]?.unsettled, evidence).toBe(
      "1 request(s) in flight; the page was not asked (the cap ran out first)",
    );
    // The page's own: a request it never answered.
    expect(kinds(said), evidence).toEqual(["stepUnsettled"]);
    // Said at the request cap, not the page's.
    expect(screens[0]?.waitedMs ?? 0, evidence).toBeGreaterThanOrEqual(
      STEP_REQUEST_CAP_MS,
    );
    // The opening waited for it; the steps after leave it out, say so, and
    // ask the page. Red if they wait the cap again (I1).
    expect(screens.length, evidence).toBeGreaterThan(1);
    for (const s of screens.slice(1)) {
      expect(s.unsettled, evidence).toBeUndefined();
      expect(s.waitedMs, evidence).toBeLessThan(STEP_REQUEST_CAP_MS);
    }
    expect(
      result.degradations
        .filter((x) => x.kind === "requestNotWaited")
        .map((x) => x.note),
      JSON.stringify(result.degradations),
    ).toHaveLength(screens.length - 1);
    const asked = d.cdp.calls.filter((c) =>
      String(c.params.expression ?? "").includes(STEP_SETTLE_MARKER),
    );
    expect(asked, evidence).toHaveLength(screens.length - 1);
  });

  // A streamed answer is one request open for seconds. Red when requests
  // share the page's 2 s cap: the screen would say "1 request(s) in flight".
  it("waits out a request open for 3 s, then asks the page", async () => {
    const d = deps();
    const sleep = d.clock.sleep;
    let opened = -1;
    let closed = false;
    d.clock.sleep = async (ms) => {
      await sleep(ms);
      if (opened >= 0 && !closed && d.clock.now() - opened >= 3000) {
        closed = true;
        d.cdp.emit("Network.loadingFinished", { requestId: "stream" });
      }
    };
    intercept(
      d,
      (m) => m === "Network.enable",
      async () => {
        queueMicrotask(() => {
          opened = d.clock.now();
          d.cdp.emit("Network.requestWillBeSent", {
            requestId: "stream",
            type: "Fetch",
          });
        });
        return {};
      },
    );
    const { screens, evidence } = await screensOf(d);
    expect(closed, evidence).toBe(true); // the premise: the request did open and close
    expect(screens[0]?.unsettled, evidence).toBeUndefined();
    expect(screens[0]?.waitedMs ?? 0, evidence).toBeGreaterThanOrEqual(3000);
    const asked = d.cdp.calls.filter((c) =>
      String(c.params.expression ?? "").includes(STEP_SETTLE_MARKER),
    );
    expect(asked.length, evidence).toBeGreaterThan(0);
  });

  // Red when the words are inferred from how long the probe waited: a cap
  // answer that came early read as a failed animation read (close review 7).
  it.each([
    [
      "animationReadFailed",
      10,
      "the page's animations could not be read",
      "stepSettleFailed",
    ],
    ["cap", 10, "the DOM never went quiet", "stepUnsettled"],
    ["cap", 5000, "the DOM never went quiet", "stepUnsettled"],
    [
      "unwatched",
      0,
      "the page's changes could not be watched",
      "stepSettleFailed",
    ],
  ])(
    "says why the probe stopped as it says (%s, waited %i ms)",
    async (stopped, waitedMs, words, kind) => {
      const d = deps();
      intercept(
        d,
        (m, p) =>
          m === "Runtime.evaluate" &&
          String(p.expression).includes(STEP_SETTLE_MARKER),
        async () => ({
          result: {
            type: "object",
            value: {
              painted: true,
              animations: 0,
              quiet: false,
              waitedMs,
              stopped,
            },
          },
        }),
      );
      const { screens, said, evidence } = await screensOf(d);
      expect(screens[1]?.unsettled, evidence).toBe(words);
      expect(kinds(said), evidence).toEqual([kind]);
    },
  );

  // Red if a paint that never came (a covered window) is said as the
  // page's, and an animation still running is said as the machine's.
  it("says a paint that never came as the machine's, beside the page's animation", async () => {
    const d = deps();
    intercept(
      d,
      (m, p) =>
        m === "Runtime.evaluate" &&
        String(p.expression).includes(STEP_SETTLE_MARKER),
      async () => ({
        result: {
          type: "object",
          value: {
            painted: false,
            animations: 2,
            quiet: false,
            waitedMs: 2000,
            stopped: "cap",
          },
        },
      }),
    );
    const { screens, said, evidence } = await screensOf(d);
    expect(screens[1]?.unsettled, evidence).toBe(
      "its first paint never came; 2 animation(s) still running",
    );
    expect(kinds(said), evidence).toEqual(["stepSettleFailed"]);
  });

  it("says an animation the page kept running as the page's", async () => {
    const d = deps();
    intercept(
      d,
      (m, p) =>
        m === "Runtime.evaluate" &&
        String(p.expression).includes(STEP_SETTLE_MARKER),
      async () => ({
        result: {
          type: "object",
          value: {
            painted: true,
            animations: 1,
            quiet: false,
            waitedMs: 2000,
            stopped: "cap",
          },
        },
      }),
    );
    const { screens, said, evidence } = await screensOf(d);
    expect(screens[1]?.unsettled, evidence).toBe(
      "1 animation(s) still running",
    );
    expect(kinds(said), evidence).toEqual(["stepUnsettled"]);
  });

  it("gives up waiting behind a still that never answers, and says so", async () => {
    const d = deps();
    let checks = 0;
    // Visible for the first step only, so the run stops at the second
    // rather than queue a marker still behind the hung one.
    d.occlusion = {
      install: async () => undefined,
      ensureVisible: async () => ++checks === 1,
      pauses: () => (checks > 1 ? 1 : 0),
      pausedMs: () => 0,
      stalledSince: () => null,
    };
    const send = d.cdp.send.bind(d.cdp);
    let stills = 0;
    let hung = false;
    d.cdp.send = async (method, params) => {
      if (method === "Page.captureScreenshot" && params?.format !== "png") {
        stills++;
        // The first marker still: the click paints.
        if (stills === 2) {
          for (let i = 0; i < 3; i++) {
            d.cdp.emit("Page.screencastFrame", {
              sessionId: 300 + i,
              data: fakeScreenshotBase64(),
            });
          }
        }
        // The settled still after it: the page has stopped painting.
        if (stills === 3) {
          hung = true;
          return new Promise(() => undefined);
        }
      }
      return send(method, params);
    };
    const result = await runReplay(scene(), d);
    const screens = result.bundle?.pageScreens ?? [];
    const evidence = JSON.stringify({ screens, reason: result.reason });
    // The premise: a still really was asked for and never answered.
    expect(hung, evidence).toBe(true);
    expect(result.reason, evidence).toBe("occlusionTimeout");
    // The pointer's move before the settle waits on the same line, and
    // gives up on it the same way rather than wait forever.
    const stuck = `a still ahead of it was still being taken after ${STILL_DRAIN_MS / 1000} s; the page had most likely stopped painting`;
    expect(screens[1]?.unsettled, evidence).toBe(
      `the pointer's hover could not be renewed (${stuck}); the page screen could not be taken (${stuck})`,
    );
  }, 5000);
});

describe("frames a page screen keeps out of the film", () => {
  it("drops the stray frame a clipped capture makes after the opening, at display scale 2", async () => {
    const d = deps();
    const HI = fakeScreenshotBase64(2560, 1600);
    const LO = fakeScreenshotBase64(1280, 800);
    let releases = 0;
    let strayDue = false;
    let strays = 0;
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params = {}) => {
      // The page painting itself in before the opening still, at 2x: the
      // only frames seen before the opening's page screen on a static page.
      if (
        method === "Runtime.evaluate" &&
        String(params.expression).includes("__demomanSettlePaint")
      ) {
        d.cdp.emit("Page.screencastFrame", { sessionId: 1, data: HI });
      }
      // On the walk's next call after the opening's release: Chrome's 1x
      // frame, then the page moving at 2x, all painted past the release's
      // echo (`ECHO_WINDOW_MS`), so only the stray rule can drop the 1x one.
      if (strayDue && method !== "Page.screencastFrameAck") {
        strayDue = false;
        strays++;
        const past = d.clock.now() + ECHO_WINDOW_MS;
        const at = (ms: number) => ({ timestamp: ms / 1000 });
        d.cdp.emit("Page.screencastFrame", {
          sessionId: 2,
          data: LO,
          metadata: at(past + 1),
        });
        for (let i = 0; i < 4; i++) {
          d.cdp.emit("Page.screencastFrame", {
            sessionId: 3 + i,
            data: HI,
            metadata: at(past + 2 + i),
          });
        }
      }
      const reply = await send(method, params);
      if (
        method === "Runtime.evaluate" &&
        params.expression === PAGE_CAPTURE_RELEASE &&
        ++releases === 1
      ) {
        strayDue = true;
      }
      return reply;
    };
    await runReplay(scene(), d);
    const pushed = vi
      .mocked(d.encoder.push)
      .mock.calls.map(([f]) => `${f.width}x${f.height}`);
    // The premises: the stray was sent, and the motion after it was kept.
    expect(strays).toBe(1);
    expect(
      pushed.filter((s) => s === "2560x1600").length,
      pushed.join(","),
    ).toBeGreaterThan(0);
    expect(pushed, pushed.join(",")).not.toContain("1280x800");
  });

  // Red when the stray check stops at the first frame of the normal size, or
  // judges by arrival: Chrome's 1x frame arriving second was kept, and so was
  // a frame painted while the hold had the caret hidden that arrived after
  // the release (close review 3).
  it("drops a stray arriving second, and a frame painted in the hold arriving after it", async () => {
    const d = deps();
    const HI = fakeScreenshotBase64(2560, 1600);
    const LO = fakeScreenshotBase64(1280, 800);
    // Its own size, so it can be found among the pushed frames; it arrives
    // after a frame of the normal size, so only when it was painted can
    // drop it.
    const HELD = fakeScreenshotBase64(2400, 1500);
    let holdAt = -1;
    let releases = 0;
    let burstDue = false;
    let burst = 0;
    const send = d.cdp.send.bind(d.cdp);
    const frame = (sessionId: number, data: string, paintedMs: number) =>
      d.cdp.emit("Page.screencastFrame", {
        sessionId,
        data,
        metadata: { timestamp: paintedMs / 1000 },
      });
    d.cdp.send = async (method, params = {}) => {
      if (
        method === "Runtime.evaluate" &&
        String(params.expression).includes("__demomanSettlePaint")
      ) {
        d.cdp.emit("Page.screencastFrame", { sessionId: 1, data: HI });
      }
      if (
        method === "Runtime.evaluate" &&
        params.expression === PAGE_CAPTURE_HOLD &&
        holdAt < 0
      ) {
        holdAt = d.clock.now();
      }
      if (burstDue && method !== "Page.screencastFrameAck") {
        burstDue = false;
        burst++;
        // Past the release's echo, so only the stray rule judges these.
        const after = d.clock.now() + ECHO_WINDOW_MS;
        frame(2, HI, after);
        frame(3, HELD, holdAt);
        frame(4, LO, after + 1);
        frame(5, HI, after + 2);
        frame(6, HI, after + 3);
      }
      const reply = await send(method, params);
      if (
        method === "Runtime.evaluate" &&
        params.expression === PAGE_CAPTURE_RELEASE &&
        ++releases === 1
      ) {
        burstDue = true;
      }
      return reply;
    };
    await runReplay(scene(), d);
    const pushed = vi
      .mocked(d.encoder.push)
      .mock.calls.map(([f]) => `${f.width}x${f.height}`);
    // The premises: the burst was sent, and its frames after the hold were
    // kept.
    expect(burst).toBe(1);
    expect(holdAt).toBeGreaterThan(0);
    expect(
      pushed.filter((s) => s === "2560x1600").length,
      pushed.join(","),
    ).toBeGreaterThanOrEqual(3);
    expect(pushed, pushed.join(",")).not.toContain("1280x800");
    expect(pushed, pushed.join(",")).not.toContain("2400x1500");
  });
});

/**
 * Before each step's settle the pointer's move is sent again where it rests,
 * so the screen's hover is the pointer's (Chrome can lose it to a hover
 * recomputed while a still was in flight; the integration lane's "a layout
 * change as a still is taken" shows that against Chromium). Here: where and
 * when it goes, through what, and what it leaves out of the take.
 */
describe("the pointer's move before each step's settle", () => {
  /** Input calls and settle probes in order, each input marked with
   *  whether it went out inside a gate section. */
  function watch(d: ReturnType<typeof deps>) {
    const inner = createInputGate();
    let inSection = 0;
    d.inputGate = {
      section: (input) =>
        inner.section(async () => {
          inSection++;
          try {
            return await input();
          } finally {
            inSection--;
          }
        }),
      capture: (take) => inner.capture(take),
    };
    const seen: { what: string; x?: unknown; y?: unknown; gated?: boolean }[] =
      [];
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params = {}) => {
      if (method === "Input.dispatchMouseEvent")
        seen.push({
          what: String(params.type),
          x: params.x,
          y: params.y,
          gated: inSection > 0,
        });
      if (String(params.expression ?? "").includes(STEP_SETTLE_MARKER))
        seen.push({ what: "settle" });
      return send(method, params);
    };
    return seen;
  }

  // Red without the move: the input before each step's settle is the
  // click's release, not a move.
  it("sends it at the click's point, through the gate, before each step's settle and not the opening's", async () => {
    const d = deps();
    const seen = watch(d);
    const { result, evidence } = await screensOf(d);
    const settles = seen.flatMap((s, i) => (s.what === "settle" ? [i] : []));
    // The premise: the opening and both clicks were settled.
    expect(settles, evidence).toHaveLength(3);
    // The opening: no pointer had been placed, so nothing was sent.
    expect(seen.slice(0, settles[0]), JSON.stringify(seen)).toEqual([]);
    for (const i of settles.slice(1)) {
      const before = seen.slice(0, i).filter((s) => s.what !== "settle");
      const [release, move] = before.slice(-2);
      expect(release?.what, JSON.stringify(seen)).toBe("mouseReleased");
      expect(move, JSON.stringify(seen)).toEqual({
        what: "mouseMoved",
        x: release?.x,
        y: release?.y,
        gated: true,
      });
    }
    // No cursor sample for it: the drawn cursor did not move. Every other
    // move the walk sent is one.
    const moves = seen.filter((s) => s.what === "mouseMoved").length;
    expect(result.bundle?.cursorSamples, evidence).toHaveLength(moves - 2);
    const release = seen.filter((s) => s.what === "mouseReleased").at(-1);
    expect(result.bundle?.cursorSamples.at(-1), evidence).toMatchObject({
      x: release?.x,
      y: release?.y,
    });
  });

  // Red if the move follows every step: a keyboard step leaves the pointer
  // alone, or a menu its keys walk would follow the pointer instead.
  it("sends none after a press, which did not move the pointer", async () => {
    const base = scene();
    const doc = {
      ...base,
      actions: [
        base.actions[0],
        {
          id: "act-press",
          kind: "press",
          anchorId: null,
          timestamp: 1,
          marker: "press:none",
          key: "ArrowDown",
        },
      ],
    } as SceneDocument;
    const d = deps({ madeFrom: madeFromOf(doc) });
    const seen = watch(d);
    const result = await runReplay(doc, d);
    const evidence = JSON.stringify({ seen, reason: result.reason });
    expect(result.outcome, evidence).toBe("complete");
    const settles = seen.flatMap((s, i) => (s.what === "settle" ? [i] : []));
    // The premise: the opening, the click and the press were each settled,
    // and the click's settle had its move (the case above).
    expect(settles, evidence).toHaveLength(3);
    expect(seen[(settles[1] as number) - 1]?.what, evidence).toBe("mouseMoved");
    // Between the click's settle and the press's: no pointer input at all.
    expect(
      seen
        .slice((settles[1] as number) + 1, settles[2])
        .filter((s) => s.what !== "settle"),
      evidence,
    ).toEqual([]);
  });

  // Red if the refusal is swallowed: the screen would read settled with a
  // hover that may be stale.
  it("says a move the browser refused as the machine's, and still settles and captures", async () => {
    const d = deps();
    let last = "";
    intercept(
      d,
      (m, p) => {
        const resent =
          m === "Input.dispatchMouseEvent" &&
          p.type === "mouseMoved" &&
          last === "mouseReleased";
        if (m === "Input.dispatchMouseEvent") last = String(p.type);
        return resent;
      },
      async () => {
        throw new Error("Input domain refused");
      },
    );
    const { screens, said, evidence } = await screensOf(d);
    expect(screens[0]?.unsettled, evidence).toBeUndefined();
    for (const s of screens.slice(1)) {
      expect(s.unsettled, evidence).toBe(
        "the pointer's hover could not be renewed (Input domain refused)",
      );
      expect(s.ref, evidence).not.toBe("");
    }
    expect(said, evidence).toHaveLength(2);
    expect(kinds(said), evidence).toEqual(["stepSettleFailed"]);
  });
});
