import { describe, expect, it } from "vitest";
import { computeName, computeRole } from "../../src/accessibility";

const el = (html: string): Element => {
  document.body.innerHTML = html;
  const found = document.body.firstElementChild;
  if (found === null) throw new Error("fixture produced no element");
  return found;
};

describe("accessibility in Chromium", () => {
  it("computes the same roles the node lane expects", () => {
    expect(computeRole(el(`<button>Go</button>`))).toBe("button");
    expect(computeRole(el(`<a href="/x">Go</a>`))).toBe("link");
    expect(computeRole(el(`<input type="text" />`))).toBe("textbox");
  });

  it("resolves aria-labelledby against the live document", () => {
    document.body.innerHTML = `<span id="lbl">Check out</span><button aria-labelledby="lbl">Go</button>`;
    const button = document.querySelector("button") as Element;
    expect(computeName(button)).toBe("Check out");
  });

  it("fails safe rather than guessing for input types with no ARIA role or with no mapping", () => {
    expect(computeRole(el(`<input type="password" />`))).toBeNull();
    expect(computeRole(el(`<input type="date" />`))).toBeNull();
  });
});
