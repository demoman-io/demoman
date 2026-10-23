import { CURSOR_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

describe("resolvePlan's cursorLook", () => {
  it("carries the scene's authored look through", () => {
    const scene = readonlyScene();
    const authored = {
      hidden: false,
      style: "touch" as const,
      scale: 1.5,
      motionBlur: 0.25,
      hideWhenIdle: true,
    };
    const resolved = resolvePlan(planScene(scene), proceduralBundle(), {
      ...scene,
      cursor: authored,
    });
    expect(resolved.cursorLook).toEqual(authored);
  });

  it("falls back to the defaults when the caller passes no scene at all", () => {
    // The compositor's `scene` parameter is optional, and a caller without
    // one must keep drawing the look every take drew before this feature.
    const resolved = resolvePlan(
      planScene(readonlyScene()),
      proceduralBundle(),
    );
    expect(resolved.cursorLook).toEqual(CURSOR_DEFAULTS);
  });
});
