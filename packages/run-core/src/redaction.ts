const CREDENTIAL_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]);

// `key` stops short of "keyword(s)" -- a search box. Every other hint is a
// bare substring, over-inclusion accepted (see below).
const NAME_HINT =
  /pass|pwd|secret|token|cvv|cvc|card|ssn|otp|mfa|key(?!word)|auth|credential/i;
// `pin` stands on its own word, so "shipping", "spinner" and "pinned" stay
// ordinary fields while "pin", "pinCode", "pin_code" and "Card PIN" hit.
// Case-sensitive on purpose: under /i the trailing lookahead would reject
// the C in "pinCode".
const PIN_HINT = /(?:^|[^A-Za-z])(?:pin|Pin|PIN)(?![a-z])/;

const HINT_ATTRS = ["name", "id", "placeholder", "aria-label"] as const;

/**
 * v8 §5's hard rule plus a heuristic layer. Deliberately over-inclusive: a
 * false positive costs the author one substitution in the step's Replace
 * on-screen text field, a false negative writes a real secret to disk.
 *
 * Attribute reads, not `instanceof HTMLInputElement` — `instanceof` is
 * realm-bound, and this runs against elements inside iframes, the same reason
 * the resolver's treepath.ts checks nodeType instead.
 */
export function isCredentialField(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  const editable =
    tag === "input" || tag === "textarea" || el.hasAttribute("contenteditable");
  if (!editable) return false;

  if ((el.getAttribute("type") ?? "").toLowerCase() === "password") return true;

  const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  // The attribute is a token list: "billing cc-number" is legal and common.
  if (autocomplete.split(/\s+/).some((t) => CREDENTIAL_AUTOCOMPLETE.has(t)))
    return true;

  return HINT_ATTRS.some((attr) => {
    const value = el.getAttribute(attr) ?? "";
    return NAME_HINT.test(value) || PIN_HINT.test(value);
  });
}

const EDITABLE = "input, textarea, [contenteditable]";

/**
 * `isCredentialField`, asked of the field an action on `el` will put the
 * keys into rather than of `el` alone (launch C). A snapshot lists no target
 * for a bare password input — it has no role and no text — so a script
 * reaches it through its label: the walk clicks `<label for=pw>Password</label>`,
 * the browser focuses the input, and the label alone would answer "not a
 * credential". So: the element itself, a label's own control, the control
 * of a label around it, and any editable field inside it. Over-inclusive,
 * like the rule: a wrapper holding a password field hides what is typed
 * into it even if the keys would land in another field.
 *
 * The extension's sensor asks `isCredentialField` of the element that
 * received the keys, so it never needs this.
 */
export function focusesCredentialField(el: Element): boolean {
  if (isCredentialField(el)) return true;
  const fields: Element[] = [];
  const controlOf = (label: Element | null) => {
    // `control` exists on every realm's HTMLLabelElement; read as a
    // property, not by instanceof (see isCredentialField).
    const control = (label as { control?: Element | null } | null)?.control;
    if (control) fields.push(control);
  };
  if (el.tagName.toLowerCase() === "label") controlOf(el);
  controlOf(el.closest("label"));
  fields.push(...el.querySelectorAll(EDITABLE));
  return fields.some(isCredentialField);
}
