import { describe, expect, it } from "vitest";
import { computeName, computeRole } from "../../src/accessibility";
import { normalizeText } from "../../src/text";
import { mount } from "../helpers/fixtures";

const el = (html: string): Element => {
  const found = mount(html).body.firstElementChild;
  if (found === null) throw new Error("fixture produced no element");
  return found;
};

describe("computeRole", () => {
  it("honours an explicit role attribute", () => {
    expect(computeRole(el(`<div role="button">Go</div>`))).toBe("button");
  });

  it("maps implicit roles for the elements capture actually touches", () => {
    expect(computeRole(el(`<button>Go</button>`))).toBe("button");
    expect(computeRole(el(`<a href="/x">Go</a>`))).toBe("link");
    expect(computeRole(el(`<input type="text" />`))).toBe("textbox");
    expect(computeRole(el(`<input type="checkbox" />`))).toBe("checkbox");
    expect(computeRole(el(`<select></select>`))).toBe("combobox");
    expect(computeRole(el(`<textarea></textarea>`))).toBe("textbox");
    expect(computeRole(el(`<h2>Title</h2>`))).toBe("heading");
  });

  it("maps dialogs, options, rows, cells, articles and named landmarks", () => {
    const at = (html: string, selector: string): string | null => {
      const found = mount(html).querySelector(selector);
      if (found === null) throw new Error(`fixture has no ${selector}`);
      return computeRole(found);
    };
    expect(computeRole(el(`<dialog open>Hi</dialog>`))).toBe("dialog");
    expect(at(`<select><option>One</option></select>`, "option")).toBe(
      "option",
    );
    expect(at(`<table><tr><td>A</td></tr></table>`, "tr")).toBe("row");
    expect(at(`<table><tr><td>A</td></tr></table>`, "td")).toBe("cell");
    expect(at(`<table role="grid"><tr><td>A</td></tr></table>`, "td")).toBe(
      "gridcell",
    );
    expect(computeRole(el(`<article>Post</article>`))).toBe("article");
    expect(computeRole(el(`<form aria-label="Sign up"></form>`))).toBe("form");
    expect(computeRole(el(`<section aria-label="Plans"></section>`))).toBe(
      "region",
    );
  });

  // An unnamed form or section is generic, as in Playwright's table: a role
  // every wrapper `<section>` shared would tie on the role tier for nothing.
  it("leaves an unnamed form or section, and a stray cell, without a role", () => {
    expect(computeRole(el(`<form></form>`))).toBeNull();
    expect(computeRole(el(`<section>Plans</section>`))).toBeNull();
    const cell = mount(`<div></div>`).createElement("td");
    expect(computeRole(cell)).toBeNull();
  });

  it("returns null for an element with no role", () => {
    expect(computeRole(el(`<span>text</span>`))).toBeNull();
  });

  it("treats a bare anchor as having no link role", () => {
    expect(computeRole(el(`<a>Go</a>`))).toBeNull();
  });

  // `type` is page-controlled. A lookup table read with `[]` answers
  // `Object.prototype`'s members for their names: `type="constructor"` gave
  // a function, `===` in the ladder never matched, and the scene failed its
  // own schema at finalize.
  it("answers null, not a prototype member, for a type named after one", () => {
    expect(computeRole(el(`<input type="constructor" />`))).toBeNull();
    expect(computeRole(el(`<input type="__proto__" />`))).toBeNull();
    expect(computeRole(el(`<constructor>x</constructor>`))).toBeNull();
    expect(computeRole(el(`<tostring>x</tostring>`))).toBeNull();
  });

  it("fails safe rather than guessing for input types with no ARIA role or with no mapping", () => {
    expect(computeRole(el(`<input type="password" />`))).toBeNull();
    expect(computeRole(el(`<input type="date" />`))).toBeNull();
    expect(computeRole(el(`<input type="checkbox" />`))).toBe("checkbox");
    expect(computeRole(el(`<input type="text" />`))).toBe("textbox");
  });
});

describe("computeName", () => {
  it("prefers aria-label over content", () => {
    expect(computeName(el(`<button aria-label="Check out">Go</button>`))).toBe(
      "Check out",
    );
  });

  it("falls back to trimmed text content", () => {
    expect(computeName(el(`<button>  Checkout  </button>`))).toBe("Checkout");
  });

  it("returns null when there is no name at all", () => {
    expect(computeName(el(`<input type="text" />`))).toBeNull();
  });
});

describe("normalizeText", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeText("  Check\n  out  ")).toBe("Check out");
  });

  it("maps an empty or whitespace-only string to null", () => {
    expect(normalizeText("   ")).toBeNull();
    expect(normalizeText(null)).toBeNull();
  });
});
