// The shipped shell stylesheet, and the colour arithmetic the shell tests
// share. Browser lane only: `?raw` is a vite import.
import shell from "../../../pages/assets/shell.css?raw";

/** The shell's dark tokens, read out of the file rather than restated, so
 *  the lane (which runs light) can apply them to `:root` directly the way
 *  editor-shell-layout.test.ts does. */
const DARK =
  /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\}\s*\}/.exec(
    shell,
  )?.[1];

if (!shell.includes(".btn") || !shell.includes("--shell")) {
  throw new Error("assets/shell.css no longer carries the shell");
}
if (!DARK?.includes("--")) {
  throw new Error("assets/shell.css has no prefers-color-scheme: dark block");
}

export const shellCss = shell;
export const shellDark = DARK;

/** The `<style>` a page keeps inline beside the shell link, and its body. */
export function pageParts(html: string, mustCarry: string) {
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  const body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1];
  if (!html.includes('href="../../assets/shell.css"')) {
    throw new Error("the page no longer links assets/shell.css");
  }
  if (!css?.includes(mustCarry)) {
    throw new Error(`the page's own stylesheet no longer carries ${mustCarry}`);
  }
  if (!body) throw new Error("the page has no <body>");
  return { css, body: body.replace(/<script[\s\S]*?<\/script>/g, "") };
}

/** Mounts the shell plus a page's own rules under one theme. Transitions
 *  are switched off: a computed style read right after a change would
 *  otherwise return the value the transition had reached — the OLD one.
 *
 *  The theme is set the way the toggle sets it — `data-theme` on the root
 *  — so a dark mount exercises the shell's own `:root[data-theme="dark"]`
 *  block, and a light mount pins light whatever the lane's system says.
 *
 *  `order` is which sheet comes first. "source" is the page as written
 *  (the shell's <link> above the inline <style>); "build" is the page as
 *  shipped, where vite moves the <link> to the end of the head. The shell
 *  sits in a cascade layer so both orders paint the same; a test that
 *  cares mounts both. */
export function mountShell(
  scheme: "light" | "dark",
  pageCss: string,
  order: "source" | "build" = "source",
): void {
  for (const old of document.head.querySelectorAll("[data-shell]"))
    old.remove();
  const style = document.createElement("style");
  style.setAttribute("data-shell", "");
  style.textContent = [
    ...(order === "source" ? [shellCss, pageCss] : [pageCss, shellCss]),
    "* { transition: none !important; }",
  ].join("\n");
  document.head.append(style);
  document.documentElement.dataset.theme = scheme;
}

/** Every style rule in a sheet, including those inside the shell's
 *  `@layer shell { … }` and inside media blocks. A rule that moves into the
 *  shell leaves the sheet's top level, so a test reading
 *  `sheet.cssRules` directly would stop finding it and go green on nothing. */
export function styleRules(list: CSSRuleList): CSSStyleRule[] {
  return [...list].flatMap((r) =>
    r instanceof CSSStyleRule
      ? [r]
      : r instanceof CSSLayerBlockRule || r instanceof CSSMediaRule
        ? styleRules(r.cssRules)
        : [],
  );
}

/** Where a switch's knob is painted: the x of its `::after` transform, in
 *  px (0 at rest off, the travel at rest on). Of the first `.switch` under
 *  `root`. */
export function knobX(root: ParentNode): number {
  const track = root.querySelector(".switch-track");
  if (!track) throw new Error("no .switch-track under the root");
  const t = getComputedStyle(track, "::after").transform;
  if (t === "none") return 0;
  const m = /^matrix\(([^)]+)\)$/.exec(t);
  const x = Number(m?.[1]?.split(",")[4]);
  if (!Number.isFinite(x)) throw new Error(`not a 2D translate: ${t}`);
  return x;
}

/** Holds the thread for `ms` and says how long it actually held. A
 *  measured gap, not a wait for anything: the switch reads the same clock
 *  to know how far a slide has run, and nothing else can move meanwhile. */
export function spin(ms: number): number {
  const start = performance.now();
  while (performance.now() - start < ms) {
    // the gap is the point
  }
  return performance.now() - start;
}

export type Rgba = readonly [number, number, number, number];

export function parse(colour: string): Rgba {
  // Chrome computes `color-mix()` to `color(srgb r g b[ / a])`, with
  // components in 0..1 rather than 0..255 — never to `rgb()`. The shell
  // reaches for color-mix wherever a tone has to move in OPPOSITE
  // directions per theme (the editor's rail, a Recordings card's hover),
  // which is exactly where a flat surface's only edge lives, so a parser
  // that knows `rgb()` alone throws on the surfaces this suite most needs
  // to measure.
  const srgb = /color\(srgb\s+([^)]+)\)/.exec(colour);
  if (srgb?.[1]) {
    const [r, g, b, a] = srgb[1]
      .split(/[\s/]+/)
      .filter(Boolean)
      .map(Number.parseFloat);
    if (r === undefined || g === undefined || b === undefined) {
      throw new Error(`not a colour: ${colour}`);
    }
    return [r * 255, g * 255, b * 255, a ?? 1];
  }
  const inner = /rgba?\(([^)]+)\)/.exec(colour);
  if (!inner?.[1]) throw new Error(`not an rgb colour: ${colour}`);
  const [r, g, b, a] = inner[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number.parseFloat);
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`not a colour: ${colour}`);
  }
  return [r, g, b, a ?? 1];
}

export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

export function luminance([r, g, b]: Rgba): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const one = luminance(a);
  const two = luminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

export const node = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector} in the mounted markup`);
  return found;
};

/** A selector's background composited up the stack onto the body: the
 *  first selector is the bottom layer, the last is what is seen. */
export const surface = (...selectors: string[]): Rgba =>
  selectors
    .map((s) => parse(getComputedStyle(node(s)).backgroundColor))
    .reduce((below, layer) => over(layer, below));
export const ink = (selector: string): Rgba =>
  parse(getComputedStyle(node(selector)).color);
export const radius = (selector: string): number =>
  Number.parseFloat(getComputedStyle(node(selector)).borderTopLeftRadius);
/** A shell token's colour, resolved the way the browser resolves it —
 *  through a probe's `background-color` — so `parse`/`contrast` read it the
 *  same way they read every other computed colour. Reads `:root` after a
 *  mount. */
export const token = (name: string): Rgba => {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${name})`;
  document.body.append(probe);
  const colour = parse(getComputedStyle(probe).backgroundColor);
  probe.remove();
  return colour;
};
/** A shell length token — `--radius`, say — resolved through a probe's
 *  `border-top-left-radius`, so a page's radius can be asserted EQUAL to
 *  the token rather than merely larger than some number. */
export const length = (name: string): number => {
  const probe = document.createElement("div");
  probe.style.borderTopLeftRadius = `var(${name})`;
  document.body.append(probe);
  const value = Number.parseFloat(getComputedStyle(probe).borderTopLeftRadius);
  probe.remove();
  // An undefined token computes to 0px on the probe AND on any element
  // declared with it, so `toBe(length(...))` would pass as 0 === 0 with
  // the token deleted (review finding, 2026-09-14). No shell length is 0.
  if (!Number.isFinite(value) || value === 0) {
    throw new Error(`shell token ${name} did not resolve to a length`);
  }
  return value;
};
