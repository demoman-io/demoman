import type { SceneAnchor } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { captureAnchor } from "../../src/capture";
import { resolveAll } from "../../src/resolve";
import { mount } from "../helpers/fixtures";

const ctx = {
  anchorId: "a-1",
  url: "https://app.example.com/orders",
  actionIndex: 0,
  entryState: true,
};

describe("resolveAll", () => {
  it("keeps each anchor's own report even when ids collide", async () => {
    const doc = mount(`<main>
      <button data-testid="one">One</button>
      <button data-testid="two">Two</button>
    </main>`);
    const elOne = doc.querySelector('[data-testid="one"]') as Element;
    const elTwo = doc.querySelector('[data-testid="two"]') as Element;
    const { anchor: anchorOne } = await captureAnchor(elOne, ctx, {
      root: doc,
    });
    const { anchor: anchorTwo } = await captureAnchor(elTwo, ctx, {
      root: doc,
    });
    // Schema-valid but adversarial: two anchors sharing an id, distinguished
    // only by their own fingerprints.
    const dupOne: SceneAnchor = { ...anchorOne, id: "dup" };
    const dupTwo: SceneAnchor = { ...anchorTwo, id: "dup" };

    const reports = await resolveAll([dupOne, dupTwo], { root: doc });
    expect(reports).toHaveLength(2);
    expect(reports[0]?.element).toBe(elOne);
    expect(reports[1]?.element).toBe(elTwo);
  });

  it("does not let one malformed treePath abort the whole batch", async () => {
    const doc = mount(`<main>
      <button data-testid="ok">OK</button>
    </main>`);
    const el = doc.querySelector('[data-testid="ok"]') as Element;
    const { anchor: goodAnchor } = await captureAnchor(el, ctx, { root: doc });

    const badAnchor: SceneAnchor = {
      id: "bad",
      fingerprint: {
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: "not-a-valid-tree-path!!!",
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "broken",
        failureReason: null,
        candidates: 0,
      },
    };

    const reports = await resolveAll([badAnchor, goodAnchor], { root: doc });
    expect(reports).toHaveLength(2);
    expect(reports[0]?.strategy).toBe("broken");
    expect(reports[1]?.element).toBe(el);
  });
});
