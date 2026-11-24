import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  capsOf,
  KEYCAP_HOLD_MS,
  KEYCAP_LEAD_MS,
  MULTI_CLICK_GAP_MS,
  needsTextFont,
  planKeyMarks,
} from "../../src/plan/key-marks";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { toOutputMs } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

type Action = SceneDocument["actions"][number];

/** The replay fixture with a press after its last marker, as
 *  `taps.test.ts` adds one; `modifiers` only when given (a v17 press). */
function withPress(modifiers?: ("Mod" | "Shift")[]) {
  const scene = readonlyScene();
  const bundle = proceduralBundle();
  const last = Math.max(...bundle.markers.map((m) => m.sourceTimeMs));
  const press = {
    id: "act-press",
    kind: "press" as const,
    anchorId: null,
    timestamp: 99999,
    marker: "press:none",
    key: modifiers ? "K" : "Enter",
    ...(modifiers ? { modifiers } : {}),
  };
  return {
    scene: { ...scene, actions: [...scene.actions, press] } as SceneDocument,
    bundle: {
      ...bundle,
      markers: [
        ...bundle.markers,
        { actionId: press.id, sourceTimeMs: last + 100 },
      ],
    },
    pressSourceMs: last + 100,
  };
}

const click = (id: string, extra: Record<string, unknown> = {}): Action =>
  ({
    id,
    anchorId: "a-checkout",
    timestamp: 1,
    marker: `click:${id}`,
    kind: "click",
    ...extra,
  }) as Action;
const press = (id: string, extra: Record<string, unknown>): Action =>
  ({
    id,
    anchorId: null,
    timestamp: 1,
    marker: "press:none",
    kind: "press",
    ...extra,
  }) as Action;
const REPLAY = new Set(["click", "type", "drag", "press"]);

describe("planKeyMarks through resolvePlan", () => {
  it("a pre-17 press keeps its ripple and draws no pill", () => {
    const { scene, bundle, pressSourceMs } = withPress();
    // The premise: a replay whose press has no `modifiers`, and whose
    // marker is one of the times the pulse draws at today.
    expect(bundle.source).toBe("replay");
    const p = scene.actions.find((a) => a.kind === "press");
    expect(p && "modifiers" in p).toBe(false);
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    expect(resolved.clickOutputMs).toContain(
      toOutputMs(resolved.timeline, pressSourceMs),
    );

    expect(resolved.pulseOutputMs).toEqual(resolved.clickOutputMs);
    expect(resolved.keycaps).toEqual([]);
    expect(resolved.clickTags).toEqual([]);
    expect(resolved.rightClicks).toEqual([]);
  });

  it("a press with modifiers gets a pill and no ripple", () => {
    const { scene, bundle, pressSourceMs } = withPress(["Mod"]);
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const m = toOutputMs(resolved.timeline, pressSourceMs);
    // The premise: the press still counts as a click moment for the screens.
    expect(resolved.clickOutputMs).toContain(m);

    expect(resolved.keycaps).toEqual([
      {
        range: { startMs: m - KEYCAP_LEAD_MS, endMs: m + KEYCAP_HOLD_MS },
        caps: [{ glyph: "command" }, { text: "K" }],
      },
    ]);
    expect(resolved.pulseOutputMs).not.toContain(m);
    expect(resolved.pulseOutputMs).toEqual(
      resolved.clickOutputMs.filter((t) => t !== m),
    );
  });
});

