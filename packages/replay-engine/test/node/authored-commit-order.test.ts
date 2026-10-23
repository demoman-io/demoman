import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  type SceneAnchor,
} from "@demoman/scene-schema";
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

/**
 * `runAuthored` end to end against the fake CDP session, for the two places
 * where the walk and the authored source disagree about which steps the take
 * has. `packages/replay-engine/test/node/authored.test.ts` drives the source
 * with a contract double of the walk (`walkThrough`), which counts and commits
 * in the order the source's docblock describes — so neither ordering below can
 * show up there. Only the real walk can.
 */

const PAGE = "https://app.example.com/";

function encoderStub(): EngineDeps["encoder"] {
  return {
    openSpan: vi.fn(),
    push: vi.fn(async () => undefined),
    closeSpan: vi.fn(async () => null),
    queueDepth: () => 0,
    heapFraction: () => 0.1,
  };
}

/** The anchor the page would capture for an element it found. */
function anchorFor(intent: AnchorIntent): SceneAnchor {
  return {
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
  };
}

const FOUND = (intent: AnchorIntent): IntentCapture => ({
  anchor: anchorFor(intent),
  failureReason: null,
  intentResolution: {
    strategy: "stableId",
    candidates: 1,
    failureReason: null,
  },
  pageUrl: null,
});

/** The page answered and resolved nothing, on the same page. */
const NOTHING: IntentCapture = {
  anchor: null,
  failureReason: "unresolved",
  intentResolution: { strategy: "broken", candidates: 0, failureReason: null },
  pageUrl: PAGE,
};

