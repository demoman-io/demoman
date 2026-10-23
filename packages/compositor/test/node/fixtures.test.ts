import { SceneDocumentSchema } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  mutatingScene,
  readonlyScene,
  sceneWithCamera,
  sceneWithCosmetics,
  sceneWithNavigationWait,
} from "../fixtures/scene";

describe("scene fixtures", () => {
  // If a fixture drifts out of schema, every planning test built on it is
  // testing fiction. Validate at the source.
  it.each([
    ["readonly", readonlyScene],
    ["mutating", mutatingScene],
    ["camera", sceneWithCamera],
    ["cosmetics", sceneWithCosmetics],
    ["navigation wait", sceneWithNavigationWait],
  ])("%s validates against the current schema", (_name, build) => {
    expect(() => SceneDocumentSchema.parse(build())).not.toThrow();
  });

  it("gives the read-only scene a click, a type and a scroll", () => {
    const kinds = readonlyScene().actions.map((a) => a.kind);
    expect(kinds).toContain("click");
    expect(kinds).toContain("type");
    expect(kinds).toContain("scrollTo");
  });

  it("marks the mutating scene mutating and hover-sensitive", () => {
    expect(mutatingScene().flags.mutating).toBe(true);
    expect(mutatingScene().flags.hoverSensitive).toBe(true);
  });
});
