import { describe, expect, it } from "vitest";
import {
  findByStableId,
  isAuthoredIdentifier,
  readStableId,
} from "../../src/identifiers";
import { mount } from "../helpers/fixtures";

describe("isAuthoredIdentifier", () => {
  it.each([
    "checkout-btn",
    "search",
    "order_row",
    "submitPayment",
    "20260825",
    "10293847",
    "_sidebar_toggle",
    "_order_status",
    "css-button",
    "css-modal",
    "toolbar-rectangle",
    "pay2",
    "openUserSettingsDialogFromHeaderMenu",
    "invoiceRow-INV-2026-0042",
    "submitPaymentButtonPrimaryV2",
    "user-123-profile-456-edit",
  ])("accepts the authored identifier %s", (value) => {
    expect(isAuthoredIdentifier(value)).toBe(true);
  });

  // The five patterns v8 §4 enumerates, plus the empty case.
  it.each([
    ["_button_a1b2c", "CSS Modules"],
    ["css-1x2y3z", "styled-components / Emotion"],
    ["data-v-7ba5bd90", "Vue scoped styles"],
    ["_ngcontent-abc-123", "Angular"],
    [":r1:", "React useId"],
    ["", "empty"],
    ["_grid_row_x1y2z", "CSS Modules with digits in tail"],
    ["«r1»", "React 19.0 useId"],
    ["_r_2_", "React 19.1 useId"],
    // Seen on Actual Budget and Excalidraw, a different value on every load.
    ["react-aria544548995-_r_2_", "react-aria around a React useId"],
    ["hoAsHkNPh68XUqrK1u8gY-shapes-title", "a nanoid prefix"],
    // Its `-_-` splits the key and its suffix is long: a whole-value ratio passed it.
    [
      "zuJE2PSMV8je74tm-_-6H-selectedShapeActions-title",
      "a nanoid before a long suffix",
    ],
  ])("rejects %s (%s)", (value) => {
    expect(isAuthoredIdentifier(value)).toBe(false);
  });

  it("rejects a bare hash even when it is long", () => {
    expect(isAuthoredIdentifier("a1b2c3d4e5")).toBe(false);
  });
});

describe("readStableId", () => {
  it("prefers data-testid over a bare id", () => {
    const doc = mount(`<button id="x" data-testid="checkout-btn">Go</button>`);
    expect(readStableId(doc.querySelector("button") as Element)).toBe(
      "checkout-btn",
    );
  });

  it("falls back to an authored id attribute", () => {
    const doc = mount(`<button id="checkout-btn">Go</button>`);
    expect(readStableId(doc.querySelector("button") as Element)).toBe(
      "checkout-btn",
    );
  });

  it("ignores a framework-generated id attribute", () => {
    const doc = mount(`<button id=":r1:">Go</button>`);
    expect(readStableId(doc.querySelector("button") as Element)).toBeNull();
  });

  it("falls through a generated data-testid to find an authored id", () => {
    const doc = mount(
      `<button data-testid=":r1:" id="checkout-btn">Go</button>`,
    );
    expect(readStableId(doc.querySelector("button") as Element)).toBe(
      "checkout-btn",
    );
  });
});

describe("findByStableId", () => {
  it("finds every element carrying the value under any recognised attribute", () => {
    const doc = mount(
      `<button data-testid="go">A</button><a data-cy="go">B</a><i id="go">C</i>`,
    );
    expect(findByStableId(doc, "go")).toHaveLength(3);
  });
});