describe("planKeyMarks", () => {
  it("presses 300 ms apart are three pills that never overlap", () => {
    const actions = ["a", "b", "c"].map((id) =>
      press(id, { key: "Enter", modifiers: [] }),
    );
    // The premise: each pill's own range would run into the next one's.
    expect(300).toBeLessThan(KEYCAP_LEAD_MS + KEYCAP_HOLD_MS);
    const { keycaps } = planKeyMarks(
      actions,
      actions.map((a, i) => ({ actionId: a.id, outputMs: 1000 + 300 * i })),
      REPLAY,
    );
    expect(keycaps.map((p) => p.range)).toEqual([
      { startMs: 850, endMs: 1150 },
      { startMs: 1150, endMs: 1450 },
      { startMs: 1450, endMs: 1600 + KEYCAP_HOLD_MS },
    ]);
    expect(keycaps.map((p) => p.caps)).toEqual(
      Array(3).fill([{ glyph: "return" }]),
    );
  });

  it("a double-click is two ripples 140 apart and a ×2 tag", () => {
    const marks = planKeyMarks(
      [click("dbl", { clicks: 2 })],
      [{ actionId: "dbl", outputMs: 1000 }],
      REPLAY,
    );
    expect(marks.pulseOutputMs).toEqual([1000, 1000 + MULTI_CLICK_GAP_MS]);
    expect(marks.clickTags).toEqual([{ outputMs: 1000, count: 2 }]);
    expect(marks.keycaps).toEqual([]);
    expect(marks.rightClicks).toEqual([]);
  });

  it("a triple-click is three ripples and a ×3 tag", () => {
    const marks = planKeyMarks(
      [click("tri", { clicks: 3 })],
      [{ actionId: "tri", outputMs: 500 }],
      REPLAY,
    );
    expect(marks.pulseOutputMs).toEqual([500, 640, 780]);
    expect(marks.clickTags).toEqual([{ outputMs: 500, count: 3 }]);
  });

  it("a right-click has no ripple and one mouse mark", () => {
    const marks = planKeyMarks(
      [click("ctx", { button: "right" })],
      [{ actionId: "ctx", outputMs: 2000 }],
      REPLAY,
    );
    expect(marks.pulseOutputMs).toEqual([]);
    expect(marks.rightClicks).toEqual([2000]);
    expect(marks.clickTags).toEqual([]);
  });

  it("a captured right-click keeps its ripple and draws no mouse", () => {
    const marks = planKeyMarks(
      [click("ctx", { button: "right" })],
      [{ actionId: "ctx", outputMs: 2000 }],
      new Set(["click"]),
    );
    expect(marks.pulseOutputMs).toEqual([2000]);
    expect(marks.rightClicks).toEqual([]);
  });

  it("a Shift-click has its ripple and a pill reading ⇧ + click", () => {
    const marks = planKeyMarks(
      [click("sh", { modifiers: ["Shift"] })],
      [{ actionId: "sh", outputMs: 3000 }],
      REPLAY,
    );
    expect(marks.pulseOutputMs).toEqual([3000]);
    expect(marks.keycaps).toEqual([
      {
        range: { startMs: 3000 - KEYCAP_LEAD_MS, endMs: 3000 + KEYCAP_HOLD_MS },
        caps: [{ glyph: "shift" }],
        suffix: "+ click",
      },
    ]);
  });

  it("orders modifiers as a Mac does and names keys as its keyboard prints them", () => {
    expect(capsOf(["Mod", "Shift", "Ctrl", "Alt"], "Escape")).toEqual([
      { glyph: "control" },
      { glyph: "option" },
      { glyph: "shift" },
      { glyph: "command" },
      { text: "esc" },
    ]);
    expect(capsOf([], "PageDown")).toEqual([{ text: "Page Down" }]);
    expect(capsOf([], "Delete")).toEqual([{ glyph: "delete" }]);
    expect(capsOf([], "ArrowLeft")).toEqual([{ text: "←" }]);
  });
});

describe("needsTextFont", () => {
  const scene = readonlyScene();
  const plus = (a: Action) =>
    ({ ...scene, actions: [...scene.actions, a] }) as SceneDocument;

  it("is false for the fixture scene, and for a right-click alone", () => {
    expect(needsTextFont(scene)).toBe(false);
    expect(needsTextFont(plus(click("ctx", { button: "right" })))).toBe(false);
    expect(needsTextFont(plus(press("p", { key: "Enter" })))).toBe(false);
  });

  it("is true for each field that draws text", () => {
    expect(needsTextFont(plus(press("p", { key: "K", modifiers: [] })))).toBe(
      true,
    );
    expect(needsTextFont(plus(click("d", { clicks: 2 })))).toBe(true);
    expect(needsTextFont(plus(click("s", { modifiers: ["Shift"] })))).toBe(
      true,
    );
    expect(
      needsTextFont(
        plus(
          click("c", {
            dialogs: [
              {
                kind: "alert",
                host: "h",
                message: "m",
                answer: "accept",
                by: "default",
                beatMs: 1500,
              },
            ],
          }),
        ),
      ),
    ).toBe(true);
  });
});
