import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DemoScriptSchema,
  type HoleReason,
  type SceneAction,
  type SceneAnchor,
  type SceneDocument,
  SceneDocumentSchema,
  scriptFromTake,
  URL_SCRUB_PLACEHOLDER,
} from "../src/index";

/**
 * `readonly-scene.json`: two anchors (`a-checkout` won by stableId,
 * `a-search` won by roleName), and moveTo / click / type / anchorless
 * waitFor. A fresh parse per call, so a case can mutate its own copy.
 */
const take = (): SceneDocument =>
  SceneDocumentSchema.parse(
    JSON.parse(
      readFileSync(
        join(__dirname, "..", "fixtures", "readonly-scene.json"),
        "utf8",
      ),
    ),
  );

const derived = (doc: SceneDocument) => {
  const d = scriptFromTake(doc);
  if (d.outcome !== "derived") {
    throw new Error(`expected derived, got ${d.outcome}`);
  }
  return d;
};

const anchor = (doc: SceneDocument, id: string): SceneAnchor => {
  const found = doc.anchors.find((a) => a.id === id);
  if (found === undefined) throw new Error(`fixture has no anchor ${id}`);
  return found;
};

/** Each zod issue as the one string a hole's step and field should produce:
 *  `steps.2.text` for a missing field, `steps.2.button` for a strict key. */
const issueFields = (draft: unknown): string[] => {
  const r = DemoScriptSchema.safeParse(draft);
  if (r.success) return [];
  return r.error.issues.flatMap((i) =>
    i.code === "unrecognized_keys"
      ? i.keys.map((k) => [...i.path, k].join("."))
      : [i.path.join(".")],
  );
};

/** The premise every hand-edited take below owes: the edit still leaves a
 *  document the schema accepts, so the derivation reads a take that could
 *  really be on disk. */
const expectValidTake = (doc: SceneDocument, label = ""): void => {
  const r = SceneDocumentSchema.safeParse(doc);
  expect(r.success, `${label} ${JSON.stringify(r.error?.issues)}`).toBe(true);
};

