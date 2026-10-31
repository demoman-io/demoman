import type { FrameBundle } from "@demoman/compositor";
import {
  buildTimeline,
  madeFromOf,
  planScene,
  segmentDurationMs,
  toOutputMs,
  validateBundle,
} from "@demoman/compositor";
import { BRANDING_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import type {
  ClickSeen,
  EncodedSpan,
  EngineDeps,
  InputGate,
  PageAgent,
  ResolveFailure,
  RoomPolicy,
} from "../../src/index.js";
import {
  ANSWER_DEADLINE_MS,
  createInputGate,
  createOcclusionGuard,
  OCCLUSION_TIMEOUT_MS,
  REPLAY_TARGETS,
  runAuthored,
  runReplay,
  SCROLL_MARKER,
  SETTLE_MARKER,
  SPAN_QUIET_MS,
  STILL_DRAIN_MS,
  TYPE_KEY_MS,
  TYPE_LEAD_MS,
  TYPE_MAX_MS,
} from "../../src/index.js";
import {
  type CdpFake,
  createCdpFake,
  fakeScreenshotBase64,
} from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { scene } from "../helpers/replay-scene";

/** The default encoder. The pressure tests that varied its budget dials
 *  moved to the recorder suite (`replay-motion-recorder.test.ts`); every
 *  call site here wants the same stub. */
function encoderStub(): EngineDeps["encoder"] {
  return {
    openSpan: vi.fn(),
    push: vi.fn(async () => undefined),
    closeSpan: vi.fn(async () => null),
    queueDepth: () => 0,
    heapFraction: () => 0.1,
  };
}

/** A screencast frame as CDP delivers one. */
function frame(sessionId: number, data = fakeScreenshotBase64()) {
  return {
    sessionId,
    data,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
  };
}

/** A one-click scene, so a span's counters belong to exactly one span. */
function oneClick(): SceneDocument {
  const doc = scene();
  return {
    ...doc,
    actions: [doc.actions[0] as (typeof doc.actions)[number]],
  } as SceneDocument;
}

/**
 * Drive the screencast intake from inside an open span.
 *
 * `recorder.open()` sets the span before it calls `encoder.openSpan`, so the
 * encoder port is the seam where a test is inside a span with the handler
 * already listening — no clock games, no reaching into the engine.
 *
 * The FIRST span only. A beat opens two now — the approach, which records
 * the corrective scroll, and the verb — and a helper that fired on both
 * would emit every frame twice, doubling every count a caller asserts on
 * and reporting one degradation per span for a single injected fault.
 * One span is all any caller here needs; which one it is does not matter,
 * because the frame handler is the same code either way.
 */
function emitDuringSpan(
  d: EngineDeps & { cdp: CdpFake },
  frames: Record<string, unknown>[],
): void {
  let fired = false;
  d.encoder.openSpan = () => {
    if (fired) return;
    fired = true;
    for (const f of frames) d.cdp.emit("Page.screencastFrame", f);
  };
}

function deps(
  over: Partial<EngineDeps> = {},
  /** The resolver's verdict for anchors in `cdp.missing`, per anchor. */
  unresolvedAs: Map<string, ResolveFailure> = new Map(),
): EngineDeps & { cdp: CdpFake } {
  const cdp = createCdpFake();
  const page: PageAgent = {
    resolve: async (anchors) =>
      anchors.map((a) => ({
        anchorId: a.id,
        strategy: cdp.missing.has(a.id) ? ("broken" as const) : "stableId",
        resolved: !cdp.missing.has(a.id),
        // What the resolver says about a missing anchor when it has nothing
        // more specific: gone. `cdp.unresolved` overrides it per anchor.
        failureReason: cdp.missing.has(a.id)
          ? (unresolvedAs.get(a.id) ?? null)
          : null,
      })),
  };
  let clock = 0;
  return {
    page,
    encoder: encoderStub(),
    store: createMemoryFrameStore(),
    clock: {
      now: () => (clock += 10),
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
    // Most tests are not about the mutation gate, so the default lets a
    // scene through; the tests that are about it override this explicitly.
    mayReplay: true,
    // Most tests here replay the default fixture; the handful that replay a
    // variant (`oneClick`, `wideScene`, a hand-built action list) are not
    // about `madeFrom` and do not read it back, so this default is not
    // threaded per call — see `EngineDeps.madeFrom`'s docblock for what it
    // means in production.
    madeFrom: madeFromOf(scene()),
    ...over,
    // Kept concrete past the spread so a test can reach the fake's `calls`
    // and `missing` without casting at every use.
    cdp,
  };
}

/** Everything the walk typed, its keys joined: a type goes in a key at a
 *  time, so no one `insertText` carries the value. */
function typedText(d: { cdp: CdpFake }): string {
  return d.cdp.calls
    .filter((c) => c.method === "Input.insertText")
    .map((c) => String(c.params.text))
    .join("");
}

/** Two beats on one button, recorded at `rects` in order. */
function hoverThenClick(
  rects: { x: number; y: number; width: number; height: number }[],
): SceneDocument {
  const doc = scene();
  const [a, b] = doc.actions as [
    (typeof doc.actions)[number],
    (typeof doc.actions)[number],
  ];
  return {
    ...doc,
    actions: [
      { ...a, kind: "moveTo", rect: rects[0] },
      { ...b, kind: "click", rect: rects[1] },
    ],
  } as SceneDocument;
}

describe("runReplay", () => {
  it("runs against a store that implements only what the engine calls", async () => {
    const written: string[] = [];
    // Deliberately NOT `createMemoryFrameStore()`. The point of this test is
    // that two methods are enough: it is the compile-time assertion that
    // EngineDeps.store is EngineStore and not FrameStore, and `pnpm typecheck`
    // is where it fails if that regresses.
    const store = {
      async putKeyframe(sceneId: string, index: number, _bytes: Uint8Array) {
        const ref = `kf:${sceneId}:${index}`;
        written.push(ref);
        return ref;
      },
      async putBundle(_sceneId: string, _bundle: FrameBundle) {},
    };

    // `deps(over)` takes a Partial<EngineDeps> and spreads it, so this is the
    // compile-time assertion: before the narrowing, `store` is typed
    // FrameStore and a two-method object is rejected here.
    const result = await runReplay(oneClick(), deps({ store }));

    expect(result.outcome).toBe("complete");
    expect(
      written.length,
      `keyframes written: ${written.join(", ")}`,
    ).toBeGreaterThan(0);
  });

  // v8 §5's one brutal rule, asserted where it cannot be bypassed by a UI
  // that forgot to check. The check itself has moved from the scene's flag
  // to the caller's decision, so the refusal is driven by `mayReplay: false`
  // here rather than by `scene.flags.mutating`.
  it("refuses a mutating scene before touching the page", async () => {
    const d = deps({ mayReplay: false });
    const result = await runReplay(
      scene({ flags: { mutating: true, hoverSensitive: false } }),
      d,
    );

    expect(result.reason).toBe("mutating");
    expect(result.bundle).toBeNull();
    expect(result.completed).toBe(0);
    expect(result.lastCompletedActionId).toBeNull();
    expect(d.cdp.calls).toEqual([]);
  });

  // The gate is now a decision the caller made, not a flag the core reads.
  // Required on EngineDeps rather than optional, so a UI that forgets to
  // decide cannot compile — which is stronger than the flag read it replaces.
  it("refuses when the caller says this scene may not replay", async () => {
    const d = deps();
    const result = await runReplay(scene(), { ...d, mayReplay: false });

    expect(result.reason).toBe("mutating");
    expect(result.completed).toBe(0);
    expect(result.bundle).toBeNull();
  });

  it("replays a mutating scene when the caller permits it", async () => {
    const base = scene();
    const mutating = { ...base, flags: { ...base.flags, mutating: true } };
    const d = deps();

    const result = await runReplay(mutating, { ...d, mayReplay: true });

    expect(result.reason).not.toBe("mutating");
  });

  it("applies SP1's production condition before harvesting anything", async () => {
    const d = deps();
    await runReplay(scene(), d);
    const byMethod = (m: string) => d.cdp.calls.find((c) => c.method === m);

    expect(
      byMethod("Emulation.setDeviceMetricsOverride")?.params,
    ).toMatchObject({
      width: 1280,
      height: 800,
      deviceScaleFactor: 3,
    });
    expect(byMethod("Page.setWebLifecycleState")?.params).toEqual({
      state: "active",
    });
    // Runtime is cycled, not just enabled: only a fresh enable replays the
    // execution contexts that already exist, and without them every
    // cross-frame anchor fails. The order is the whole point.
    const methods = d.cdp.calls.map((c) => c.method);
    expect(methods.indexOf("Runtime.disable")).toBeGreaterThan(-1);
    expect(methods.indexOf("Runtime.disable")).toBeLessThan(
      methods.indexOf("Runtime.enable"),
    );
    expect(byMethod("Emulation.setFocusEmulationEnabled")?.params).toEqual({
      enabled: true,
    });
  });

  it("harvests a keyframe at the marker instant, before the verb fires", async () => {
    const d = deps();
    const result = await runReplay(scene(), d);
    const order = d.cdp.calls
      .map((c) => c.method)
      .filter(
        (m) =>
          m === "Page.captureScreenshot" || m === "Input.dispatchMouseEvent",
      );

    // The first mouse events are the path; the marker keyframe lands after
    // the path and the settle, and before the press. SP6 paid for this
    // ordering already: a keyframe tagged downstream renders its still from
    // a camera position the beat was never played at.
    const pressIndex = d.cdp.calls.findIndex(
      (c) => c.params.type === "mousePressed",
    );
    const shotBefore = d.cdp.calls
      .slice(0, pressIndex)
      .filter((c) => c.method === "Page.captureScreenshot").length;
    expect(shotBefore).toBeGreaterThanOrEqual(2); // the opening frame and act-1's marker
    expect(order.length).toBeGreaterThan(0);
    expect(result.bundle?.markers.map((m) => m.actionId)).toEqual([
      "act-1",
      "act-2",
    ]);
  });

  it("records the cursor samples it dispatched and the rects it landed on", async () => {
    const result = await runReplay(scene(), deps());

    expect(result.storageRefused).toBe(false);
    expect(result.bundle?.cursorSamples.length).toBeGreaterThan(10);
    expect(result.bundle?.anchorRects).toEqual([
      {
        actionId: "act-1",
        anchorId: "first-btn",
        rect: { x: 10, y: 20, width: 100, height: 40 },
      },
      {
        actionId: "act-2",
        anchorId: "second-btn",
        rect: { x: 10, y: 20, width: 100, height: 40 },
      },
    ]);
  });

  // The rect the bundle carries is the element as `getBoundingClientRect`
  // reports it, because that is what capture recorded into
  // `fingerprint.boundingRect` — and the compositor frames its camera from
  // these. `DOM.getBoxModel` also returns a `content` quad, inset by padding;
  // reading that one leaves clicks working (symmetric padding shares a
  // centre) while auto-zoom silently frames the label instead of the control.
  // The fake returns two genuinely different quads so this cannot pass by
  // accident.
  it("measures the border box, the way capture measured it", async () => {
    const result = await runReplay(scene(), deps());
    const rect = result.bundle?.anchorRects[0]?.rect;

    expect(rect).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    // Named explicitly so a future reader cannot repair a failure here by
    // editing the expected numbers: this is the content quad, and it is the
    // wrong answer.
    expect(rect).not.toEqual({ x: 30, y: 32, width: 60, height: 16 });
  });

  // The compositor seeds the cursor just outside the first target — low and
  // to the left — so the opening move reads as an approach. Seeded at the
  // origin instead, `retargetSegment` drags the first segment's whole bow to
  // the viewport corner and the replay opens by hovering whatever sits at the
  // top left on its way past.
  it("enters from the plan's entry point rather than the viewport corner", async () => {
    const doc = scene();
    const result = await runReplay(doc, deps());
    const entry = planScene(doc).cursorSegments[0]?.from;
    const first = result.bundle?.cursorSamples[0];

    expect(entry).toBeDefined();
    expect(entry).not.toEqual({ x: 0, y: 0 });
    expect(first?.x).toBeCloseTo(entry?.x as number, 5);
    expect(first?.y).toBeCloseTo(entry?.y as number, 5);
  });

  it("stops where an anchor no longer resolves and reports how far it got", async () => {
    const d = deps();
    d.cdp.missing.add("second-btn");
    const result = await runReplay(scene(), d);

    expect(result.outcome).toBe("partial");
    expect(result.reason).toBe("unresolvedAnchor");
    expect(result.completed).toBe(1);
    expect(result.total).toBe(2);
    // The id of the step that DID complete, not an index into whatever log
    // the caller happened to hand in — see `ReplayResult.lastCompletedActionId`.
    expect(result.lastCompletedActionId).toBe("act-1");
    // A partial run is still a bundle: SP10's retro-keep reports
    // "reconstructed through step 6 of 9" from exactly this.
    expect(result.bundle?.markers.length).toBe(1);
  });

  // Three different author actions, so three different reasons. The resolver
  // already distinguishes them; folding them into one threw away the only
  // signal an author has about which of the three they are looking at.
  it("tells a tied anchor from an unrendered row from one that is gone", async () => {
    const stopFor = async (
      failure: ResolveFailure | null,
    ): Promise<string | null> => {
      const d = deps(
        {},
        failure === null ? new Map() : new Map([["second-btn", failure]]),
      );
      d.cdp.missing.add("second-btn");
      return (await runReplay(scene(), d)).reason;
    };

    // Several candidates matched: clicking one of them is how a replay clicks
    // the wrong row of a table. The anchor needs disambiguating.
    expect(await stopFor("ambiguousTie")).toBe("ambiguousAnchor");
    // Not in the tree *yet* — a virtualized row the app can be asked to
    // scroll to. Not the same as gone.
    expect(await stopFor("notInTree")).toBe("anchorNotRendered");
    // Everything else means the element could not be found.
    expect(await stopFor("closedShadowRoot")).toBe("unresolvedAnchor");
    expect(await stopFor(null)).toBe("unresolvedAnchor");
    // Except silence, which is not a verdict about the element at all: the
    // page agent reports it when the tab never answered, and it earns its
    // own reason rather than "gone".
    expect(await stopFor("pageSilent")).toBe("pageSilent");
  });

  // v8 §5: "a scene containing a redacted type can't fully replay, and that
  // is correct behavior". Typing a placeholder into a real logged-in app is
  // not an acceptable alternative.
  it("stops at a redacted type with no replacement to supply the value", async () => {
    const doc = scene();
    const result = await runReplay(
      {
        ...doc,
        actions: [
          {
            id: "act-1",
            kind: "type",
            anchorId: "first-btn",
            timestamp: 0,
            marker: "type:first-btn",
            text: null,
            redacted: true,
          },
        ],
      } as SceneDocument,
      deps(),
    );

    expect(result.reason).toBe("redactedWithoutReplacement");
    expect(result.outcome).toBe("partial");
  });

  // "Make this field say X" is what a type action records for an input or a
  // textarea, so replay selects the field's contents and types over them. A
  // contenteditable host is the whole editor, and its contents are the
  // document: selecting all and typing over it would destroy every
  // paragraph the author did not touch. The sensor marks a host's type
  // action, and replay inserts at the caret the click left.
  it("types into a contenteditable host at the caret, without selecting its contents", async () => {
    const doc = scene();
    const d = deps();
    const result = await runReplay(
      {
        ...doc,
        actions: [
          {
            id: "act-1",
            kind: "type",
            anchorId: "first-btn",
            timestamp: 0,
            marker: "type:first-btn",
            text: "hi",
            redacted: false,
            host: true,
          },
        ],
      } as SceneDocument,
      d,
    );

    expect(result.outcome).toBe("complete");
    const selectAll = d.cdp.calls.filter(
      (c) =>
        c.method === "Input.dispatchKeyEvent" &&
        (c.params.commands as string[] | undefined)?.includes("selectAll"),
    );
    expect(selectAll).toEqual([]);
    expect(typedText(d)).toBe("hi");
  });

  it("still selects an input's contents before typing over them", async () => {
    const doc = scene();
    const d = deps();
    await runReplay(
      {
        ...doc,
        actions: [
          {
            id: "act-1",
            kind: "type",
            anchorId: "first-btn",
            timestamp: 0,
            marker: "type:first-btn",
            text: "hi",
            redacted: false,
          },
        ],
      } as SceneDocument,
      d,
    );

    const selectAll = d.cdp.calls.filter(
      (c) =>
        c.method === "Input.dispatchKeyEvent" &&
        (c.params.commands as string[] | undefined)?.includes("selectAll"),
    );
    expect(selectAll).toHaveLength(1);
  });

  it("a click at {x:0.25,y:0.5} sends its mouse events at that spot of the box", async () => {
    const d = deps();
    // The page sees the click where it is sent: not the default centre.
    const seen = d.cdp.click;
    if (seen === "unreadable" || seen === "unplaceable")
      throw new Error("fake");
    d.cdp.click = { ...seen, down: { x: 35, y: 40 }, up: { x: 35, y: 40 } };
    const result = await runReplay(
      {
        ...scene(),
        actions: [
          {
            id: "act-1",
            kind: "click",
            anchorId: "first-btn",
            timestamp: 0,
            marker: "click:first-btn",
            at: { x: 0.25, y: 0.5 },
          },
        ],
      } as SceneDocument,
      d,
    );
    expect(result.outcome, String(result.reason)).toBe("complete");
    const presses = d.cdp.calls.filter(
      (c) =>
        c.method === "Input.dispatchMouseEvent" &&
        (c.params.type === "mousePressed" || c.params.type === "mouseReleased"),
    );
    // The fixture's border box is x 10, y 20, 100 x 40 (cdp-fake): the
    // premise the coordinates below are read from.
    expect(presses).toHaveLength(2);
    for (const c of presses) {
      expect([c.params.x, c.params.y], JSON.stringify(c.params)).toEqual([
        35, 40,
      ]);
    }
  });

  const pressScene = (key: string): SceneDocument =>
    ({
      ...scene(),
      actions: [
        {
          id: "act-1",
          kind: "press",
          anchorId: null,
          timestamp: 0,
          marker: "press:none",
          key,
        },
      ],
    }) as SceneDocument;

  it("a press-only scene still gets a bundle, with its marker", async () => {
    const doc = pressScene("Enter");
    const d = deps({ madeFrom: madeFromOf(doc) });
    const result = await runReplay(doc, d);
    expect(result.outcome, String(result.reason)).toBe("complete");
    // The premise: nothing in it moves the cursor or measures an anchor.
    expect(result.bundle?.cursorSamples ?? []).toEqual([]);
    expect(result.bundle?.anchorRects ?? []).toEqual([]);
    expect(result.bundle?.markers.map((m) => m.actionId)).toEqual(["act-1"]);
  });

  it("press Tab sends rawKeyDown and keyUp with key Tab, code Tab, code 9 and no text", async () => {
    const d = deps();
    const result = await runReplay(pressScene("Tab"), d);
    expect(result.outcome, String(result.reason)).toBe("complete");
    const keys = d.cdp.calls.filter(
      (c) => c.method === "Input.dispatchKeyEvent",
    );
    expect(keys.map((c) => c.params.type)).toEqual(["rawKeyDown", "keyUp"]);
    for (const k of keys) {
      expect(k.params).toMatchObject({
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
      expect("text" in k.params).toBe(false);
    }
  });

  it("press Space carries text ' '", async () => {
    const d = deps();
    await runReplay(pressScene("Space"), d);
    const down = d.cdp.calls.find(
      (c) =>
        c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown",
    );
    expect(down?.params).toMatchObject({ code: "Space", text: " " });
  });

  it("press Enter sends keyDown and keyUp with key Enter and text \\r", async () => {
    const d = deps();
    const result = await runReplay(
      {
        ...scene(),
        actions: [
          {
            id: "act-1",
            kind: "press",
            anchorId: null,
            timestamp: 0,
            marker: "press:none",
            key: "Enter",
          },
        ],
      } as SceneDocument,
      d,
    );
    expect(result.outcome, String(result.reason)).toBe("complete");
    const keys = d.cdp.calls.filter(
      (c) => c.method === "Input.dispatchKeyEvent",
    );
    expect(keys.map((c) => c.params.type)).toEqual(["keyDown", "keyUp"]);
    expect(keys[0]?.params).toMatchObject({ key: "Enter", text: "\r" });
    expect(keys[1]?.params).toMatchObject({ key: "Enter" });
  });

  // The film records while the verb runs, so the text appears on screen as
  // fast as it goes in: one `insertText` of the whole string put it there
  // in a single frame. A key at a time, spaced, is what types it.
  function typeOf(text: string): SceneDocument {
    const doc = scene();
    return {
      ...doc,
      actions: [
        {
          id: "act-1",
          kind: "type",
          anchorId: "first-btn",
          timestamp: 0,
          marker: "type:first-btn",
          text,
          redacted: false,
        },
      ],
    } as SceneDocument;
  }
  /** Each release, select-all, key and sleep, in the order the walk made
   *  them. */
  function typingLog(d: ReturnType<typeof deps>): string[] {
    const log: string[] = [];
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params) => {
      if (method === "Input.insertText") log.push(`key ${params?.text}`);
      if (
        method === "Input.dispatchMouseEvent" &&
        params?.type === "mouseReleased"
      )
        log.push("release");
      if (
        method === "Input.dispatchKeyEvent" &&
        JSON.stringify(params?.commands) === '["selectAll"]'
      )
        log.push("selectAll");
      return send(method, params);
    };
    const sleep = d.clock.sleep;
    d.clock.sleep = async (ms) => {
      log.push(`sleep ${ms}`);
      return sleep(ms);
    };
    return log;
  }
  const keysOnly = (log: string[]) => {
    const first = log.findIndex((l) => l.startsWith("key "));
    // `findLastIndex` is ES2023; this package compiles against ES2022.
    const last =
      log.length -
      1 -
      [...log].reverse().findIndex((l) => l.startsWith("key "));
    return log.slice(first, last + 1);
  };

  it("types one character at a time, at a human pace", async () => {
    const d = deps();
    const log = typingLog(d);
    const result = await runReplay(typeOf("hi there"), d);

    expect(result.outcome).toBe("complete");
    const keys = keysOnly(log);
    expect(keys, log.join("\n")).toEqual(
      [..."hi there"].flatMap((ch, i) =>
        i === 0 ? [`key ${ch}`] : [`sleep ${TYPE_KEY_MS}`, `key ${ch}`],
      ),
    );
  });

  // A person clicks into a field and the caret shows before the first key.
  // Without the beat the click and the first letter land together, and the
  // drawn press has nothing to its own.
  it("waits a beat after the click before the first key", async () => {
    const d = deps();
    const log = typingLog(d);
    await runReplay(typeOf("hi"), d);

    const release = log.lastIndexOf("release");
    const firstKey = log.findIndex((l) => l.startsWith("key "));
    // The premise: the type clicked its field before typing into it.
    expect(release, log.join("\n")).toBeGreaterThanOrEqual(0);
    expect(log.slice(release, firstKey + 1), log.join("\n")).toEqual([
      "release",
      `sleep ${TYPE_LEAD_MS}`,
      "selectAll",
      "key h",
    ]);
  });

  it("types a long value faster, so it never takes longer than the ceiling", async () => {
    const text = "x".repeat(200);
    // The premise: at the everyday pace this text would run past the ceiling.
    expect(text.length * TYPE_KEY_MS).toBeGreaterThan(TYPE_MAX_MS);
    const d = deps();
    const log = typingLog(d);
    await runReplay(typeOf(text), d);

    const keys = keysOnly(log);
    expect(keys.filter((l) => l.startsWith("key "))).toHaveLength(200);
    const slept = keys
      .filter((l) => l.startsWith("sleep "))
      .reduce((sum, l) => sum + Number(l.slice(6)), 0);
    expect(slept).toBeLessThanOrEqual(TYPE_MAX_MS);
    expect(slept).toBeGreaterThan(TYPE_MAX_MS * 0.9);
  });

  // An emoji is two UTF-16 units, a flag four: split by code unit, each half
  // goes in as a lone surrogate and the field shows garbage.
  it("never splits a character the reader sees as one", async () => {
    const d = deps();
    const log = typingLog(d);
    await runReplay(typeOf("a👍🇫🇷é"), d);

    expect(
      keysOnly(log).filter((l) => l.startsWith("key ")),
      log.join("\n"),
    ).toEqual(["key a", "key 👍", "key 🇫🇷", "key é"]);
  });

  // Backbone property: every bundle the engine emits parses, complete runs
  // and partial ones alike.
  it("emits a bundle the compositor's schema accepts", async () => {
    const complete = await runReplay(scene(), deps());
    expect(() => validateBundle(complete.bundle)).not.toThrow();

    const d = deps();
    d.cdp.missing.add("second-btn");
    const partial = await runReplay(scene(), d);
    expect(() => validateBundle(partial.bundle)).not.toThrow();
  });

  // --- the screencast intake ---------------------------------------------
  // Most of this path's branches now have a direct test in
  // replay-motion-recorder.test.ts, which calls the handler rather than
  // driving a whole run. What is left here is what only a real run can
  // pin: the engine's own CDP calls around the recorder, and the surface
  // mismatch's note content.

  /**
   * The take of 2026-08-30, reproduced from its own numbers.
   *
   * A 1710x840 capture viewport replayed in the 900x640 window: the
   * keyframes came back 5130x2520, a clean 3x, and the screencast came back
   * 1800x1104 — the window's own content area, and a crop of the page's
   * top-left corner. `renderFrame` maps a frame's full extent onto the full
   * viewport rect, so those frames rendered 1.90x magnified across and 1.52x
   * down: zoomed in and a quarter wider than tall, for every scroll and
   * every page load in the video, while the stills either side of them were
   * correct.
   */
  const HARVESTED_VIEWPORT = { width: 1710, height: 840 };
  const FROM_THE_SURFACE = { width: 1800, height: 1104 };

  function wideScene(): SceneDocument {
    const doc = oneClick();
    return {
      ...doc,
      meta: {
        ...doc.meta,
        capture: { ...doc.meta.capture, viewport: HARVESTED_VIEWPORT },
      },
    } as SceneDocument;
  }

  it("says why it refused, rather than reporting a page that held still", async () => {
    const d = deps();
    emitDuringSpan(d, [
      frame(
        1,
        fakeScreenshotBase64(FROM_THE_SURFACE.width, FROM_THE_SURFACE.height),
      ),
    ]);

    const result = await runReplay(wideScene(), d);

    const reported = result.degradations.filter(
      (dg) => dg.kind === "surfaceMismatch",
    );
    expect(reported.length).toBe(1);
    expect(reported[0]?.note).toContain("1800x1104");
    expect(reported[0]?.note).toContain("1710x840");
  });

  // The correction, measured against real Chrome: re-sending the override
  // after the surface has drifted puts the frames back at the emulated size.
  it("re-asserts the metrics override when the surface has drifted", async () => {
    const d = deps();
    emitDuringSpan(d, [
      frame(
        1,
        fakeScreenshotBase64(FROM_THE_SURFACE.width, FROM_THE_SURFACE.height),
      ),
    ]);

    await runReplay(wideScene(), d);

    const overrides = d.cdp.calls.filter(
      (c) => c.method === "Emulation.setDeviceMetricsOverride",
    );
    // One at setup, one on detection. Without the correction the surface
    // stays wrong and every later frame of the run is refused too.
    expect(overrides.length).toBe(2);
    expect(overrides[1]?.params).toEqual(
      expect.objectContaining(HARVESTED_VIEWPORT),
    );
  });

  /**
   * The corrective scroll aims everything downstream: the rect is measured
   * once it returns, the cursor path is dispatched at that rect, and the
   * click lands where the path ended. A scroll still moving when the wait
   * expires makes all three point at where the target used to be — on a run
   * that then reports `complete`.
   */
  it("says when the corrective scroll never settled", async () => {
    const d = deps();
    d.cdp.scroll = { settled: false, movedPx: 400 };

    const result = await runReplay(oneClick(), d);

    const reported = result.degradations.filter(
      (dg) => dg.kind === "scrollUnsettled",
    );
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0]?.note).toContain("still moving");
  });

  it("treats a scroll reply it cannot read as a scroll that did not settle", async () => {
    const d = deps();
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params?.functionDeclaration ?? "").includes("scrollIntoView")
      ) {
        return {};
      }
      return send(method, params);
    };

    const result = await runReplay(oneClick(), d);

    expect(
      result.degradations.some(
        (dg) =>
          dg.kind === "scrollUnsettled" &&
          dg.note.includes("nothing this could read"),
      ),
    ).toBe(true);
  });

  // The defect this replaced scrolled twice: an instant correction to the
  // screen edge that nothing recorded, then a smooth scroll over the short
  // remainder that a span did record. One scroll per beat is the fix.
  it("scrolls a scrollTo beat once, not once to the edge and once to the middle", async () => {
    const doc = scene();
    const scrolling: SceneDocument = {
      ...doc,
      actions: [
        {
          ...(doc.actions[0] as (typeof doc.actions)[number]),
          kind: "scrollTo",
        },
      ],
    } as SceneDocument;
    const d = deps();

    await runReplay(scrolling, d);

    const scrolls = d.cdp.calls.filter(
      (c) =>
        c.method === "Runtime.callFunctionOn" &&
        String(c.params.functionDeclaration ?? "").includes("scrollIntoView"),
    );
    expect(scrolls.length).toBe(1);
    // And it goes straight to where the beat wants the target, rather than
    // to the nearest edge and then onward.
    expect(String(scrolls[0]?.params.functionDeclaration)).toContain(
      'block: "center"',
    );
  });

  /** One `scrollTo` beat, recorded (or not) at `rect`. */
  function recordedScroll(
    rect: { x: number; y: number; width: number; height: number } | null,
  ): SceneDocument {
    const doc = scene();
    const first = doc.actions[0] as (typeof doc.actions)[number];
    return {
      ...doc,
      actions: [
        { ...first, kind: "scrollTo", ...(rect === null ? {} : { rect }) },
      ],
    } as SceneDocument;
  }

  const scrollCalls = (d: EngineDeps & { cdp: CdpFake }) =>
    d.cdp.calls
      .filter(
        (c) =>
          c.method === "Runtime.callFunctionOn" &&
          String(c.params.functionDeclaration ?? "").includes(SCROLL_MARKER),
      )
      .map((c) => String(c.params.functionDeclaration));

  // The author's take of 2026-09-29: the anchor under the centre of the
  // screen was a 909px block whose top sat at y=318 when the scroll stopped.
  // Centring it put its top at -34.5, 352px short of the author's scroll,
  // and the next step's corrective scroll then parked the button at the edge.
  it("returns a recorded scroll's anchor to where the author left it", async () => {
    const d = deps();
    const result = await runReplay(
      recordedScroll({ x: 215, y: 318, width: 1280, height: 909 }),
      d,
    );

    expect(result.outcome).toBe("complete");
    const scrolls = scrollCalls(d);
    expect(scrolls.length, scrolls.join("\n---\n")).toBe(1);
    expect(scrolls[0]).toContain("318");
    expect(scrolls[0]).not.toContain('block: "center"');
    expect(result.degradations.map((g) => g.kind)).not.toContain(
      "scrollLandingOffscreen",
    );
  });

  // An authored script names an element and nothing else, and a document
  // written before `action.rect` existed has none: both keep the centring
  // scroll, which is the only aim there is without a recorded landing.
  it("centres a scroll that has no recorded landing", async () => {
    const d = deps();
    const result = await runReplay(recordedScroll(null), d);

    expect(scrollCalls(d)[0]).toContain('block: "center"');
    expect(result.degradations.map((g) => g.kind)).not.toContain(
      "scrollLandingOffscreen",
    );
  });

  // A recorded landing the anchor could not have had: it was chosen from the
  // centre of the screen, so a rect that misses the viewport was measured
  // late, after the page moved (the hover rect on the same take read y=2460
  // in an 840px viewport for exactly that reason). Aiming at it would scroll
  // the anchor off screen, so the scroll centres instead — and says so,
  // because a landing that is not the author's must not read like one.
  it("centres a scroll whose recorded landing is off screen, and says so", async () => {
    const d = deps();
    const result = await runReplay(
      recordedScroll({ x: 747, y: 2460, width: 103, height: 40 }),
      d,
    );

    expect(result.outcome).toBe("complete");
    expect(scrollCalls(d)[0]).toContain('block: "center"');
    const said = result.degradations.find(
      (g) => g.kind === "scrollLandingOffscreen",
    );
    expect(said, JSON.stringify(result.degradations)).toBeDefined();
    expect(said?.note).toContain("2460");
  });

  /**
   * One authored `scrollTo`, run through `runAuthored` against the same fake
   * page as the document runs above. The fake's element measures
   * (10, 20, 100x40), so a landing at 280 is a real move from where it sits.
   */
  async function authoredScroll(landing: { top: number } | undefined) {
    const d = deps();
    let n = 0;
    const result = await runAuthored(
      {
        scriptVersion: 1,
        name: "one scroll",
        target: "https://app.example.com/",
        steps: [
          {
            do: "scrollTo",
            on: { stableId: "b" },
            ...(landing === undefined ? {} : { landing }),
          },
        ],
      },
      {
        ...d,
        captureResolved: async (intent) => ({
          anchor: {
            id: intent.id,
            fingerprint: {
              ...intent.fingerprint,
              boundingRect: { x: 10, y: 20, width: 100, height: 40 },
            },
            resolution: {
              url: "https://app.example.com/",
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
        sceneId: "authored-scroll",
        createdAt: "2026-09-30T09:00:00.000Z",
        viewport: { width: 1280, height: 800 },
        startingBranding: BRANDING_DEFAULTS,
        cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
      },
    );
    return { d, result };
  }

  // The film lane's long page, 2026-10-07: an authored action was stamped when
  // its step was pulled, before the walk located the element, moved the
  // cursor and settled, while its marker was set after all of that. In a
  // sampled film the retimer stretches each pair of markers to the pair's
  // timestamp gap, so every step froze for about the previous step's move:
  // 652ms after a 640ms hover, before a click that did not move at all. A
  // capture take's markers ARE its timestamps (`bundleFromCapture`); an
  // authored take's must be too.
  it("stamps each authored action at its marker, the instant the frames show", async () => {
    const d = deps();
    let n = 0;
    const result = await runAuthored(
      {
        scriptVersion: 1,
        name: "hover then click",
        target: "https://app.example.com/",
        steps: [
          { do: "waitForLoad" },
          { do: "hover", on: { stableId: "b" } },
          { do: "click", on: { stableId: "b" } },
        ],
      },
      {
        ...d,
        captureResolved: async (intent) => ({
          anchor: {
            id: intent.id,
            fingerprint: {
              ...intent.fingerprint,
              boundingRect: { x: 600, y: 400, width: 100, height: 40 },
            },
            resolution: {
              url: "https://app.example.com/",
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
        sceneId: "authored-stamps",
        createdAt: "2026-10-07T09:00:00.000Z",
        viewport: { width: 1280, height: 800 },
        startingBranding: BRANDING_DEFAULTS,
        cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
      },
    );

    expect(result.outcome, JSON.stringify(result)).toBe("complete");
    const actions = result.document?.actions ?? [];
    const markers = result.bundle?.markers ?? [];
    const evidence = JSON.stringify({
      actions: actions.map((a) => [a.id, a.kind, a.timestamp]),
      markers,
    });
    // The premise: a wait, and a hover whose cursor really travelled first,
    // so its marker comes well after the moment its step was pulled.
    expect(
      actions.map((a) => a.kind),
      evidence,
    ).toEqual(["waitFor", "moveTo", "click"]);
    const hoverAt = markers.find((m) => m.actionId === actions[1]?.id);
    const travelled = (result.bundle?.cursorSamples ?? []).filter(
      (c) => c.sourceTimeMs <= (hoverAt?.sourceTimeMs ?? 0),
    );
    expect(travelled.length, evidence).toBeGreaterThan(2);

    for (const action of actions) {
      const marker = markers.find((m) => m.actionId === action.id);
      expect(marker, evidence).toBeDefined();
      expect(action.timestamp, evidence).toBe(marker?.sourceTimeMs);
    }
  });

  // A derived script carries where the author's scroll stopped as intent
  // (`landing`), because an authored action has no recorded rect to aim at.
  // The film lane's take of 2026-09-30 centred six scrolls instead, off by up
  // to 580px, and reported `complete` with no degradation.
  it("lands an authored scroll where its script says, not centred", async () => {
    const { d, result } = await authoredScroll({ top: 280 });

    expect(result.outcome, JSON.stringify(result)).toBe("complete");
    const scrolls = scrollCalls(d);
    expect(scrolls.length, scrolls.join("\n---\n")).toBe(1);
    expect(scrolls[0]).toContain("280");
    expect(scrolls[0]).not.toContain('block: "center"');
    expect(result.degradations.map((g) => g.kind)).not.toContain(
      "scrollLandingOffscreen",
    );
  });

  // The positive control for the case above: the same run without `landing`
  // still centres, so the 280 there came from the landing and nothing else.
  it("centres an authored scroll whose script names only the element", async () => {
    const { d, result } = await authoredScroll(undefined);

    expect(result.outcome, JSON.stringify(result)).toBe("complete");
    expect(scrollCalls(d)[0]).toContain('block: "center"');
    expect(result.degradations.map((g) => g.kind)).not.toContain(
      "scrollLandingOffscreen",
    );
  });

  // The recorded rule, for an authored top: a landing that would leave the
  // element off screen is not one to aim at, so the scroll centres — and
  // says so.
  it("centres an authored scroll whose landing is off screen, and says so", async () => {
    const { d, result } = await authoredScroll({ top: 2460 });

    expect(result.outcome, JSON.stringify(result)).toBe("complete");
    expect(scrollCalls(d)[0]).toContain('block: "center"');
    const said = result.degradations.find(
      (g) => g.kind === "scrollLandingOffscreen",
    );
    expect(said, JSON.stringify(result.degradations)).toBeDefined();
    expect(said?.note).toContain("2460");
  });

  // --- the cursor path ---------------------------------------------------

  /** Where the fake's box model puts every target: the centre of its border quad. */
  const TARGET = { x: 60, y: 40 };

  // film-check spec §1: a scroll leaves the cursor where the previous step
  // put it, the way a wheel leaves the pointer.
  it("does not move the cursor for a scroll", async () => {
    const doc = scene({ anchorIds: ["first-btn", "row", "second-btn"] });
    const [a, b, c] = doc.actions as [
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
    ];
    const scrolling = {
      ...doc,
      actions: [
        a,
        {
          id: b.id,
          anchorId: b.anchorId,
          timestamp: b.timestamp,
          marker: `scrollTo:${b.anchorId}`,
          kind: "scrollTo",
        },
        c,
      ],
    } as SceneDocument;
    // The premise: the scroll's anchor has a rect, so a planner that ignored
    // the table would make it a waypoint.
    expect(
      scrolling.anchors.find((x) => x.id === "row")?.fingerprint.boundingRect,
    ).not.toBeNull();

    const d = deps();
    const result = await runReplay(scrolling, d);

    expect(result.outcome).toBe("complete");
    const bundle = result.bundle as FrameBundle;
    const at = (id: string) =>
      bundle.markers.find((m) => m.actionId === id)?.sourceTimeMs as number;
    const during = bundle.cursorSamples.filter(
      (s) => s.sourceTimeMs > at("act-1") && s.sourceTimeMs <= at("act-2"),
    );
    expect(during, JSON.stringify(bundle.cursorSamples)).toEqual([]);
    // Positive controls: the fake does produce cursor samples, both on the way
    // to the first click and on the way to the last, so the empty window above
    // is the scroll's doing and not an absent cursor.
    const toFirst = bundle.cursorSamples.filter(
      (s) => s.sourceTimeMs <= at("act-1"),
    );
    const toLast = bundle.cursorSamples.filter(
      (s) => s.sourceTimeMs > at("act-2") && s.sourceTimeMs <= at("act-3"),
    );
    expect(
      toFirst.length,
      JSON.stringify(bundle.cursorSamples),
    ).toBeGreaterThan(0);
    expect(toLast.length, JSON.stringify(bundle.cursorSamples)).toBeGreaterThan(
      0,
    );
  });

  // The author's take of 2026-09-29: a hover on "Get started" recorded two
  // screens down (measured after the click's jump), then the click on it. The
  // click's segment was planned across that 2310px gap, the cursor was
  // already on the button, and the path swung 180px off it and back.
  it("does not move a cursor that is already on the click's target", async () => {
    const doc = hoverThenClick([
      { x: 747, y: 2460, width: 103, height: 40 },
      { x: 747, y: 150, width: 103, height: 40 },
    ]);
    // The premise: the plan really does send the click on a long, bowed trip,
    // or there is no loop for the walk to avoid.
    const planned = planScene(doc).cursorSegments.find(
      (g) => g.toActionId === "act-2",
    );
    expect(planned?.durationMs).toBe(1400);

    const d = deps();
    const result = await runReplay(doc, d);

    expect(result.outcome).toBe("complete");
    const bundle = result.bundle as FrameBundle;
    const hoverAt = bundle.markers.find((m) => m.actionId === "act-1")
      ?.sourceTimeMs as number;
    const after = bundle.cursorSamples.filter((c) => c.sourceTimeMs > hoverAt);
    const farthest = Math.max(
      0,
      ...after.map((c) => Math.hypot(c.x - TARGET.x, c.y - TARGET.y)),
    );
    expect(farthest, JSON.stringify(after.slice(0, 20))).toBeLessThan(1);
  });

  // Each step used to sleep 8ms AFTER its `mouseMoved` came back, and Chrome
  // answers one only when the renderer has taken it — about a frame. So every
  // path took about twice its plan: 1.4s for a 700ms move, twice in a row on
  // the author's take. The fake answers after 9ms, the same shape.
  it("keeps a path to its planned duration when each move takes time to land", async () => {
    // Two clicks, the second measured across the viewport from the first:
    // the fake's box model puts every target at one box, so the second gets
    // its own here. The walk moves the cursor between the rects it measures,
    // so that travel is the move whose timing is under test.
    const FAR = { x: 1150, y: 720 };
    const expected = segmentDurationMs(TARGET, FAR);
    // The premise: a move long enough that doubling it is unmistakable.
    expect(expected).toBeGreaterThanOrEqual(600);

    const d = deps();
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params) => {
      if (
        method === "DOM.getBoxModel" &&
        String(params?.objectId ?? "").includes(":second-btn:")
      ) {
        const [l, t, r, b] = [FAR.x - 50, FAR.y - 20, FAR.x + 50, FAR.y + 20];
        const quad = [l, t, r, t, r, b, l, b];
        return { model: { border: quad, content: quad } };
      }
      const reply = await send(method, params);
      // Chrome answers a `mouseMoved` once the renderer has taken it.
      if (method === "Input.dispatchMouseEvent") await d.clock.sleep(9);
      return reply;
    };
    const result = await runReplay(scene(), d);

    expect(result.outcome).toBe("complete");
    const bundle = result.bundle as FrameBundle;
    const firstAt = bundle.markers.find((m) => m.actionId === "act-1")
      ?.sourceTimeMs as number;
    const path = bundle.cursorSamples.filter((c) => c.sourceTimeMs > firstAt);
    const span =
      (path.at(-1)?.sourceTimeMs ?? 0) - (path[0]?.sourceTimeMs ?? 0);
    const evidence = `${path.length} samples over ${span}ms`;
    // The move really ran across to the far target.
    expect(path.at(-1), evidence).toMatchObject(FAR);
    // One step of lateness, plus the fake clock's 10ms a read.
    expect(span, evidence).toBeLessThanOrEqual(expected + 50);
    expect(span, evidence).toBeGreaterThanOrEqual(expected - 50);
  });

  // The author's probe of 2026-10-07: every agent move had one frame that
  // jumped 1.4-1.7x its neighbours, near top speed. The path was planned as
  // 8ms samples and Chrome answers a move about every 16.7ms, so each send
  // took the latest sample due, advancing 16ms of plan per 16.7ms of clock
  // until one send had to skip three. The drawn cursor is these samples at
  // their real times, so the skip was in the video. Here the fake answers
  // after 9ms and every clock read costs 10ms — a cadence off the 8ms grid,
  // the same shape.
  it("moves the cursor without a jump when moves land off the planned grid", async () => {
    const FAR = { x: 1150, y: 720 };
    // The premise: a long move. The 1.15 below holds for the ease's own
    // shape only when its peak is broad; sampled once a frame, a perfect
    // easeInOutCubic of 233-334ms already scores 1.11-1.26 (measured on the
    // probe's moves), so a short one could not tell a jump from the curve.
    expect(segmentDurationMs(TARGET, FAR)).toBeGreaterThanOrEqual(600);
    const d = deps();
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params) => {
      if (
        method === "DOM.getBoxModel" &&
        String(params?.objectId ?? "").includes(":second-btn:")
      ) {
        const [l, t, r, b] = [FAR.x - 50, FAR.y - 20, FAR.x + 50, FAR.y + 20];
        const quad = [l, t, r, t, r, b, l, b];
        return { model: { border: quad, content: quad } };
      }
      const reply = await send(method, params);
      if (method === "Input.dispatchMouseEvent") await d.clock.sleep(9);
      return reply;
    };
    const result = await runReplay(scene(), d);

    expect(result.outcome).toBe("complete");
    const bundle = result.bundle as FrameBundle;
    const firstAt = bundle.markers.find((m) => m.actionId === "act-1")
      ?.sourceTimeMs as number;
    const path = bundle.cursorSamples.filter((c) => c.sourceTimeMs > firstAt);
    const steps = path
      .slice(1)
      .map((c, i) =>
        Math.hypot(
          c.x - (path[i] as { x: number }).x,
          c.y - (path[i] as { y: number }).y,
        ),
      );
    const peak = Math.max(...steps);
    const evidence = `steps ${steps.map((s) => s.toFixed(1)).join(", ")}`;
    // The premise: the move ran to the far target, and enough of it is fast
    // for a jump there to have somewhere to show. An ease's speed is smooth,
    // so neighbouring steps above half its peak differ by little.
    expect(path.at(-1), evidence).toMatchObject(FAR);
    const fast = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => i > 0 && i < steps.length - 1 && s >= peak / 2);
    expect(fast.length, evidence).toBeGreaterThanOrEqual(5);

    const worst = Math.max(
      ...fast.map(
        ({ s, i }) =>
          s / (((steps[i - 1] as number) + (steps[i + 1] as number)) / 2),
      ),
    );
    expect(worst, evidence).toBeLessThanOrEqual(1.15);
  });

  it("acknowledges a frame that arrives with no span open", async () => {
    const d = deps();
    // The opening keyframe is taken before any span exists, and `locate`'s
    // first port call is the seam for it.
    const resolve = d.page.resolve;
    let fired = false;
    d.page = {
      resolve: async (anchors) => {
        if (!fired) {
          fired = true;
          d.cdp.emit("Page.screencastFrame", frame(77));
        }
        return resolve(anchors);
      },
    };

    const result = await runReplay(oneClick(), d);

    // Acked anyway: Chrome withholds the next frame until the last is
    // acknowledged, so an ack skipped for want of a span stalls the span
    // that comes after it.
    expect(
      d.cdp.calls.some(
        (c) =>
          c.method === "Page.screencastFrameAck" && c.params.sessionId === 77,
      ),
    ).toBe(true);
    // Acked, but not encoded and not charged to any span.
    expect(result.counters.motionFrames).toBe(0);
    expect(result.counters.droppedMotionFrames).toBe(0);
    expect(result.counters.budgetBreaches).toBe(0);
  });

  // --- the cross-frame lookup --------------------------------------------
  // Step 1's hard part: an anchor parked inside an iframe lives on THAT
  // frame's window, so the evaluate has to name that frame's default context.

  const IN_FRAME =
    "#frame(origin=https://pay.example.com,name=checkout,ordinal=1)/button:1";

  /** A child document under the top frame, as CDP reports it. */
  function withChildFrame(d: EngineDeps & { cdp: CdpFake }): void {
    d.cdp.frameTree.childFrames = [
      {
        frame: {
          id: "frame-pay",
          url: "https://pay.example.com/card",
          name: "checkout",
        },
        childFrames: [],
      },
    ];
  }

  function framedScene(): SceneDocument {
    const doc = oneClick();
    const first = doc.anchors[0] as (typeof doc.anchors)[number];
    return {
      ...doc,
      anchors: [
        { ...first, fingerprint: { ...first.fingerprint, treePath: IN_FRAME } },
        ...doc.anchors.slice(1),
      ],
    } as SceneDocument;
  }

  /** Announce an execution context just before the engine looks the anchor
   *  up — the same ordering Runtime.enable produces when it replays the
   *  contexts that already exist. */
  function announceContext(
    d: EngineDeps & { cdp: CdpFake },
    context: Record<string, unknown>,
  ): void {
    const resolve = d.page.resolve;
    let fired = false;
    d.page = {
      resolve: async (anchors) => {
        if (!fired) {
          fired = true;
          d.cdp.emit("Runtime.executionContextCreated", { context });
        }
        return resolve(anchors);
      },
    };
  }

  it("evaluates an in-frame anchor in that frame's default context", async () => {
    const d = deps();
    withChildFrame(d);
    announceContext(d, {
      id: 42,
      auxData: { frameId: "frame-pay", isDefault: true },
    });

    const result = await runReplay(framedScene(), d);

    // The anchor lookups specifically. Not "every evaluate" — the settle
    // probe is one too, and a positional assertion would break the moment
    // anything else asked the page a question.
    const evaluated = d.cdp.calls.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        String(c.params.expression ?? "").includes(REPLAY_TARGETS),
    );
    expect(evaluated.length).toBeGreaterThan(0);
    expect(evaluated[0]?.params.contextId).toBe(42);
    // The obvious-looking call, and the wrong one: an isolated world has its
    // own global and cannot see what the sensor parked on MAIN, so it would
    // report every cross-frame anchor as missing.
    expect(
      d.cdp.calls.some((c) => c.method === "Page.createIsolatedWorld"),
    ).toBe(false);
    expect(result.outcome).toBe("complete");
  });

  it("refuses to guess when only a non-default context is known", async () => {
    const d = deps();
    withChildFrame(d);
    announceContext(d, {
      id: 43,
      auxData: { frameId: "frame-pay", isDefault: false },
    });

    const result = await runReplay(framedScene(), d);

    // Failing closed is the whole point. Evaluating in the isolated world
    // instead would return undefined and read as "the element is gone" — a
    // silent wrong answer dressed up as a missing element. `anchorUnreachable`
    // rather than `unresolvedAnchor` because the resolver did find it: the
    // context we would need to measure it in is what is missing.
    expect(result.reason).toBe("anchorUnreachable");
    expect(result.completed).toBe(0);
    expect(
      d.cdp.calls.some(
        (c) => c.method === "Runtime.evaluate" && c.params.contextId === 43,
      ),
    ).toBe(false);
  });

  it("stops rather than clicking into a document the frame tree does not hold", async () => {
    const d = deps();
    const result = await runReplay(framedScene(), d);

    // The anchor resolved; the frame its hop names is not in the tree. Its
    // own reason, not `anchorUnreachable`: the anchor is fine either way, but
    // corroboration refuses this frame on every future run, so the author is
    // told to re-record rather than to run it again forever.
    expect(result.reason).toBe("anchorFrameMismatch");
    expect(
      d.cdp.calls.some((c) => c.method === "Input.dispatchMouseEvent"),
    ).toBe(false);
  });

  /**
   * Two runs that fail to locate the same way, told apart by what the
   * resolver said — which is the only thing that distinguishes "your anchor
   * is broken" from "your anchor is fine and we could not reach it". They
   * were one reason until a same-origin iframe was found parking its element
   * in the wrong realm: the resolver reported `stableId`, the engine found
   * nothing where the hop pointed, and the author was told to re-record a
   * step whose anchor was healthy.
   */
  it("separates an anchor the resolver could not find from one replay could not reach", async () => {
    const broken = deps();
    broken.cdp.missing.add("first-btn");
    const brokenResult = await runReplay(oneClick(), broken);

    const unreachable = deps();
    unreachable.cdp.missing.add("first-btn");
    const unreachableResult = await runReplay(oneClick(), {
      ...unreachable,
      // Same CDP state; the resolver disagrees with it. This is the shape a
      // realm mismatch takes: a clean resolution the engine cannot cash in.
      page: {
        resolve: async (anchors) =>
          anchors.map((a) => ({
            anchorId: a.id,
            strategy: "stableId" as const,
            resolved: true,
            failureReason: null,
          })),
      },
    });

    expect({
      resolverSaidBroken: brokenResult.reason,
      resolverSaidResolved: unreachableResult.reason,
    }).toEqual({
      resolverSaidBroken: "unresolvedAnchor",
      resolverSaidResolved: "anchorUnreachable",
    });
  });

  // --- waitFor against a node with no layout box --------------------------
  // `DOM.getBoxModel` rejects for such a node rather than returning an empty
  // model, and the sensor resolves on tree presence rather than on
  // visibility — so a `display:none` panel resolves, is parked, and is
  // measured. Both `waitFor` conditions run straight through that.

  function waitScene(condition: "visible" | "hidden"): SceneDocument {
    const doc = scene();
    return {
      ...doc,
      actions: [
        {
          id: "act-1",
          kind: "waitFor",
          anchorId: "first-btn",
          timestamp: 0,
          marker: `wait:${condition}`,
          condition,
        },
      ],
    } as SceneDocument;
  }

  it("succeeds a hidden wait by measuring nothing, instead of reporting a port failure", async () => {
    const d = deps();
    d.cdp.boxless.add("first-btn");

    const result = await runReplay(waitScene("hidden"), d);

    // The *success* path of `hidden` is "the element has no box". A throw
    // out of the measurement escapes `awaitCondition` entirely and lands in
    // the engine's outer catch, which reports the one thing that did not
    // happen: a port giving way.
    expect(result.reason).toBeNull();
    expect(result.outcome).toBe("complete");
    expect(result.completed).toBe(1);
  });

  it("keeps polling a visible wait on a panel that has not rendered yet", async () => {
    const d = deps();
    d.cdp.boxless.add("first-btn");
    const send = d.cdp.send.bind(d.cdp);
    let measurements = 0;
    d.cdp.send = async (method, params) => {
      // The panel renders between the first poll and the second — which is
      // the whole point of a `visible` wait, and unreachable if the first
      // measurement throws the run away.
      if (method === "DOM.getBoxModel" && ++measurements === 2) {
        d.cdp.boxless.delete("first-btn");
      }
      return send(method, params);
    };

    const result = await runReplay(waitScene("visible"), d);

    expect(result.reason).toBeNull();
    expect(result.completed).toBe(1);
    expect(measurements).toBeGreaterThan(1);
  });

  // --- a port that gives way ---------------------------------------------

  it("turns a thrown port error into a reported partial run", async () => {
    const d = deps();
    const progress: string[] = [];
    d.onProgress = (p) => {
      if (p.state === "failed") progress.push(p.note ?? "");
    };
    // Fail on the second action, so there is a real prefix to hand back.
    const resolve = d.page.resolve;
    let calls = 0;
    d.page = {
      resolve: async (anchors) => {
        calls++;
        if (calls > 1) throw new Error("debugger detached from target");
        return resolve(anchors);
      },
    };

    const result = await runReplay(scene(), d);

    expect(result.reason).toBe("portFailure");
    expect(result.outcome).toBe("partial");
    expect(result.completed).toBe(1);
    expect(result.total).toBe(2);
    // Invariant 5: a run that stops early still returns a valid bundle
    // through the actions it reached.
    expect(result.bundle?.markers.map((m) => m.actionId)).toEqual(["act-1"]);
    expect(() => validateBundle(result.bundle)).not.toThrow();
    // The message reaches the live channel and nothing that gets persisted:
    // a port error can quote page content.
    expect(progress).toEqual(["debugger detached from target"]);
  });

  it("reports a bundle it could not store, and still hands it back", async () => {
    const store = createMemoryFrameStore();
    const d = deps({ store });
    const notes: string[] = [];
    d.onProgress = (p) => {
      if (p.state === "failed") notes.push(p.note ?? "");
    };
    // The most plausible failure this extension has: frames are the largest
    // thing it writes, and up to 200 keyframes at 1-3 MB each is a real
    // quota risk.
    store.putBundle = async () => {
      throw new Error("QuotaExceededError");
    };

    const result = await runReplay(scene(), d);

    // The replay itself reached its last action, so it is complete — a stop
    // reason attached to it describes the write, not the run, and the two
    // are distinguishable precisely because outcome tracks the actions.
    expect(result.outcome).toBe("complete");
    expect(result.reason).toBe("portFailure");
    expect(result.completed).toBe(2);
    expect(result.lastCompletedActionId).toBe("act-2");
    // The frames are on disk and the bundle is valid; it simply is not
    // indexed, so the caller holding this one can re-persist or render now.
    expect(result.bundle).not.toBeNull();
    expect(() => validateBundle(result.bundle)).not.toThrow();
    expect(result.bundle?.markers.map((m) => m.actionId)).toEqual([
      "act-1",
      "act-2",
    ]);
    expect(result.storageRefused).toBe(true);
    expect(await store.getBundle("scene-1", "replay")).toBeNull();
    expect(notes).toEqual(["bundle not persisted: QuotaExceededError"]);
  });

  // Continuous capture: the screencast stops once, at teardown, and a stop
  // the page refuses must not fail a run that already finished — the
  // detach tears the stream down regardless, and the frames are on disk.
  // (Before continuous capture this same refusal was a per-span
  // portFailure; the encoder-close-exactly-once and motion-kept invariants
  // carry over unchanged.)
  it("keeps a finished run and its motion when the teardown stop fails", async () => {
    const encoder = encoderStub();
    // A span that DID encode something, so the assertion below can tell
    // "kept it" from "there was never anything to keep".
    encoder.closeSpan = vi.fn(async () => ({
      ref: "span:scene-1:0",
      width: 1280,
      height: 800,
      fps: 42,
      frames: 21,
      byteLength: 0,
    }));
    const d = deps({ encoder });
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params) => {
      if (method === "Page.stopScreencast") throw new Error("target closed");
      return send(method, params);
    };

    const result = await runReplay(scene(), d);

    expect(result.outcome).toBe("complete");
    expect(result.reason).toBe(null);
    // Exactly once per span — two actions, two spans — and the teardown
    // path added no third close: an encoder span left open pins every frame
    // pushed into it, and a double close of one span would be a different
    // bug (closeEncoderSpan's flag is what this pins).
    expect(d.encoder.closeSpan).toHaveBeenCalledTimes(2);
    expect(result.bundle?.motionSpans.length).toBe(2);
    expect(result.bundle?.motionSpans[0]?.fps).toBe(42);
  });

  it("releases the encoder's span when a CDP call throws mid-verb, with one open", async () => {
    // A run that throws with a span open — portFailure, a detached
    // debugger, a closed window — must still release the encoder's span
    // through recorder.teardown(); otherwise every frame it holds stays
    // pinned for the life of the offscreen document. `recorder.open()` runs
    // before `performVerb`'s click and `recorder.close()` runs after it, so
    // throwing inside the click leaves the span open when the run's own
    // catch fires.
    const d = deps();
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params) => {
      if (
        method === "Input.dispatchMouseEvent" &&
        (params as { type?: string }).type === "mousePressed"
      ) {
        throw new Error("Session with given id not found");
      }
      return send(method, params);
    };

    const result = await runReplay(oneClick(), d);

    expect(result.reason).toBe("portFailure");
    expect(d.encoder.closeSpan).toHaveBeenCalled();
  });

  // The continuous-capture contract itself
  // (2026-08-31-continuous-capture-design.md): one screencast for the life
  // of the run, started at setup — before the opening keyframe, so Chrome's
  // occlusion-throttling exemption for captured pages covers the whole run,
  // navigation and waits included. The production change that reddens each
  // half: moving the start back into recorder.open(), or the stop back into
  // recorder.close()/teardown().
  it("runs one screencast for the whole take, not one per span", async () => {
    const d = deps();
    const result = await runReplay(scene(), d);
    expect(result.outcome).toBe("complete");

    const methods = d.cdp.calls.map((c) => c.method);
    expect(methods.filter((m) => m === "Page.startScreencast")).toHaveLength(1);
    expect(methods.filter((m) => m === "Page.stopScreencast")).toHaveLength(1);
    // Started at setup: before the opening keyframe, which is the first
    // captureScreenshot of the run.
    expect(methods.indexOf("Page.startScreencast")).toBeLessThan(
      methods.indexOf("Page.captureScreenshot"),
    );
    // Stopped at teardown: after the last keyframe.
    expect(methods.indexOf("Page.stopScreencast")).toBeGreaterThan(
      methods.lastIndexOf("Page.captureScreenshot"),
    );
  });

  it("keeps the reason it stopped for when persisting then fails too", async () => {
    const d = deps();
    const notes: string[] = [];
    d.onProgress = (p) => {
      if (p.state === "failed") notes.push(p.note ?? "");
    };
    d.cdp.missing.add("second-btn");
    d.store.putBundle = async () => {
      throw new Error("QuotaExceededError");
    };

    const result = await runReplay(scene(), d);

    // The wait — not the write — is what explains this run. A persistence
    // failure arriving afterwards is a second fact, and overwriting the
    // first with it would make `reason` mean "how the run stopped" or "how
    // persistence failed" depending on history.
    expect(result.reason).toBe("unresolvedAnchor");
    expect(result.outcome).toBe("partial");
    expect(result.completed).toBe(1);
    expect(result.bundle?.markers.map((m) => m.actionId)).toEqual(["act-1"]);
    // Both facts survive: the reason is the stop, the note has the write —
    // and `storageRefused` is what carries the write into telemetry, which
    // the note deliberately never reaches.
    expect(result.storageRefused).toBe(true);
    expect(notes).toEqual(["bundle not persisted: QuotaExceededError"]);
  });

  it("refuses no storage on the paths that never built a bundle", async () => {
    // Refused: nothing was built, so nothing was lost to the store. `false`
    // here is not a claim that anything is on disk — `bundle` is null and
    // says so.
    const refused = await runReplay(
      scene({ flags: { mutating: true, hoverSensitive: false } }),
      deps({ mayReplay: false }),
    );
    expect(refused.storageRefused).toBe(false);
    expect(refused.bundle).toBeNull();

    // Assembly itself failing is not a storage event: an empty ref makes the
    // bundle unparseable, so the store is never asked. Counting it would put
    // a false positive into the one signal this flag exists to give.
    const d = deps();
    d.store.putKeyframe = async () => "";
    const unassembled = await runReplay(scene(), d);
    expect(unassembled.reason).toBe("portFailure");
    expect(unassembled.bundle).toBeNull();
    expect(unassembled.storageRefused).toBe(false);
  });

  it("tears its listeners down even when the run throws", async () => {
    const d = deps();
    d.store.putKeyframe = async () => {
      throw new Error("quota exceeded");
    };

    const result = await runReplay(scene(), d);
    expect(result.reason).toBe("portFailure");

    // A handler still attached would ack, and the count would move.
    const before = d.cdp.calls.length;
    d.cdp.emit("Page.screencastFrame", frame(9));
    d.cdp.emit("Runtime.executionContextCreated", {
      context: { id: 1, auxData: { frameId: "top", isDefault: true } },
    });
    expect(d.cdp.calls.length).toBe(before);
  });

  // --- a complete run with nothing to hand back ---------------------------

  it("completes a wait-only scene with no bundle and no reason", async () => {
    const doc = scene();
    const result = await runReplay(
      {
        ...doc,
        actions: [
          {
            id: "act-1",
            kind: "waitFor",
            anchorId: null,
            timestamp: 0,
            marker: "wait:loaded",
            condition: "loaded",
          },
        ],
      } as SceneDocument,
      deps(),
    );

    // It reached its last action, so it did not stop early and carries no
    // stop reason — but it dispatched no cursor path, and SP6's schema will
    // not accept a replay bundle with no samples. `bundle === null` is the
    // signal, never the outcome.
    expect(result.outcome).toBe("complete");
    expect(result.reason).toBeNull();
    expect(result.completed).toBe(1);
    expect(result.bundle).toBeNull();
  });

  it("keeps a motion span the page actually painted, and drops one it did not", async () => {
    const d = deps({
      encoder: {
        openSpan: vi.fn(),
        push: vi.fn(async () => undefined),
        closeSpan: vi
          .fn()
          .mockResolvedValueOnce({
            ref: "span:scene-1:0",
            width: 1280,
            height: 800,
            fps: 42,
            frames: 21,
          })
          .mockResolvedValue(null),
        queueDepth: () => 0,
        heapFraction: () => 0.1,
      },
    });
    const result = await runReplay(scene(), d);

    expect(result.bundle?.motionSpans.length).toBe(1);
    expect(result.bundle?.motionSpans[0]?.fps).toBe(42);
  });

  /**
   * The same stop, driven through the *real* guard.
   *
   * The test below mocks the guard entirely, so the pause accounting on the
   * timeout path — `pauses` and the `pausedMs` charged before it gives up —
   * is never executed by anything. Those two numbers are the whole of what
   * telemetry knows about occlusion, and nothing would notice them going to
   * zero.
   */
  it("charges the pause and its duration when the window never comes back", async () => {
    const d = deps();
    const guard = createOcclusionGuard({ cdp: d.cdp, clock: d.clock });
    d.occlusion = guard;
    // Stall the heartbeat: no beat is ever emitted, and the construction
    // grace is burned off (the fake clock advances 10ms per read), so the
    // first check finds a page with no evidence of painting — and nothing
    // ever beats to resume it.
    for (let i = 0; i < 300; i++) d.clock.now();

    const result = await runReplay(scene(), d);

    expect(result.reason).toBe("occlusionTimeout");
    expect(result.counters.occlusionPauses).toBe(1);
    expect(result.counters.occlusionMs).toBeGreaterThanOrEqual(
      OCCLUSION_TIMEOUT_MS,
    );
    expect(result.completed).toBe(0);
  });

  it("stops rather than harvesting through an occluded window", async () => {
    const d = deps({
      occlusion: {
        install: async () => undefined,
        ensureVisible: async () => false,
        pauses: () => 1,
        pausedMs: () => 60_000,
        stalledSince: () => null,
      },
    });
    const result = await runReplay(scene(), d);

    expect(result.reason).toBe("occlusionTimeout");
    expect(result.counters.occlusionPauses).toBe(1);
    expect(result.degradations.some((x) => x.kind === "occlusionPause")).toBe(
      true,
    );
  });
});

