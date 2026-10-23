import {
  CURSOR_DEFAULTS,
  MOTION_DEFAULTS,
  type SceneCursor,
} from "@demoman/scene-schema";
import { commands, page } from "@vitest/browser/context";
import { describe, expect, it, vi } from "vitest";
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderCursor } from "../../../pages/entrypoints/editor/view";
import {
  contrast,
  knobX,
  luminance,
  mountShell,
  over,
  pageParts,
  parse,
  spin,
  styleRules,
  token,
} from "../helpers/shell-css";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    /** See `test/helpers/drag-command.ts`; registered in `vitest.config.ts`. */
    dragAcross: (selector: string, steps: number) => Promise<void>;
  }
}

// `pageParts` throws if the page stops linking the shell or stops carrying
// this rule, so a stylesheet that drifts fails loudly instead of leaving
// every assertion below measuring unstyled defaults.
const { css } = pageParts(shell, ".cursor-style");

function mountCursorPanel(
  scheme: "light" | "dark",
  cursor: Partial<SceneCursor> = {},
): HTMLElement {
  mountShell(scheme, css);
  // `#inspector`'s 320px is `--panel-w`, typed by hand — not read off
  // `body`'s grid at all. This file mounts a synthetic `<aside
  // id="inspector">` straight into `document.body`, not the real shell
  // (`editor-shell-layout.test.ts` does that), so it never sees `body`'s
  // `grid-template-columns` — which since 2026-09-21 is
  // `minmax(520px, 1fr) calc(var(--rail-w) + var(--seam))
  // calc(var(--panel-w) + var(--seam))` with a compensating
  // `margin-left`, not the plain `48px 320px` this comment used to claim
  // — or its restructure at all. What the inline width is really standing
  // in for is simpler: an unstyled `<aside>` collapses to the width of its
  // content, which would lay every control out narrower than it ever is
  // in the real editor, so the fixture pins `--panel-w` directly instead.
  document.body.innerHTML =
    '<aside id="inspector" style="width: 320px"><div data-panel-cursor></div></aside>';
  const host = document.querySelector("[data-panel-cursor]") as HTMLElement;
  renderCursor(host, { ...CURSOR_DEFAULTS, ...cursor }, MOTION_DEFAULTS, {
    onCursor: vi.fn(),
    onCursorPreview: vi.fn(),
    onCursorPreviewEnd: vi.fn(),
    onMotion: vi.fn(),
    onMotionPreview: vi.fn(),
    onMotionPreviewEnd: vi.fn(),
  });
  return host;
}

/**
 * The Cursor panel, as it is actually painted.
 *
 * Three things here cannot be checked in the node lane and have each bitten
 * this editor before: a control that measures right and draws wrong, a
 * surface that separates in one theme and not the other, and a panel that
 * overflows its row under a short window. The style buttons add a fourth —
 * a canvas that reports its width while having painted nothing.
 */
