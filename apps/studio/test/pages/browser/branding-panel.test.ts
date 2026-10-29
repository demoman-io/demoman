import type { SceneBranding } from "@demoman/scene-schema";
import { page } from "@vitest/browser/context";
import { describe, expect, it, vi } from "vitest";
// The project's own marks: a square logomark, and a lockup more than three
// times as wide as it is tall. The square one is what spilled out of the
// tile on 2026-10-07 while the lockups fitted.
import lockupDark from "../../../../../brand/lockup_dark.svg?raw";
import logomark from "../../../../../brand/logomark.svg?raw";
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderBranding } from "../../../pages/entrypoints/editor/view";
import { decodeLogo, logoThumbnail } from "../../../pages/src/adapters/logo";
import type {
  KitRowProps,
  LogoThumb,
} from "../../../pages/src/branding/controls";
import type { KitEntry } from "../../../pages/src/core/brand-kit";
import {
  contrast,
  mountShell,
  over,
  pageParts,
  parse,
  token,
} from "../helpers/shell-css";

// Throws if the page stops linking the shell or carrying the inspector's
// rules, so a drifted stylesheet fails loudly instead of every assertion
// below measuring unstyled defaults.
const { css } = pageParts(shell, "#inspector");

const BRANDING: SceneBranding = {
  background: {
    kind: "gradient",
    from: "#1b2a4a",
    to: "#3b5bdb",
    angle: 135,
  },
  logo: { ref: "logo:a", corner: "bottom-right", size: 0.2, opacity: 0.9 },
  padding: 0.08,
};

