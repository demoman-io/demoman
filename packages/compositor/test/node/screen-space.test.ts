import { describe, expect, it } from "vitest";
import { inScreenSpace, transformAt } from "../../src/plan/screen-space";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

// The measured iPhone case (probe:tap-space): a page with no meta viewport
// lays out 980 wide at scale 0.401, and client (300, 600) paints at
// (120, 241) of the 393-wide screen.
const ZOOMED = { scale: 393 / 980, offsetX: 0, offsetY: 0 };

describe("transformAt", () => {
  const list = [
    { sourceTimeMs: 100, ...ZOOMED },
    { sourceTimeMs: 500, scale: 1, offsetX: 0, offsetY: 0 },
  ];
  it("answers the record in force at an instant", () => {
    expect(transformAt(list, 300)?.scale).toBeCloseTo(ZOOMED.scale, 6);
    expect(transformAt(list, 500)?.scale).toBe(1);
  });
  it("answers the first record before the first record", () => {
    expect(transformAt(list, 0)?.scale).toBeCloseTo(ZOOMED.scale, 6);
  });
  it("answers null with no records", () => {
    expect(transformAt([], 0)).toBeNull();
  });
});

describe("inScreenSpace", () => {
  const plain = readonlyScene();
  const base = proceduralBundle();
  const marker = base.markers[0];
  if (!marker) throw new Error("the procedural bundle has no marker");
  const anchor = plain.anchors[0];
  if (!anchor?.fingerprint.boundingRect) {
    throw new Error("the fixture scene's first anchor has no rect");
  }
  // The fixture's actions carry no rect of their own; give the marked one
  // a rect, so the scene's action rects are exercised too.
  const ACTION_RECT = { x: 300, y: 600, width: 98, height: 49 };
  const scene = {
    ...plain,
    actions: plain.actions.map((a) =>
      a.id === marker.actionId ? { ...a, rect: ACTION_RECT } : a,
    ),
  } as typeof plain;
  const zoomed = {
    ...base,
    viewportTransforms: [{ sourceTimeMs: 0, ...ZOOMED }],
    cursorSamples: [{ sourceTimeMs: 10, x: 300, y: 600 }],
    anchorRects: [
      { actionId: marker.actionId, anchorId: anchor.id, rect: ACTION_RECT },
    ],
  };

  it("draws a client point where the zoomed-out page painted it", () => {
    const { bundle } = inScreenSpace(zoomed, scene);
    expect(bundle.cursorSamples[0]?.x).toBeCloseTo(120.3, 1);
    expect(bundle.cursorSamples[0]?.y).toBeCloseTo(240.6, 1);
  });

  it("scales a rect's position and size", () => {
    const rect = inScreenSpace(zoomed, scene).bundle.anchorRects[0]?.rect;
    expect(rect?.x).toBeCloseTo(120.3, 1);
    expect(rect?.width).toBeCloseTo(39.3, 1);
  });

  it("converts the scene's action and fingerprint rects too", () => {
    const out = inScreenSpace(zoomed, scene).scene;
    const action = out.actions.find((a) => a.id === marker.actionId);
    expect(action && "rect" in action ? action.rect?.width : null).toBeCloseTo(
      ACTION_RECT.width * ZOOMED.scale,
      6,
    );
    const fp = out.anchors.find((a) => a.id === anchor.id)?.fingerprint;
    expect(fp?.boundingRect?.width).toBeCloseTo(
      (anchor.fingerprint.boundingRect?.width ?? 0) * ZOOMED.scale,
      6,
    );
  });

  it("subtracts the visual viewport's offset before scaling", () => {
    const pinched = {
      ...zoomed,
      viewportTransforms: [
        { sourceTimeMs: 0, scale: 2, offsetX: 100, offsetY: 50 },
      ],
    };
    const s = inScreenSpace(pinched, scene).bundle.cursorSamples[0];
    expect(s).toMatchObject({ x: 400, y: 1100 });
  });

  it("uses the transform in force at each sample", () => {
    const mixed = {
      ...zoomed,
      viewportTransforms: [
        { sourceTimeMs: 0, scale: 1, offsetX: 0, offsetY: 0 },
        { sourceTimeMs: 50, ...ZOOMED },
      ],
      cursorSamples: [
        { sourceTimeMs: 10, x: 300, y: 600 },
        { sourceTimeMs: 60, x: 300, y: 600 },
      ],
    };
    const [a, b] = inScreenSpace(mixed, scene).bundle.cursorSamples;
    expect(a?.x).toBe(300);
    expect(b?.x).toBeCloseTo(120.3, 1);
  });

  it("is a no-op on its own output", () => {
    const once = inScreenSpace(zoomed, scene);
    const twice = inScreenSpace(once.bundle, once.scene);
    expect(twice.bundle.cursorSamples).toEqual(once.bundle.cursorSamples);
    expect(twice.scene).toEqual(once.scene);
    expect(twice.bundle.viewportTransforms ?? []).toEqual([]);
  });

  it("leaves a bundle with no transforms as it is", () => {
    const { bundle, scene: out } = inScreenSpace(base, scene);
    expect(bundle.cursorSamples).toEqual(base.cursorSamples);
    expect(bundle.anchorRects).toEqual(base.anchorRects);
    expect(out).toBe(scene);
  });
});
