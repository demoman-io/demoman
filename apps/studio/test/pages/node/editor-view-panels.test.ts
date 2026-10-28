import { CURSOR_ART } from "@demoman/compositor";
import {
  CURSOR_DEFAULTS,
  type CursorStyle,
  MOTION_DEFAULTS,
  type SceneCursor,
  type SceneMotion,
} from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import {
  renderBranding,
  renderCursor,
  stylePreviewDrawn,
  stylePreviewOrigin,
} from "../../../pages/entrypoints/editor/view";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
});

// `replacementCandidates` and `renderReplacements` (the demo panel's Steps
// disclosure and its replacements list) were deleted by Task 5. What the
// author might substitute is now fixed from the step that touches the
// anchor — "Replace on-screen text" on that step's own panel
// (`editor-inspector.test.ts`'s "replace on-screen text" describe) — and the
// notice's fix-it route selects that step directly rather than forcing the
// old disclosure open (`editor-main-inspector.test.ts`). Their describes
// above went with them.

// `renderMasks` (the always-visible list, with its "Draw a mask on the
// preview" button) was deleted by Task 11. A mask is now created from the
// timeline's own "+ Mask" button (`timeline-view.ts`), shown and dragged as
// a box on the preview via `renderStageOverlay`
// (`editor-stage-overlay.test.ts`'s "resizes the mask box…" case), and
// edited in `renderMaskPanel` — the same one-selected-thing detail panel a
// step or a zoom gets (`editor-inspector.test.ts`'s "a mask selected"
// describe) — rather than its own always-visible list. Its two tests above
// went with it; Task 15 records the retirement.

describe("renderBranding", () => {
  // The panel is `src/branding/controls.ts`, covered case by case in
  // `branding-controls.test.ts`. This only pins that the editor mounts it.
  it("mounts the branding controls", () => {
    renderBranding(
      root,
      {
        branding: readonlyScene().branding,
        logoThumb: null,
        logoPlacement: null,
        formatTitle: "Landscape video",
        logoNotes: [],
        wallpaper: {
          thumbUrl: (id: string) => `/wallpapers/${id}-thumb.webp`,
          custom: null,
          loadError: null,
        },
      },
      {
        onCommit: vi.fn(),
        onPreview: vi.fn(),
        onLogoFile: vi.fn(),
        onWallpaperFile: vi.fn(),
      },
    );
    expect(root.querySelectorAll("[data-bg-kind]").length).toBe(3);
    expect(root.querySelector('input[type="file"]')).not.toBeNull();
  });
});

const handlers = () => ({
  onCursor: vi.fn(),
  onCursorPreview: vi.fn(),
  onCursorPreviewEnd: vi.fn(),
  onMotion: vi.fn(),
  onMotionPreview: vi.fn(),
  onMotionPreviewEnd: vi.fn(),
});
const draw = (
  cursor: Partial<SceneCursor> = {},
  motion: Partial<SceneMotion> = {},
) => {
  const h = handlers();
  renderCursor(
    root,
    { ...CURSOR_DEFAULTS, ...cursor },
    { ...MOTION_DEFAULTS, ...motion },
    h,
  );
  return h;
};
const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);

// Mirrors `stylePreview`'s own fixed size in view.ts — the preview canvas
// never resizes with the button.
const PREVIEW_CANVAS_SIZE = 44;

// The shapes `drawCursor` actually paints (draw-cursor.ts's ARROW path and
// its touch circle), reproduced independently of `stylePreviewOrigin` so
// these tests check where the real ink lands, not just that the function
// agrees with itself. If either shape changes, these constants have to
// change with it.
const ARROW_INK_BOX = { minX: 0, maxX: 0.56, minY: 0, maxY: 0.87 };
const TOUCH_INK_RADIUS_FRACTION = 0.42;