describe("scriptFromTake", () => {
  it("names the take and, on every step, the action it came from", () => {
    const doc = take();
    // A removed action is kept as a step (with a note), so a removed piece
    // in the fixture must not shorten the expected list; asserted below.
    const cutId = doc.actions[1]?.id;
    if (cutId === undefined)
      throw new Error("the fixture has no second action");
    doc.edits.removed.push({
      id: "cut-1",
      start: { actionId: cutId, sourceOffsetMs: 0 },
      end: null,
    });
    expectValidTake(doc);
    const d = derived(doc);
    // The premise: the fixture derives more than one step, and one was cut.
    expect(d.draft.steps.length).toBeGreaterThan(1);
    expect(d.notes.some((n) => n.kind === "cut")).toBe(true);
    expect(d.draft.recordedFrom).toBe(doc.meta.id);
    expect(d.draft.steps.map((s) => s.recorded)).toEqual(
      doc.actions.map((a) => a.id),
    );
  });

  it("derives a clean take to a script that parses, with no holes", () => {
    const doc = take();
    // Premise: the fixture's anchors won by two different tiers, so this case
    // covers both rather than one twice.
    expect(anchor(doc, "a-checkout").resolution.strategy).toBe("stableId");
    expect(anchor(doc, "a-search").resolution.strategy).toBe("roleName");

    const d = derived(doc);
    expect(d.holes).toEqual([]);
    expect(DemoScriptSchema.safeParse(d.draft).success).toBe(true);
    expect(d.draft).toMatchObject({
      scriptVersion: 1,
      name: "Orders walkthrough (read-only)",
      target: "https://app.example.com/orders",
      viewport: { width: 1280, height: 800 },
      look: { branding: doc.branding, cursor: doc.cursor, canvas: doc.canvas },
    });
    expect(d.draft.steps).toEqual([
      {
        do: "hover",
        on: { stableId: "checkout-btn" },
        recorded: expect.any(String),
      },
      {
        do: "click",
        on: { stableId: "checkout-btn" },
        recorded: expect.any(String),
      },
      {
        do: "type",
        into: { role: "textbox", name: "Search orders" },
        text: "Q3 revenue",
        recorded: expect.any(String),
      },
      { do: "waitForLoad", recorded: expect.any(String) },
    ]);
  });

  /** One take per hole reason, each built from the clean fixture by one edit.
   *  The invariant runs over all of them and over the clean one. Keyed by
   *  `HoleReason`, so a reason added to the type and not here fails to
   *  compile rather than going untested. */
  const holed: Record<HoleReason, () => SceneDocument> = {
    redacted: () => {
      const doc = take();
      const t = doc.actions[2] as Extract<SceneAction, { kind: "type" }>;
      t.redacted = true;
      t.text = null;
      return doc;
    },
    unnameable: () => {
      const doc = take();
      // A picture: the one tier a script can never say. (A `treePath` win is
      // no longer a hole — see "names a scroll by the position…".)
      anchor(doc, "a-checkout").resolution.strategy = "imagePatch";
      return doc;
    },
    ambiguousAtCapture: () => {
      const doc = take();
      const a = anchor(doc, "a-checkout");
      a.resolution.strategy = "ambiguous";
      a.resolution.candidates = 3;
      return doc;
    },
    brokenAtCapture: () => {
      const doc = take();
      anchor(doc, "a-search").resolution.strategy = "broken";
      return doc;
    },
    buttonNotScriptable: () => {
      const doc = take();
      (doc.actions[1] as Extract<SceneAction, { kind: "click" }>).button =
        "right";
      return doc;
    },
    hostField: () => {
      const doc = take();
      (doc.actions[2] as Extract<SceneAction, { kind: "type" }>).host = true;
      return doc;
    },
    // Capture scrubs the origin before it reaches disk (`scrubUrl` in the
    // extension): every query value, and any secret-looking path segment,
    // becomes the placeholder. The page the author was on is not recoverable.
    scrubbedTarget: () => {
      const doc = take();
      doc.meta.capture.originUrl = `https://app.example.com/orders?q=${URL_SCRUB_PLACEHOLDER}`;
      return doc;
    },
  };

  it("names a hole exactly where the schema refuses, and nowhere else", () => {
    for (const [reason, build] of Object.entries(holed)) {
      const doc = build();
      expectValidTake(doc, reason);
      const d = derived(doc);
      expect(
        d.holes.map((h) => h.reason),
        reason,
      ).toContain(reason);
      const holeFields = d.holes.map((h) =>
        h.step === null ? h.field : `steps.${h.step}.${h.field}`,
      );
      expect(issueFields(d.draft).sort(), reason).toEqual(holeFields.sort());
      for (const h of d.holes) {
        expect(h.sentence, reason).toMatch(
          h.step === null ? /^The start URL/ : /^Step \d+/,
        );
      }
    }
  });

  it("holds the invariant: no holes iff the draft parses", () => {
    for (const build of [take, ...Object.values(holed)]) {
      const d = derived(build());
      expect(d.holes.length === 0).toBe(
        DemoScriptSchema.safeParse(d.draft).success,
      );
    }
  });

  it("tells the agent what capture saw of an element it cannot name", () => {
    const d = derived(holed.ambiguousAtCapture());
    const h = d.holes.find((x) => x.reason === "ambiguousAtCapture");
    expect(h?.saw).toEqual({
      stableId: "checkout-btn",
      role: "button",
      name: "Checkout",
      text: "Checkout",
      candidates: 3,
    });
    expect(h?.sentence).toContain("3 elements");
  });

  it("treats an empty name as no name, not as a target, and says which name", () => {
    const doc = take();
    anchor(doc, "a-search").fingerprint.accessibleName = "";
    expectValidTake(doc);
    const d = derived(doc);
    expect(d.holes).toMatchObject([
      { step: 2, field: "into", reason: "unnameable" },
    ]);
    // The sentence names the tier that won and what it lacked — not a
    // position or a picture, neither of which is what happened here.
    expect(d.holes[0]?.sentence).toContain("role and name");
    expect(d.holes[0]?.sentence).not.toMatch(/position|picture/);
  });

  it("names a scroll by the position capture measured, when that is what won", () => {
    const doc = take();
    const a = anchor(doc, "a-checkout");
    a.resolution.strategy = "treePath";
    // Premise: the fingerprint holds the path capture resolved by.
    expect(a.fingerprint.treePath).toBe("body:1/main:1/section:2/button:1");
    const d = derived(doc);
    expect(d.holes).toEqual([]);
    expect(d.draft.steps[0]).toEqual({
      do: "hover",
      on: { treePath: "body:1/main:1/section:2/button:1" },
      recorded: expect.any(String),
    });
    expect(DemoScriptSchema.safeParse(d.draft).success).toBe(true);
  });

  it("says a picture-only element was found by its picture", () => {
    const d = derived(holed.unnameable());
    expect(d.holes[0]?.sentence).toContain("its picture");
  });

  it("a cleared field derives as an empty text, not a hole", () => {
    const doc = take();
    (doc.actions[2] as Extract<SceneAction, { kind: "type" }>).text = "";
    expectValidTake(doc);
    const d = derived(doc);
    expect(d.holes).toEqual([]);
    expect(d.draft.steps[2]).toMatchObject({ do: "type", text: "" });
  });

  it("uses the tier that won at capture, not the first field the fingerprint has", () => {
    const doc = take();
    const a = anchor(doc, "a-checkout");
    a.resolution.strategy = "text";
    // Premise: this anchor also has a stableId and a role and name, so a
    // derivation in fingerprint order would emit {stableId} instead.
    expect(a.fingerprint.stableId).not.toBeNull();
    expect(a.fingerprint.role).not.toBeNull();
    expect(a.fingerprint.accessibleName).not.toBeNull();
    const d = derived(doc);
    expect(d.draft.steps[1]).toEqual({
      do: "click",
      on: { text: "Checkout" },
      recorded: expect.any(String),
    });
  });

  it("reads each wait the way the engine does", () => {
    const doc = take();
    // `act-4` is the fixture's anchorless `condition: "loaded"` wait; its own
    // condition is dropped so the no-condition case really has none.
    const { condition: _loaded, ...navWait } = doc.actions[3] as Extract<
      SceneAction,
      { kind: "waitFor" }
    >;
    const wait = (condition?: "visible" | "hidden" | "loaded") => ({
      ...navWait,
      anchorId: "a-checkout",
      ...(condition === undefined ? {} : { condition }),
    });
    expect(wait().condition).toBeUndefined();
    // The fixture's one camera event is keyed to `act-2`, which this case
    // replaces; left in, the premise parse below refuses a dangling marker.
    doc.camera = [];
    doc.actions = [
      { ...wait("hidden"), id: "w1" },
      { ...wait("visible"), id: "w2" },
      { ...wait(), id: "w3" },
      { ...wait("loaded"), id: "w4" },
      { ...(doc.actions[3] as SceneAction), id: "w5" },
    ] as SceneAction[];
    expectValidTake(doc);
    const d = derived(doc);
    expect(d.draft.steps).toEqual([
      {
        do: "waitFor",
        on: { stableId: "checkout-btn" },
        until: "hidden",
        recorded: expect.any(String),
      },
      {
        do: "waitFor",
        on: { stableId: "checkout-btn" },
        until: "visible",
        recorded: expect.any(String),
      },
      {
        do: "waitFor",
        on: { stableId: "checkout-btn" },
        until: "visible",
        recorded: expect.any(String),
      },
      {
        do: "waitFor",
        on: { stableId: "checkout-btn" },
        until: "visible",
        recorded: expect.any(String),
      },
      { do: "waitForLoad", recorded: expect.any(String) },
    ]);
  });

  it("maps scrollTo to scrollTo", () => {
    const doc = take();
    doc.actions = [
      { ...(doc.actions[1] as SceneAction), kind: "scrollTo" },
    ] as SceneAction[];
    expectValidTake(doc);
    expect(derived(doc).draft.steps).toEqual([
      { do: "scrollTo", on: { stableId: "checkout-btn" }, recorded: "act-2" },
    ]);
  });

  // The author's scroll stopped with the anchor's top at y=280 — the only
  // thing that tells two "scrollTo tall-block" steps apart. Without it the
  // derived run centres every scroll (film lane, 2026-09-30: landings off by
  // +120/-580/-232/-232/0/-180 against the recording).
  it("keeps where a recorded scroll left its anchor", () => {
    const doc = take();
    const rect = { x: 140, y: 280, width: 1000, height: 1400 };
    doc.actions = [
      { ...(doc.actions[1] as SceneAction), kind: "scrollTo", rect },
    ] as SceneAction[];
    expectValidTake(doc);
    // The premise: the rect meets the capture viewport, the walk's own test.
    const { height } = doc.meta.capture.viewport;
    expect(rect.y < height && rect.y + rect.height > 0).toBe(true);

    const d = derived(doc);
    expect(d.draft.steps).toEqual([
      {
        do: "scrollTo",
        on: { stableId: "checkout-btn" },
        recorded: "act-2",
        landing: { top: 280 },
      },
    ]);
    expect(d.holes).toEqual([]);
    expect(d.notes).toEqual([]);
    expect(DemoScriptSchema.safeParse(d.draft).success).toBe(true);
  });

  // A rect that misses the viewport was measured after the page moved on, so
  // it is not a landing the author had. The derived run will centre that
  // scroll, and the derivation says so rather than leaving it to happen.
  it("keeps no landing off screen, and notes that the scroll will centre", () => {
    const doc = take();
    const rect = { x: 747, y: 2460, width: 103, height: 40 };
    doc.actions = [
      { ...(doc.actions[1] as SceneAction), kind: "scrollTo", rect },
    ] as SceneAction[];
    expectValidTake(doc);
    // The premise: this rect misses the capture viewport entirely.
    const { height } = doc.meta.capture.viewport;
    expect(rect.y < height && rect.y + rect.height > 0).toBe(false);

    const d = derived(doc);
    expect(d.draft.steps).toEqual([
      { do: "scrollTo", on: { stableId: "checkout-btn" }, recorded: "act-2" },
    ]);
    expect(d.notes).toEqual([
      { kind: "landingOffscreen", step: 0, actionId: "act-2" },
    ]);
    expect(DemoScriptSchema.safeParse(d.draft).success).toBe(true);
  });

  it("keeps every removed and trimmed step, and notes each", () => {
    const doc = take();
    doc.edits.removed = [
      {
        id: "cut-1",
        start: { actionId: "act-2", sourceOffsetMs: 0 },
        end: { actionId: "act-3", sourceOffsetMs: 0 },
      },
    ];
    doc.edits.trim = {
      head: { actionId: "act-2", offsetMs: 0 },
      tail: { actionId: "act-3", offsetMs: 0 },
    };
    expectValidTake(doc);
    const d = derived(doc);
    expect(d.draft.steps).toHaveLength(doc.actions.length);
    expect(d.notes).toEqual([
      { kind: "trimmed", step: 0, actionId: "act-1", end: "head" },
      { kind: "cut", step: 1, actionId: "act-2" },
      { kind: "trimmed", step: 3, actionId: "act-4", end: "tail" },
    ]);
  });

  it("names an untitled take, and says it did", () => {
    const doc = take();
    doc.meta.name = "";
    const d = derived(doc);
    expect(d.draft.name).toBe(`untitled take ${doc.meta.id}`);
    expect(d.notes).toContainEqual({ kind: "untitled" });
  });

  it("does not hand back a start URL capture scrubbed, and says what was recorded", () => {
    for (const url of [
      `https://app.example.com/orders?q=${URL_SCRUB_PLACEHOLDER}&page=${URL_SCRUB_PLACEHOLDER}`,
      `https://app.example.com/invite/${URL_SCRUB_PLACEHOLDER}/accept`,
    ]) {
      const doc = take();
      doc.meta.capture.originUrl = url;
      expectValidTake(doc, url);
      const d = derived(doc);
      expect(d.draft, url).not.toHaveProperty("target");
      expect(d.holes, url).toEqual([
        expect.objectContaining({
          step: null,
          actionId: null,
          field: "target",
          reason: "scrubbedTarget",
          recorded: url,
        }),
      ]);
      expect(d.holes[0]?.sentence).toContain(url);
    }
  });

  it("keeps a start URL that was never scrubbed", () => {
    const doc = take();
    // Premise: a query key and a path both survive a scrub; only values and
    // secret-looking segments are replaced, so this URL is what was visited.
    doc.meta.capture.originUrl = "https://app.example.com/orders/42";
    const d = derived(doc);
    expect(d.draft.target).toBe("https://app.example.com/orders/42");
    expect(d.holes).toEqual([]);
  });

  it("derives nothing from a take with no actions, and says so", () => {
    const doc = take();
    doc.actions = [];
    doc.anchors = [];
    expect(scriptFromTake(doc)).toEqual({
      outcome: "nothingToDerive",
      takeId: doc.meta.id,
      reason: "noActions",
    });
  });
});