describe("the Cursor panel", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`separates its style buttons from the panel in ${scheme}`, async () => {
      const root = mountCursorPanel(scheme);
      // Every button, not just the default-checked one: `CURSOR_DEFAULTS.style
      // === "light"` makes `[data-cursor-style="light"]` the CHECKED button
      // (accent border) on every unparametrised mount, which cannot fail this
      // assertion — it is the two UNCHECKED buttons, bordered with the
      // panel-local ring token, that came in under the 1.3 threshold in light
      // before that token was strengthened (measured: 1.227). Looping all
      // three is what makes this test capable of catching that.
      const panel = parse(
        getComputedStyle(document.querySelector("#inspector") as HTMLElement)
          .backgroundColor,
      );
      for (const style of ["light", "dark", "touch"]) {
        const button = root.querySelector<HTMLElement>(
          `[data-cursor-style="${style}"]`,
        );
        if (!button) throw new Error(`no ${style} style button`);
        const border = parse(getComputedStyle(button).borderTopColor);
        const measured = contrast(over(border, panel), panel);
        expect(
          measured,
          `${scheme}/${style} border vs panel: contrast ${measured.toFixed(3)}`,
        ).toBeGreaterThan(1.3);
      }
    });

    /**
     * One column, one treatment. What lets the eye run down a panel of
     * rows is that every label reads the same, and this panel stacks three
     * kinds — a slider's, a switch's and the Style heading — which arrived
     * at 14/500, 13/700 and 13/600 respectively when the slider rows were
     * restyled on 2026-09-21.
     *
     * Asserted as "they all match each other", not against a literal:
     * pinning 14px here would leave the next change to the shared token
     * green while the column it is meant to protect drifts apart.
     */
    it(`reads every row label in one treatment in ${scheme}`, () => {
      const root = mountCursorPanel(scheme);
      const kinds = {
        slider: [...root.querySelectorAll<HTMLElement>(".slider-label")],
        switch: [...root.querySelectorAll<HTMLElement>(".switch-text strong")],
        heading: [...root.querySelectorAll<HTMLElement>(".cursor-label")],
      };
      // The fixture's premise: all three kinds are on the panel. A selector
      // that stopped matching would leave the set below trivially uniform.
      // Size, Motion blur, Tilt, Click bounce, Smoothness, Camera blur;
      // Hide cursor, Hide when not moving, Follow cursor; Style, Camera.
      expect(kinds.slider, "slider labels").toHaveLength(6);
      expect(kinds.switch, "switch labels").toHaveLength(3);
      expect(
        kinds.heading.map((h) => h.textContent),
        "the Style and Camera headings",
      ).toEqual(["Style", "Camera"]);
      const seen = new Map<string, string[]>();
      for (const node of [...kinds.slider, ...kinds.switch, ...kinds.heading]) {
        const s = getComputedStyle(node);
        const treatment = `${s.fontSize}/${s.fontWeight}/${s.color}`;
        seen.set(treatment, [
          ...(seen.get(treatment) ?? []),
          node.textContent ?? "",
        ]);
      }
      expect(
        seen.size,
        `the panel's labels read in ${seen.size} treatments: ${[...seen]
          .map(([t, who]) => `${t} — ${who.join(", ")}`)
          .join(" | ")}`,
      ).toBe(1);
    });

    /**
     * The readout is rewritten on every `pointermove` of a drag, so a
     * proportional digit set would change its width — and with it the right
     * edge the eye is tracking — under the author's own hand. This asks the
     * invariant rather than either machine's numbers: two readouts, same
     * width, whatever face the runner resolves `system-ui` to.
     */
    it(`holds the readout's width as its digits change in ${scheme}`, () => {
      const root = mountCursorPanel(scheme);
      const slider = root.querySelector<HTMLInputElement>(
        "[data-cursor-scale]",
      );
      const value = slider
        ?.closest(".slider-row")
        ?.querySelector(".slider-value") as HTMLElement | null;
      if (!slider || !value) throw new Error("no size slider row");
      const widthAt = (v: string): number => {
        slider.value = v;
        slider.dispatchEvent(new Event("input"));
        return value.getBoundingClientRect().width;
      };
      const narrow = widthAt("1");
      const wide = widthAt("1.45");
      // The premise: the two readouts really are different strings, and the
      // first one really was painted. Equal widths mean nothing otherwise.
      expect(value.textContent).toBe("1.45x");
      expect(narrow).toBeGreaterThan(0);
      expect(wide, `1.00x measured ${narrow}, 1.45x measured ${wide}`).toBe(
        narrow,
      );
    });

    /**
     * The row shape copied from the reference on 2026-09-21: the label on
     * its own line with the readout flush to the far end, and the track
     * spanning the full width beneath both. Before it, all three were one
     * flex line and the readout was a `.chip` pill.
     *
     * Measured on the painted boxes rather than on the classes, because a
     * row that carries `.slider-row` and lays out as a single line is
     * exactly what this is here to catch.
     */
    it(`stacks each slider under its label with the value at the far end in ${scheme}`, () => {
      const root = mountCursorPanel(scheme);
      for (const [attr, readout] of [
        ["data-cursor-scale", "1.00x"],
        ["data-cursor-blur", "100%"],
      ] as const) {
        const slider = root.querySelector<HTMLElement>(`[${attr}]`);
        const row = slider?.closest<HTMLElement>(".slider-row");
        const label = row?.querySelector<HTMLElement>(".slider-label");
        const value = row?.querySelector<HTMLElement>(".slider-value");
        if (!slider || !row || !label || !value)
          throw new Error(`no slider row for ${attr}`);
        // The fixture's own premise. An empty value span is zero wide and
        // sits at the far end of an `auto` column anyway, so it satisfies
        // every edge comparison below without a readout being painted at
        // all — this is what makes those comparisons mean something.
        expect(value.textContent, `${attr} readout`).toBe(readout);
        const track = slider.getBoundingClientRect();
        const box = value.getBoundingClientRect();
        const name = label.getBoundingClientRect();
        // Edges only, never the value's own x or width: that number comes
        // from glyph advance, and the runner's fonts are not these fonts
        // (CLAUDE.md, 2026-09-10).
        expect(box.right, `${attr}: value vs track right edge`).toBeCloseTo(
          track.right,
          0,
        );
        expect(name.left, `${attr}: label vs track left edge`).toBeCloseTo(
          track.left,
          0,
        );
        // Above the track, not beside it.
        expect(
          box.bottom,
          `${attr}: value bottom vs track top`,
        ).toBeLessThanOrEqual(track.top);
        // And on one line with its label.
        expect(box.bottom, `${attr}: value vs label baseline`).toBeCloseTo(
          name.bottom,
          0,
        );
        const painted = getComputedStyle(value);
        expect(painted.fontSize, `${attr} value size`).toBe("14px");
        expect(getComputedStyle(label).fontSize, `${attr} label size`).toBe(
          "14px",
        );
        expect(parse(painted.color), `${attr} value ink`).toEqual(
          token("--ink-muted"),
        );
        // Not a pill. The `.chip` this replaced carried both of these, and
        // a value that kept them would still pass every edge check above.
        expect(painted.borderTopLeftRadius, `${attr} value radius`).toBe("0px");
        expect(parse(painted.backgroundColor)[3], `${attr} value fill`).toBe(0);
      }
    });

    it(`paints ink inside each style button in ${scheme}`, async () => {
      const root = mountCursorPanel(scheme);
      for (const style of ["light", "dark", "touch"]) {
        const canvas = root.querySelector<HTMLCanvasElement>(
          `[data-cursor-style="${style}"] canvas`,
        );
        if (!canvas) throw new Error(`no preview canvas for ${style}`);
        const ctx = canvas.getContext("2d");
        const data = ctx?.getImageData(0, 0, canvas.width, canvas.height).data;
        const painted = [...(data ?? [])].some((v, i) => i % 4 === 3 && v > 0);
        // A canvas element with a width is not a painted cursor.
        expect(painted).toBe(true);
      }
    });

    it(`centres each style's painted cursor in its button in ${scheme}`, () => {
      const root = mountCursorPanel(scheme);
      // The arrows sit 1.5px right of ink-centred at the default size, an
      // optical correction (`OPTICAL_NUDGE` in view.ts); the circle is
      // centred exactly.
      const rightOfCentre = { light: 1.5, dark: 1.5, touch: 0 };
      for (const style of ["light", "dark", "touch"] as const) {
        const canvas = root.querySelector<HTMLCanvasElement>(
          `[data-cursor-style="${style}"] canvas`,
        );
        if (!canvas) throw new Error(`no preview canvas for ${style}`);
        const { width, height } = canvas;
        const data = canvas
          .getContext("2d")
          ?.getImageData(0, 0, width, height).data;
        if (!data) throw new Error(`no pixels for ${style}`);
        // Near-opaque pixels only: the fill and stroke, not the drop
        // shadow, whose peak alpha is 0.35 and which falls downward.
        let minX = width;
        let maxX = -1;
        let minY = height;
        let maxY = -1;
        for (let i = 3; i < data.length; i += 4) {
          if ((data[i] ?? 0) < 200) continue;
          const x = ((i - 3) / 4) % width;
          const y = Math.floor((i - 3) / 4 / width);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        const evidence = `${style}: ink x ${minX}..${maxX}, y ${minY}..${maxY} in ${width}x${height}`;
        // The fixture has to paint a shape of real size, or an empty box
        // centres trivially.
        expect(maxX - minX, evidence).toBeGreaterThan(10);
        expect(maxY - minY, evidence).toBeGreaterThan(10);
        // Centring the arrow's whole art box, not its ink, put the ink's
        // centre 5.3px left of the canvas's; ink-centred with no nudge
        // leaves it 1.5px short of where it now sits.
        expect(
          Math.abs((minX + maxX + 1) / 2 - (width / 2 + rightOfCentre[style])),
          evidence,
        ).toBeLessThan(1);
        expect(
          Math.abs((minY + maxY + 1) / 2 - height / 2),
          evidence,
        ).toBeLessThan(1);
      }
    });
  }

  /**
   * The Style heading sits as far above its buttons as a slider's name sits
   * above its track — measured as painted, not as boxes: a range input's
   * box is taller than the 4px track it draws, so the input's own top is
   * not where the eye reads the gap. Until 2026-09-22 the buttons sat 4px
   * under "Style" while the sliders below breathed at 12.
   */
  it("spaces the Style heading from its buttons as a slider's name from its track", () => {
    const root = mountCursorPanel("light");
    const name = root.querySelector(".slider-row > .slider-label");
    const slider = root.querySelector<HTMLInputElement>(
      ".slider-row > input[type='range']",
    );
    const heading = root.querySelector(".cursor-label");
    const buttons = root.querySelector(".cursor-styles");
    if (!name || !slider || !heading || !buttons)
      throw new Error("missing a slider row or the Style row");
    // Chrome answers `getComputedStyle` for this pseudo-element with the
    // input's own height, so the track's is read off the rule that sets it.
    const trackRule = [...document.styleSheets]
      .flatMap((sheet) => styleRules(sheet.cssRules))
      .find(
        (rule) =>
          rule.selectorText ===
          'input[type="range"]::-webkit-slider-runnable-track',
      );
    const track = Number.parseFloat(trackRule?.style.height ?? "");
    const box = slider.getBoundingClientRect();
    // The premise: the pseudo-element really was read, and really is
    // shorter than its input — or the correction below is nothing.
    expect(
      track,
      `track height ${track}, input height ${box.height}`,
    ).toBeGreaterThan(0);
    expect(track).toBeLessThan(box.height);
    const trackTop = box.top + (box.height - track) / 2;
    const sliderGap = trackTop - name.getBoundingClientRect().bottom;
    const styleGap =
      buttons.getBoundingClientRect().top -
      heading.getBoundingClientRect().bottom;
    expect(
      styleGap,
      `Style heading to buttons ${styleGap}px, slider name to track ${sliderGap}px`,
    ).toBeCloseTo(sliderGap, 0);
  });

  /* The editor re-renders the Cursor panel on every session emit, the
     one a switch's own click raises included, so the clicked switch is
     replaced mid-slide. It used to be born at rest, and Hide cursor
     snapped. */
  it("keeps Hide cursor sliding through the render its click causes", () => {
    const root = mountCursorPanel("light");
    const input = root.querySelector(
      "[data-cursor-hidden]",
    ) as HTMLInputElement;
    // Premise: off, at rest.
    expect(input.checked).toBe(false);
    expect(knobX(root)).toBe(0);
    input.click();
    spin(50);
    renderCursor(root, { ...CURSOR_DEFAULTS, hidden: true }, MOTION_DEFAULTS, {
      onCursor: vi.fn(),
      onCursorPreview: vi.fn(),
      onCursorPreviewEnd: vi.fn(),
      onMotion: vi.fn(),
      onMotionPreview: vi.fn(),
      onMotionPreviewEnd: vi.fn(),
    });
    const again = root.querySelector("[data-cursor-hidden]");
    expect(again, "the render kept the clicked element").not.toBe(input);
    const x = knobX(root);
    expect(x, `knob at ${x}px: 16 is a snap`).toBeGreaterThan(0);
    expect(x).toBeLessThan(16);
  });

  it("draws each style button as a circle", () => {
    const root = mountCursorPanel("light");
    for (const button of root.querySelectorAll<HTMLElement>(
      "[data-cursor-style]",
    )) {
      const box = button.getBoundingClientRect();
      // A radius of half the side is only a circle on a square box.
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeCloseTo(box.width, 1);
      expect(getComputedStyle(button).borderTopLeftRadius).toBe("50%");
    }
  });

  it("keeps the checked style visibly distinct from the others", () => {
    const root = mountCursorPanel("light", { style: "dark" });
    const checked = root.querySelector<HTMLElement>(
      '[data-cursor-style="dark"]',
    );
    const other = root.querySelector<HTMLElement>(
      '[data-cursor-style="light"]',
    );
    if (!checked || !other) throw new Error("missing style buttons");
    expect(getComputedStyle(checked).borderTopColor).not.toBe(
      getComputedStyle(other).borderTopColor,
    );
  });

  // This guards the flex-shrink default, not "any control growing past the
  // panel". Measured: widening `.cursor-style` alone (no `flex-shrink: 0`)
  // was silently absorbed by flexbox's default `flex-shrink: 1` — the
  // buttons shrank to fit and this test stayed green. It only went red once
  // `flex-shrink: 0` was added alongside the width increase, i.e. once
  // shrinking was actually turned off. A future reader should not assume
  // this test would catch a regression that flexbox's own default shrink
  // still absorbs.
  it("keeps every control inside the panel in a short window", async () => {
    await page.viewport(1100, 620);
    const root = mountCursorPanel("light");
    const panel = root.getBoundingClientRect();
    for (const control of root.querySelectorAll<HTMLElement>(
      "[data-cursor-scale], [data-cursor-blur], [data-cursor-tilt], [data-cursor-bounce], [data-cursor-style], [data-cursor-hidden], [data-cursor-idle], [data-motion-smoothness], [data-motion-blur], [data-motion-follow]",
    )) {
      const box = control.getBoundingClientRect();
      expect(box.right).toBeLessThanOrEqual(panel.right + 0.5);
      expect(box.left).toBeGreaterThanOrEqual(panel.left - 0.5);
      // A control with no box at all satisfies every comparison above.
      expect(box.width).toBeGreaterThan(0);
    }
  });

  /**
   * A drag is not an `input` event. These two cases are the same real Blink
   * mouse gesture — press at the Size slider's left edge, 20 moves to its
   * right edge, release — run against two `onCursorPreview` handlers, and
   * they are here because the node lane cannot tell them apart: a synthetic
   * `input` dispatched on a retained reference never took a pointer capture
   * and so cannot lose one.
   *
   * The first case characterises the hazard: a handler that re-renders the
   * panel detaches the `<input type="range">` the pointer is captured to,
   * and the drag dies on its first value change. The second is the guard: a
   * handler that leaves the panel's DOM alone lets the same gesture run to
   * the top of the range.
   *
   * Neither case loads `main.ts`, so neither can see whether the editor's
   * own handler is the second kind — that is
   * `test/node/editor-main-cursor.test.ts`'s "keeps the dragged slider
   * itself alive, and writes nothing", which asserts on the real wiring.
   */
  for (const scheme of ["light", "dark"] as const) {
    /* Quiet at rest, lit under the pointer.
       
       Read out of the CSSOM, not measured: Chrome does not expose
       `::-webkit-slider-thumb` to `getComputedStyle` — asked for it, it
       hands back the HOST's style instead (verified: the thumb reported the
       input's own 200px width and `opacity: 1`), so an assertion that looks
       like it is measuring the thumb is measuring the slider. The painted
       result was checked by screenshot in both themes; this is what can be
       held automatically. */
    it(`hides the slider's thumb until the pointer arrives in ${scheme}`, () => {
      mountCursorPanel(scheme);
      const sheet = [...document.styleSheets].find((x) =>
        (x.ownerNode as HTMLElement | null)?.hasAttribute("data-shell"),
      );
      if (!sheet) throw new Error("the editor's stylesheet is not mounted");
      const rules = styleRules(sheet.cssRules);
      const allThumbs = rules.filter((r) =>
        r.selectorText.includes("::-webkit-slider-thumb"),
      );
      // The timeline's zoom slider is a deliberate exception and keeps its
      // knob drawn at all times: it has no readout beside it, so the knob
      // IS the readout, and ⌘-scroll moves it with no pointer on it at
      // all. Asserted here rather than merely excluded — an exception this
      // filter dropped silently could disappear and nothing would notice.
      const zoomAlwaysOn = allThumbs.filter(
        (r) =>
          r.selectorText.includes(".zoom-control") && r.style.opacity === "1",
      );
      expect(
        zoomAlwaysOn.length,
        "the timeline's zoom knob is no longer drawn at rest",
      ).toBe(1);
      const thumbs = allThumbs.filter(
        (r) => !r.selectorText.includes(".zoom-control"),
      );
      const hidden = thumbs.filter(
        (r) => r.style.opacity === "0" && !r.selectorText.includes(":hover"),
      );
      const shown = thumbs.filter((r) => r.style.opacity === "1");
      expect(hidden.length, "nothing hides the thumb at rest").toBe(1);
      expect(shown.length, "nothing brings the thumb back").toBe(1);
      // Hover is what was asked for; the keyboard never hovers, so focus
      // has to summon it too or the thumb is invisible to the one input
      // method that cannot reveal it.
      const revealer = shown[0]?.selectorText ?? "";
      expect(revealer).toContain(":hover");
      expect(revealer).toContain(":focus-visible");
    });

    /* The resting fill has to be LIGHTER than the remainder, or "filled"
       and "empty" read backwards. Asserted as a relationship rather than
       against two hexes: `--slider-rest` is a different colour per theme,
       and a literal would pin one and pass the other. */
    it(`fills lighter than it leaves empty in ${scheme}`, () => {
      mountCursorPanel(scheme);
      const probe = (name: string) => {
        const d = document.createElement("div");
        d.style.backgroundColor = `var(${name})`;
        document.body.append(d);
        const c = parse(getComputedStyle(d).backgroundColor);
        d.remove();
        return c;
      };
      const panel = parse(
        getComputedStyle(document.querySelector("#inspector") as HTMLElement)
          .backgroundColor,
      );
      const rest = over(probe("--slider-rest"), panel);
      const empty = over(probe("--switch-off"), panel);
      expect(
        luminance(rest),
        `the resting fill is darker than the empty track in ${scheme}`,
      ).toBeGreaterThan(luminance(empty));
      // And it is visible against the panel it sits on, which is what a
      // literally white fill was not in light.
      expect(
        contrast(rest, panel),
        `the resting fill vanishes into the panel in ${scheme}`,
      ).toBeGreaterThan(1.1);
    });
  }

  describe("dragging the Size slider", () => {
    const STEPS = 20;

    function mountForDrag(
      handler: (host: HTMLElement) => (patch: Partial<SceneCursor>) => void,
    ): { host: HTMLElement; inputs: string[] } {
      mountShell("light", css);
      document.body.innerHTML =
        '<aside id="inspector" style="width: 320px"><div data-panel-cursor></div></aside>';
      const host = document.querySelector("[data-panel-cursor]") as HTMLElement;
      // On the host, which no re-render replaces, so the count survives the
      // hazard case's own rebuilding of everything under it.
      const inputs: string[] = [];
      host.addEventListener("input", (event) => {
        inputs.push((event.target as HTMLInputElement).value);
      });
      renderCursor(host, { ...CURSOR_DEFAULTS }, MOTION_DEFAULTS, {
        onCursor: vi.fn(),
        onCursorPreview: handler(host),
        onCursorPreviewEnd: vi.fn(),
        onMotion: vi.fn(),
        onMotionPreview: vi.fn(),
        onMotionPreviewEnd: vi.fn(),
      });
      return { host, inputs };
    }

    const sizeOf = (host: HTMLElement): HTMLInputElement => {
      const slider = host.querySelector<HTMLInputElement>(
        "[data-cursor-scale]",
      );
      if (!slider) throw new Error("no size slider");
      return slider;
    };

    it("dies after one step when the handler re-renders the panel", async () => {
      const { host, inputs } = mountForDrag((mountedOn) => {
        function rerender(patch: Partial<SceneCursor>): void {
          renderCursor(
            mountedOn,
            { ...CURSOR_DEFAULTS, ...patch },
            MOTION_DEFAULTS,
            {
              onCursor: vi.fn(),
              onCursorPreview: rerender,
              onCursorPreviewEnd: vi.fn(),
              onMotion: vi.fn(),
              onMotionPreview: vi.fn(),
              onMotionPreviewEnd: vi.fn(),
            },
          );
        }
        return rerender;
      });
      await commands.dragAcross("[data-cursor-scale]", STEPS);
      const slider = sizeOf(host);
      // The press itself lands one value change; every move after it is
      // spent on an element that never took the pointer.
      expect(inputs.length, `values seen: ${inputs.join(", ")}`).toBeLessThan(
        3,
      );
      expect(Number(slider.value)).toBeLessThan(2);
    });

    it("runs to the top of the range when the handler leaves the DOM alone", async () => {
      const { host, inputs } = mountForDrag(() => () => undefined);
      await commands.dragAcross("[data-cursor-scale]", STEPS);
      const slider = sizeOf(host);
      // The same gesture, tracked the whole way: many values, ending at the
      // slider's maximum, on the element that was there before it started.
      expect(
        inputs.length,
        `values seen: ${inputs.join(", ")}`,
      ).toBeGreaterThan(STEPS / 2);
      expect(slider.value).toBe(slider.max);
      expect(slider.isConnected).toBe(true);
    });
  });

  /**
   * The polish rows, dragged the same real way. Each is wired as `main.ts`
   * wires it — the preview handler leaves the DOM alone — and records what
   * it was handed, so the case also says WHICH handler a real drag reaches
   * and with which field, not only that the thumb moved.
   */
  for (const [sel, field, block] of [
    ["[data-cursor-tilt]", "tilt", "cursor"],
    ["[data-cursor-bounce]", "clickBounce", "cursor"],
    ["[data-motion-smoothness]", "smoothness", "motion"],
    ["[data-motion-blur]", "blur", "motion"],
  ] as const) {
    it(`drags ${field} to the top of its range under a real mouse`, async () => {
      mountShell("light", css);
      document.body.innerHTML =
        '<aside id="inspector" style="width: 320px"><div data-panel-cursor></div></aside>';
      const host = document.querySelector("[data-panel-cursor]") as HTMLElement;
      const seen: number[] = [];
      const record = (patch: Record<string, unknown>) => {
        const v = patch[field];
        if (typeof v === "number") seen.push(v);
      };
      const onCursor = vi.fn();
      const onMotion = vi.fn();
      renderCursor(host, { ...CURSOR_DEFAULTS }, MOTION_DEFAULTS, {
        onCursor,
        onCursorPreview: block === "cursor" ? record : vi.fn(),
        onCursorPreviewEnd: vi.fn(),
        onMotion,
        onMotionPreview: block === "motion" ? record : vi.fn(),
        onMotionPreviewEnd: vi.fn(),
      });
      const node = host.querySelector<HTMLInputElement>(sel);
      if (!node) throw new Error(`no ${sel}`);
      await commands.dragAcross(sel, 20);
      expect(seen.length, `values seen: ${seen.join(", ")}`).toBeGreaterThan(
        10,
      );
      expect(node.value).toBe(node.max);
      expect(node.isConnected).toBe(true);
      // The readout followed the thumb to the end.
      const shown = node.parentElement?.querySelector(".slider-value");
      expect(shown?.textContent).toBe(node.max === "2" ? "2.00x" : "100%");
      // And the release committed the top value to the right block.
      const commit = block === "cursor" ? onCursor : onMotion;
      const other = block === "cursor" ? onMotion : onCursor;
      expect(commit).toHaveBeenCalledWith({ [field]: Number(node.max) });
      expect(other).not.toHaveBeenCalled();
    });
  }

  it("greys the disabled controls visibly when the cursor is hidden", () => {
    const opacityOf = (root: HTMLElement) =>
      Number(
        getComputedStyle(
          root.querySelector('[data-cursor-style="light"]') as HTMLElement,
        ).opacity,
      );
    // Each read has to happen before the NEXT mount: `mountCursorPanel`
    // replaces `document.body.innerHTML`, which detaches the previous
    // root from the live document. A disconnected node's `getComputedStyle`
    // returns `""` for `opacity` in Chromium, and `Number("")` is `0` — not
    // NaN — so reading both roots only after both mounts silently compared
    // "hidden" against a phantom 0 instead of the shown button's real 1.
    const shown = opacityOf(mountCursorPanel("light"));
    const hidden = opacityOf(mountCursorPanel("light", { hidden: true }));
    expect(hidden).toBeLessThan(shown);
  });
});