function inkExtent(style: CursorStyle, drawn: number) {
  const at = stylePreviewOrigin(style, drawn, PREVIEW_CANVAS_SIZE);
  const boxSize = CURSOR_ART[style].height * drawn;
  if (style === "touch") {
    const r = boxSize * TOUCH_INK_RADIUS_FRACTION;
    return { minX: at.x - r, maxX: at.x + r, minY: at.y - r, maxY: at.y + r };
  }
  return {
    minX: at.x + ARROW_INK_BOX.minX * boxSize,
    maxX: at.x + ARROW_INK_BOX.maxX * boxSize,
    minY: at.y + ARROW_INK_BOX.minY * boxSize,
    maxY: at.y + ARROW_INK_BOX.maxY * boxSize,
  };
}

describe("stylePreviewOrigin", () => {
  // drawn = clamp(scale, 0.5, 2) * 0.6 (see `stylePreview`), so scale 1 —
  // CURSOR_DEFAULTS.scale — is drawn 0.6, scale 0.5 is drawn 0.3, and scale
  // 2 is drawn 1.2.

  it("centres the touch circle exactly, at the default scale", () => {
    const at = stylePreviewOrigin("touch", 0.6, PREVIEW_CANVAS_SIZE);
    expect(at.x).toBeCloseTo(22, 5);
    expect(at.y).toBeCloseTo(22, 5);
  });

  it("centres the arrow's ink, nudged 1.5px right, at the default scale", () => {
    // The arrow's ink fills only the box's top-left 56% x 87%, so centring
    // the box (as until 2026-09-22) left the arrow visibly left of centre:
    // its tip landed at (10, 10) and its ink centred 5.3px left of the
    // canvas. Ink-centred still read left to the eye, so it sits 1.5px
    // right of that (see `OPTICAL_NUDGE`); vertically it is centred exactly.
    for (const style of ["light", "dark"] as const) {
      const ext = inkExtent(style, 0.6);
      expect((ext.minX + ext.maxX) / 2, `${style} x`).toBeCloseTo(23.5, 5);
      expect((ext.minY + ext.maxY) / 2, `${style} y`).toBeCloseTo(22, 5);
    }
  });
});

describe("stylePreviewDrawn", () => {
  it("is unchanged below where the cap binds", () => {
    // The cap binds only once clamped-scale * PREVIEW_SCALE exceeds
    // canvasSize / height = 44 / 40 = 1.1, i.e. above scale ~1.83 — so the
    // default scale and the slider's minimum draw exactly as before this
    // round.
    expect(stylePreviewDrawn("light", 1, PREVIEW_CANVAS_SIZE)).toBeCloseTo(
      0.6,
      5,
    );
    expect(stylePreviewDrawn("light", 0.5, PREVIEW_CANVAS_SIZE)).toBeCloseTo(
      0.3,
      5,
    );
  });

  it("caps at what the canvas can hold once the slider would overflow it", () => {
    // Uncapped, scale 2 draws at 2 * 0.6 = 1.2, giving a 40 * 1.2 = 48px
    // nominal box against a 44px canvas. The cap holds it to
    // 44 / 40 = 1.1 instead. Applied uniformly by style height rather than
    // by name, so it also caps touch's draw size here even though touch
    // does not strictly need it (its hotspot already keeps it inside the
    // canvas uncapped) — one formula, no per-style branching.
    expect(stylePreviewDrawn("light", 2, PREVIEW_CANVAS_SIZE)).toBeCloseTo(
      1.1,
      5,
    );
    expect(stylePreviewDrawn("touch", 2, PREVIEW_CANVAS_SIZE)).toBeCloseTo(
      1.1,
      5,
    );
  });
});

describe("style preview bounds — no clipping across the scale range", () => {
  it("keeps every style's drawn extent inside the canvas at any scale across 0.5–2", () => {
    // This is the assertion that should have caught both the original bug
    // (touch clipped at the default scale) and its residual (light/dark's
    // nominal box outgrowing the canvas at the slider's maximum, fixed by
    // `stylePreviewDrawn`'s cap) from the start. It could not be written
    // unconditionally until the cap existed — until then, the top of the
    // range genuinely did clip. `1.83` and `1.9` bracket the point where
    // the cap starts binding, so both sides of that edge are covered.
    for (const scale of [0.5, 0.75, 1, 1.5, 1.83, 1.9, 2]) {
      for (const style of ["light", "dark", "touch"] as const) {
        const drawn = stylePreviewDrawn(style, scale, PREVIEW_CANVAS_SIZE);
        const ext = inkExtent(style, drawn);
        expect(
          ext.minX,
          `${style} at scale=${scale}: minX`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          ext.minY,
          `${style} at scale=${scale}: minY`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          ext.maxX,
          `${style} at scale=${scale}: maxX`,
        ).toBeLessThanOrEqual(PREVIEW_CANVAS_SIZE);
        expect(
          ext.maxY,
          `${style} at scale=${scale}: maxY`,
        ).toBeLessThanOrEqual(PREVIEW_CANVAS_SIZE);
      }
    }
  });
});

