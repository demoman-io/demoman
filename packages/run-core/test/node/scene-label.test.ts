import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { sceneLabel } from "../../src/scene-label.js";

const meta = (
  name: string,
  originUrl: string,
  createdAt = "2026-09-22T18:03:11Z",
) => ({ name, createdAt, capture: { originUrl } }) as SceneDocument["meta"];

describe("sceneLabel", () => {
  it("is the name when there is one", () => {
    expect(sceneLabel(meta("Checkout", "https://a.test/b"))).toBe("Checkout");
  });

  it("is host and path for an untitled take, the root's path dropped", () => {
    expect(sceneLabel(meta("", "http://localhost:4000/checkout?x=1#y"))).toBe(
      "localhost:4000/checkout",
    );
    expect(sceneLabel(meta("", "https://a.test/"))).toBe("a.test");
  });
});