/**
 * The page has to be done painting before its picture is taken.
 *
 * `Page.loadEventFired` is not that promise. `load` waits for the images the
 * markup asked for eagerly and says nothing about the ones marked
 * `loading="lazy"` — which on a content site is most of them, including the
 * ones on the first screen. The engine took its opening keyframe immediately
 * after the navigation resolved, so those images finished arriving *inside
 * the video*, and the video opened on a half-drawn page.
 */
describe("settling the page before harvesting it", () => {
  const settleCalls = (d: EngineDeps & { cdp: CdpFake }): number[] =>
    d.cdp.calls
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          c.method === "Runtime.evaluate" &&
          String(c.params.expression ?? "").includes(SETTLE_MARKER),
      )
      .map(({ i }) => i);

  it("settles the page before taking the opening keyframe", async () => {
    const d = deps();
    await runReplay(scene(), d);

    const firstSettle = settleCalls(d)[0];
    const firstShot = d.cdp.calls.findIndex(
      (c) => c.method === "Page.captureScreenshot",
    );
    expect(firstSettle).toBeDefined();
    expect(firstShot).toBeGreaterThanOrEqual(0);
    expect(firstSettle as number).toBeLessThan(firstShot);
  });

  it("waits for the probe rather than firing it and moving on", async () => {
    const d = deps();
    await runReplay(scene(), d);
    const settle = d.cdp.calls.find(
      (c) =>
        c.method === "Runtime.evaluate" &&
        String(c.params.expression ?? "").includes(SETTLE_MARKER),
    );
    // Without `awaitPromise` the evaluate returns the pending promise itself
    // and the engine proceeds immediately — the probe would run, report
    // nothing, and change nothing.
    expect(settle?.params.awaitPromise).toBe(true);
    expect(settle?.params.returnByValue).toBe(true);
  });

  it("records nothing when the page settles", async () => {
    const result = await runReplay(scene(), deps());
    expect(result.degradations.some((x) => x.kind === "pageNeverSettled")).toBe(
      false,
    );
  });

  // Forgiving the control flow and not the reason: a page that never settles
  // still gets harvested — a slow image must not cost the author their take —
  // but the frames carry the note saying they may be half-drawn.
  it("says so, and harvests anyway, when the page never settles", async () => {
    const d = deps();
    d.cdp.settle = {
      settled: false,
      pending: 3,
      fonts: "ok",
      ready: "complete",
      quiet: true,
    };
    const result = await runReplay(scene(), d);

    const note = result.degradations.find((x) => x.kind === "pageNeverSettled");
    expect(note?.note).toMatch(/3 image/);
    expect(result.outcome).toBe("complete");
    expect(result.bundle?.keyframes.length).toBeGreaterThan(0);
  });

  // A page whose markup never finished arriving has no images to be
  // outstanding, so `0 image(s) outstanding` on its own reads as though
  // nothing had been wrong with it. The two faults have different fixes and
  // the note has to say which one it was.
  it("says the page was still parsing when that is what the deadline caught", async () => {
    const d = deps();
    d.cdp.settle = {
      settled: false,
      pending: 0,
      fonts: "pending",
      ready: "loading",
      quiet: true,
    };
    const result = await runReplay(scene(), d);

    const note = result.degradations.find((x) => x.kind === "pageNeverSettled");
    // `readyState loading`, not `loading`: the note has always opened with
    // "page still loading", so the bare word matches with and without this.
    expect(note?.note).toMatch(/readyState loading/);
  });

  // Parsed, every picture in, and the document still changing: an app
  // drawing its own loading state (Phoenix's topbar, on the take of
  // 2026-10-03). `readyState complete` and `0 image(s) outstanding` would
  // read as nothing wrong, so the note names what the probe actually saw.
  it("says the page was still changing when that is what the deadline caught", async () => {
    const d = deps();
    d.cdp.settle = {
      settled: false,
      pending: 0,
      fonts: "ok",
      ready: "complete",
      quiet: false,
    };
    const result = await runReplay(scene(), d);

    const note = result.degradations.find((x) => x.kind === "pageNeverSettled");
    expect(note?.note).toMatch(/still changing/);
    expect(note?.note).not.toMatch(/image\(s\) outstanding/);
  });

  // The probe's own reply is the only evidence the engine has. A reply it
  // cannot read is not a settled page, and reading it as one would be the
  // silent success this whole mechanism exists to prevent.
  it("says so when the probe answers with something it cannot read", async () => {
    const d = deps();
    d.cdp.settle = undefined as never;
    const result = await runReplay(scene(), d);
    expect(result.degradations.some((x) => x.kind === "pageNeverSettled")).toBe(
      true,
    );
  });

  it("says so when the fonts never arrived", async () => {
    const d = deps();
    d.cdp.settle = {
      settled: true,
      pending: 0,
      fonts: "failed: no network",
      ready: "complete",
      quiet: true,
    };
    const result = await runReplay(scene(), d);
    const note = result.degradations.find((x) => x.kind === "pageNeverSettled");
    expect(note?.note).toMatch(/font/i);
  });

  // A page that navigates out from under the probe destroys the execution
  // context the evaluate was running in, and CDP reports that as a rejection.
  // Everything else in this region turns a rejection into a stopped run, and
  // that would be the wrong trade here: the take can carry on against the
  // document that replaced it, so the probe forgives its own failure and says
  // what happened.
  it("carries on, and says so, when the probe itself is destroyed", async () => {
    const d = deps();
    d.cdp.settleThrows = "Execution context was destroyed.";
    const result = await runReplay(scene(), d);

    expect(result.outcome).toBe("complete");
    expect(result.reason).toBeNull();
    const note = result.degradations.find((x) => x.kind === "pageNeverSettled");
    expect(note?.note).toMatch(/destroyed/);
  });

  // A click that navigates lands the take on a second document, which arrives
  // exactly as unfinished as the first one did.
  it("settles again after a navigation wait", async () => {
    const doc = scene();
    const withNav: SceneDocument = {
      ...doc,
      actions: [
        doc.actions[0] as (typeof doc.actions)[number],
        {
          id: "act-nav",
          anchorId: null,
          timestamp: 5000,
          marker: "waitFor:navigation",
          kind: "waitFor",
          condition: "loaded",
        },
      ],
    };
    const d = deps();
    await runReplay(withNav, d);
    expect(settleCalls(d).length).toBeGreaterThan(1);
  });

  /**
   * A `waitFor` is the verb that exists because the page just became
   * something else, so the instant it is satisfied is the one instant in the
   * take guaranteed to be worth a picture. It used to take none: the beat was
   * marked and never photographed, and `stillSourceMs` then fell back to the
   * nearest keyframe at or before the marker — the page the wait was waiting
   * to leave. On the take of 2026-08-30 that left a 1.6s hole across the
   * navigation with nothing in it but the pre-click frame.
   */
  it("photographs the page the wait was waiting for", async () => {
    const doc = scene();
    const withNav: SceneDocument = {
      ...doc,
      actions: [
        doc.actions[0] as (typeof doc.actions)[number],
        {
          id: "act-nav",
          anchorId: null,
          timestamp: 5000,
          marker: "waitFor:navigation",
          kind: "waitFor",
          condition: "loaded",
        },
      ],
    };
    const d = deps();

    const result = await runReplay(withNav, d);
    const bundle = result.bundle;
    if (!bundle) throw new Error("no bundle");

    const marker = bundle.markers.find((m) => m.actionId === "act-nav");
    expect(marker).toBeDefined();
    // The claim: this beat has a frame of its own, so the still for it is the
    // settled page rather than whatever preceded the wait.
    const own = bundle.keyframes.find((k) => k.actionId === "act-nav");
    expect(own).toBeDefined();
    expect(own?.sourceTimeMs).toBeGreaterThanOrEqual(
      marker?.sourceTimeMs as number,
    );
  });
});

