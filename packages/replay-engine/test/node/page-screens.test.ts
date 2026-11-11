import { madeFromOf } from "@demoman/compositor";
import { describe, expect, it, vi } from "vitest";
import type { EngineDeps, PageAgent } from "../../src/index.js";
import {
  PAGE_CAPTURE_HOLD,
  PAGE_CAPTURE_RELEASE,
  runReplay,
  STEP_REQUEST_CAP_MS,
  STEP_SETTLE_MARKER,
  STILL_DRAIN_MS,
} from "../../src/index.js";
import {
  type CdpFake,
  createCdpFake,
  fakeScreenshotBase64,
} from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { scene } from "../helpers/replay-scene";

/**
 * Every way a step's settle and page screen can fail, against the fake CDP:
 * each says what happened on the screen and as a `stepUnsettled`, and none
 * fails the take (CLAUDE.md, "Report before you forgive").
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
  const said = result.degradations.filter((x) => x.kind === "stepUnsettled");
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
  });

  it("says the page screen could not be taken when the hold throws in the page", async () => {
    const d = deps();
    intercept(d, isEval(PAGE_CAPTURE_HOLD), async () => ({
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "TypeError: getAnimations is broken" },
      },
    }));
    const { screens, evidence } = await screensOf(d);
    for (const s of screens) {
      expect(s.unsettled, evidence).toBe(
        "the page screen could not be taken (TypeError: getAnimations is broken)",
      );
      expect(s.ref, evidence).toBe("");
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
    // The release still ran after each refused capture.
    const releases = d.cdp.calls.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        c.params.expression === PAGE_CAPTURE_RELEASE,
    );
    expect(releases, evidence).toHaveLength(3);
  });

  it("says the caret may not have been put back when the release fails", async () => {
    const d = deps();
    intercept(d, isEval(PAGE_CAPTURE_RELEASE), async () => {
      throw new Error("Cannot find context with specified id");
    });
    const { screens, evidence } = await screensOf(d);
    expect(screens[1]?.unsettled, evidence).toBe(
      "the caret and held animations may not have been put back (Cannot find context with specified id)",
    );
    // The screen was taken: its bytes are kept, and only refresh skips it.
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
    const { result, screens, evidence } = await screensOf(d);
    expect(screens[0]?.unsettled, evidence).toBe(
      "1 request(s) in flight; the page was not asked (the cap ran out first)",
    );
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

  it.each([
    [10, "the page's animations could not be read"],
    [5000, "the DOM never went quiet"],
  ])(
    "tells a failed animation read from a DOM still changing (waited %i ms)",
    async (waitedMs, words) => {
      const d = deps();
      intercept(
        d,
        (m, p) =>
          m === "Runtime.evaluate" &&
          String(p.expression).includes(STEP_SETTLE_MARKER),
        async () => ({
          result: {
            type: "object",
            value: { painted: true, animations: 0, quiet: false, waitedMs },
          },
        }),
      );
      const { screens, evidence } = await screensOf(d);
      expect(screens[1]?.unsettled, evidence).toBe(words);
    },
  );

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
    expect(screens[1]?.unsettled, evidence).toBe(
      `the page screen could not be taken (a still ahead of it was still being taken after ${STILL_DRAIN_MS / 1000} s; the page had most likely stopped painting)`,
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
      // frame, then the page moving at 2x.
      if (strayDue && method !== "Page.screencastFrameAck") {
        strayDue = false;
        strays++;
        d.cdp.emit("Page.screencastFrame", { sessionId: 2, data: LO });
        for (let i = 0; i < 4; i++) {
          d.cdp.emit("Page.screencastFrame", { sessionId: 3 + i, data: HI });
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
});
