import { describe, expect, it } from "vitest";
import { resolveAnchor } from "../../src/resolve.js";
import { mount } from "../helpers/fixtures.js";

describe("resolveAnchor from an intent", () => {
  // The whole point: an authored step has a fingerprint and NO resolution,
  // because no resolution has happened yet. Passing an object that lacks the
  // field entirely — not one with a stub in it — is what makes this test able
  // to fail: the moment any code reads `.resolution`, this throws or returns
  // broken rather than resolving.
  it("resolves an anchor that carries no resolution field at all", async () => {
    const doc = mount(`<button id="pay" type="button">Pay now</button>`);
    // Premise: the element the intent names is actually in this fixture.
    expect(doc.querySelector("#pay")).not.toBeNull();

    const intent = {
      id: "a-pay",
      fingerprint: {
        stableId: null,
        role: "button",
        accessibleName: "Pay now",
        textContent: null,
        treePath: null,
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
    };

    const report = await resolveAnchor(intent, { root: doc });
    expect(report.strategy).toBe("roleName");
    expect(report.failureReason).toBeNull();
    expect("resolution" in intent).toBe(false);
  });
});
