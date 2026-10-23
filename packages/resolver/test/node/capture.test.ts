import { describe, expect, it } from "vitest";
import { captureAnchor } from "../../src/capture";
import { resolveAnchor } from "../../src/resolve";
import { loadPair, mount } from "../helpers/fixtures";

const ctx = {
  anchorId: "a-1",
  url: "https://app.example.com/orders",
  actionIndex: 0,
  entryState: true,
};

describe("captureAnchor", () => {
  it("fills every fingerprint field it can see", async () => {
    const doc = mount(loadPair("baseline").before);
    const el = doc.querySelector("[data-testid=checkout-btn]") as Element;
    const { anchor } = await captureAnchor(el, ctx, { root: doc });

    expect(anchor.fingerprint.stableId).toBe("checkout-btn");
    expect(anchor.fingerprint.role).toBe("button");
    expect(anchor.fingerprint.accessibleName).toBe("Checkout");
    expect(anchor.fingerprint.textContent).toBe("Checkout");
    expect(anchor.fingerprint.treePath).toBe(
      "body:1/main:1/section:1/button:1",
    );
    expect(anchor.fingerprint.imagePatchRef).toBeNull();
  });

  it("copies the capture context into the resolution state verbatim", async () => {
    const doc = mount(loadPair("baseline").before);
    const el = doc.querySelector("[data-testid=checkout-btn]") as Element;
    const { anchor } = await captureAnchor(
      el,
      { ...ctx, actionIndex: 4, entryState: false },
      { root: doc },
    );

    expect(anchor.resolution.url).toBe(ctx.url);
    expect(anchor.resolution.actionIndex).toBe(4);
    expect(anchor.resolution.entryState).toBe(false);
  });

  it("self-verifies, recording the strategy that matched at capture time", async () => {
    const doc = mount(loadPair("baseline").before);
    const el = doc.querySelector("[data-testid=checkout-btn]") as Element;
    const { anchor, report } = await captureAnchor(el, ctx, { root: doc });

    expect(report.element).toBe(el);
    expect(anchor.resolution.strategy).toBe("stableId");
    expect(anchor.resolution.strategy).toBe(report.strategy);
  });

  // The backbone invariant: whatever we captured, we can find again.
  it("round-trips every element in every fixture", async () => {
    for (const name of [
      "baseline",
      "id-removed",
      "copy-changed",
      "portal-modal",
      "deleted",
    ]) {
      const doc = mount(loadPair(name).before);
      for (const el of Array.from(doc.querySelectorAll("main *, body > div"))) {
        const { anchor, report } = await captureAnchor(el, ctx, { root: doc });
        expect(
          report.element,
          `${name}: ${anchor.fingerprint.treePath} resolved to the wrong element`,
        ).toBe(el);
      }
    }
  });
});

describe("resolveAnchor", () => {
  it("resolves against a drifted document", async () => {
    const { before, after } = loadPair("id-removed");
    const doc = mount(before);
    const el = doc.querySelector("[data-testid=checkout-btn]") as Element;
    const { anchor } = await captureAnchor(el, ctx, { root: doc });

    const afterDoc = mount(after);
    const report = await resolveAnchor(anchor, { root: afterDoc });
    expect(report.strategy).toBe("roleName");
  });
});

describe("captureAnchor's textContent", () => {
  it("records the text of an element whose only child is an icon", async () => {
    const doc = mount(
      `<main><details><summary>How do customers pay me?<span class="chevron"></span>` +
        `</summary><p>Through Stripe.</p></details></main>`,
    );
    const el = doc.querySelector("summary") as Element;
    // Premise: an element child, so a childless-only rule would record null.
    expect(el.children.length).toBe(1);

    const { anchor } = await captureAnchor(el, ctx, { root: doc });
    expect(anchor.fingerprint.textContent).toBe("How do customers pay me?");
  });

  it("records no text for a container whose text is its child's", async () => {
    const doc = mount(
      `<main><div class="card"><button>Save draft</button></div></main>`,
    );
    const el = doc.querySelector(".card") as Element;
    // Premise: the container's own textContent is non-empty.
    expect(el.textContent).toBe("Save draft");

    const { anchor } = await captureAnchor(el, ctx, { root: doc });
    expect(anchor.fingerprint.textContent).toBeNull();
  });
});
