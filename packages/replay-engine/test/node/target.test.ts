import type { SceneAnchor } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { fingerprintFromTarget, targetFromFingerprint } from "../../src/target";

const fp = (
  over: Partial<SceneAnchor["fingerprint"]>,
): SceneAnchor["fingerprint"] => ({
  stableId: null,
  role: null,
  accessibleName: null,
  textContent: null,
  treePath: null,
  boundingRect: null,
  imagePatchRef: null,
  dataKey: null,
  ...over,
});

describe("a captured fingerprint as a script target, and back", () => {
  // Red if a strategy reads the wrong field, or if the round trip does not
  // close: the snapshot would list a target whose fingerprint the run builds
  // differently from the one the snapshot checked.
  it("names the one field the strategy resolved by, and fingerprintFromTarget sets exactly that field", () => {
    const full = fp({
      stableId: "checkout-btn",
      role: "button",
      accessibleName: "Checkout",
      textContent: "Check out now",
      treePath: "body:1/button:1",
    });
    // Premise: every field holds a different value, so a strategy that reads
    // another strategy's field answers something visibly wrong. With name and
    // text both "Checkout", a roleName that read textContent passed.
    const values = [
      full.stableId,
      full.accessibleName,
      full.textContent,
      full.treePath,
    ];
    expect(new Set(values).size).toBe(values.length);
    const cases = [
      ["stableId", { stableId: "checkout-btn" }],
      ["roleName", { role: "button", name: "Checkout" }],
      ["text", { text: "Check out now" }],
      ["treePath", { treePath: "body:1/button:1" }],
    ] as const;
    for (const [strategy, target] of cases) {
      expect(targetFromFingerprint(strategy, full)).toEqual(target);
      const back = fingerprintFromTarget(target);
      const set = Object.entries(back).filter(([, v]) => v !== null);
      // Exactly one strategy's fields, and nothing else: the run's intent.
      expect(set.length, `${strategy}: ${JSON.stringify(back)}`).toBe(
        strategy === "roleName" ? 2 : 1,
      );
    }
  });

  // Red if a failed or tie-broken capture is turned into a target: the
  // snapshot would list an element the run cannot name.
  it("answers null for ambiguous, broken and image-patch strategies, and for a strategy whose field is empty", () => {
    const full = fp({ role: "button", accessibleName: "Go" });
    expect(targetFromFingerprint("ambiguous", full)).toBeNull();
    expect(targetFromFingerprint("broken", full)).toBeNull();
    expect(targetFromFingerprint("imagePatch", full)).toBeNull();
    expect(targetFromFingerprint("text", full)).toBeNull();
    expect(
      targetFromFingerprint("roleName", fp({ role: "button" })),
    ).toBeNull();
  });
});
