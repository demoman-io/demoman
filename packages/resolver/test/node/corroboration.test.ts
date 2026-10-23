import { describe, expect, it } from "vitest";
import { breakTie, scoreCandidate } from "../../src/corroboration";
import { mount } from "../helpers/fixtures";

const fingerprint = {
  stableId: "row-action",
  role: "button",
  accessibleName: "Cancel order",
  textContent: "Cancel order",
  treePath: "body:1/main:1/div:2/button:1",
  boundingRect: { x: 100, y: 200, width: 80, height: 32 },
  imagePatchRef: null,
  dataKey: null,
};

describe("scoreCandidate", () => {
  it("reports agreement per signal", () => {
    const doc = mount(
      `<main><div><button>Other</button></div><div><button>Cancel order</button></div></main>`,
    );
    const target = doc.querySelectorAll("button")[1] as Element;
    const signals = scoreCandidate(target, fingerprint, doc);
    const agreed = new Set(
      signals.filter((s) => s.agreed).map((s) => s.signal),
    );
    expect(agreed.has("role")).toBe(true);
    expect(agreed.has("name")).toBe(true);
    expect(agreed.has("text")).toBe(true);
    expect(agreed.has("path")).toBe(true);
  });

  it("marks disagreement when the name changed", () => {
    const doc = mount(
      `<main><div></div><div><button>Keep order</button></div></main>`,
    );
    const target = doc.querySelector("button") as Element;
    const signals = scoreCandidate(target, fingerprint, doc);
    expect(signals.find((s) => s.signal === "name")?.agreed).toBe(false);
  });
});

describe("breakTie", () => {
  it("picks the candidate corroborated by the most signals", () => {
    const doc = mount(
      `<main><div><button data-testid="row-action">Keep order</button></div>` +
        `<div><button data-testid="row-action">Cancel order</button></div></main>`,
    );
    const candidates = Array.from(doc.querySelectorAll("button"));
    const { winner } = breakTie(candidates, fingerprint, doc);
    expect(winner?.textContent).toBe("Cancel order");
  });

  it("returns no winner when two candidates are indistinguishable", () => {
    const doc = mount(
      `<main><div><button data-testid="row-action">Cancel order</button></div>` +
        `<div><button data-testid="row-action">Cancel order</button></div></main>`,
    );
    const candidates = Array.from(doc.querySelectorAll("button"));
    // Without a tree path there is nothing left to separate them: both agree on
    // role, name and text, and neither agrees on the rect. A real tie.
    const ambiguous = { ...fingerprint, treePath: null };
    expect(breakTie(candidates, ambiguous, doc).winner).toBeNull();
  });

  it("returns the sole candidate untouched", () => {
    const doc = mount(`<main><div><button>Cancel order</button></div></main>`);
    const only = doc.querySelector("button") as Element;
    expect(breakTie([only], fingerprint, doc).winner).toBe(only);
  });
});
