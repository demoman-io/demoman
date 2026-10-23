import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { resolvePlan, sampleCursor } from "../../src/plan/resolve";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

/** Spec 2026-10-10 §5: a phone take draws a fingertip at each tap. */
const IPHONE = {
  preset: "phone" as const,
  width: 393,
  height: 852,
  mobile: true,
  touch: true,
  userAgent: "Mozilla/5.0 (iPhone; test)",
};

function touchScene(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    meta: { ...scene.meta, capture: { ...scene.meta.capture, device: IPHONE } },
  };
}

describe("resolvePlan: taps", () => {
  // A replayed type taps its field to focus it, as a click does.
  it("lists one tap per click and type marker, standing where the pointer was", () => {
    const scene = touchScene();
    const bundle = proceduralBundle();
    const clicks = new Set(
      scene.actions
        .filter((a) => a.kind === "click" || a.kind === "type")
        .map((a) => a.id),
    );
    const markers = bundle.markers.filter((m) => clicks.has(m.actionId));
    // The premise: a replay, with a click and a type that have markers, and
    // pointer samples.
    expect(bundle.source).toBe("replay");
    const kinds = new Set(
      scene.actions
        .filter((a) => markers.some((m) => m.actionId === a.id))
        .map((a) => a.kind),
    );
    expect(kinds).toEqual(new Set(["click", "type"]));
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    expect(resolved.cursor.length).toBeGreaterThan(0);

    expect(resolved.touch).toBe(true);
    expect(resolved.taps).toHaveLength(markers.length);
    const sorted = [...markers].sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
    resolved.taps.forEach((tap, i) => {
      const marker = sorted[i];
      if (marker === undefined) throw new Error("unreachable");
      expect(tap.at).toEqual(
        sampleCursor(resolved.cursor, marker.sourceTimeMs),
      );
    });
    expect(resolved.taps.map((t) => t.outputMs)).toEqual(
      resolved.clickOutputMs,
    );
  });

  it("lists no taps for a desktop take", () => {
    const scene = readonlyScene();
    const resolved = resolvePlan(planScene(scene), proceduralBundle(), scene);
    expect(resolved.touch).toBe(false);
    expect(resolved.taps).toEqual([]);
  });
});
