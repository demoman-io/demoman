import { computeAccessibleName } from "dom-accessibility-api";
import { normalizeText } from "./text.js";

// Deliberately partial: only the input types capture actually touches.
// An unmapped type (date, color, file, image, hidden, ...) yields null
// rather than a guess — a wrong role can mis-resolve to a different
// element entirely, which is worse than falling through to a lower tier.
const INPUT_ROLES: Record<string, string> = {
  text: "textbox",
  search: "searchbox",
  email: "textbox",
  tel: "textbox",
  url: "textbox",
  number: "spinbutton",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  submit: "button",
  button: "button",
  reset: "button",
};

const TAG_ROLES: Record<string, string> = {
  button: "button",
  select: "combobox",
  textarea: "textbox",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  nav: "navigation",
  main: "main",
  table: "table",
  ul: "list",
  ol: "list",
  li: "listitem",
  img: "img",
};

// Own keys only. Both tables are read with page-controlled names, and a
// bare `[]` lookup answers `Object.prototype`'s members for theirs:
// `<input type="constructor">` yielded a function, `===` in the ladder never
// matched it, and the scene failed its own schema at finalize.
const roleFor = (table: Record<string, string>, key: string): string | null =>
  Object.hasOwn(table, key) ? (table[key] ?? null) : null;

export function computeRole(el: Element): string | null {
  const explicit = normalizeText(el.getAttribute("role"));
  // Takes the first token of a (possibly space-separated) role attribute
  // without validating it against a role vocabulary — the resolver has
  // no such vocabulary to validate against.
  if (explicit !== null) return explicit.split(" ")[0] ?? null;

  const tag = el.tagName.toLowerCase();
  if (tag === "a" || tag === "area") {
    return el.hasAttribute("href") ? "link" : null;
  }
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    return roleFor(INPUT_ROLES, type);
  }
  return roleFor(TAG_ROLES, tag);
}

export function computeName(el: Element): string | null {
  return normalizeText(computeAccessibleName(el));
}
