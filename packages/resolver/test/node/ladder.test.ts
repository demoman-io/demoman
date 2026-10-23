import type { SceneAnchor } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { computeName, computeRole } from "../../src/accessibility";
import { readStableId } from "../../src/identifiers";
import { runLadder } from "../../src/ladder";
import { normalizeText } from "../../src/text";
import { buildTreePath, serializeTreePath } from "../../src/treepath";
import { loadPair, mount } from "../helpers/fixtures";

/** Hand-build the anchor a real capture would produce for `selector` in `doc`. */
function anchorFor(doc: Document, selector: string, id = "a-1"): SceneAnchor {
  const el = doc.querySelector(selector);
  if (el === null) throw new Error(`no element for ${selector}`);
  return {
    id,
    fingerprint: {
      stableId: readStableId(el),
      role: computeRole(el),
      accessibleName: computeName(el),
      textContent: normalizeText(el.textContent),
      treePath: serializeTreePath(buildTreePath(el, doc)),
      boundingRect: null,
      imagePatchRef: null,
      dataKey: null,
    },
    resolution: {
      url: "https://app.example.com/orders",
      actionIndex: 0,
      entryState: true,
      strategy: "stableId",
      failureReason: null,
      candidates: 1,
    },
  };
}

const resolveAgainst = (pair: string, selector: string) => {
  const { before, after } = loadPair(pair);
  const beforeDoc = mount(before);
  const afterDoc = mount(after);
  const anchor = anchorFor(beforeDoc, selector);
  return { report: runLadder(anchor, afterDoc, { root: afterDoc }), afterDoc };
};

describe("resolution ladder", () => {
  it("reports stableId when the identifier survives a framework re-hash", () => {
    const { report } = resolveAgainst("baseline", "[data-testid=checkout-btn]");
    expect(report.strategy).toBe("stableId");
    expect(report.candidates).toBe(1);
    expect(report.failureReason).toBeNull();
  });

  it("falls to roleName when the stable ID is removed", () => {
    const { report } = resolveAgainst(
      "id-removed",
      "[data-testid=checkout-btn]",
    );
    expect(report.strategy).toBe("roleName");
    expect(report.element?.tagName).toBe("BUTTON");
  });

  it("falls to treePath when the copy also changed", () => {
    const { report } = resolveAgainst("copy-changed", "[data-testid=pay]");
    expect(report.strategy).toBe("treePath");
  });

  it("uses corroboration to pick the right one of three duplicate IDs", () => {
    const { report } = resolveAgainst(
      "duplicate-ids",
      "div:nth-of-type(2) button",
    );
    expect(report.strategy).toBe("stableId");
    expect(report.candidates).toBe(3);
    expect(report.element?.textContent).toBe("Cancel order");
  });

  it("reports ambiguous when nothing can break the tie", () => {
    const doc = mount(
      `<main><div><button data-testid="row-action">Cancel order</button></div>` +
        `<div><button data-testid="row-action">Cancel order</button></div></main>`,
    );
    const anchor = anchorFor(doc, "button");
    anchor.fingerprint.treePath = null; // the one signal that still separated them
    const report = runLadder(anchor, doc, { root: doc });
    expect(report.strategy).toBe("ambiguous");
    expect(report.failureReason).toBe("ambiguousTie");
    expect(report.candidates).toBe(2);
  });

  it("survives a portal: the modal moved to body, roleName still holds", () => {
    const { report } = resolveAgainst("portal-modal", "[role=dialog] button");
    expect(report.strategy).toBe("roleName");
    expect(report.element?.textContent).toBe("Confirm");
  });

  it("reports broken when the element is gone entirely", () => {
    const { report } = resolveAgainst("deleted", "[data-testid=legacy-export]");
    expect(report.strategy).toBe("broken");
    expect(report.element).toBeNull();
    expect(report.candidates).toBe(0);
  });

  it("records how long resolution took", () => {
    const { report } = resolveAgainst("baseline", "[data-testid=checkout-btn]");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("the text tier", () => {
  /** What an authored `{ "text": … }` step hands the ladder: text, and nothing else. */
  const textOnly = (text: string): SceneAnchor => ({
    id: "a-text",
    fingerprint: {
      stableId: null,
      role: null,
      accessibleName: null,
      textContent: text,
      treePath: null,
      boundingRect: null,
      imagePatchRef: null,
      dataKey: null,
    },
    resolution: {
      url: "https://app.example.com/",
      actionIndex: 0,
      entryState: true,
      strategy: "text",
      failureReason: null,
      candidates: 1,
    },
  });

  // KitchenLink's FAQ, as Phoenix renders it (2026-10-01, M2): the question is
  // a bare text node beside an icon span with no text of its own, and the
  // summary has no role and no id — the text tier is the only one that can
  // reach it.
  const faq =
    `<main><details><summary class="flex">\n  How do customers pay me?\n  ` +
    `<!-- @caller home_live.ex:340 --><span class="lucide-chevron-down"></span>` +
    `<!-- </icon> -->\n</summary><p>Through Stripe.</p></details></main>`;

  it("matches text that sits beside an icon with no text of its own", () => {
    const doc = mount(faq);
    const summary = doc.querySelector("summary") as Element;
    // Premise: the summary is NOT a childless leaf — the icon is an element
    // child — and nothing above the text tier can name it.
    expect(summary.children.length).toBe(1);
    expect(computeRole(summary)).toBeNull();
    expect(readStableId(summary)).toBeNull();

    const report = runLadder(textOnly("How do customers pay me?"), doc, {
      root: doc,
    });
    expect(report.strategy).toBe("text");
    expect(report.candidates).toBe(1);
    expect(report.element).toBe(summary);
  });

  it("still resolves a container's text to the child that carries it", () => {
    const doc = mount(
      `<main><div class="card"><button type="button">Save draft</button></div></main>`,
    );
    // Premise: the container's textContent is exactly the child's, so only the
    // leaf rule keeps the container out.
    expect(normalizeText(doc.querySelector(".card")?.textContent)).toBe(
      "Save draft",
    );

    const report = runLadder(textOnly("Save draft"), doc, { root: doc });
    expect(report.strategy).toBe("text");
    expect(report.candidates).toBe(1);
    expect(report.element?.tagName).toBe("BUTTON");
  });
});
