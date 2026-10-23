import { describe, expect, it } from "vitest";
import { planCosmetics } from "../../src/plan/cosmetics";
import { sceneWithCosmetics } from "../fixtures/scene";

/**
 * These cases are about cosmetic planning, not about removed pieces: no step
 * is removed, so nothing is filtered and nothing is collected.
 * `plan-cuts.test.ts` owns what a removal does to a mask, and passing the
 * two arguments explicitly here — rather than giving `planCosmetics`
 * defaults — is what keeps a future caller from silently getting "nothing
 * removed" by forgetting them.
 */
const bindingsOf = (scene: Parameters<typeof planCosmetics>[0]) =>
  planCosmetics(scene, new Set<string>(), []);

describe("planCosmetics", () => {
  const bindings = bindingsOf(sceneWithCosmetics());

  it("binds masks, the one cosmetic left", () => {
    expect(bindings.map((b) => b.kind)).toEqual(["mask"]);
  });

  it("binds a mask to its own rect", () => {
    const mask = bindings.find((b) => b.id === "mask-1");
    expect(mask).toMatchObject({
      kind: "mask",
      rect: { x: 60, y: 380, width: 400, height: 24 },
    });
  });

  it("returns nothing for a scene with no cosmetics", () => {
    const scene = sceneWithCosmetics();
    expect(
      bindingsOf({
        ...scene,
        edits: { ...scene.edits, masks: [] },
      }),
    ).toEqual([]);
  });

  it("carries a mask's range and gives a whole-take mask range: null", () => {
    const scene = sceneWithCosmetics();
    const ranged = {
      ...scene,
      edits: {
        ...scene.edits,
        masks: [
          ...scene.edits.masks,
          {
            id: "mask-2",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            start: { actionId: "act-1", offsetMs: 0 },
            end: { actionId: "act-2", offsetMs: -100 },
          },
        ],
      },
    };
    const out = bindingsOf(ranged);
    expect(out.find((b) => b.id === "mask-1")?.range).toBeNull();
    expect(out.find((b) => b.id === "mask-2")?.range).toEqual({
      start: { actionId: "act-1", offsetMs: 0 },
      end: { actionId: "act-2", offsetMs: -100 },
    });
  });
});