describe("continuous recording", () => {
  const screenshots = (d: ReturnType<typeof deps>) =>
    d.cdp.calls.filter((c) => c.method === "Page.captureScreenshot").length;

  it("marks the bundle real-time and takes no post-verb still", async () => {
    const sampled = deps();
    await runReplay(scene(), sampled);
    const continuous = deps({ recording: "continuous" });
    const result = await runReplay(scene(), continuous);
    expect(result.outcome).toBe("complete");
    expect(result.bundle?.timing).toBe("real");
    // Opening + (marker + post-verb) x2 = 5 sampled. Continuous: opening +
    // marker x2 + one closing still for the last step's result = 4.
    expect(screenshots(sampled)).toBe(5);
    expect(screenshots(continuous)).toBe(4);
  });

  // The last step's own paint lands after its verb returns, by which time
  // the walk has left its loop and stopped listening for frames — so no
  // settled still would ever follow it. Found 2026-10-03 by the authored
  // lane's "the typed text is actually in the frames": a run ending on a
  // `type` filed nothing after the verb.
  // The film starts at the opening still, taken once the page has settled.
  // Paint before it — the navigation, a page still loading — is what the
  // author asked not to see (the loading-bar report of 2026-10-03), and the
  // first continuous export opened on a black frame of exactly that.
  it("keeps no motion from before the opening still", async () => {
    const d = deps({ recording: "continuous" });
    d.encoder.closeSpan = vi.fn(async () => ({
      ref: "m",
      width: 1280,
      height: 800,
      fps: 30,
      frames: 3,
      byteLength: 10,
    }));
    const send = d.cdp.send.bind(d.cdp);
    let loadingPainted = false;
    d.cdp.send = async (method, params) => {
      // The first evaluate is the settle probe, before the opening still:
      // the page is still painting itself in.
      if (method === "Runtime.evaluate" && !loadingPainted) {
        loadingPainted = true;
        for (let i = 0; i < 3; i++) {
          d.cdp.emit("Page.screencastFrame", frame(500 + i));
        }
      }
      return send(method, params);
    };
    const result = await runReplay(scene(), d);
    // The premise: the loading paint happened.
    expect(loadingPainted).toBe(true);
    const opening = result.bundle?.keyframes[0]?.sourceTimeMs ?? 0;
    const early = (result.bundle?.motionSpans ?? []).filter(
      (s) => s.startMs < opening,
    );
    expect(early, `opening still at ${opening}`).toEqual([]);
  });

  // Final review I2: a focused field's blinking caret repaints about every
  // 500 ms — one frame each, a span that is never motion — and took a full
  // 3x still per blink. A blip earns no still unless a verb happened since
  // the last one; real motion still does.
  it("takes no still per one-frame blip while nothing is being done", async () => {
    const d = deps({ recording: "continuous" });
    const doc = scene();
    const [a, b] = doc.actions as [
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
    ];
    const paced = {
      ...doc,
      actions: [
        { ...a, timestamp: 0 },
        { ...b, timestamp: 10_000 },
      ],
    } as SceneDocument;
    const sleep = d.clock.sleep;
    let blips = 0;
    d.clock.sleep = async (ms) => {
      if (ms < 1000) return sleep(ms);
      // The pacing wait: one frame every 500 ms of it, then a real yield so
      // the recorder's own close loop can notice each go quiet.
      const chunks = Math.floor(ms / 500);
      for (let i = 0; i < chunks; i++) {
        await sleep(500);
        d.cdp.emit("Page.screencastFrame", frame(2000 + blips++));
        await new Promise((r) => setTimeout(r, 0));
      }
      await sleep(ms - chunks * 500);
    };
    const result = await runReplay(paced, d);
    // The premise: the page blipped many times inside the wait.
    expect(blips).toBeGreaterThanOrEqual(10);
    const [m1, m2] = (result.bundle?.markers ?? []).map((m) => m.sourceTimeMs);
    const between = (result.bundle?.keyframes ?? []).filter(
      (k) =>
        k.actionId === null &&
        k.sourceTimeMs > (m1 ?? 0) &&
        k.sourceTimeMs < (m2 ?? 0),
    );
    // At most the one still the first verb is owed.
    expect(between.length, `${blips} blips`).toBeLessThanOrEqual(1);
  });

  // Final review I1: the closing still is a still like any other. If it
  // cannot be taken that is a `stillFailed`, not a port failure — a finished
  // run must not be reported as broken, and a run stopped for another reason
  // must keep that reason.
  it("reports a closing still that fails without changing the outcome", async () => {
    const d = deps({ recording: "continuous" });
    // No paint at all, so screenshot #4 is the closing still.
    paintAtScreenshot(d, 99, 0, 4);
    const result = await runReplay(scene(), d);
    expect(result.outcome).toBe("complete");
    expect(result.reason).toBeNull();
    const failed = result.degradations.find((x) => x.kind === "stillFailed");
    expect(failed?.note).toMatch(/screenshot refused/);
  });

  it("takes no closing still once the stage stopped being driven", async () => {
    const d = deps({ recording: "continuous" });
    let checks = 0;
    d.occlusion = {
      install: async () => undefined,
      // Visible for the first step, never again.
      ensureVisible: async () => ++checks === 1,
      pauses: () => (checks > 1 ? 1 : 0),
      pausedMs: () => 0,
      stalledSince: () => null,
    };
    const result = await runReplay(scene(), d);
    expect(result.reason).toBe("occlusionTimeout");
    expect(result.bundle?.keyframes.at(-1)?.actionId).not.toBeNull();
  });

  // A page that never stops painting — a hero video — keeps a span open, or
  // reopens one the moment the last closes. The closing still's wait must
  // be bounded, or the run never returns.
  it("finishes on a page that never stops painting", async () => {
    const d = deps({ recording: "continuous" });
    const sleep = d.clock.sleep;
    let painted = 0;
    const slept: number[] = [];
    d.clock.sleep = async (ms) => {
      // At the end of every tick of the run's clock, the page has painted a
      // frame. After the time passes, not before: a frame stamped before the
      // sleep leaves a quiet gap behind it, which is a page at rest.
      await sleep(ms);
      slept.push(ms);
      d.cdp.emit("Page.screencastFrame", frame(1000 + painted++));
    };
    const result = await runReplay(scene(), d);
    expect(result.outcome).toBe("complete");
    // The premise: the page was still painting when the closing wait began,
    // so the wait polled (50 ms ticks, a frame painted after each) instead of
    // finding quiet at once — a page at rest closes its span in the
    // `SPAN_QUIET_MS` sleep before the loop and the loop never ticks.
    //
    // This said `painted > 50` until 2026-10-13. That counted ticks of a fake
    // clock every concurrent wait advances, so a still-drain racing beside
    // the closing wait (a 5 s sleep) moved the loop's deadline: the click
    // check's extra round trips reordered the two and the count fell to 41
    // with nothing wrong. The loop's own ticks are what the premise means.
    const closing = slept.slice(slept.lastIndexOf(SPAN_QUIET_MS) + 1);
    const ticks = closing.filter((ms) => ms === 50).length;
    expect(
      ticks,
      `sleeps after the closing quiet: ${closing}`,
    ).toBeGreaterThanOrEqual(3);
    expect(result.bundle?.keyframes.at(-1)?.actionId).toBeNull();
  }, 5000);

  it("ends with a still of the last step's result", async () => {
    const result = await runReplay(scene(), deps({ recording: "continuous" }));
    const keyframes = result.bundle?.keyframes ?? [];
    const lastMarker = result.bundle?.markers.at(-1);
    const last = keyframes.at(-1);
    expect(last?.actionId).toBeNull();
    expect(last?.sourceTimeMs).toBeGreaterThan(lastMarker?.sourceTimeMs ?? 0);
  });

  it("leaves a sampled bundle without timing", async () => {
    const result = await runReplay(scene(), deps());
    expect(result.bundle !== null && "timing" in result.bundle).toBe(false);
  });

  it("opens no span itself: only paint does", async () => {
    const d = deps({ recording: "continuous" });
    await runReplay(scene(), d);
    expect(d.encoder.openSpan).not.toHaveBeenCalled();
  });

  /** Emit `count` frames the moment the `nth` screenshot is requested, and
   *  refuse the `fail`th screenshot outright. */
  function paintAtScreenshot(
    d: ReturnType<typeof deps>,
    nth: number,
    count = 3,
    fail?: number,
  ) {
    const send = d.cdp.send.bind(d.cdp);
    let n = 0;
    d.cdp.send = async (method, params) => {
      if (method === "Page.captureScreenshot") {
        n++;
        if (n === fail) throw new Error("screenshot refused");
        if (n === nth) {
          for (let i = 0; i < count; i++) {
            d.cdp.emit("Page.screencastFrame", frame(100 + i));
          }
        }
      }
      return send(method, params);
    };
  }

  // The author's half-speed probe of 2026-10-07: the video stopped 0.42s
  // after the last click although the script asked for 800ms more. A film
  // ends at its last frame, the page went quiet after the click and earned a
  // settled still, and the closing still was skipped because "a settled still
  // already did" — so nothing filmed the rest. A take must run on for a
  // second after its last action, re-shoot or agent run alike.
  // The fake's sleeps resolve at once AND move its clock by their whole
  // length, so `drainShots`' race against `STILL_DRAIN_MS` put the closing
  // still 5s past the last action whether or not anything waited for a tail
  // — measured: removing the tail wait left these tests green. In Chrome the
  // shots drain first and the timeout never fires; here it never fires either.
  const drainWithoutTimeout = (d: ReturnType<typeof deps>) => {
    const sleep = d.clock.sleep;
    d.clock.sleep = (ms) =>
      ms === STILL_DRAIN_MS ? new Promise<void>(() => undefined) : sleep(ms);
  };

  const lastFrameAfterLastMarker = (result: { bundle: FrameBundle | null }) => {
    const markers = result.bundle?.markers ?? [];
    const keyframes = result.bundle?.keyframes ?? [];
    const lastMarker = markers.at(-1)?.sourceTimeMs ?? 0;
    return {
      tail: (keyframes.at(-1)?.sourceTimeMs ?? 0) - lastMarker,
      settledAfter: keyframes.filter(
        (k) => k.actionId === null && k.sourceTimeMs > lastMarker,
      ).length,
      evidence: `keyframes ${JSON.stringify(keyframes.map((k) => [k.sourceTimeMs, k.actionId]))}; last marker ${lastMarker}`,
    };
  };

  it("runs a re-shoot on for a second after its last action, past a settled still", async () => {
    const d = deps({ recording: "continuous" });
    paintAtScreenshot(d, 3); // the last marker still
    drainWithoutTimeout(d);
    const result = await runReplay(scene(), d);
    expect(result.outcome).toBe("complete");
    const { tail, settledAfter, evidence } = lastFrameAfterLastMarker(result);
    // The premise: the page went quiet after the last action and earned a
    // settled still, the case that used to stand in for the closing one.
    expect(settledAfter, evidence).toBeGreaterThanOrEqual(1);
    expect(tail, evidence).toBeGreaterThanOrEqual(1000);
  });

  async function authoredEnding(trailingPauseMs: number | null) {
    const d = deps({ recording: "continuous" });
    // The click's marker still (#2 after the opening one) paints, so the page
    // goes quiet after the last action and earns a settled still: the case
    // the author's video was.
    paintAtScreenshot(d, 2);
    drainWithoutTimeout(d);
    let n = 0;
    return runAuthored(
      {
        scriptVersion: 1,
        name: "one click",
        target: "https://app.example.com/",
        steps: [
          { do: "click", on: { stableId: "b" } },
          ...(trailingPauseMs === null
            ? []
            : [{ do: "pause" as const, ms: trailingPauseMs }]),
        ],
      },
      {
        ...d,
        captureResolved: async (intent) => ({
          anchor: {
            id: intent.id,
            fingerprint: {
              ...intent.fingerprint,
              boundingRect: { x: 600, y: 400, width: 100, height: 40 },
            },
            resolution: {
              url: "https://app.example.com/",
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
        sceneId: "authored-ending",
        createdAt: "2026-10-07T09:00:00.000Z",
        viewport: { width: 1280, height: 800 },
        startingBranding: BRANDING_DEFAULTS,
        cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
      },
    );
  }

  it("runs an agent take on for a second after its last action when the script asks for nothing", async () => {
    const result = await authoredEnding(null);
    expect(result.outcome, JSON.stringify(result.reason)).toBe("complete");
    const { tail, settledAfter, evidence } = lastFrameAfterLastMarker(result);
    expect(settledAfter, evidence).toBeGreaterThanOrEqual(1);
    expect(tail, evidence).toBeGreaterThanOrEqual(1000);
  });

  // The control for the case above: the second is a floor, not a length. A
  // script that asks for longer gets longer.
  it("keeps an agent script's own longer ending", async () => {
    const result = await authoredEnding(2000);
    expect(result.outcome, JSON.stringify(result.reason)).toBe("complete");
    const { tail, settledAfter, evidence } = lastFrameAfterLastMarker(result);
    expect(settledAfter, evidence).toBeGreaterThanOrEqual(1);
    expect(tail, evidence).toBeGreaterThanOrEqual(2000);
  });

  // Between two markers, not at the end: the closing still lands after the
  // last marker whatever the recorder does, so a settled still asserted
  // there passed with `onSettled` disconnected (final review I4).
  it("takes a sharp still once the page goes quiet after painting", async () => {
    const d = deps({ recording: "continuous" });
    paintAtScreenshot(d, 2); // the first marker still
    const result = await runReplay(scene(), d);
    const [m1, m2] = (result.bundle?.markers ?? []).map((m) => m.sourceTimeMs);
    const settled = (result.bundle?.keyframes ?? []).filter(
      (k) =>
        k.actionId === null &&
        k.sourceTimeMs > (m1 ?? 0) &&
        k.sourceTimeMs < (m2 ?? 0),
    );
    expect(
      settled.length,
      `keyframes ${JSON.stringify(result.bundle?.keyframes.map((k) => [k.sourceTimeMs, k.actionId]))}; markers ${m1}, ${m2}`,
    ).toBe(1);
  });

  it("reports a settled still that fails, and keeps the run", async () => {
    const d = deps({ recording: "continuous" });
    // Paint at the last marker still (#3); the settled still is then #4.
    paintAtScreenshot(d, 3, 3, 4);
    const result = await runReplay(scene(), d);
    expect(result.outcome).toBe("complete");
    const failed = result.degradations.find((x) => x.kind === "stillFailed");
    expect(failed?.note).toMatch(/screenshot refused/);
  });

  // Review Focus 3. The fake clock's sleeps resolve at once, so on their own
  // a settled still and a marker still never overlap. Two real delays make
  // them: the first marker still's reply is held 30ms, during which the page
  // paints, goes quiet and asks for a settled still; and every store write
  // takes 50ms, so both stills sit between "picture taken" and "filed" at
  // the same time — where an index is chosen.
  it("never files two stills under one index, however they interleave", async () => {
    const d = deps({ recording: "continuous" });
    const send = d.cdp.send.bind(d.cdp);
    let shots = 0;
    let settledAskedWhileMarkerPending = false;
    let markerPending = false;
    d.cdp.send = async (method, params) => {
      if (method !== "Page.captureScreenshot") return send(method, params);
      shots++;
      if (shots === 2) {
        markerPending = true;
        for (let i = 0; i < 3; i++) {
          d.cdp.emit("Page.screencastFrame", frame(100 + i));
        }
        await new Promise((r) => setTimeout(r, 30));
        const reply = await send(method, params);
        markerPending = false;
        return reply;
      }
      if (markerPending) settledAskedWhileMarkerPending = true;
      return send(method, params);
    };
    const filed: number[] = [];
    const put = d.store.putKeyframe.bind(d.store);
    d.store.putKeyframe = async (sceneId, index, bytes) => {
      filed.push(index);
      await new Promise((r) => setTimeout(r, 50));
      return put(sceneId, index, bytes);
    };
    const result = await runReplay(scene(), d);
    // That the two stills overlap is shown by running this without the
    // walk's still line: the settled still is then asked for mid-marker and
    // indices 0,1,1,3 are filed (2026-10-03). With the line in place the
    // settled still waits its turn, so the flag in the message reads false.
    const keyframes = result.bundle?.keyframes ?? [];
    expect(
      new Set(filed).size,
      `indices filed: ${filed.join(",")}; settled asked mid-marker: ${settledAskedWhileMarkerPending}`,
    ).toBe(filed.length);
    const times = keyframes.map((k) => k.sourceTimeMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // Five stills: opening, two markers, the settled one between them, and
    // the closing still after the last marker.
    expect(filed.length).toBe(5);
  });

  // Review Focus 1: spans whose closes finish out of order.
  it("files spans in time order even when their closes finish out of order", async () => {
    const d = deps({ recording: "continuous" });
    const resolvers: (() => void)[] = [];
    const finished: string[] = [];
    let index = 0;
    d.encoder.closeSpan = vi.fn(
      () =>
        new Promise<EncodedSpan | null>((resolve) => {
          const i = index++;
          resolvers.push(() => {
            finished.push(`m-${i}`);
            resolve({
              ref: `m-${i}`,
              width: 1280,
              height: 800,
              fps: 30,
              frames: 3,
              byteLength: 10,
            });
          });
          // Finish the second close before the first. The first is held
          // until the second arrives; if no second span ever opens, it is
          // released after 3s so teardown cannot hang, and the assertions
          // below then fail and say so.
          if (resolvers.length === 2) {
            resolvers[1]?.();
            setTimeout(() => resolvers[0]?.(), 20);
          } else {
            setTimeout(() => {
              if (!finished.includes("m-0")) resolvers[0]?.();
            }, 3000);
          }
        }),
    );
    paintAtScreenshot(d, 2);
    paintAtScreenshot(d, 3);
    const result = await runReplay(scene(), d);
    const starts = (result.bundle?.motionSpans ?? []).map((s) => s.startMs);
    expect(starts.length).toBe(2);
    // The premise: the closes really did finish out of order.
    expect(result.bundle?.motionSpans.map((s) => s.ref)).toEqual([
      "m-0",
      "m-1",
    ]);
    expect(finished).toEqual(["m-1", "m-0"]);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(() => validateBundle(result.bundle)).not.toThrow();
  });

  it("calls a moveTo hover-sensitive when the page painted on arrival", async () => {
    const doc = hoverThenClick([
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 0, y: 0, width: 100, height: 40 },
    ]);
    const quietRun = await runReplay(doc, deps({ recording: "continuous" }));
    expect(quietRun.hoverSensitive).toBe(false);
    const d = deps({ recording: "continuous" });
    d.encoder.closeSpan = vi.fn(async () => ({
      ref: "m-0",
      width: 1280,
      height: 800,
      fps: 30,
      frames: 3,
      byteLength: 10,
    }));
    paintAtScreenshot(d, 2); // the moveTo's marker still
    expect((await runReplay(doc, d)).hoverSensitive).toBe(true);
  });
});

describe("re-shoot pacing", () => {
  /** The default two clicks, recorded `gapMs` apart. */
  function recordedApart(gapMs: number): SceneDocument {
    const doc = scene();
    const [a, b] = doc.actions as [
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
    ];
    return {
      ...doc,
      // From 10 s, so a backwards gap still leaves both timestamps positive.
      actions: [
        { ...a, timestamp: 10_000 },
        { ...b, timestamp: 10_000 + gapMs },
      ],
    } as SceneDocument;
  }
  const markerGap = (result: Awaited<ReturnType<typeof runReplay>>) => {
    const [m1, m2] = result.bundle?.markers ?? [];
    return (m2?.sourceTimeMs ?? 0) - (m1?.sourceTimeMs ?? 0);
  };

  it("waits out the recorded interval live in continuous mode", async () => {
    const doc = recordedApart(5000);
    // The control: sampled leaves pacing to the compositor and is faster.
    expect(markerGap(await runReplay(doc, deps()))).toBeLessThan(5000);
    expect(
      markerGap(await runReplay(doc, deps({ recording: "continuous" }))),
    ).toBeGreaterThanOrEqual(5000);
  });

  // Review Focus 4.
  it("neither sleeps backwards nor stalls on a log that runs backwards", async () => {
    const doc = recordedApart(-4000);
    const slept: number[] = [];
    const d = deps({ recording: "continuous" });
    const sleep = d.clock.sleep;
    d.clock.sleep = async (ms) => {
      slept.push(ms);
      await sleep(ms);
    };
    const result = await runReplay(doc, d);
    expect(result.outcome).toBe("complete");
    expect(slept.every((ms) => ms >= 0)).toBe(true);
    expect(markerGap(result)).toBeLessThan(4000);
  });

  // Final review C1: a log missing a step the take had keeps the others'
  // timestamps, so the interval between the steps either side of the gap
  // spans the missing step too — and waiting it out would film it.
  it("does not wait out a stretch the author cut", async () => {
    const base = scene({ anchorIds: ["first-btn", "cut-btn", "last-btn"] });
    const [a, b, c] = base.actions as [
      (typeof base.actions)[number],
      (typeof base.actions)[number],
      (typeof base.actions)[number],
    ];
    const full = {
      ...base,
      actions: [
        { ...a, timestamp: 0 },
        { ...b, timestamp: 10_000 },
        { ...c, timestamp: 20_000 },
      ],
    } as SceneDocument;
    const performed = {
      ...full,
      actions: full.actions.filter((x) => x.id !== b.id),
    };
    // The premise: the cut step is gone and the two left are 20 s apart.
    expect(performed.actions.map((x) => x.id)).toEqual([a.id, c.id]);
    const result = await runReplay(
      performed,
      deps({ recording: "continuous", madeFrom: madeFromOf(full) }),
    );
    expect(result.outcome).toBe("complete");
    expect(markerGap(result)).toBeLessThan(10_000);
  });

  // Final review I5: a gap the author shortened before re-shooting is the
  // pause they want; the recorded one is what they edited away. On a page
  // that moves throughout there is no idle for the compositor to rescale,
  // so only the engine can honour it.
  it("waits the author's edited gap rather than the recorded one", async () => {
    const doc = recordedApart(5000);
    const [a] = doc.actions as [(typeof doc.actions)[number]];
    const edited = {
      ...doc,
      edits: {
        ...doc.edits,
        gaps: [{ id: "gap-1", afterActionId: a.id, durationMs: 1000 }],
      },
    } as SceneDocument;
    // The control: unedited, the recorded 5 s is waited out.
    expect(
      markerGap(await runReplay(doc, deps({ recording: "continuous" }))),
    ).toBeGreaterThanOrEqual(5000);
    const gap = markerGap(
      await runReplay(edited, deps({ recording: "continuous" })),
    );
    expect(gap).toBeGreaterThanOrEqual(1000);
    expect(gap).toBeLessThan(5000);
  });
});

describe("a recovered occlusion pause", () => {
  it("is recorded with its range, in either mode", async () => {
    for (const recording of ["sampled", "continuous"] as const) {
      const d = deps({ recording });
      let paused = false;
      let pauses = 0;
      let stalled: number | null = null;
      d.occlusion = {
        install: async () => undefined,
        ensureVisible: async () => {
          if (!paused) {
            paused = true;
            pauses++;
            // The stall began at the check itself.
            stalled = d.clock.now();
            await d.clock.sleep(2000);
          }
          return true;
        },
        pauses: () => pauses,
        pausedMs: () => (paused ? 2000 : 0),
        stalledSince: () => stalled,
      };
      const result = await runReplay(scene(), d);
      expect(result.outcome).toBe("complete");
      const pause = result.degradations.find(
        (x) => x.kind === "occlusionPause",
      );
      expect(pause, recording).toBeDefined();
      expect(
        (pause?.endMs ?? 0) - (pause?.startMs ?? 0),
      ).toBeGreaterThanOrEqual(2000);
      expect(pause?.note).toMatch(/covered for 2\.\d s/);
    }
  });
});

/** A guard that is covered once, at its `nth` check, for `coveredMs` —
 *  the page having stopped painting `stalledForMs` before that check. */
function coveredOnce(
  d: ReturnType<typeof deps>,
  nth: number,
  coveredMs: number,
  stalledForMs = 0,
) {
  let checks = 0;
  let pauses = 0;
  let stalled: number | null = null;
  d.occlusion = {
    install: async () => undefined,
    ensureVisible: async () => {
      if (++checks === nth) {
        pauses++;
        stalled = d.clock.now() - stalledForMs;
        await d.clock.sleep(coveredMs);
      }
      return true;
    },
    pauses: () => pauses,
    pausedMs: () => (pauses > 0 ? coveredMs : 0),
    stalledSince: () => stalled,
  };
}

describe("review of 2026-10-03: continuous pacing and its pauses", () => {
  function recordedApart(gapMs: number): SceneDocument {
    const doc = scene();
    const [a, b] = doc.actions as [
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
    ];
    return {
      ...doc,
      actions: [
        { ...a, timestamp: 10_000 },
        { ...b, timestamp: 10_000 + gapMs },
      ],
    } as SceneDocument;
  }
  const pauseOf = (result: Awaited<ReturnType<typeof runReplay>>) =>
    result.degradations.find(
      (x) => x.kind === "occlusionPause" && x.endMs > x.startMs,
    );

  // #6: the frozen seconds before the check are the pause too.
  it("removes the pause from when the page stopped painting, not from the check", async () => {
    const d = deps({ recording: "continuous" });
    coveredOnce(d, 2, 2000, 500);
    const result = await runReplay(scene(), d);
    expect(result.outcome).toBe("complete");
    const pause = pauseOf(result);
    expect(pause).toBeDefined();
    // The premise: the stall began inside the run, so nothing was clamped.
    expect(pause?.startMs ?? 0).toBeGreaterThan(0);
    expect((pause?.endMs ?? 0) - (pause?.startMs ?? 0)).toBeGreaterThanOrEqual(
      2500,
    );
    expect(pause?.note).toMatch(/covered for 2\.[5-9] s/);
  });

  // #3: the timeline removes the pause, so the recorded interval must not
  // be spent on it.
  it("does not spend the recorded interval on a pause the film removes", async () => {
    const doc = recordedApart(3000);
    const d = deps({ recording: "continuous" });
    coveredOnce(d, 2, 2000);
    const result = await runReplay(doc, d);
    const [m1, m2] = (result.bundle?.markers ?? []).map((m) => m.sourceTimeMs);
    const pause = pauseOf(result);
    // The premise: the pause sits between the two markers.
    expect(pause).toBeDefined();
    expect(pause?.startMs ?? -1).toBeGreaterThanOrEqual(m1 ?? 0);
    expect(pause?.endMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      m2 ?? 0,
    );
    const removed = (pause?.endMs ?? 0) - (pause?.startMs ?? 0);
    const kept = (m2 ?? 0) - (m1 ?? 0) - removed;
    expect(
      kept,
      `markers ${m1}, ${m2}; removed ${removed}`,
    ).toBeGreaterThanOrEqual(3000);
  });

  // #1: the engine waits an edited gap out live, so the compositor must not
  // apply it a second time. On a page that never stops painting the second
  // application stretched the idle slivers between ceiling-split spans up
  // to the whole gap again: about 2 s of film for a 1 s pause.
  it("plays an edited gap the engine waited out once, on a page that never stops painting", async () => {
    const doc = recordedApart(5000);
    const [a, b] = doc.actions as [
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
    ];
    const edited = {
      ...doc,
      edits: {
        ...doc.edits,
        gaps: [{ id: "gap-1", afterActionId: a.id, durationMs: 1000 }],
      },
    } as SceneDocument;
    const d = deps({ recording: "continuous" });
    let spans = 0;
    d.encoder.closeSpan = vi.fn(async () => ({
      ref: `m-${spans++}`,
      width: 1280,
      height: 800,
      fps: 30,
      frames: 3,
      byteLength: 10,
    }));
    const sleep = d.clock.sleep;
    let painted = 0;
    d.clock.sleep = async (ms) => {
      await sleep(ms);
      d.cdp.emit("Page.screencastFrame", frame(1000 + painted++));
    };
    const result = await runReplay(edited, d);
    expect(result.outcome).toBe("complete");
    const bundle = result.bundle as FrameBundle;
    const at = new Map(bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]));
    const from = at.get(a.id) ?? 0;
    const to = at.get(b.id) ?? 0;
    // The premises: the engine waited the edited gap, not the recorded 5 s,
    // and the page painted throughout it.
    expect(to - from).toBeGreaterThanOrEqual(1000);
    expect(to - from).toBeLessThan(5000);
    expect(painted).toBeGreaterThan(20);
    expect(bundle.pacedGaps).toEqual([
      { afterActionId: a.id, durationMs: 1000 },
    ]);
    const timeline = buildTimeline(planScene(edited), bundle);
    const played = toOutputMs(timeline, to) - toOutputMs(timeline, from);
    expect(played, `source ${to - from} ms`).toBeCloseTo(to - from, 6);
  });

  it("records no paced gap where the author edited none", async () => {
    const result = await runReplay(
      recordedApart(3000),
      deps({ recording: "continuous" }),
    );
    expect(result.bundle !== null && "pacedGaps" in result.bundle).toBe(false);
  });

  // #4: a settled still asked for just as the window is covered has no
  // deadline of its own, and the run must still return its reason.
  it("returns, and says so, when a still hangs as the window is covered", async () => {
    const d = deps({ recording: "continuous" });
    let checks = 0;
    d.occlusion = {
      install: async () => undefined,
      ensureVisible: async () => ++checks === 1,
      pauses: () => (checks > 1 ? 1 : 0),
      pausedMs: () => 0,
      stalledSince: () => null,
    };
    const send = d.cdp.send.bind(d.cdp);
    let shots = 0;
    let hung = false;
    d.cdp.send = async (method, params) => {
      if (method === "Page.captureScreenshot") {
        shots++;
        // The first marker still: the click paints.
        if (shots === 2) {
          for (let i = 0; i < 3; i++) {
            d.cdp.emit("Page.screencastFrame", frame(300 + i));
          }
        }
        // The settled still that follows: the page has stopped painting.
        if (shots === 3) {
          hung = true;
          return new Promise(() => undefined);
        }
      }
      return send(method, params);
    };
    const result = await runReplay(scene(), d);
    // The premise: the settled still really was asked for, and never answered.
    expect(hung).toBe(true);
    expect(result.reason).toBe("occlusionTimeout");
    const failed = result.degradations.find((x) => x.kind === "stillFailed");
    expect(failed?.note).toMatch(/abandoned/);
  }, 5000);

  // #7: with recorded pacing the marker comes SETTLE_MS plus the recorded
  // interval after the path — long after a hover's paint has closed.
  it("calls a moveTo hover-sensitive when its path made the page paint, however long the pace after it", async () => {
    const doc = scene();
    const [a, b] = doc.actions as [
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
    ];
    const paced = {
      ...doc,
      actions: [
        { ...a, kind: "click", timestamp: 10_000 },
        { ...b, kind: "moveTo", timestamp: 12_000 },
      ],
    } as SceneDocument;
    const run = async (paint: boolean) => {
      const d = deps({ recording: "continuous", madeFrom: madeFromOf(paced) });
      d.encoder.closeSpan = vi.fn(async () => ({
        ref: "m",
        width: 1280,
        height: 800,
        fps: 30,
        frames: 3,
        byteLength: 10,
      }));
      const send = d.cdp.send.bind(d.cdp);
      let clicked = false;
      let painted = false;
      d.cdp.send = async (method, params) => {
        if (method === "Input.dispatchMouseEvent") {
          if (params?.type === "mouseReleased") clicked = true;
          // The moveTo's path arrives: the page reacts to the pointer.
          else if (
            paint &&
            params?.type === "mouseMoved" &&
            clicked &&
            !painted
          ) {
            painted = true;
            for (let i = 0; i < 3; i++) {
              d.cdp.emit("Page.screencastFrame", frame(700 + i));
            }
          }
        }
        return send(method, params);
      };
      const result = await runReplay(paced, d);
      return { result, painted };
    };
    const quiet = await run(false);
    expect(quiet.result.hoverSensitive).toBe(false);
    const { result, painted } = await run(true);
    // The premise: the path painted, and that paint's span was over well
    // before the moveTo's marker.
    expect(painted).toBe(true);
    const marker = result.bundle?.markers.at(-1)?.sourceTimeMs ?? 0;
    const spans = result.bundle?.motionSpans ?? [];
    expect(spans.length).toBeGreaterThan(0);
    expect(
      spans.every((s) => s.endMs + SPAN_QUIET_MS < marker),
      `spans ${JSON.stringify(spans.map((s) => [s.startMs, s.endMs]))}; marker ${marker}`,
    ).toBe(true);
    expect(result.hoverSensitive).toBe(true);
  });
});

// Spec 2026-10-10 §1: a take filmed as a phone replays as that phone.
describe("a device take", () => {
  const IPHONE = {
    preset: "phone" as const,
    width: 393,
    height: 852,
    mobile: true,
    touch: true,
    userAgent: "Mozilla/5.0 (iPhone; test)",
  };
  const PHONE_METRICS = {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
  };
  /** A landscape surface frame: the shape a crop of a portrait override is. */
  const LANDSCAPE_SURFACE = { width: 1800, height: 1104 };

  function phoneScene(): SceneDocument {
    const doc = oneClick();
    return {
      ...doc,
      meta: {
        ...doc.meta,
        capture: {
          ...doc.meta.capture,
          viewport: { width: 393, height: 852 },
          device: IPHONE,
        },
      },
    } as SceneDocument;
  }

  it("applies the whole device before anything else is filmed", async () => {
    const d = deps();
    await runReplay(phoneScene(), d);
    const methods = d.cdp.calls.map((c) => c.method);
    const screencast = methods.indexOf("Page.startScreencast");
    expect(screencast, methods.join(",")).toBeGreaterThan(-1);
    for (const m of [
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setEmitTouchEventsForMouse",
      "Emulation.setUserAgentOverride",
    ]) {
      expect(
        methods.indexOf(m),
        `${m} in ${methods.join(",")}`,
      ).toBeGreaterThan(-1);
      expect(methods.indexOf(m)).toBeLessThan(screencast);
    }
    expect(
      d.cdp.calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride")
        ?.params,
    ).toEqual(PHONE_METRICS);
    expect(
      d.cdp.calls.find((c) => c.method === "Emulation.setUserAgentOverride")
        ?.params,
    ).toEqual({ userAgent: IPHONE.userAgent });
  });

  // A tap is checked the way a click is: the pointer events a touch makes
  // carry the same points. Red if the touch path skips the check.
  it("stops at a tap whose release went elsewhere", async () => {
    const d = deps();
    d.cdp.click = {
      own: { x: 10, y: 20, width: 100, height: 40 },
      viewport: { width: 1280, height: 800 },
      down: { x: 60, y: 40 },
      up: { x: 40, y: 27 },
      cancelled: false,
      focused: false,
    };
    const result = await runReplay(phoneScene(), d);
    // The premise: the run tapped, it did not click.
    expect(d.cdp.calls.map((c) => c.method)).toContain(
      "Input.dispatchTouchEvent",
    );
    expect(result.reason).toBe("clickNotDelivered");
  });

  // Red if the re-assert keeps its `mobile: false` literal: the phone becomes
  // a desktop mid-take, on the path that only fires when something went wrong.
  it("re-asserts a device's metrics with mobile still true", async () => {
    const d = deps();
    emitDuringSpan(d, [
      frame(
        1,
        fakeScreenshotBase64(LANDSCAPE_SURFACE.width, LANDSCAPE_SURFACE.height),
      ),
    ]);
    await runReplay(phoneScene(), d);
    const overrides = d.cdp.calls.filter(
      (c) => c.method === "Emulation.setDeviceMetricsOverride",
    );
    expect(overrides.length).toBe(2);
    expect(overrides[1]?.params).toEqual(PHONE_METRICS);
  });

  // Review focus 1: a desktop take emulates nothing a phone take did.
  it("sends no touch or user-agent override for a desktop take", async () => {
    const d = deps();
    await runReplay(oneClick(), d);
    const methods = d.cdp.calls.map((c) => c.method);
    expect(methods).not.toContain("Emulation.setTouchEmulationEnabled");
    expect(methods).not.toContain("Emulation.setUserAgentOverride");
    expect(
      d.cdp.calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride")
        ?.params,
    ).toMatchObject({ mobile: false });
  });

  // Review focus 3: a phone take rebuilds as taps, never as mouse presses.
  it("taps rather than clicks on a touch device", async () => {
    // The premise: the scene has a click to perform.
    expect(phoneScene().actions.some((a) => a.kind === "click")).toBe(true);
    const d = deps();
    const result = await runReplay(phoneScene(), d);
    expect(result.completed, JSON.stringify(result.reason)).toBe(1);
    const touches = d.cdp.calls.filter(
      (c) => c.method === "Input.dispatchTouchEvent",
    );
    expect(touches.map((c) => c.params.type)).toEqual([
      "touchStart",
      "touchEnd",
    ]);
    expect(
      d.cdp.calls.filter(
        (c) =>
          c.method === "Input.dispatchMouseEvent" &&
          c.params.type === "mousePressed",
      ),
    ).toEqual([]);
  });

  it("clicks with the mouse on the desktop, as before", async () => {
    const d = deps();
    await runReplay(oneClick(), d);
    expect(
      d.cdp.calls.some((c) => c.method === "Input.dispatchTouchEvent"),
    ).toBe(false);
    expect(
      d.cdp.calls.some(
        (c) =>
          c.method === "Input.dispatchMouseEvent" &&
          c.params.type === "mousePressed",
      ),
    ).toBe(true);
  });

  it("stops as deviceFailed, naming the device, when emulation is refused", async () => {
    const d = deps();
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params) => {
      if (method === "Emulation.setTouchEmulationEnabled") {
        throw new Error("Not allowed");
      }
      return send(method, params);
    };
    const notes: string[] = [];
    d.onProgress = (p) => {
      if (p.note !== null) notes.push(p.note);
    };
    const result = await runReplay(phoneScene(), d);
    expect(result.reason).toBe("deviceFailed");
    expect(notes.join(" ")).toMatch(/could not emulate phone: .*Not allowed/i);
    expect(d.cdp.calls.map((c) => c.method)).not.toContain(
      "Page.startScreencast",
    );
  });
});

// 2026-10-13: the browser sometimes delivered a click at 2/3 of the point it
// was sent to — the release alone, or the press and the release together —
// the button never activated, and the run said `complete`. The engine now
// asks the page where both arrived (`click-probe.ts`); the fake answers a
// delivered click unless a test says otherwise.
describe("a click the browser did not deliver", () => {
  /** The fake's target, in the page's coordinates: the same box its
   *  `DOM.getBoxModel` answers, so the click is sent to (60, 40) there. */
  const OWN = { x: 10, y: 20, width: 100, height: 40 };
  /** Pressed where it was sent, released at 2/3 of it — the first shape
   *  measured in the sample app. */
  const MISSED = {
    own: OWN,
    viewport: { width: 1280, height: 800 },
    down: { x: 60, y: 40 },
    up: { x: 40, y: 26.67 },
    cancelled: false,
    focused: false,
  };
  const MISSED_WHY =
    "sent to (60, 40), the press arrived at (60, 40) and the release arrived at (40, 27)";
  /** The second shape: the press and the release together at 2/3, so they
   *  agree with each other and with nothing else. */
  const MOVED = {
    ...MISSED,
    down: { x: 40, y: 26.67 },
    up: { x: 40, y: 26.67 },
  };

  /** The fake answers `click` from the second step on: the first step's
   *  progress event is the seam between the two. */
  function missFromStepTwo(
    d: ReturnType<typeof deps>,
    click: CdpFake["click"],
    notes: string[],
  ): void {
    d.onProgress = (p) => {
      if (p.state === "failed") notes.push(p.note ?? "");
      if (p.state === "running" && p.step === 1) d.cdp.click = click;
    };
  }

  for (const recording of ["sampled", "continuous"] as const) {
    it(`stops at a click whose release went elsewhere, and claims no step it did not perform (${recording})`, async () => {
      const d = deps({ recording });
      const notes: string[] = [];
      missFromStepTwo(d, MISSED, notes);
      const result = await runReplay(scene(), d);

      // The premise: step two's click really was checked and answered a miss.
      const reads = d.cdp.calls.filter(
        (c) =>
          c.method === "Runtime.callFunctionOn" &&
          c.params.returnByValue === true &&
          String(c.params.functionDeclaration).includes("__demomanClickProbe"),
      );
      expect(reads).toHaveLength(2);

      expect(result.reason).toBe("clickNotDelivered");
      expect(result.outcome).toBe("partial");
      expect(result.completed).toBe(1);
      expect(result.lastCompletedActionId).toBe("act-1");
      expect(notes).toEqual([
        `the click was ${MISSED_WHY}, so the page never saw a click on its target`,
      ]);
      // The step that did not happen is not in the bundle as a step.
      const bundle = result.bundle;
      expect(bundle?.markers.map((m) => m.actionId)).toEqual(["act-1"]);
      expect(bundle?.anchorRects.map((r) => r.actionId)).toEqual(["act-1"]);
      expect(bundle?.keyframes.some((k) => k.actionId === "act-2")).toBe(false);
      // The premise of that: step 2's marker still WAS taken, and is kept as
      // a picture of the page that claims no step — so "none tagged act-2"
      // is the untagging, not a still that never happened (review M4). The
      // same scene with the click delivered says which still it is.
      const control = await runReplay(scene(), deps({ recording }));
      const marker = control.bundle?.keyframes.findIndex(
        (k) => k.actionId === "act-2",
      );
      expect(marker, "the control tags act-2's still").toBeGreaterThan(0);
      expect(bundle?.keyframes[marker as number]).toMatchObject({
        actionId: null,
      });
      expect(() => validateBundle(bundle)).not.toThrow();
    });
  }

  // Review of 2026-10-21: a drag taken back kept its held press, so the film
  // drew the cursor pressed, and held the zoom in, for a step that did not
  // happen.
  it("keeps no held press for a drag whose release went elsewhere", async () => {
    const dragScene = (): SceneDocument => {
      const doc = scene();
      const [a, b] = doc.actions as [
        (typeof doc.actions)[number],
        (typeof doc.actions)[number],
      ];
      return {
        ...doc,
        actions: [
          a,
          {
            ...b,
            kind: "drag",
            toAnchorId: null,
            to: { by: { x: 300, y: 0 } },
          },
        ],
      } as SceneDocument;
    };
    // Pressed at (60, 40), released 300px right: at (360, 40), or short.
    const released = (x: number) => ({ ...MISSED, up: { x, y: 40 } });
    const control = deps();
    missFromStepTwo(control, released(360), []);
    const done = await runReplay(dragScene(), control);
    // The premise: a drag the page took records its held press.
    expect(done.outcome, done.reason ?? "").toBe("complete");
    expect(done.bundle?.heldPresses?.map((h) => h.actionId)).toEqual(["act-2"]);

    const d = deps();
    missFromStepTwo(d, released(200), []);
    const result = await runReplay(dragScene(), d);
    expect(result.reason).toBe("clickNotDelivered");
    expect(result.bundle?.markers.map((m) => m.actionId)).toEqual(["act-1"]);
    expect(result.bundle?.heldPresses ?? []).toEqual([]);
    expect(() => validateBundle(result.bundle)).not.toThrow();
  });

  // The shape the first version of this check let through: press and release
  // agreed with each other, so comparing the two called it delivered, and the
  // page had seen a real click on the backdrop it landed on.
  it("stops at a click that arrived whole somewhere other than where it was sent", async () => {
    const d = deps();
    const notes: string[] = [];
    missFromStepTwo(d, MOVED, notes);
    const result = await runReplay(scene(), d);
    expect(result.reason).toBe("clickNotDelivered");
    expect(notes).toEqual([
      "the click was sent to (60, 40), the press arrived at (40, 27) and the release arrived at (40, 27), so the page never saw a click on its target",
    ]);
  });

  // A click whose press threw still takes the check's listeners down: left
  // on, they would sit on the author's own tab holding the target (review
  // M1). Red if the throw skips the read that removes them.
  it("takes the check down when the click itself throws", async () => {
    const d = deps();
    const send = d.cdp.send.bind(d.cdp);
    const order: string[] = [];
    d.cdp.send = async (method, params) => {
      const probe = String(params?.functionDeclaration ?? "").includes(
        "__demomanClickProbe",
      );
      if (method === "Runtime.callFunctionOn" && probe) {
        order.push(params?.returnByValue === true ? "read" : "place");
      }
      if (
        method === "Input.dispatchMouseEvent" &&
        params?.type === "mousePressed"
      ) {
        order.push("press threw");
        throw new Error("Target closed");
      }
      return send(method, params);
    };
    const result = await runReplay(oneClick(), d);
    expect(result.reason).toBe("portFailure");
    expect(order).toEqual(["place", "press threw", "read"]);
  });

  // The check must not move the click: placed before the press, read after
  // the release, nothing dispatched between the two.
  it("places the check before the press and reads it after the release", async () => {
    const d = deps();
    await runReplay(oneClick(), d);
    const order = d.cdp.calls
      .map((c) =>
        c.method === "Input.dispatchMouseEvent" &&
        c.params.type !== "mouseMoved"
          ? String(c.params.type)
          : c.method === "Runtime.callFunctionOn" &&
              String(c.params.functionDeclaration).includes(
                "__demomanClickProbe",
              )
            ? c.params.returnByValue === true
              ? "read"
              : "place"
            : null,
      )
      .filter((x) => x !== null);
    expect(order).toEqual(["place", "mousePressed", "mouseReleased", "read"]);
  });

  // Neither a miss nor a hit: said, and the run goes on.
  for (const [click, why] of [
    [
      "unreadable",
      "the page went away before the click could be checked (Cannot find context with specified id)",
    ],
    [
      "unplaceable",
      "the click could not be checked: Cannot find context with specified id",
    ],
  ] as const) {
    it(`goes on, and says so, when the click could not be checked (${click})`, async () => {
      const d = deps();
      d.cdp.click = click;
      const result = await runReplay(scene(), d);
      expect(result.outcome).toBe("complete");
      expect(result.reason).toBeNull();
      const said = result.degradations.filter(
        (x) => x.kind === "clickUnconfirmed",
      );
      expect(said.map((x) => x.note)).toEqual([
        `the click: ${why}`,
        `the click: ${why}`,
      ]);
      expect(() => validateBundle(result.bundle)).not.toThrow();
    });
  }

  function oneType(): SceneDocument {
    const doc = scene();
    return {
      ...doc,
      actions: [
        {
          id: "act-1",
          kind: "type",
          anchorId: "first-btn",
          timestamp: 0,
          marker: "type:first-btn",
          text: "hello",
          redacted: false,
        },
      ],
    } as SceneDocument;
  }

  // The value a type put in, as one entry; none when nothing was typed.
  const typed = (d: ReturnType<typeof deps>) => {
    const keys = d.cdp.calls.filter((c) => c.method === "Input.insertText");
    return keys.length === 0 ? [] : [typedText(d)];
  };
  const selectedAll = (d: ReturnType<typeof deps>) =>
    d.cdp.calls.some(
      (c) =>
        c.method === "Input.dispatchKeyEvent" &&
        JSON.stringify(c.params.commands) === '["selectAll"]',
    );

  // The press focuses a field on its own, so a stray release costs a type
  // nothing on screen: said, and the text goes in.
  it("types on, and says so, when a type's release went elsewhere but its field is focused", async () => {
    const d = deps();
    d.cdp.click = { ...MISSED, focused: true };
    const result = await runReplay(oneType(), d);
    expect(result.outcome).toBe("complete");
    expect(typed(d)).toEqual(["hello"]);
    expect(
      result.degradations
        .filter((x) => x.kind === "clickUnconfirmed")
        .map((x) => x.note),
    ).toEqual([
      `the type's click: ${MISSED_WHY}; the field holds focus, so the text still went in`,
    ]);
  });

  // Unfocused, the keys would land wherever focus was: nothing is typed.
  it("stops a type whose click left its field unfocused, before a key is sent", async () => {
    const d = deps();
    const notes: string[] = [];
    d.onProgress = (p) => {
      if (p.state === "failed") notes.push(p.note ?? "");
    };
    d.cdp.click = MISSED;
    const result = await runReplay(oneType(), d);
    expect(result.reason).toBe("clickNotDelivered");
    expect(result.completed).toBe(0);
    expect(typed(d)).toEqual([]);
    expect(selectedAll(d)).toBe(false);
    expect(notes).toEqual([
      `the type's click was ${MISSED_WHY}, so the page never saw a click on its target and nothing was typed`,
    ]);
  });

  // Second review, Important 1: a click the check could not confirm (here
  // its press was never seen) that left the field unfocused types nothing
  // either — the keys would go wherever focus was, whatever the events said.
  it("stops a type whose unconfirmed click left its field unfocused, before a key is sent", async () => {
    const d = deps();
    const notes: string[] = [];
    d.onProgress = (p) => {
      if (p.state === "failed") notes.push(p.note ?? "");
    };
    d.cdp.click = { ...MISSED, down: null, up: { x: 60, y: 40 } };
    const result = await runReplay(oneType(), d);
    expect(result.reason).toBe("clickNotDelivered");
    expect(typed(d)).toEqual([]);
    expect(selectedAll(d)).toBe(false);
    expect(notes).toEqual([
      "the type's click could not be confirmed (sent to (60, 40), the press was never seen and the release arrived at (60, 40) — the page's own code may have kept it from the check) and its field did not hold focus, so nothing was typed",
    ]);
  });

  // The positive control for the two above: a delivered click types, and
  // says nothing.
  it("types after a delivered click and says nothing about it", async () => {
    const d = deps();
    const result = await runReplay(oneType(), d);
    expect(result.outcome).toBe("complete");
    expect(typed(d)).toEqual(["hello"]);
    expect(selectedAll(d)).toBe(true);
    expect(result.degradations.some((x) => x.kind === "clickUnconfirmed")).toBe(
      false,
    );
  });
});

// 2026-10-13: input sent while `Page.captureScreenshot` is in flight lands at
// display DPR / REPLAY_DPR of where it was sent (`input-gate.ts`), and a
// settled still could be capturing as a step's click went out. The walk now
// keeps the two apart; this is the walk's half, the gate's own half runs in
// real Chromium in apps/runner/test/input-gate.test.ts.
describe("input and stills never overlap", () => {
  /**
   * A real gate that also records, for each CDP call, whether it went out
   * inside one of its sections or captures. Which call goes where is the
   * walk's half of the fix; whether the gate then keeps them apart is the
   * gate's half, proven against real Chromium.
   */
  function recordingGate(d: ReturnType<typeof deps>) {
    const inner = createInputGate();
    let inSection = 0;
    let inCapture = 0;
    const strays: string[] = [];
    let inputs = 0;
    let captures = 0;
    const send = d.cdp.send.bind(d.cdp);
    d.cdp.send = async (method, params) => {
      if (method.startsWith("Input.")) {
        inputs++;
        if (inSection === 0)
          strays.push(
            `${method} ${String(params?.type ?? "")} outside a section`,
          );
      }
      if (method === "Page.captureScreenshot") {
        captures++;
        if (inCapture === 0) strays.push("a screenshot outside a capture");
      }
      return send(method, params);
    };
    const gate: InputGate = {
      section: (input) =>
        inner.section(async () => {
          inSection++;
          try {
            return await input();
          } finally {
            inSection--;
          }
        }),
      capture: (take) =>
        inner.capture(async () => {
          inCapture++;
          try {
            return await take();
          } finally {
            inCapture--;
          }
        }),
    };
    return { gate, strays, counts: () => ({ inputs, captures }) };
  }

  for (const recording of ["sampled", "continuous"] as const) {
    it(`sends every input inside a section and takes every still through the gate (${recording})`, async () => {
      const d = deps({ recording });
      const { gate, strays, counts } = recordingGate(d);
      d.inputGate = gate;
      const doc = scene();
      // A click and a type, so moves, presses, releases and keys all go out.
      const result = await runReplay(
        {
          ...doc,
          actions: [
            doc.actions[0],
            {
              id: "act-2",
              kind: "type",
              anchorId: "first-btn",
              timestamp: 900,
              marker: "type:first-btn",
              text: "hello",
              redacted: false,
            },
          ],
        } as SceneDocument,
        d,
      );
      expect(result.outcome).toBe("complete");
      // The premise: the run sent input of every kind and took stills.
      const methods = new Set(
        d.cdp.calls
          .filter((c) => c.method.startsWith("Input."))
          .map((c) => `${c.method}:${String(c.params.type ?? "")}`),
      );
      for (const m of [
        "Input.dispatchMouseEvent:mouseMoved",
        "Input.dispatchMouseEvent:mousePressed",
        "Input.dispatchMouseEvent:mouseReleased",
        "Input.insertText:",
      ]) {
        expect([...methods], m).toContain(m);
      }
      expect(counts().captures).toBeGreaterThan(1);
      expect(strays).toEqual([]);
    });
  }
});

// 2026-10-13: a CLI run sat in a `waitForLoad` for ten minutes, saying
// nothing, because some CDP call never answered and nothing in the walk had
// a deadline over one. Now every call has one (`answer-deadline.ts`). Real
// timers, so only `setTimeout` is faked here: the fake's own clock is not
// what the deadline runs on.
describe("a call the browser never answers", () => {
  it("stops the run as portFailure, naming the call, instead of never returning", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const d = deps();
      const notes: string[] = [];
      // From step two on, the press never answers.
      let hanging = false;
      d.onProgress = (p) => {
        if (p.state === "failed") notes.push(p.note ?? "");
        if (p.state === "running" && p.step === 1) hanging = true;
      };
      const send = d.cdp.send.bind(d.cdp);
      let hung = 0;
      d.cdp.send = (method, params) => {
        if (
          hanging &&
          method === "Input.dispatchMouseEvent" &&
          params?.type === "mousePressed"
        ) {
          hung++;
          return new Promise(() => undefined);
        }
        return send(method, params);
      };
      let result: Awaited<ReturnType<typeof runReplay>> | null = null;
      const running = runReplay(scene(), d).then((r) => {
        result = r;
      });
      // A minute of real time, a second at a go, with the run's own
      // promises let through between.
      for (let s = 0; s < 60 && result === null; s++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      // Said here rather than as the test's own timeout, which is what a walk
      // with no deadline gives: it never returns.
      expect(result, "the run never returned").not.toBeNull();
      await running;
      const got = result as Awaited<ReturnType<typeof runReplay>> | null;
      // The premise: step two's press really was the call left unanswered.
      expect(hung).toBe(1);
      expect(got?.reason).toBe("portFailure");
      expect(got?.completed).toBe(1);
      expect(notes).toEqual([
        `Input.dispatchMouseEvent got no answer from the browser in ${ANSWER_DEADLINE_MS / 1000} s`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Red if the walk returns without clearing its deadlines: one would fire
  // thirty seconds later into a call nobody awaits — here an ack, which the
  // walk sends and never waits for.
  it("leaves no deadline running once it returns", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const d = deps();
      const resolve = d.page.resolve;
      let fired = false;
      d.page = {
        resolve: async (anchors) => {
          if (!fired) {
            fired = true;
            d.cdp.emit("Page.screencastFrame", frame(77));
          }
          return resolve(anchors);
        },
      };
      const send = d.cdp.send.bind(d.cdp);
      let unanswered = 0;
      d.cdp.send = (method, params) => {
        if (method === "Page.screencastFrameAck") {
          unanswered++;
          return new Promise(() => undefined);
        }
        return send(method, params);
      };
      const result = await runReplay(oneClick(), d);
      expect(result.outcome).toBe("complete");
      // The premise: a call was still waiting for its answer as it returned.
      expect(unanswered).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Review of 2026-10-21: `zoomsForClicks` zooms drags, and the room policy
// heard only clicks, so its record of the last zoom was not the take's: a
// click just after a zoomed drag waited for a zoom the take would not have.
describe("a drag, asked of the room policy", () => {
  it("asks for the drag as well as the click, framed by both its ends", async () => {
    const doc = scene();
    const [a, b] = doc.actions as [
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
    ];
    const dragFirst = {
      ...doc,
      actions: [
        { ...a, kind: "drag", toAnchorId: null, to: { by: { x: 300, y: 0 } } },
        b,
      ],
    } as SceneDocument;
    const asked: { actionId: string; rect: unknown }[] = [];
    const room: RoomPolicy = {
      neededMs: () => 0,
      zooms: ({ actionId, rect }) => {
        asked.push({ actionId, rect });
        return false;
      },
    };
    const d = deps({ recording: "continuous", room });
    // The drag let go where it was sent, then the click lands as sent.
    const delivered = d.cdp.click as ClickSeen;
    d.cdp.click = { ...delivered, up: { x: 360, y: 40 } };
    d.onProgress = (p) => {
      if (p.state === "running" && p.step === 1) d.cdp.click = delivered;
    };
    const result = await runReplay(dragFirst, d);
    expect(result.outcome, result.reason ?? "").toBe("complete");
    // Pressed at the fake target's centre (60, 40), let go 300px right.
    expect(asked).toEqual([
      { actionId: "act-1", rect: { x: 60, y: 40, width: 300, height: 0 } },
      { actionId: "act-2", rect: expect.anything() },
    ]);
  });
});

// Spec 2026-10-22: a click the camera pans to from the zoom before it gets
// no added room — the author's pacing "C".
describe("a run of zoomed clicks, asked of the room policy", () => {
  // /code-review 2026-10-22: the author's rhythm waits after the room is
  // asked, so a click judged a pan could land late enough for the camera to
  // return, with no room for the push-in. The room is asked of the click
  // where the rhythm will put it.
  // /code-review 2026-10-22: the camera holds a zoom through any drag
  // pressed while it is in (`heldUntilOf`), zoomed or not, so the walk counts
  // the zoom held until that release too, or it paces a return the camera
  // renders as a pan, and the take waits for a push-in that never comes.
  it("counts a zoom held through a drag with no zoom of its own", async () => {
    const doc = scene({ anchorIds: ["a", "b", "c"] });
    const [x, y, z] = doc.actions as [
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
    ];
    const run = {
      ...doc,
      // One timestamp for all three, so no recorded rhythm spaces them: the
      // drag is pressed while the first click's zoom is still in.
      actions: [
        { ...x, timestamp: 0 },
        {
          ...y,
          timestamp: 0,
          kind: "drag",
          toAnchorId: null,
          to: { by: { x: 300, y: 0 } },
        },
        { ...z, timestamp: 0 },
      ],
    } as SceneDocument;
    const asked: { heldUntilMs: number | null; clickMs: number }[] = [];
    const room: RoomPolicy = {
      neededMs: (gap) => {
        asked.push(gap);
        return 0;
      },
      // The clicks zoom; the drag does not.
      zooms: ({ actionId }) => actionId !== "act-2",
    };
    const d = deps({ recording: "continuous", room });
    // The drag lets go where it was sent; the clicks land as sent.
    const delivered = d.cdp.click as ClickSeen;
    d.onProgress = (p) => {
      if (p.state !== "running") return;
      d.cdp.click =
        p.step === 1 ? { ...delivered, up: { x: 360, y: 40 } } : delivered;
    };
    const result = await runReplay(run, d);
    expect(result.outcome, result.reason ?? "").toBe("complete");
    const markers = result.bundle?.markers ?? [];
    const drag = markers.find((m) => m.actionId === "act-2");
    const last = markers.find((m) => m.actionId === "act-3");
    if (!drag || !last) throw new Error(JSON.stringify(markers));
    // Premise: the drag was pressed while the first zoom was in (its arrival
    // 350ms before its click, held 1200ms), and the third click was asked.
    const first = markers.find((m) => m.actionId === "act-1");
    expect(drag.sourceTimeMs).toBeLessThan(
      (first?.sourceTimeMs ?? 0) - 350 + 1200,
    );
    const third = asked.at(-1);
    expect(third?.clickMs).toBeGreaterThan(drag.sourceTimeMs);
    // Held until the drag let go, after its press, not the first zoom's
    // arrival.
    expect(third?.heldUntilMs).toBeGreaterThan(drag.sourceTimeMs);
  });

  it("asks the room of the click where the author's rhythm puts it", async () => {
    const doc = scene();
    const [a, b] = doc.actions as [
      (typeof doc.actions)[number],
      (typeof doc.actions)[number],
    ];
    const apart = {
      ...doc,
      actions: [
        { ...a, timestamp: 10_000 },
        { ...b, timestamp: 14_000 },
      ],
    } as SceneDocument;
    const asked: { heldUntilMs: number | null; clickMs: number }[] = [];
    const room: RoomPolicy = {
      neededMs: (gap) => {
        asked.push(gap);
        return 0;
      },
      zooms: () => true,
    };
    const result = await runReplay(
      apart,
      deps({ recording: "continuous", room }),
    );
    expect(result.outcome, result.reason ?? "").toBe("complete");
    const [first, second] = result.bundle?.markers ?? [];
    if (!first || !second) throw new Error("two markers expected");
    // Premise: the rhythm did hold the second click 4s after the first.
    expect(second.sourceTimeMs - first.sourceTimeMs).toBeGreaterThanOrEqual(
      4000,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.clickMs).toBeGreaterThanOrEqual(first.sourceTimeMs + 4000);
  });

  it("adds no room before a zoomed click the camera pans to", async () => {
    const doc = scene({ anchorIds: ["a", "b", "c"] });
    const asked: { heldUntilMs: number | null; clickMs: number }[] = [];
    const room: RoomPolicy = {
      // Answers as the real policy would for a run this tight: a pan.
      neededMs: (gap) => {
        asked.push(gap);
        return gap.heldUntilMs === null ? 2050 : 0;
      },
      zooms: () => true,
    };
    const d = deps({ recording: "continuous", room });
    const result = await runReplay(doc, d);
    expect(result.outcome, result.reason ?? "").toBe("complete");
    const markers = result.bundle?.markers ?? [];
    const [first, second, third] = ["act-1", "act-2", "act-3"].map((id) =>
      markers.find((m) => m.actionId === id),
    );
    if (!first || !second || !third) {
      throw new Error(`markers: ${JSON.stringify(markers)}`);
    }
    // Premise: the two later clicks were asked; the first has no act
    // before it to wait on, so the walk never asks.
    expect(asked).toHaveLength(2);
    // No hold for the camera's room: `roomMs` may still carry the wait for
    // the page to go quiet after the click before, which stays.
    expect(second.roomHeldMs, JSON.stringify(markers)).toBeUndefined();
    expect(third.roomHeldMs, JSON.stringify(markers)).toBeUndefined();
    // The camera counts the zoom before as held from its arrival, the
    // lead-in before its click.
    expect(asked[0]?.heldUntilMs).toBe(first.sourceTimeMs - 350);
    expect(asked[1]?.heldUntilMs).toBe(second.sourceTimeMs - 350);
  });
});
