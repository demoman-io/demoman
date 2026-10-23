import { describe, expect, it } from "vitest";
import { buildCaptureBundle } from "../../src/index.js";
import { scene } from "../helpers/replay-scene";

describe("buildCaptureBundle, anchor rects", () => {
  it("emits one entry per action that carried a rect", () => {
    const base = scene();
    const withRects = {
      ...base,
      actions: base.actions.map((action, i) => ({
        ...action,
        rect: { x: 0, y: i * 100, width: 40, height: 20 },
      })),
    };

    const bundle = buildCaptureBundle(withRects, [
      {
        sourceTimeMs: 0,
        ref: "kf:s:0",
        width: 1280,
        height: 800,
        byteLength: 0,
      },
    ]);

    const firstAction = withRects.actions[0];
    expect(bundle.anchorRects).toHaveLength(withRects.actions.length);
    const first = bundle.anchorRects[0];
    expect(first).toBeDefined();
    if (firstAction && first) {
      expect(first).toEqual({
        actionId: firstAction.id,
        anchorId: firstAction.anchorId,
        rect: { x: 0, y: 0, width: 40, height: 20 },
      });
    }
  });

  it("omits actions with no rect rather than inventing one", () => {
    const base = scene();
    const bundle = buildCaptureBundle(base, [
      {
        sourceTimeMs: 0,
        ref: "kf:s:0",
        width: 1280,
        height: 800,
        byteLength: 0,
      },
    ]);
    // The fixture's actions carry no rect. An entry here would put every
    // effect at the origin; absence sends `plan/resolve.ts` to the
    // fingerprint rect, which is the truth for a frame no replay produced.
    expect(bundle.anchorRects).toEqual([]);
  });

  it("omits actions with no anchor", () => {
    const base = scene();
    const withNullAnchor = {
      ...base,
      actions: [
        {
          ...base.actions[0],
          kind: "waitFor" as const,
          anchorId: null,
          rect: { x: 1, y: 2, width: 3, height: 4 },
        },
      ],
    };
    const bundle = buildCaptureBundle(withNullAnchor as never, [
      {
        sourceTimeMs: 0,
        ref: "kf:s:0",
        width: 1280,
        height: 800,
        byteLength: 0,
      },
    ]);
    // A navigation wait names no element. An `anchorId: null` entry would
    // fail AnchorRectSchema's `min(1)` and take the whole bundle with it.
    expect(bundle.anchorRects).toEqual([]);
  });
});