function mountPanel(
  scheme: "light" | "dark",
  logoThumb: LogoThumb | null = null,
  kit?: KitRowProps,
): HTMLElement {
  mountShell(scheme, css);
  // `--panel-w`, pinned as the Cursor panel's browser test does: an unstyled
  // aside would collapse to its content and lay the controls out narrower
  // than the real editor ever does.
  document.body.innerHTML =
    '<aside id="inspector" style="width: 320px"><div data-panel-branding></div></aside>';
  const host = document.querySelector("[data-panel-branding]") as HTMLElement;
  renderBranding(
    host,
    {
      branding: BRANDING,
      logoThumb,
      logoPlacement: {
        rect: { x: 0, y: 0, width: 10, height: 5 },
        effectiveSize: 0.13,
        capped: true,
      },
      formatTitle: "Landscape video",
      logoNotes: [
        "Upscaled in a Landscape video export — an SVG or a larger PNG stays sharp",
      ],
      ...(kit === undefined ? {} : { kit }),
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
  return host;
}

const q = <T extends HTMLElement>(root: ParentNode, sel: string): T => {
  const node = root.querySelector<T>(sel);
  if (!node) throw new Error(`no ${sel}`);
  return node;
};

/** The element actually painted at `el`'s centre — the check a rect cannot
 *  make: a control with a clean rect can still be painted over. */
function paintedAtCentre(el: Element): Element | null {
  const r = el.getBoundingClientRect();
  return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
}

describe("the Background panel, as painted", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`shows every swatch and corner unobstructed in ${scheme}, below full height`, async () => {
      // Below the ~900px height where the preview once painted over the
      // timeline (CLAUDE.md, "Check the editor below full screen").
      await page.viewport(1155, 720);
      const root = mountPanel(scheme);
      const swatches = [
        ...root.querySelectorAll<HTMLInputElement>('input[type="color"]'),
      ];
      // Premise: a gradient mounts two colour fields.
      expect(swatches.map((s) => s.value)).toEqual(["#1b2a4a", "#3b5bdb"]);
      for (const swatch of swatches) {
        expect(
          paintedAtCentre(swatch),
          swatch.getAttribute("aria-label") ?? "",
        ).toBe(swatch);
      }
      const corners = [
        ...root.querySelectorAll<HTMLButtonElement>("[data-logo-corner]"),
      ];
      expect(corners).toHaveLength(4);
      for (const corner of corners) {
        expect(paintedAtCentre(corner), corner.title).toBe(corner);
      }
      await page.screenshot({
        path: `__screenshots__/branding-panel-${scheme}.png`,
      });
    });

    it(`tells the checked corner apart from the others in ${scheme}`, () => {
      const root = mountPanel(scheme);
      const checked = q(root, '[data-logo-corner="bottom-right"]');
      const unchecked = q(root, '[data-logo-corner="top-left"]');
      // Premise: the fixture's logo is in the bottom-right.
      expect(checked.getAttribute("aria-checked")).toBe("true");
      const mark = (el: Element) =>
        getComputedStyle(el, "::after").backgroundColor;
      expect(mark(checked)).not.toBe(mark(unchecked));
      // And an unchecked corner's outline separates from the frame it sits
      // on (mockup A: the corner buttons have no edge of their own) — the
      // threshold the Cursor panel's style buttons are held to.
      const card = over(token("--card"), parse("rgb(255, 255, 255)"));
      const frame = over(
        parse(getComputedStyle(q(root, ".corner-frame")).backgroundColor),
        card,
      );
      const outline = parse(
        getComputedStyle(unchecked, "::after").borderTopColor,
      );
      expect(contrast(over(outline, frame), frame)).toBeGreaterThan(1.3);
    });

    // The author's pick (mockup A, 2026-10-08): a logo well big enough to
    // read, Replace and Remove stacked beside it, and the corner picker a
    // frame across the panel, centred. Red if any goes back to the 32px
    // tile in a wrapping row, or the 68px grid hugging the left edge.
    it(`lays the logo out as the mockup does in ${scheme}, and screenshots it`, async () => {
      await page.viewport(1155, 900);
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 160;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = "#cdeb45";
      ctx.beginPath();
      ctx.arc(80, 80, 64, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(170, 60, 290, 40);
      const root = mountPanel(scheme, {
        kind: "ready",
        url: canvas.toDataURL("image/png"),
      });
      const img = q(root, ".logo-thumb-img") as HTMLImageElement;
      await img.decode();
      const well = q(root, ".logo-thumb").getBoundingClientRect();
      const replace = q(root, ".logo-stack label.btn").getBoundingClientRect();
      const remove = q(root, "[data-logo-remove]").getBoundingClientRect();
      const frame = q(root, ".corner-frame").getBoundingClientRect();
      const row = (
        q(root, ".corner-frame").parentElement as HTMLElement
      ).getBoundingClientRect();
      expect(well.height, "the well").toBeGreaterThanOrEqual(70);
      expect(
        well.width,
        "the well takes the row's spare width",
      ).toBeGreaterThan(140);
      expect(
        img.getBoundingClientRect().height,
        "the logo reads",
      ).toBeGreaterThan(40);
      expect(remove.top, "Remove under Replace").toBeGreaterThanOrEqual(
        replace.bottom,
      );
      expect(Math.abs(remove.left - replace.left), "one column").toBeLessThan(
        1,
      );
      expect(replace.left, "the stack beside the well").toBeGreaterThan(
        well.right,
      );
      expect(frame.width, "the frame").toBeGreaterThanOrEqual(200);
      expect(
        Math.abs(frame.left - row.left - (row.right - frame.right)),
        "centred",
      ).toBeLessThan(2);
      q(root, ".logo-controls").scrollIntoView({ block: "start" });
      await page.screenshot({
        path: `__screenshots__/branding-logo-${scheme}.png`,
        element: q(root, ".logo-controls"),
      });
    });

    // `.slider-row` is two lines by design: label and readout on the first,
    // the slider across the second, as the logo's Size row draws.
    it(`draws the Padding row as its sibling sliders do, within the panel, in ${scheme}`, async () => {
      const host = mountPanel(scheme);
      const slider = q<HTMLInputElement>(host, "[data-padding]");
      const row = slider.closest(".slider-row") as HTMLElement | null;
      expect(row, "the Padding row").not.toBeNull();
      if (!row) return;
      const label = q(row, ".slider-label");
      const readout = q(row, ".slider-value");
      expect(label.textContent).toBe("Padding");
      expect(readout.textContent).toBe("8%");
      const r = row.getBoundingClientRect();
      const panel = host.getBoundingClientRect();
      const l = label.getBoundingClientRect();
      const v = readout.getBoundingClientRect();
      const s = slider.getBoundingClientRect();
      expect(r.width).toBeGreaterThan(100);
      expect(r.right).toBeLessThanOrEqual(panel.right + 0.5);
      // Label and readout share the first line, readout at its end.
      expect(Math.abs(l.bottom - v.bottom)).toBeLessThan(4);
      expect(v.left).toBeGreaterThan(l.right);
      // The slider spans the line below, and nothing paints over it.
      expect(s.top).toBeGreaterThanOrEqual(l.bottom - 0.5);
      expect(s.width).toBeGreaterThan(r.width * 0.9);
      expect(paintedAtCentre(slider)).toBe(slider);
      await page.screenshot({
        path: `__screenshots__/branding-padding-${scheme}.png`,
        element: row,
      });
    });

    it(`keeps the colour text readable in ${scheme}`, () => {
      const root = mountPanel(scheme);
      const text = q<HTMLInputElement>(root, "[data-colour-text]");
      const style = getComputedStyle(text);
      const bed = over(
        parse(style.backgroundColor),
        over(token("--card"), parse("rgb(255, 255, 255)")),
      );
      const ink = over(parse(style.color), bed);
      expect(contrast(ink, bed)).toBeGreaterThanOrEqual(4.5);
      // A pasted hex reads as code. Asserted on the computed face: the
      // shell's input rule once overrode a class rule setting it directly.
      expect(style.fontFamily).toMatch(/mono|Menlo/i);
    });
  }
});