describe("renderCursor", () => {
  // jsdom has no 2D canvas context (the `canvas` package is not installed
  // here), so every `draw()` below takes `stylePreview`'s fallback branch
  // for all three styles and would otherwise print three "no 2D context"
  // lines to stderr per render — noise this repo's own rule treats as a
  // finding. Pinning it here does two jobs: stderr goes quiet, and the
  // fallback itself — the panel's one documented failure path — gets a
  // guard instead of running unobserved in every other test in this file.
  let errors: string[];
  beforeEach(() => {
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says so when a style button cannot paint its preview", () => {
    // jsdom has no 2D canvas context (the `canvas` package is not installed
    // here), so this lane always takes the fallback. That makes it the one
    // place the fallback can be asserted at all — and without this the same
    // condition just printed three lines of stderr per render and proved
    // nothing. The real paint path is covered in the browser lane instead.
    draw();
    expect(errors.filter((e) => /no 2D context/.test(e))).toHaveLength(3);
    // The button is still there and still selectable: a preview that did not
    // paint must not take the control with it.
    expect(root.querySelectorAll("[data-cursor-style]").length).toBe(3);
  });

  it("shows the authored size and blur on their sliders", () => {
    draw({ scale: 1.5, motionBlur: 0.25 });
    expect(q<HTMLInputElement>("[data-cursor-scale]")?.value).toBe("1.5");
    expect(q<HTMLInputElement>("[data-cursor-blur]")?.value).toBe("0.25");
  });

  it("defaults motion blur to its maximum", () => {
    draw();
    const blur = q<HTMLInputElement>("[data-cursor-blur]");
    expect(blur?.value).toBe(blur?.max);
  });

  it("presses the authored style and no other", () => {
    draw({ style: "touch" });
    const pressed = [...root.querySelectorAll("[data-cursor-style]")]
      .filter((b) => b.getAttribute("aria-checked") === "true")
      .map((b) => b.getAttribute("data-cursor-style"));
    expect(pressed).toEqual(["touch"]);
  });

  it("offers all three styles, each with a painted preview", () => {
    draw();
    const buttons = [...root.querySelectorAll("[data-cursor-style]")];
    expect(buttons.map((b) => b.getAttribute("data-cursor-style"))).toEqual([
      "light",
      "dark",
      "touch",
    ]);
    for (const b of buttons) expect(b.querySelector("canvas")).not.toBeNull();
  });

  it("commits a style on click", () => {
    const h = draw();
    q<HTMLButtonElement>('[data-cursor-style="dark"]')?.click();
    expect(h.onCursor).toHaveBeenCalledWith({ style: "dark" });
  });

  it("previews a slider while it is dragged and commits when it is released", () => {
    const h = draw();
    const scale = q<HTMLInputElement>("[data-cursor-scale]");
    if (!scale) throw new Error("no size slider");
    scale.value = "1.8";
    scale.dispatchEvent(new Event("input"));
    expect(h.onCursorPreview).toHaveBeenCalledWith({ scale: 1.8 });
    expect(h.onCursor).not.toHaveBeenCalled();
    scale.dispatchEvent(new Event("change"));
    expect(h.onCursor).toHaveBeenCalledWith({ scale: 1.8 });
  });

  /**
   * The release that commits nothing still has to end the preview.
   *
   * Blink dispatches `change` on a range input only when the released value
   * differs from the one the drag began at, so a drag that wanders and
   * returns to its starting value releases with `onCursor` never called —
   * and `onCursor` is what `main.ts` drops its override on. Left there, the
   * override layered over every later snapshot: undo appeared to do nothing
   * in the panel and on the canvas while the export path, which reads the
   * stored document, still rendered the real value.
   *
   * jsdom does not implement that `change` rule, so these two cases give it
   * the event sequence Blink gives — the point under test is which handler
   * `cursorSlider` calls on `pointerup`, not jsdom's event dispatch.
   */
  it("ends the preview when a drag returns to its starting value", () => {
    const h = draw();
    const scale = q<HTMLInputElement>("[data-cursor-scale]");
    if (!scale) throw new Error("no size slider");
    scale.value = "1.8";
    scale.dispatchEvent(new Event("input"));
    scale.value = "1";
    scale.dispatchEvent(new Event("input"));
    scale.dispatchEvent(new Event("pointerup"));
    expect(h.onCursor).not.toHaveBeenCalled();
    expect(h.onCursorPreviewEnd).toHaveBeenCalled();
  });

  it("leaves the preview standing when the release is about to commit", () => {
    const h = draw();
    const scale = q<HTMLInputElement>("[data-cursor-scale]");
    if (!scale) throw new Error("no size slider");
    scale.value = "1.8";
    scale.dispatchEvent(new Event("input"));
    scale.dispatchEvent(new Event("pointerup"));
    // `change` has not been dispatched yet. Ending the preview here would
    // put the document's old look back on the canvas for the frame between
    // the two events — and if it re-rendered the panel to do it, the
    // detached input would never dispatch `change` at all.
    expect(h.onCursorPreviewEnd).not.toHaveBeenCalled();
    scale.dispatchEvent(new Event("change"));
    expect(h.onCursor).toHaveBeenCalledWith({ scale: 1.8 });
  });

  it("disables every other control while the cursor is hidden", () => {
    draw({ hidden: true });
    const others = [
      ...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        "[data-cursor-scale], [data-cursor-blur], [data-cursor-idle], [data-cursor-style]",
      ),
    ];
    // Three style buttons plus the two sliders and the idle switch: six,
    // not five — the selector matches all three `[data-cursor-style]`
    // buttons individually. A wrong count here would let this test pass by
    // matching nothing, which is exactly what it exists to rule out.
    expect(others.length).toBe(6);
    expect(others.every((c) => c.disabled)).toBe(true);
  });

  it("adds no text to the panel when the cursor is hidden", () => {
    // The disabled controls are the whole signal. Until 2026-09-22 a note
    // under the switch also said "The cursor is hidden, so nothing below it
    // is drawn." — removed at the author's request.
    draw({ hidden: false });
    const shown = root.textContent;
    root = document.createElement("div");
    draw({ hidden: true });
    // The premise: the panel really rendered text to compare.
    expect(shown).toMatch(/Hide cursor/);
    expect(root.textContent).toBe(shown);
  });

  it("re-enables them when the cursor is shown", () => {
    draw({ hidden: false });
    const others = [
      ...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        "[data-cursor-scale], [data-cursor-blur], [data-cursor-idle], [data-cursor-style]",
      ),
    ];
    expect(others.every((c) => c.disabled)).toBe(false);
  });
  // The polish rows. Each slider's value, readout, preview, commit and end
  // are asserted per control: they share `panelSlider`, but which handler a
  // row calls and which field it names is per row, and a row wired to the
  // wrong block or field is exactly what a shared-helper test would miss.
  const readout = (sel: string) =>
    q<HTMLInputElement>(sel)?.parentElement?.querySelector(".slider-value")
      ?.textContent;

  it("shows tilt and click bounce at their defaults when the document has none", () => {
    // Premise: the defaults block really lacks both fields, so this reads
    // the fallback rather than a stored value that happens to match.
    expect("tilt" in CURSOR_DEFAULTS).toBe(false);
    expect("clickBounce" in CURSOR_DEFAULTS).toBe(false);
    draw();
    expect(q<HTMLInputElement>("[data-cursor-tilt]")?.value).toBe("0.5");
    expect(readout("[data-cursor-tilt]")).toBe("50%");
    expect(q<HTMLInputElement>("[data-cursor-bounce]")?.value).toBe("1");
    expect(q<HTMLInputElement>("[data-cursor-bounce]")?.max).toBe("2");
    expect(readout("[data-cursor-bounce]")).toBe("1.00x");
  });

  it("shows the authored tilt and click bounce", () => {
    draw({ tilt: 0.2, clickBounce: 1.5 });
    expect(q<HTMLInputElement>("[data-cursor-tilt]")?.value).toBe("0.2");
    expect(readout("[data-cursor-tilt]")).toBe("20%");
    expect(q<HTMLInputElement>("[data-cursor-bounce]")?.value).toBe("1.5");
    expect(readout("[data-cursor-bounce]")).toBe("1.50x");
  });

  it("shows the camera's motion under a Camera heading", () => {
    draw({}, { smoothness: 0.8, blur: 0.15, follow: false });
    const heading = [...root.querySelectorAll(".cursor-label")].map(
      (n) => n.textContent,
    );
    expect(heading).toEqual(["Style", "Camera"]);
    expect(q<HTMLInputElement>("[data-motion-smoothness]")?.value).toBe("0.8");
    expect(readout("[data-motion-smoothness]")).toBe("80%");
    expect(q<HTMLInputElement>("[data-motion-blur]")?.value).toBe("0.15");
    expect(readout("[data-motion-blur]")).toBe("15%");
    expect(q<HTMLInputElement>("[data-motion-follow]")?.checked).toBe(false);
    // The heading comes after every pointer row and before its own rows.
    const precedes = (a: string, b: string) => {
      const [x, y] = [q(a), q(b)];
      if (!x || !y) throw new Error(`missing ${x ? b : a}`);
      return (
        (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      );
    };
    expect(precedes("[data-cursor-bounce]", "[data-cursor-idle]")).toBe(true);
    expect(precedes("[data-cursor-idle]", ".camera-label")).toBe(true);
    expect(precedes(".camera-label", "[data-motion-smoothness]")).toBe(true);
    expect(precedes("[data-motion-blur]", "[data-motion-follow]")).toBe(true);
  });

  it("labels every new row and adds no other text", () => {
    draw();
    const text = root.textContent ?? "";
    for (const label of [
      "Tilt",
      "Click bounce",
      "Camera",
      "Smoothness",
      "Camera blur",
      "Follow cursor",
    ]) {
      expect(text).toContain(label);
    }
    // No helper copy anywhere: the panel is its labels and readouts.
    expect(root.querySelectorAll(".hint, .muted").length).toBe(0);
  });

  for (const [sel, field, to] of [
    ["[data-cursor-tilt]", "tilt", 0.85],
    ["[data-cursor-bounce]", "clickBounce", 1.75],
  ] as const) {
    it(`previews ${field} on input and commits it on change, to the cursor`, () => {
      const h = draw();
      const slider = q<HTMLInputElement>(sel);
      if (!slider) throw new Error(`no ${field} slider`);
      slider.value = String(to);
      slider.dispatchEvent(new Event("input"));
      expect(h.onCursorPreview).toHaveBeenCalledWith({ [field]: to });
      expect(h.onCursor).not.toHaveBeenCalled();
      expect(h.onMotionPreview).not.toHaveBeenCalled();
      // The readout moves in place with the thumb.
      expect(readout(sel)).toBe(
        field === "tilt" ? `${Math.round(to * 100)}%` : `${to.toFixed(2)}x`,
      );
      slider.dispatchEvent(new Event("change"));
      expect(h.onCursor).toHaveBeenCalledWith({ [field]: to });
      expect(h.onMotion).not.toHaveBeenCalled();
    });
  }

  for (const [sel, field] of [
    ["[data-motion-smoothness]", "smoothness"],
    ["[data-motion-blur]", "blur"],
  ] as const) {
    it(`previews ${field} on input and commits it on change, to the motion block`, () => {
      const h = draw();
      const slider = q<HTMLInputElement>(sel);
      if (!slider) throw new Error(`no ${field} slider`);
      slider.value = "0.9";
      slider.dispatchEvent(new Event("input"));
      expect(h.onMotionPreview).toHaveBeenCalledWith({ [field]: 0.9 });
      expect(h.onMotion).not.toHaveBeenCalled();
      expect(h.onCursorPreview).not.toHaveBeenCalled();
      expect(readout(sel)).toBe("90%");
      slider.dispatchEvent(new Event("change"));
      expect(h.onMotion).toHaveBeenCalledWith({ [field]: 0.9 });
      expect(h.onCursor).not.toHaveBeenCalled();
    });

    it(`ends the ${field} preview when a drag returns to its starting value`, () => {
      const h = draw();
      const slider = q<HTMLInputElement>(sel);
      if (!slider) throw new Error(`no ${field} slider`);
      slider.value = "0.9";
      slider.dispatchEvent(new Event("input"));
      slider.value = "0.5";
      slider.dispatchEvent(new Event("input"));
      slider.dispatchEvent(new Event("pointerup"));
      expect(h.onMotion).not.toHaveBeenCalled();
      expect(h.onMotionPreviewEnd).toHaveBeenCalled();
      expect(h.onCursorPreviewEnd).not.toHaveBeenCalled();
    });
  }

  it("commits Follow cursor to the motion block on click", () => {
    const h = draw();
    const follow = q<HTMLInputElement>("[data-motion-follow]");
    if (!follow) throw new Error("no follow switch");
    // Premise: on by default, so the click turns it off.
    expect(follow.checked).toBe(true);
    follow.click();
    expect(h.onMotion).toHaveBeenCalledWith({ follow: false });
    expect(h.onCursor).not.toHaveBeenCalled();
  });

  it("disables tilt and click bounce with the cursor, and leaves the camera alone", () => {
    draw({ hidden: true });
    const pointer = [
      ...root.querySelectorAll<HTMLInputElement>(
        "[data-cursor-tilt], [data-cursor-bounce]",
      ),
    ];
    const camera = [
      ...root.querySelectorAll<HTMLInputElement>(
        "[data-motion-smoothness], [data-motion-blur], [data-motion-follow]",
      ),
    ];
    // Counted, so a selector that matched nothing cannot pass either half.
    expect(pointer.length).toBe(2);
    expect(camera.length).toBe(3);
    expect(pointer.every((c) => c.disabled)).toBe(true);
    expect(camera.some((c) => c.disabled)).toBe(false);
  });

  it("enables tilt and click bounce when the cursor is shown", () => {
    draw({ hidden: false });
    const pointer = [
      ...root.querySelectorAll<HTMLInputElement>(
        "[data-cursor-tilt], [data-cursor-bounce]",
      ),
    ];
    expect(pointer.length).toBe(2);
    expect(pointer.some((c) => c.disabled)).toBe(false);
  });
});

// Spec 2026-10-10 §5: a phone take is drawn as taps, so the panel offers only
// what a tap reads — hidden and size — and none of the arrow's own controls.
describe("the Cursor panel for a touch take", () => {
  const ARROW_ONLY = [
    "[data-cursor-style]",
    "[data-cursor-blur]",
    "[data-cursor-tilt]",
    "[data-cursor-bounce]",
    "[data-cursor-idle]",
  ];

  it("shows hide and size, and nothing that only the arrow reads", () => {
    renderCursor(root, CURSOR_DEFAULTS, MOTION_DEFAULTS, handlers(), true);
    expect(q("[data-cursor-hidden]")).not.toBeNull();
    expect(q("[data-cursor-scale]")).not.toBeNull();
    for (const sel of ARROW_ONLY) expect(q(sel), sel).toBeNull();
    // The camera rows are about the camera, not the pointer: still there.
    expect(q("[data-motion-smoothness]")).not.toBeNull();
  });

  it("shows every control for a desktop take", () => {
    renderCursor(root, CURSOR_DEFAULTS, MOTION_DEFAULTS, handlers(), false);
    for (const sel of ARROW_ONLY) expect(q(sel), sel).not.toBeNull();
  });
});
