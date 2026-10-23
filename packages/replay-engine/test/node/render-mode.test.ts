import { describe, expect, it } from "vitest";
import { renderModeOf } from "../../src/index.js";
import { scene } from "../helpers/replay-scene";

describe("renderModeOf", () => {
  it("reads a scene written before the field as demo", () => {
    const base = scene();
    const legacy = { ...base, meta: { ...base.meta } };
    delete (legacy.meta as { renderMode?: unknown }).renderMode;

    // Not a default. Those takes were made under a regime where Stop always
    // replayed, and they have the replay bundle on disk to prove it.
    expect(renderModeOf(legacy)).toBe("demo");
  });

  it("reads an explicit screen scene as screen", () => {
    const base = scene();
    const screen = {
      ...base,
      meta: { ...base.meta, renderMode: "screen" as const },
    };
    expect(renderModeOf(screen)).toBe("screen");
  });

  it("reads an explicit demo scene as demo", () => {
    const base = scene();
    const demo = {
      ...base,
      meta: { ...base.meta, renderMode: "demo" as const },
    };
    expect(renderModeOf(demo)).toBe("demo");
  });
});