function authoredDeps(
  cdp: CdpFake,
  captureResolved: AuthoredDeps["captureResolved"],
  resolved: string[],
): AuthoredDeps {
  let n = 0;
  let clock = 0;
  const page: PageAgent = {
    resolve: async (anchors) => {
      for (const a of anchors) resolved.push(a.id);
      return anchors.map((a) => ({
        anchorId: a.id,
        strategy: cdp.missing.has(a.id) ? ("broken" as const) : "stableId",
        resolved: !cdp.missing.has(a.id),
        failureReason: null,
      }));
    },
  };
  return {
    cdp,
    page,
    encoder: encoderStub(),
    store: createMemoryFrameStore(),
    clock: {
      now: () => (clock += 10),
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
    mayReplay: true,
    captureResolved,
    newId: (prefix) => `${prefix}-${++n}`,
    sceneId: "authored-commit-order",
    createdAt: "2026-10-02T09:00:00.000Z",
    viewport: { width: 1280, height: 800 },
    startingBranding: BRANDING_DEFAULTS,
    cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
  };
}

function script(steps: DemoScript["steps"]): DemoScript {
  return {
    scriptVersion: 1,
    name: "commit order",
    target: PAGE,
    steps,
  };
}

describe("runAuthored: a wait whose element cannot be captured after it", () => {
  /**
   * A click, then a wait for a spinner to go away — and the spinner is
   * already gone. The first capture finds nothing, so the walk is handed the
   * bare intent; the walk polls it, finds nothing, and the `hidden` condition
   * is met at once. The walk counts the wait, marks it and shoots a keyframe
   * tagged with its id, and only then resumes the source — whose second
   * capture also finds nothing, so it stops WITHOUT committing the wait.
   */
  async function spinnerAlreadyGone() {
    const cdp = createCdpFake();
    const resolved: string[] = [];
    const spinnerCaptures: (SceneAnchor | null)[] = [];
    let spinnerIntent: string | null = null;
    const result = await runAuthored(
      script([
        { do: "click", on: { stableId: "save" } },
        { do: "waitFor", until: "hidden", on: { text: "Loading" } },
      ]),
      authoredDeps(
        cdp,
        async (intent) => {
          if (intent.fingerprint.textContent === "Loading") {
            spinnerIntent = intent.id;
            // Gone for the page's capture and for the walk's own resolve.
            cdp.missing.add(intent.id);
            spinnerCaptures.push(null);
            return NOTHING;
          }
          return FOUND(intent);
        },
        resolved,
      ),
    );
    return { result, resolved, spinnerCaptures, spinnerIntent };
  }

  it("does not report the run complete through a wait the take does not contain", async () => {
    const { result, resolved, spinnerCaptures, spinnerIntent } =
      await spinnerAlreadyGone();
    const evidence = JSON.stringify({
      outcome: result.outcome,
      completed: result.completed,
      total: result.total,
      reason: result.reason,
      lastCompletedActionId: result.lastCompletedActionId,
      actions: result.document?.actions.map((a) => a.id),
      steps: result.steps.map((s) => ({ a: s.actionId, m: s.marker })),
    });

    // Premise: the spinner was captured twice (before and after the wait),
    // found neither time, and the walk really did poll the bare intent —
    // which is how the hidden condition came to be met.
    expect(spinnerIntent, evidence).not.toBeNull();
    expect(spinnerCaptures, evidence).toEqual([null, null]);
    expect(resolved, evidence).toContain(spinnerIntent);
    // Premise: the source stopped after the wait, for the capture that failed.
    expect(result.reason, evidence).toBe("unresolvedAnchor");
    // Premise: the wait is NOT in the take — only the click is.
    const ids = result.document?.actions.map((a) => a.id) ?? [];
    expect(ids, evidence).toHaveLength(1);
    expect(result.steps[1]?.actionId, evidence).toBeNull();

    // The defect: the walk counted the wait before the source refused it.
    expect(result.outcome, evidence).toBe("partial");
    expect(ids, evidence).toContain(result.lastCompletedActionId);
  });

  it("leaves no marker or keyframe in the bundle for a wait the take does not contain", async () => {
    const { result } = await spinnerAlreadyGone();
    const ids = result.document?.actions.map((a) => a.id) ?? [];
    const bundle = result.bundle;
    const evidence = JSON.stringify({
      actions: ids,
      markers: bundle?.markers,
      keyframes: bundle?.keyframes.map((k) => k.actionId),
      madeFrom: bundle?.madeFrom?.map((s) => s.actionId),
    });

    // Premise: there is a bundle (the click dispatched a path), and a take.
    expect(bundle, evidence).not.toBeNull();
    expect(ids, evidence).toHaveLength(1);

    for (const marker of bundle?.markers ?? []) {
      expect(ids, evidence).toContain(marker.actionId);
    }
    for (const key of bundle?.keyframes ?? []) {
      if (key.actionId !== null) expect(ids, evidence).toContain(key.actionId);
    }
  });
});

describe("runAuthored: a step whose dispatch fails after it resolved", () => {
  /**
   * Two clicks. The first runs in full. Between them the debugger detaches:
   * the second click captures and resolves (the capture round trip is not a
   * CDP call), the walk locates and scrolls to it and calls `onResolved` —
   * which commits it — and only then dispatches the cursor path, whose first
   * `Input.dispatchMouseEvent` rejects.
   */
  async function detachBeforeSecondClick() {
    const cdp = createCdpFake();
    let detached = false;
    const dispatched: string[] = [];
    const refused: string[] = [];
    const send = cdp.send.bind(cdp);
    cdp.send = async (method, params = {}) => {
      if (method === "Input.dispatchMouseEvent") {
        if (detached) {
          refused.push(String(params.type));
          throw new Error("Debugger is not attached to the tab");
        }
        dispatched.push(String(params.type));
      }
      return send(method, params);
    };
    const result = await runAuthored(
      script([
        { do: "click", on: { stableId: "first" } },
        { do: "click", on: { stableId: "second" } },
      ]),
      authoredDeps(
        cdp,
        async (intent) => {
          if (intent.fingerprint.stableId === "second") detached = true;
          return FOUND(intent);
        },
        [],
      ),
    );
    return { result, dispatched, refused };
  }

  it("does not put a click into the take that was never dispatched", async () => {
    const { result, dispatched, refused } = await detachBeforeSecondClick();
    const ids = result.document?.actions.map((a) => a.id) ?? [];
    const evidence = JSON.stringify({
      reason: result.reason,
      completed: result.completed,
      lastCompletedActionId: result.lastCompletedActionId,
      actions: ids,
      steps: result.steps.map((s) => ({ a: s.actionId, m: s.marker })),
      markers: result.bundle?.markers,
      dispatched: [...new Set(dispatched)],
      refused,
    });

    // Premise: the first click really pressed and released, and the second
    // was refused at its very first mouse event — so nothing of it reached
    // the page.
    expect(dispatched, evidence).toContain("mousePressed");
    expect(dispatched, evidence).toContain("mouseReleased");
    expect(refused, evidence).toEqual(["mouseMoved"]);
    expect(result.reason, evidence).toBe("portFailure");
    expect(result.completed, evidence).toBe(1);

    // The defect: the second click was committed in `onResolved`, before the
    // dispatch that failed.
    expect(ids, evidence).toHaveLength(result.completed);
    expect(result.steps[1]?.actionId, evidence).toBeNull();
    expect(result.steps[1]?.marker, evidence).toBeNull();
    for (const id of ids) {
      expect(
        result.bundle?.markers.map((m) => m.actionId),
        evidence,
      ).toContain(id);
    }
  });
});

describe("runAuthored: a step whose verb fails after the walk marked it", () => {
  /**
   * Two clicks. The first runs in full. The second resolves, its cursor path
   * is dispatched, the walk marks it and takes its keyframe — and then the
   * debugger detaches, so its `mousePressed` is refused. The walk stops on
   * portFailure with one step completed; the bundle must not keep a marker or
   * a tagged keyframe for the click that never happened.
   */
  async function detachBeforeSecondPress() {
    const cdp = createCdpFake();
    let second = false;
    const pressed: string[] = [];
    const refused: string[] = [];
    const send = cdp.send.bind(cdp);
    cdp.send = async (method, params = {}) => {
      if (method === "Input.dispatchMouseEvent") {
        const type = String(params.type);
        if (second && type === "mousePressed") {
          refused.push(type);
          throw new Error("Debugger is not attached to the tab");
        }
        if (type === "mousePressed") pressed.push(type);
      }
      return send(method, params);
    };
    const result = await runAuthored(
      script([
        { do: "click", on: { stableId: "first" } },
        { do: "click", on: { stableId: "second" } },
      ]),
      authoredDeps(
        cdp,
        async (intent) => {
          if (intent.fingerprint.stableId === "second") second = true;
          return FOUND(intent);
        },
        [],
      ),
    );
    return { result, pressed, refused };
  }

  // Red while the walk's catch leaves the in-flight step's marker and tagged
  // keyframe in the bundle (markers.push and shot run before performVerb).
  it("leaves no marker or tagged keyframe for the click whose press was refused", async () => {
    const { result, pressed, refused } = await detachBeforeSecondPress();
    const ids = result.document?.actions.map((a) => a.id) ?? [];
    const markers = result.bundle?.markers.map((m) => m.actionId) ?? [];
    const tagged = (result.bundle?.keyframes ?? [])
      .map((k) => k.actionId)
      .filter((id): id is string => id !== null);
    const evidence = JSON.stringify({
      reason: result.reason,
      completed: result.completed,
      actions: ids,
      markers,
      tagged,
      pressed,
      refused,
    });

    // Premise: the first click pressed, the second was refused at its press —
    // after its path ran, so the walk had already marked and shot it.
    expect(pressed, evidence).toEqual(["mousePressed"]);
    expect(refused, evidence).toEqual(["mousePressed"]);
    expect(result.reason, evidence).toBe("portFailure");
    expect(result.completed, evidence).toBe(1);
    expect(ids, evidence).toHaveLength(1);

    // Every marker and every tagged keyframe names an action the take has.
    for (const id of markers) expect(ids, evidence).toContain(id);
    for (const id of tagged) expect(ids, evidence).toContain(id);
    // Positive control: the completed click keeps its marker and its frame.
    expect(markers, evidence).toContain(ids[0]);
    expect(tagged, evidence).toContain(ids[0]);
  });
});
