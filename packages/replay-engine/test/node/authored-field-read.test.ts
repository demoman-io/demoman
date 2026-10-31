import type { AnchorIntent } from "@demoman/resolver";
import { BRANDING_DEFAULTS, type DemoScript } from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthoredDeps,
  EngineDeps,
  IntentCapture,
  PageAgent,
} from "../../src/index.js";
import { runAuthored } from "../../src/index.js";
import { type CdpFake, createCdpFake } from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";

/** Task 9: `type` reads its field back; `waitForLoad` says when nothing loaded. */
const PAGE = "https://app.example.com/";

function deps(cdp: CdpFake, treePath = "button:1"): AuthoredDeps {
  let n = 0;
  let clock = 0;
  const page: PageAgent = {
    resolve: async (anchors) =>
      anchors.map((a) => ({
        anchorId: a.id,
        strategy: "stableId" as const,
        resolved: true,
        failureReason: null,
      })),
  };
  const encoder: EngineDeps["encoder"] = {
    openSpan: vi.fn(),
    push: vi.fn(async () => undefined),
    closeSpan: vi.fn(async () => null),
    queueDepth: () => 0,
    heapFraction: () => 0.1,
  };
  return {
    cdp,
    page,
    encoder,
    store: createMemoryFrameStore(),
    clock: {
      now: () => (clock += 10),
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
    mayReplay: true,
    captureResolved: async (intent: AnchorIntent): Promise<IntentCapture> => ({
      anchor: {
        id: intent.id,
        fingerprint: {
          ...intent.fingerprint,
          treePath,
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
      },
      failureReason: null,
      intentResolution: {
        strategy: "stableId",
        candidates: 1,
        failureReason: null,
      },
      pageUrl: null,
    }),
    newId: (prefix) => `${prefix}-${++n}`,
    sceneId: "authored-text-lines",
    createdAt: "2026-10-09T09:00:00.000Z",
    viewport: { width: 1280, height: 800 },
    startingBranding: BRANDING_DEFAULTS,
    cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
  };
}

const typeScript = (text: string): DemoScript => ({
  scriptVersion: 1,
  name: "type",
  target: PAGE,
  steps: [{ do: "type", into: { stableId: "amount" }, text }],
});

/** Answers the field read with what the page "shows" and counts the asks. */
function fieldShows(cdp: CdpFake, shown: string): { asked: () => number } {
  const send = cdp.send.bind(cdp);
  let asked = 0;
  cdp.send = async (method, params) => {
    if (
      method === "Runtime.callFunctionOn" &&
      String(params?.functionDeclaration ?? "").includes('"value" in field')
    ) {
      asked++;
      return { result: { type: "string", value: shown } };
    }
    return send(method, params);
  };
  return { asked: () => asked };
}

describe("a typed field is read back", () => {
  it("typing 4800 into a field that shows 4,800 holds", async () => {
    const cdp = createCdpFake();
    const field = fieldShows(cdp, "4,800");
    const result = await runAuthored(typeScript("4800"), deps(cdp));
    // The premise: the field was read, and its value is not the typed text.
    expect(field.asked()).toBe(1);
    expect(result.steps[0]?.fieldHolds).toEqual({
      value: "4,800",
      holds: true,
    });
  });

  // Final review 2026-10-30, Minor 3: an app that formats a number as money
  // keeps the typed number. Red without the numeric comparison: "480000" is
  // not inside "4800".
  it("typing 4800.00 into a field that shows $4,800 holds", async () => {
    const cdp = createCdpFake();
    const field = fieldShows(cdp, "$4,800");
    const result = await runAuthored(typeScript("4800.00"), deps(cdp));
    expect(field.asked()).toBe(1);
    expect(result.steps[0]?.fieldHolds).toEqual({
      value: "$4,800",
      holds: true,
    });
  });

  it("typing 4800 into a field that shows $4,801 does not hold", async () => {
    const cdp = createCdpFake();
    const field = fieldShows(cdp, "$4,801");
    const result = await runAuthored(typeScript("4800"), deps(cdp));
    expect(field.asked()).toBe(1);
    expect(result.steps[0]?.fieldHolds).toEqual({
      value: "$4,801",
      holds: false,
    });
  });

  it("typing into a field the app clears records holds false", async () => {
    const cdp = createCdpFake();
    const field = fieldShows(cdp, "");
    const result = await runAuthored(typeScript("4800"), deps(cdp));
    expect(field.asked()).toBe(1);
    expect(result.steps[0]?.fieldHolds).toEqual({ value: "", holds: false });
  });

  it("a refused read leaves the run complete and says why on the step", async () => {
    const cdp = createCdpFake();
    const send = cdp.send.bind(cdp);
    let refused = 0;
    cdp.send = async (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params?.functionDeclaration ?? "").includes('"value" in field')
      ) {
        refused++;
        throw new Error("Cannot find context with specified id");
      }
      return send(method, params);
    };
    const result = await runAuthored(typeScript("4800"), deps(cdp));
    expect(refused, "the read was really refused").toBe(1);
    expect(result.reason).toBeNull();
    expect(result.completed).toBe(1);
    expect(result.steps[0]?.fieldHolds).toBeUndefined();
    expect(result.steps[0]?.fieldRead).toEqual({
      unavailable: "Cannot find context with specified id",
    });
  });

  it("clips a long value", async () => {
    const cdp = createCdpFake();
    fieldShows(cdp, `4800${"x".repeat(500)}`);
    const result = await runAuthored(typeScript("4800"), deps(cdp));
    const kept = result.steps[0]?.fieldHolds;
    expect(kept?.holds).toBe(true);
    expect(kept?.value.length).toBe(121);
    expect(kept?.value.endsWith("…")).toBe(true);
  });

  it("never reads a credential field", async () => {
    const cdp = createCdpFake();
    const field = fieldShows(cdp, "hunter2");
    const d = deps(cdp);
    const capture = d.captureResolved;
    d.captureResolved = async (intent) => ({
      ...(await capture(intent)),
      credentialField: true,
    });
    const result = await runAuthored(typeScript("hunter2"), d);
    // The premise: the step really was marked hidden.
    expect(result.steps[0]?.textHidden).toBe("credentialField");
    expect(field.asked()).toBe(0);
    expect(result.steps[0]?.fieldHolds).toBeUndefined();
  });
});

