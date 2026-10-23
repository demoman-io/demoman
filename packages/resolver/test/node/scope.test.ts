import { describe, expect, it } from "vitest";
import { captureAnchor } from "../../src/capture";
import { resolveAnchor } from "../../src/resolve";
import { findDataKeyRow, readDataKey } from "../../src/scope";
import { loadPair, mount } from "../helpers/fixtures";

const ctx = {
  anchorId: "a-row",
  url: "https://app.example.com/orders",
  actionIndex: 0,
  entryState: true,
};

const captured = async () => {
  const doc = mount(loadPair("virtual-list").before);
  const el = doc.querySelector(`[data-row-key="order-1002"] button`) as Element;
  return (await captureAnchor(el, ctx, { root: doc })).anchor;
};

describe("findDataKeyRow", () => {
  it("finds the row container by its key", () => {
    const doc = mount(loadPair("virtual-list").before);
    expect(
      findDataKeyRow(doc, "order-1002")?.getAttribute("data-row-key"),
    ).toBe("order-1002");
  });

  it("returns null when the key is not in the tree", () => {
    const doc = mount(loadPair("virtual-list").after);
    expect(findDataKeyRow(doc, "order-1002")).toBeNull();
  });
});

describe("data-key scoping", () => {
  it("captures the row's data key rather than its position", async () => {
    const anchor = await captured();
    expect(anchor.fingerprint.dataKey).toBe("order-1002");
  });

  it("resolves inside the right row when the list re-orders", async () => {
    const anchor = await captured();
    const doc = mount(loadPair("virtual-list").before);
    // Move the target row to the front; the anchor must follow the data, not the slot.
    const grid = doc.querySelector("[role=grid]") as Element;
    const row = doc.querySelector(`[data-row-key="order-1002"]`) as Element;
    grid.insertBefore(row, grid.firstElementChild);

    const report = await resolveAnchor(anchor, { root: doc });
    expect(report.strategy).toBe("stableId");
    expect(
      report.element?.closest("[data-row-key]")?.getAttribute("data-row-key"),
    ).toBe("order-1002");
  });

  // The distinction SP8 depends on: a scrolled-away row is not a broken demo.
  it("reports notInTree, not plain breakage, when the row is scrolled away", async () => {
    const anchor = await captured();
    const report = await resolveAnchor(anchor, {
      root: mount(loadPair("virtual-list").after),
    });
    expect(report.strategy).toBe("broken");
    expect(report.failureReason).toBe("notInTree");
    expect(report.element).toBeNull();
  });
});

describe("treePath tier under data-key scope", () => {
  // Strips every signal but treePath + dataKey, isolating the last-rung tier
  // this fix restores. Returns the live doc/el alongside the stripped anchor
  // so tests can assert on identity, not just strategy.
  const strippedAnchor = async () => {
    const doc = mount(loadPair("virtual-list").before);
    const el = doc.querySelector(
      `[data-row-key="order-1002"] button`,
    ) as Element;
    const { anchor } = await captureAnchor(el, ctx, { root: doc });
    const stripped = {
      ...anchor,
      fingerprint: {
        ...anchor.fingerprint,
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: null,
      },
    };
    return { doc, el, anchor: stripped };
  };

  it("resolves via treePath when it is the only usable signal left", async () => {
    const { doc, el, anchor } = await strippedAnchor();
    const report = await resolveAnchor(anchor, { root: doc });
    expect(report.strategy).toBe("treePath");
    expect(report.element).toBe(el);
  });

  it("withholds a positional false match when the row has moved", async () => {
    const { doc, anchor } = await strippedAnchor();
    const grid = doc.querySelector("[role=grid]") as Element;
    const row = doc.querySelector(`[data-row-key="order-1002"]`) as Element;
    grid.insertBefore(row, grid.firstElementChild);

    const report = await resolveAnchor(anchor, { root: doc });
    // The document-rooted path now points at whatever sits in the old slot
    // (order-1001's row) -- outside the order-1002 row the data key selected,
    // so the treePath tier withholds it rather than returning a false
    // positional match. Every other tier was stripped, so with nothing left
    // to try, "broken" (not a wrong element) is the correct outcome.
    expect(report.strategy).toBe("broken");
    expect(report.element).toBeNull();
  });
});

describe("readDataKey ancestor walk", () => {
  // Pins current behaviour: the walk has no stopping boundary, so an element
  // with no key of its own inherits a distant ancestor's data key. This is
  // documented as-is, not changed — see task-9 report for discussion.
  it("picks up a data key from a far-off ancestor wrapper when nothing closer has one", () => {
    const doc = mount(`
      <main data-id="page-wrapper">
        <div role="grid">
          <div role="row">
            <span><button data-testid="row-action">Cancel</button></span>
          </div>
        </div>
      </main>
    `);
    const el = doc.querySelector("button") as Element;
    expect(readDataKey(el)).toBe("page-wrapper");
  });
});