describe("the kit picker, as painted (mockup A)", () => {
  const kits = {
    state: "ready" as const,
    migrationPending: false,
    defaultId: "a",
    kits: [
      {
        id: "a",
        name: "Dark",
        read: { state: "ready" as const, kit: BRANDING },
      },
      {
        id: "b",
        name: "Brand gradient",
        read: {
          state: "ready" as const,
          kit: {
            ...BRANDING,
            background: {
              kind: "gradient" as const,
              from: "#ff00aa",
              to: "#3b5bdb",
              angle: 135,
            },
          },
        },
      },
    ],
  };
  const props = (): KitRowProps => ({
    read: kits,
    standing: { kit: kits.kits[0] as KitEntry, edited: true },
    naming: null,
    onApply: vi.fn(),
    onUpdate: vi.fn(),
    onStartNew: vi.fn(),
    onNameInput: vi.fn(),
    onConfirmNew: vi.fn(),
    onCancelNew: vi.fn(),
  });
  for (const scheme of ["light", "dark"] as const) {
    // Red if the menu is clipped by the panel or painted under the
    // controls below it, or the picker loses its Edited mark.
    it(`draws the picker, Edited, and its menu over the panel in ${scheme}, and screenshots it`, async () => {
      await page.viewport(1155, 900);
      const root = mountPanel(scheme, null, props());
      const picker = q(root, "[data-kit-picker]");
      expect(q(root, "[data-kit-edited]").textContent).toBe("Edited");
      const edited = getComputedStyle(q(root, "[data-kit-edited]")).color;
      expect(edited).not.toBe(getComputedStyle(picker).color);
      expect(picker.getBoundingClientRect().height).toBeGreaterThanOrEqual(34);
      await page.screenshot({
        path: `__screenshots__/kit-picker-${scheme}.png`,
        element: q(root, "[data-kit-row]"),
      });
      picker.click();
      const items = [
        ...root.querySelectorAll<HTMLElement>(
          "[data-kit-option], [data-kit-update], [data-kit-new]",
        ),
      ];
      expect(items).toHaveLength(4);
      for (const item of items) {
        expect(
          paintedAtCentre(item)?.closest("button"),
          item.textContent ?? "",
        ).toBe(item);
      }
      const menu = q(root, "[data-kit-menu]");
      const r = menu.getBoundingClientRect();
      await page.screenshot({
        path: `__screenshots__/kit-picker-menu-${scheme}.png`,
        // The row and the menu over what lies below it.
        element: q(root, ".branding-controls"),
      });
      expect(r.height).toBeGreaterThan(120);
    });
  }
});