describe("a phone take", () => {
  const IPHONE = {
    preset: "phone" as const,
    width: 393,
    height: 852,
    mobile: true,
    touch: true,
    userAgent: "Mozilla/5.0 (iPhone; test)",
  };
  /** The fixture as a phone take. A phone has no hover, so its moveTo is
   *  dropped: a phone take's sensor records taps, not dwells. */
  const phoneTake = (): SceneDocument => {
    const doc = take();
    doc.actions = doc.actions.filter((a) => a.kind !== "moveTo");
    doc.meta.capture.device = IPHONE;
    doc.meta.capture.viewport = { width: 393, height: 852 };
    return doc;
  };

  it("carries the device and declares scriptVersion 4", () => {
    const doc = phoneTake();
    // The premise: something on the page is still acted on.
    expect(doc.actions.some((a) => a.kind === "click")).toBe(true);
    const d = derived(doc);
    expect(d.draft.device).toBe("phone");
    expect(d.draft.viewport).toBeUndefined();
    expect(d.draft.scriptVersion).toBe(4);
    // A draft naming both device and viewport would be refused at the door.
    const filled = { ...d.draft, target: "https://a.example/" };
    const parsed = DemoScriptSchema.safeParse(filled);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("leaves a desktop take's draft as it was", () => {
    const doc = take();
    expect(doc.meta.capture.device).toBeUndefined();
    const d = derived(doc);
    expect(d.draft.device).toBeUndefined();
    expect(d.draft.viewport).toEqual(doc.meta.capture.viewport);
    expect(d.draft.scriptVersion).not.toBe(4);
  });
});

describe("scriptFromTake: drag", () => {
  // Red if the switch drops a drag, which a take has no other way to say.
  it("turns a drag back into a drag step with its spots and its end", () => {
    const doc = take();
    const first = doc.actions[0] as SceneAction;
    doc.actions.push(
      {
        id: "act-drag-1",
        kind: "drag",
        anchorId: "a-checkout",
        timestamp: first.timestamp + 10_000,
        marker: "m-drag-1",
        toAnchorId: "a-search",
        fromAt: { x: 0.25, y: 0.5 },
        to: { at: { x: 0.75, y: 0.5 } },
      },
      {
        id: "act-drag-2",
        kind: "drag",
        anchorId: "a-checkout",
        timestamp: first.timestamp + 11_000,
        marker: "m-drag-2",
        toAnchorId: null,
        to: { by: { x: 120, y: 0 } },
      },
    );
    expectValidTake(doc);
    const { draft } = derived(doc);
    expect(draft.scriptVersion).toBe(6);
    const drags = draft.steps.filter((s) => s.do === "drag");
    expect(drags).toEqual([
      {
        do: "drag",
        from: { on: expect.anything(), at: { x: 0.25, y: 0.5 } },
        to: { on: expect.anything(), at: { x: 0.75, y: 0.5 } },
        recorded: "act-drag-1",
      },
      {
        do: "drag",
        from: { on: expect.anything() },
        to: { by: { x: 120, y: 0 } },
        recorded: "act-drag-2",
      },
    ]);
    expect(issueFields(draft)).toEqual([]);
  });
});