describe("a waitForLoad says whether a load happened", () => {
  const clickThenWait: DemoScript = {
    scriptVersion: 1,
    name: "click then wait",
    target: PAGE,
    steps: [{ do: "click", on: { stableId: "go" } }, { do: "waitForLoad" }],
  };

  it("says loadSeen false on a page that did not navigate", async () => {
    const cdp = createCdpFake();
    const result = await runAuthored(clickThenWait, deps(cdp));
    expect(result.completed).toBe(2);
    expect(result.steps[1]?.loadSeen).toBe(false);
  });

  it("says loadSeen true when the click started a load", async () => {
    const cdp = createCdpFake();
    const send = cdp.send.bind(cdp);
    let loads = 0;
    cdp.send = async (method, params) => {
      const reply = await send(method, params);
      if (
        method === "Input.dispatchMouseEvent" &&
        params?.type === "mouseReleased"
      ) {
        loads++;
        cdp.emit("Page.frameStartedLoading", { frameId: "top" });
        cdp.emit("Page.frameStoppedLoading", { frameId: "top" });
      }
      return reply;
    };
    const result = await runAuthored(clickThenWait, deps(cdp));
    expect(loads).toBe(1);
    expect(result.steps[1]?.loadSeen).toBe(true);
  });

  // The recipe's own opening: a `waitForLoad` as step 0. The start
  // navigation happens in `occlusion.install()`, before any step; it is the
  // load that step waited for.
  const openingWait: DemoScript = {
    scriptVersion: 1,
    name: "opening wait",
    target: PAGE,
    steps: [{ do: "waitForLoad" }],
  };
  const navigatingGuard = (cdp: CdpFake, loads: { n: number }) => ({
    install: async () => {
      loads.n++;
      cdp.emit("Page.frameStartedLoading", { frameId: "top" });
      cdp.emit("Page.frameStoppedLoading", { frameId: "top" });
    },
    ensureVisible: async () => true,
    pauses: () => 0,
    pausedMs: () => 0,
    stalledSince: () => null,
  });

  it("says loadSeen true on an opening waitForLoad after the start navigation", async () => {
    const cdp = createCdpFake();
    const loads = { n: 0 };
    const result = await runAuthored(openingWait, {
      ...deps(cdp),
      occlusion: navigatingGuard(cdp, loads),
    });
    // The premise: the start navigation really started a load.
    expect(loads.n).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.steps[0]?.loadSeen).toBe(true);
  });

  it("says loadSeen false on an opening waitForLoad when nothing loaded", async () => {
    const cdp = createCdpFake();
    const result = await runAuthored(openingWait, deps(cdp));
    expect(result.completed).toBe(1);
    expect(result.steps[0]?.loadSeen).toBe(false);
  });
});