describe("the logo's thumbnail, as painted", () => {
  // A portrait mark too: the one shape neither brand file has.
  const TALL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 60"><rect width="20" height="60" fill="#7c3aed"/></svg>`;
  // Each brand file's shape, from its own viewBox, so a redrawn mark keeps
  // the premise below honest.
  const aspectOf = (svg: string) => {
    const [, , w, h] = (svg.match(/viewBox="([^"]+)"/)?.[1] ?? "")
      .split(/\s+/)
      .map(Number);
    return (w as number) / (h as number);
  };
  // And the shapes the comment at the top claims: square, and over 3:1.
  expect(aspectOf(logomark)).toBeCloseTo(1, 5);
  expect(aspectOf(lockupDark)).toBeGreaterThan(3);
  for (const [name, svg, aspect] of [
    ["the logomark", logomark, aspectOf(logomark)],
    ["the lockup", lockupDark, aspectOf(lockupDark)],
    ["a tall mark", TALL, 1 / 3],
  ] as const) {
    // Red with a percentage cap on the image: the tile's row grows to the
    // image, so the cap measures the image against itself and a square
    // 80px thumbnail paints 80px tall in a 32px tile, at 1x.
    it(`keeps ${name} inside the tile, drawn at twice its painted size`, async () => {
      const source = await decodeLogo(
        new TextEncoder().encode(svg),
        "image/svg+xml",
      );
      const url = await logoThumbnail(source);
      const root = mountPanel("light", { kind: "ready", url });
      const tile = q(root, "[data-logo-thumb]");
      const img = q<HTMLImageElement>(tile, "img");
      await img.decode();
      // Premise: the thumbnail is this mark, at the shape the file has.
      expect(img.naturalWidth / img.naturalHeight).toBeCloseTo(aspect, 1);
      const t = tile.getBoundingClientRect();
      const i = img.getBoundingClientRect();
      const cs = getComputedStyle(tile);
      const inset = (side: "Top" | "Right" | "Bottom" | "Left") =>
        Number.parseFloat(cs[`border${side}Width`]) +
        Number.parseFloat(cs[`padding${side}`]);
      const box = JSON.stringify({ tile: t, img: i });
      expect(i.top, box).toBeGreaterThanOrEqual(t.top + inset("Top") - 0.5);
      expect(i.bottom, box).toBeLessThanOrEqual(
        t.bottom - inset("Bottom") + 0.5,
      );
      expect(i.left, box).toBeGreaterThanOrEqual(t.left + inset("Left") - 0.5);
      expect(i.right, box).toBeLessThanOrEqual(t.right - inset("Right") + 0.5);
      // The whole mark, not a crop: painted at the file's own shape.
      expect(i.width / i.height).toBeCloseTo(aspect, 1);
      // Sharp on a 2x screen: at least two of the thumbnail's pixels per
      // CSS pixel painted, in both directions.
      expect(img.naturalHeight, box).toBeGreaterThanOrEqual(2 * i.height);
      expect(img.naturalWidth, box).toBeGreaterThanOrEqual(2 * i.width);
      await page.screenshot({
        path: `__screenshots__/logo-thumb-${name.replace(/\s+/g, "-")}.png`,
        element: tile.parentElement as HTMLElement,
      });
    });
  }
});
