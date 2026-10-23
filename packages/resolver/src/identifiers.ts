/** Attributes an author sets deliberately. Order is preference order. */
export const STABLE_ID_ATTRS = [
  "data-testid",
  "data-test-id",
  "data-test",
  "data-qa",
  "data-cy",
  "id",
] as const;

// v8 §4: every framework-generated identifier is unstable by construction, so
// a build that re-hashes them must not look like drift. Each hash-shaped
// pattern requires a digit in the generated segment — real hashes have them,
// authored words like `_sidebar_toggle` or `css-button` do not.
const GENERATED = [
  /^_.*_(?=[a-z0-9]*[0-9])[a-z0-9]{5,}$/i, // CSS Modules: _button_a1b2c
  /^css-(?=[a-z0-9]*[0-9])[a-z0-9]{5,}$/i, // styled-components / Emotion: css-1x2y3z
  /^data-v-[a-f0-9]{6,}$/i, // Vue scoped styles
  /^_ngcontent-/i, // Angular
  // React useId — 18 `:r1:`, 19.0 `«r1»`, 19.1 `_r_1_` — anywhere, since
  // libraries wrap it (react-aria: `react-aria544548995-_r_2_`).
  /:r[0-9a-z]*:|«r[0-9a-z]*»|(?:^|[^a-z0-9])_r_[0-9a-z]+_/i,
  // A bare hash: hex, and mixed — pure digits are a plausible authored id.
  /^(?=[a-f0-9]*[0-9])(?=[a-f0-9]*[a-f])[a-f0-9]{8,}$/i,
];

export function isAuthoredIdentifier(value: string): boolean {
  if (value.length === 0) return false;
  return !GENERATED.some((re) => re.test(value)) && !isGuidLike(value);
}

// A random key (nanoid: `hoAsHkNPh68XUqrK1u8gY-shapes-title`) switches between
// lower, upper and digit far more often than words do; upper to lower is
// camelCase, not a switch (Playwright's selector generator counts the same
// way). Counted within a nanoid's 21 characters, since an authored suffix
// dilutes a whole-value ratio. Measured on 2026-10-21: 5 switches catches
// 98% of nanoids, and authored ids like `submitPaymentButtonPrimaryV2` score 4.
// shortcut: about 1 nanoid in 50 still passes, which then fails to resolve on
// the next load; upgrade to comparing two snapshots if that shows up in runs.
function isGuidLike(value: string): boolean {
  const kinds = Array.from(value)
    .filter((c) => c !== "-" && c !== "_")
    .map((c) =>
      /[a-z]/.test(c)
        ? "lower"
        : /[A-Z]/.test(c)
          ? "upper"
          : /[0-9]/.test(c)
            ? "digit"
            : "other",
    );
  if (kinds.length < 16) return false;
  const switched = kinds.map(
    (k, i) =>
      i > 0 &&
      k !== kinds[i - 1] &&
      !(kinds[i - 1] === "upper" && k === "lower"),
  );
  for (let i = 0; i + 21 <= Math.max(kinds.length, 21); i++) {
    // switched[i] compares with the character before the window, so skip it.
    const inWindow = switched.slice(i + 1, i + 21).filter(Boolean).length;
    if (inWindow >= 5) return true;
  }
  return false;
}

export function readStableId(el: Element): string | null {
  for (const attr of STABLE_ID_ATTRS) {
    const value = el.getAttribute(attr);
    if (value !== null && isAuthoredIdentifier(value)) return value;
  }
  return null;
}

export function findByStableId(root: ParentNode, value: string): Element[] {
  const escaped = CSS.escape(value);
  const selector = STABLE_ID_ATTRS.map((a) => `[${a}="${escaped}"]`).join(",");
  return Array.from(root.querySelectorAll(selector)).filter(
    (el) => readStableId(el) === value,
  );
}
