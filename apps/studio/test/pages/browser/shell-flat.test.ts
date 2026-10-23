import { userEvent } from "@vitest/browser/context";
import { afterAll, describe, expect, it } from "vitest";
import {
  contrast,
  mountShell,
  node,
  surface,
  token,
} from "../helpers/shell-css";

/**
 * The flat shell: surfaces separated by tone, not by a hairline.
 *
 * Restyled 2026-09-20. The shell's grouped surfaces — the card, the pill,
 * a field — used to carry `1px solid var(--ring)`, and in light mode that
 * hairline was doing nearly all the work: `--shell` (#f9fafb) and `--card`
 * (#ffffff) sat 1.045:1 apart, which is not a tone step anyone can see.
 * Removing the line without deepening the page would have merged every
 * card into the page and the suite would not have noticed, so the two
 * claims are asserted together here:
 *
 *   - the borders and shadows are gone, AND
 *   - the tone step that replaces them actually exists.
 *
 * The second is the positive control. Without it the first passes on a
 * uniform white field — which is exactly the picture the change is meant
 * to avoid — and this file would be asserting that the shell looks like
 * nothing at all. Flatten the tokens back together and TONE_STEP fails.
 *
 * Scope is the shell's own rules (assets/shell.css). Each page's inline
 * sheet is covered by its own *-shell.test.ts.
 */

const THEMES = ["light", "dark"] as const;

/** Measured after the restyle: 1.141:1 in light, 1.131:1 in dark. The
 *  floor sits below both with room to retune a shade, and above the
 *  1.045:1 the light theme carried before — so this fails on the old
 *  values rather than ratifying them. */
const TONE_STEP = 1.08;

/** Every shell surface that used to carry a hairline. `.notice-error` and
 *  `.notice-warn` are deliberately absent: their borders say which notice
 *  you are reading, and they stay. */
const FLATTENED = [".card", ".pill", "input", "select"] as const;

const MARKUP = `
  <div class="card" data-probe="card">
    <button class="pill" type="button">Filter</button>
    <input type="text" value="Checkout" />
    <select><option>720p</option></select>
    <button class="btn btn-primary" type="button">Render</button>
  </div>
  <div class="notice notice-error" data-probe="error">Storage refused</div>
`;

function mount(scheme: (typeof THEMES)[number]): void {
  document.body.innerHTML = MARKUP;
  mountShell(scheme, "");
  // The fixture is a claim: every selector measured below has to be on the
  // page, or `node` throws for each and the loops assert nothing.
  for (const selector of [...FLATTENED, ".notice-error"]) node(selector);
}

afterAll(() => {
  document.body.innerHTML = "";
});

describe.each(THEMES)("the %s shell", (scheme) => {
  it("separates the page from a card by tone, not a hairline", () => {
    mount(scheme);
    const step = contrast(token("--shell"), token("--card"));
    expect(
      step,
      `--shell and --card are ${step.toFixed(3)}:1 apart in ${scheme}; below ${TONE_STEP}:1 a borderless card is invisible against the page`,
    ).toBeGreaterThan(TONE_STEP);
  });

  it.each(FLATTENED)("paints %s with no border", (selector) => {
    mount(scheme);
    const style = getComputedStyle(node(selector));
    const sides = {
      top: style.borderTopWidth,
      right: style.borderRightWidth,
      bottom: style.borderBottomWidth,
      left: style.borderLeftWidth,
    };
    expect(sides, `${selector} still carries a hairline in ${scheme}`).toEqual({
      top: "0px",
      right: "0px",
      bottom: "0px",
      left: "0px",
    });
  });

  /* The failure this whole change invites, and the one it actually made
     twice before this test existed: a surface keeps the fill it had while
     a border drew its edge, the border goes, and the surface is not flat —
     it is gone. Both the field and the pill were painted `--card` and both
     sit INSIDE a `--card` container, so each was briefly a control with no
     boundary of any kind. A per-selector `borderWidth: 0` check cannot see
     that; only asking what the thing sits on can. */
  it.each([
    { what: "a field", inner: "input" },
    { what: "a select", inner: "select" },
    { what: "a pill", inner: ".pill" },
  ])("separates $what from the card it sits on", ({ inner }) => {
    mount(scheme);
    const on = surface("body", ".card");
    const step = contrast(surface("body", ".card", inner), on);
    expect(
      step,
      `${inner} is ${step.toFixed(3)}:1 against the card behind it in ${scheme}; with no border left, that IS the control's edge`,
    ).toBeGreaterThan(TONE_STEP);
  });

  it("lifts a card with no shadow", () => {
    mount(scheme);
    expect(getComputedStyle(node(".card")).boxShadow).toBe("none");
  });

  /* The other half of the rule: a border that carries state is not
     decoration. `.notice-error` is the worked example — with the tint
     alone, nothing else on a flat surface says this notice is the one
     that failed. */
  it("keeps the border that says a notice failed", () => {
    mount(scheme);
    const width = getComputedStyle(node(".notice-error")).borderTopWidth;
    expect(width, `.notice-error lost its ring in ${scheme}`).toBe("1px");
  });

  /* Focus rings are an affordance, not a surface. They only paint for the
     keyboard, so the flat look costs nothing to keep them — but a later
     pass reaching for `outline: none` would take the only indicator these
     pages have, so it is pinned here under real keyboard focus rather
     than a programmatic `.focus()`, which does not match :focus-visible. */
  it("still rings a control the keyboard reached", async () => {
    mount(scheme);
    await userEvent.tab();
    const focused = document.activeElement;
    expect(focused, "nothing took focus, so the ring is untested").toBe(
      node(".pill"),
    );
    const style = getComputedStyle(focused as HTMLElement);
    expect(style.outlineWidth).toBe("2px");
    expect(style.outlineStyle).toBe("solid");
  });
});
