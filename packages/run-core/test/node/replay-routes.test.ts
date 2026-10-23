import { describe, expect, it } from "vitest";
import {
  mutatingScene,
  readonlyScene,
} from "../../../replay-engine/test/helpers/scenes";
import { frozenRoutes, tierOf } from "../../src/index.js";

/**
 * `tierOf` and `frozenRoutes`, at the agent door where they are read
 * (`RunReport.refused.routes`). Moved verbatim from
 * `editor-capability.test.ts` on 2026-09-28 (plan 2, Task 7), when
 * `src/editor/capability.ts` was deleted and `tierOf` followed
 * `frozenRoutes` into `src/core/replay/routes.ts`.
 */

const ALLOWED = { mayReplay: true, writes: [] };
const REFUSED = { mayReplay: false, writes: [] };

describe("tierOf", () => {
  it("takes its tier entirely from the policy, not from the scene's own flag", () => {
    // `tierOf` used to read `scene.flags.mutating` directly; now the same
    // scene lands on either tier depending only on `policy.mayReplay`. A
    // readonly scene and a mutating scene are exercised identically to pin
    // that `scene` no longer decides anything here.
    expect(tierOf(readonlyScene(), ALLOWED)).toBe("regenerating");
    expect(tierOf(readonlyScene(), REFUSED)).toBe("frozen");
    expect(tierOf(mutatingScene(), ALLOWED)).toBe("regenerating");
    expect(tierOf(mutatingScene(), REFUSED)).toBe("frozen");
  });

  it("gives a mutating scene the regenerating tier when replay is allowed", () => {
    const base = readonlyScene();
    const mutating = { ...base, flags: { ...base.flags, mutating: true } };
    expect(tierOf(mutating, ALLOWED)).toBe("regenerating");
    expect(tierOf(mutating, REFUSED)).toBe("frozen");
  });
});

describe("frozenRoutes", () => {
  // Three, not four: "Use a replacement overlay" could never land from a
  // take-wide list (it had no anchor to carry) and moved onto the retext
  // line it belongs to — plan 3's final review, I5.
  it("offers the three take-wide routes, in the recommended-first order, when the policy refuses a rebuild", () => {
    expect(frozenRoutes(readonlyScene(), REFUSED).map((r) => r.kind)).toEqual([
      "enableMutatingReplay",
      "reRecord",
      "safeEnvironment",
    ]);
  });

  it("offers nothing when the policy allows a rebuild", () => {
    expect(frozenRoutes(readonlyScene(), ALLOWED)).toEqual([]);
  });
});

describe("frozenRoutes at the door", () => {
  // A refused run at the agent door never assembled a take, so there is no
  // scene to pass (`tierOf`'s docblock answers the null).
  it("offers the same three routes with no scene at all", () => {
    expect(frozenRoutes(null, REFUSED).map((r) => r.kind)).toEqual([
      "enableMutatingReplay",
      "reRecord",
      "safeEnvironment",
    ]);
    expect(frozenRoutes(null, ALLOWED)).toEqual([]);
  });
});
