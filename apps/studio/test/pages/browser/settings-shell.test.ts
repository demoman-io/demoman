import { page } from "@vitest/browser/context";
import { afterAll, describe, expect, it } from "vitest";
import library from "../../../pages/entrypoints/library/index.html?raw";
import shell from "../../../pages/entrypoints/settings/index.html?raw";
import { paintKitPreview } from "../../../pages/src/settings/kit-preview";
import { trackSectionNav } from "../../../pages/src/settings/section-nav";
import type { SettingsModel } from "../../../pages/src/settings/state";
import { renderSettings } from "../../../pages/src/settings/view";
import {
  contrast,
  ink,
  mountShell,
  node,
  pageParts,
  parse,
  surface,
} from "../helpers/shell-css";

/**
 * The Settings page's painted surface, and the header every tabbed page
 * shares, in both themes. The header's claim — it sits in the same place
 * on every page, so only the content beneath it changes — and the tabs'
 * claim — the current page reads as current — are about paint and
 * geometry, so they are read back from the shipped markup of all three
 * pages, mounted in the order the build emits the sheets.
 */

const { css, body: bodyHtml } = pageParts(shell, "[data-section");

/** The selected kit in `MODEL`: a solid, so the card has one swatch. */
const DARK_KIT = {
  background: { kind: "solid" as const, color: "#1b2a4a" },
  logo: {
    ref: "logo:kit",
    corner: "bottom-right" as const,
    size: 0.06,
    opacity: 0.9,
  },
  padding: 0.08,
};

const MODEL: SettingsModel = {
  // Three kits, the second the default, the first selected: the strip,
  // the star in both states, and the selected ring all on one card.
  brandKits: {
    state: "ready",
    migrationPending: false,
    defaultId: "kit-light",
    kits: [
      { id: "kit-dark", name: "Dark", read: { state: "ready", kit: DARK_KIT } },
      {
        id: "kit-light",
        name: "Light",
        read: {
          state: "ready",
          kit: {
            ...DARK_KIT,
            background: { kind: "solid", color: "#f4f1ea" },
            logo: null,
          },
        },
      },
      {
        id: "kit-brand",
        name: "Brand gradient",
        read: {
          state: "ready",
          kit: {
            background: {
              kind: "gradient",
              from: "#ff00aa",
              to: "#3b5bdb",
              angle: 135,
            },
            logo: null,
            padding: 0.1,
          },
        },
      },
    ],
  },
  selectedKitId: "kit-dark",
  brandKitLogo: { ok: true },
  brandKitPlacement: null,
  brandKitLogoThumb: null,
  brandKitNotes: [],
  pullRequests: "off",
  exportQuality: "share",
  kitsUnwatched: null,
};

const noop = {
  setPullRequests() {},
  setExportQuality() {},
  setBrandKit() {},
  previewBrandKit() {},
  uploadKitLogo() {},
  selectKit() {},
  newKit() {},
  duplicateKit() {},
  deleteKit() {},
  renameKit() {},
  setDefaultKit() {},
  resetKits() {},
};

const PAGES = [
  ["library", library, "article.card:hover"],
  ["settings", shell, "[data-section"],
] as const;

function mount(scheme: "light" | "dark", model: SettingsModel = MODEL) {
  mountShell(scheme, css, "build");
  document.body.innerHTML = bodyHtml;
  renderSettings(
    node("#root"),
    model,
    noop,
    new Map([
      ["export", "Couldn't read the Export quality setting: no reply."],
    ]),
  );
  // The page scrolls smoothly when a nav link is followed. A case here
  // measures straight after `scrollIntoView`, which would still be on its
  // way, so this lane scrolls at once.
  document.documentElement.style.scrollBehavior = "auto";
}

afterAll(async () => {
  await page.viewport(414, 896);
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("scroll-behavior");
});

describe.each(["light", "dark"] as const)("the Settings page, %s", (scheme) => {
  it("paints the Brand kit's controls unobstructed, and screenshots them", async () => {
    await page.viewport(1155, 720);
    mount(scheme);
    const kit = node('[data-section="brandKit"]');
    kit.scrollIntoView();
    // Each into view first: the preview holds the tallest frame's height
    // (`KIT_PREVIEW_BOX`), and below it the section runs past this window.
    const painted = (el: Element) => {
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    };
    const swatch = kit.querySelector<HTMLInputElement>('input[type="color"]');
    // Premise: the fixture kit is a solid, so there is one swatch.
    expect(swatch?.value).toBe("#1b2a4a");
    expect(painted(swatch as Element)).toBe(swatch);
    for (const corner of kit.querySelectorAll("[data-logo-corner]")) {
      expect(painted(corner), (corner as HTMLElement).title).toBe(corner);
    }
    // Painted as the page paints it after a render (`paintPreview`), so the
    // screenshot shows the preview rather than an empty box.
    const preview = kit.querySelector(
      "[data-preview-kit]",
    ) as HTMLCanvasElement;
    expect(paintKitPreview(preview, DARK_KIT, null, "#ffffff")).toBe(true);
    const px = (
      preview.getContext("2d") as CanvasRenderingContext2D
    ).getImageData(4, 4, 1, 1).data;
    expect(Array.from(px)).toEqual([0x1b, 0x2a, 0x4a, 255]);
    const text = kit.querySelector("[data-colour-text]") as HTMLElement;
    expect(getComputedStyle(text).fontFamily).toMatch(/mono|Menlo/i);
    await page.screenshot({
      path: `__screenshots__/settings-brand-kit-${scheme}.png`,
      element: kit,
    });
  });

  // Review 2026-10-06: the preview took the Auto frame's shape, which
  // follows the padding, so a Padding drag grew the canvas under the
  // pointer (about 300 to 353 tall at 480 wide) and slid the slider and
  // everything below it down mid-gesture. Red if repainting the preview at
  // another padding moves the controls under it.
  it("holds the Brand kit's controls still while the padding changes", async () => {
    // Narrow enough that the preview stacks above the controls, the only
    // layout in which its height could push them. 900 tall, not 720: under
    // 900 the preview is capped against the window (D3 shots, K2), and the
    // premise below wants it at its full width.
    await page.viewport(600, 900);
    mount(scheme);
    const kit = node('[data-section="brandKit"]');
    const preview = kit.querySelector(
      "[data-preview-kit]",
    ) as HTMLCanvasElement;
    const slider = kit.querySelector("[data-padding]") as HTMLElement;
    const base = DARK_KIT;
    const at = (padding: number) => {
      expect(
        paintKitPreview(preview, { ...base, padding }, null, "#ffffff"),
      ).toBe(true);
      return {
        slider: slider.getBoundingClientRect().top,
        preview: preview.getBoundingClientRect().height,
      };
    };
    const none = at(0);
    const most = at(0.2);
    // Premises: the preview is drawn at its full 480 width, where the two
    // frames differ by tens of pixels in height, and it is above the slider.
    expect(preview.getBoundingClientRect().width).toBe(480);
    expect(preview.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      slider.getBoundingClientRect().top,
    );
    expect(
      most.slider,
      `the slider sat at ${none.slider} at 0% and ${most.slider} at 20%`,
    ).toBe(none.slider);
    expect(most.preview).toBe(none.preview);
  });

  /** Paints every canvas in the card as the page does after a render
   *  (`paintPreview`): the hero, and each tile from its own kit. */
  const paintKits = (kit: HTMLElement) => {
    const read = MODEL.brandKits;
    if (read.state !== "ready") throw new Error("premise: MODEL's kits read");
    const hero = kit.querySelector("[data-preview-kit]") as HTMLCanvasElement;
    expect(paintKitPreview(hero, DARK_KIT, null, "#ffffff", 12)).toBe(true);
    for (const k of read.kits) {
      const thumb = kit.querySelector(
        `[data-kit-thumb="${k.id}"]`,
      ) as HTMLCanvasElement;
      if (k.read.state !== "ready") continue;
      expect(paintKitPreview(thumb, k.read.kit, null, "#ffffff", 12)).toBe(
        true,
      );
    }
  };

  // The author's ask (2026-10-08): the card was lopsided — a 300px preview
  // top-left against a full-height column of controls. The picture now runs
  // the card's width and the controls sit under it in three short groups.
  it("puts the kits' picture above three level groups on a wide card, and screenshots it", async () => {
    await page.viewport(1280, 900);
    mount(scheme);
    const kit = node('[data-section="brandKit"]');
    // Premise: the strip drew all three kits.
    expect(kit.querySelectorAll("[data-kit-tile]")).toHaveLength(3);
    const card = (
      kit.querySelector(".section-body") as HTMLElement
    ).getBoundingClientRect();
    // Premise: the card is past the 600px the three columns ask for.
    expect(card.width).toBeGreaterThan(600 + 48);
    const hero = (
      kit.querySelector("[data-preview-kit]") as HTMLElement
    ).getBoundingClientRect();
    const groups = [...kit.querySelectorAll(".branding-group")].map((g) =>
      g.getBoundingClientRect(),
    );
    expect(groups).toHaveLength(3);
    const tops = groups.map((g) => Math.round(g.top));
    expect(
      Math.max(...tops) - Math.min(...tops),
      `group tops ${tops}`,
    ).toBeLessThanOrEqual(2);
    // The groups share the card's width — the shell's 420px cap for the
    // editor's panel left the right of the card empty.
    const inner =
      Math.max(...groups.map((g) => g.right)) -
      Math.min(...groups.map((g) => g.left));
    expect(inner, "the groups' span against the card").toBeGreaterThan(
      (card.width - 48) * 0.9,
    );
    expect(hero.bottom, "the picture above the groups").toBeLessThanOrEqual(
      Math.min(...groups.map((g) => g.top)),
    );
    expect(hero.height, "the picture carries the card").toBeGreaterThanOrEqual(
      200,
    );
    // Nothing sticks any more (spec 2026-10-08 §2).
    expect(
      getComputedStyle(kit.querySelector(".kit-hero") as Element).position,
    ).toBe("static");
    // The default's star reads apart from an outlined one, and the selected
    // tile carries its ring, in both themes.
    const starOn = kit.querySelector('[data-kit-star="kit-light"]') as Element;
    const starOff = kit.querySelector('[data-kit-star="kit-dark"]') as Element;
    expect(starOn.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(starOn).color).not.toBe(
      getComputedStyle(starOff).color,
    );
    expect(
      getComputedStyle(starOn.querySelector("svg") as Element).fill,
    ).not.toBe("none");
    // The logo's tile on its own line, Replace and Remove level under it
    // (the author's report, 2026-10-08: the three wrapped unevenly).
    const logoTile = (
      kit.querySelector("[data-logo-thumb]") as Element
    ).getBoundingClientRect();
    const replace = (
      kit.querySelector(".logo-controls label.btn") as Element
    ).getBoundingClientRect();
    const remove = (
      kit.querySelector("[data-logo-remove]") as Element
    ).getBoundingClientRect();
    expect(
      Math.abs(replace.top - remove.top),
      "Replace and Remove level",
    ).toBeLessThan(1);
    expect(remove.left, "Remove after Replace").toBeGreaterThan(replace.right);
    expect(replace.top, "both under the tile").toBeGreaterThanOrEqual(
      logoTile.bottom,
    );
    const picked = kit.querySelector('[data-kit-select="kit-dark"]') as Element;
    expect(getComputedStyle(picked).outlineStyle).not.toBe("none");
    paintKits(kit);
    kit.scrollIntoView({ block: "start" });
    await page.screenshot({
      path: `__screenshots__/brand-kits-1280x900-${scheme}.png`,
      element: kit,
    });
  });

  // The author's report (2026-10-08): between a phone and the three-column
  // card, the stacked groups kept the editor panel's 420px cap and sat left
  // under a centred picture, empty on the right. Red if they go back to the
  // left edge: here they share the picture's centre line and its width.
  it("centres the stacked groups under the picture on a mid-width card, and screenshots it", async () => {
    await page.viewport(860, 900);
    mount(scheme);
    const kit = node('[data-section="brandKit"]');
    const body = (
      kit.querySelector(".section-body") as HTMLElement
    ).getBoundingClientRect();
    // Premise: the card is below the three-column width and wider than the
    // controls' cap, the range the report was about.
    expect(body.width - 48, "the card's inner width").toBeGreaterThan(480);
    expect(body.width - 48, "the card's inner width").toBeLessThan(600);
    const tops = [...kit.querySelectorAll(".branding-group")].map((g) =>
      Math.round(g.getBoundingClientRect().top),
    );
    expect(tops[1] as number, "stacked").toBeGreaterThan(tops[0] as number);
    const hero = (
      kit.querySelector("[data-preview-kit]") as HTMLElement
    ).getBoundingClientRect();
    const controls = (
      kit.querySelector(".branding-controls") as HTMLElement
    ).getBoundingClientRect();
    const mid = (r: DOMRect) => r.left + r.width / 2;
    expect(Math.abs(mid(controls) - mid(hero)), "one centre line").toBeLessThan(
      2,
    );
    expect(
      Math.abs(controls.width - hero.width),
      "the picture's width",
    ).toBeLessThan(2);
    paintKits(kit);
    kit.scrollIntoView({ block: "start" });
    await page.screenshot({
      path: `__screenshots__/brand-kits-860x900-${scheme}.png`,
      element: kit,
    });
  });

  // The author, 2026-10-08: centred at every size. Red if the groups leave
  // the picture's centre line at any of these widths — a phone, the
  // stacked mid width, the three columns, and a wide window (where the card
  // stops growing at its own cap).
  it("centres the groups on the picture's centre line at every width", async () => {
    const mid = (r: DOMRect) => r.left + r.width / 2;
    const layouts = new Set<string>();
    for (const [w, h] of [
      [390, 844],
      [860, 900],
      [1280, 900],
      [1920, 1000],
    ] as const) {
      await page.viewport(w, h);
      mount(scheme);
      const kit = node('[data-section="brandKit"]');
      const hero = (
        kit.querySelector("[data-preview-kit]") as HTMLElement
      ).getBoundingClientRect();
      const controls = (
        kit.querySelector(".branding-controls") as HTMLElement
      ).getBoundingClientRect();
      expect(
        Math.abs(mid(controls) - mid(hero)),
        `one centre line at ${w}px`,
      ).toBeLessThan(2);
      const tops = [...kit.querySelectorAll(".branding-group")].map((g) =>
        Math.round(g.getBoundingClientRect().top),
      );
      layouts.add(tops[0] === tops[1] ? "columns" : "stacked");
    }
    // Premise: the widths really covered both layouts.
    expect([...layouts].sort()).toEqual(["columns", "stacked"]);
  });

  it("stacks the groups on a phone, with no sideways scroll, and screenshots it", async () => {
    await page.viewport(390, 844);
    mount(scheme);
    const kit = node('[data-section="brandKit"]');
    expect(kit.querySelectorAll("[data-kit-tile]")).toHaveLength(3);
    const tops = [...kit.querySelectorAll(".branding-group")].map((g) =>
      Math.round(g.getBoundingClientRect().top),
    );
    expect(tops).toHaveLength(3);
    expect(tops[1] as number).toBeGreaterThan(tops[0] as number);
    expect(tops[2] as number).toBeGreaterThan(tops[1] as number);
    expect(
      document.documentElement.scrollWidth,
      "no sideways scroll",
    ).toBeLessThanOrEqual(window.innerWidth);
    const card = (
      kit.querySelector(".section-body") as HTMLElement
    ).getBoundingClientRect();
    for (const tile of kit.querySelectorAll(".kit-tile")) {
      const r = tile.getBoundingClientRect();
      expect(r.left).toBeGreaterThanOrEqual(card.left);
      expect(r.right).toBeLessThanOrEqual(card.right + 0.5);
    }
    paintKits(kit);
    kit.scrollIntoView({ block: "start" });
    await page.screenshot({
      path: `__screenshots__/brand-kits-390x844-${scheme}.png`,
      element: kit,
    });
  });

  // Below full screen (CLAUDE.md): the card on a short window, painted, so
  // nothing in it overlaps when the page has less height to give.
  it("screenshots the card on a short window", async () => {
    await page.viewport(1280, 760);
    mount(scheme);
    const kit = node('[data-section="brandKit"]');
    expect(kit.querySelectorAll("[data-kit-tile]")).toHaveLength(3);
    paintKits(kit);
    kit.scrollIntoView({ block: "start" });
    await page.screenshot({
      path: `__screenshots__/brand-kits-1280x760-${scheme}.png`,
    });
  });

  it("titles each section on the page and holds its controls in a card", () => {
    mount(scheme);
    expect(parse(getComputedStyle(node("body")).backgroundColor)[3]).toBe(1);
    const section = '[data-section="export"]';
    const card = `${section} > .section-body`;
    // The title sits on the page, beside the card rather than in it
    // (2026-10-04), so its contrast is against the page.
    expect(node(`${section} > .section-head h2`)).toBeTruthy();
    expect(node(card).contains(node(`${section} h2`))).toBe(false);
    expect(
      contrast(ink(`${section} h2`), surface("body")),
    ).toBeGreaterThanOrEqual(7);
    // 20px since 2026-09-21. A section heading is the same size wherever
    // the extension draws one, and the editor's inspector is the other
    // half of that pair — see `editor-shell.test.ts`.
    expect(getComputedStyle(node(`${section} h2`)).fontSize).toBe("20px");
    // Alone since 2026-10-08: no line of description under any section's
    // title. Asked of every section, and of the painted page, not only
    // the markup: a description that came back would be a second child.
    const heads = [...document.querySelectorAll(".section-head")];
    expect(heads.length, "no section heads rendered").toBe(3);
    for (const head of heads) {
      expect(
        [...head.children].map((c) => c.tagName),
        head.textContent ?? "",
      ).toEqual(["H2"]);
    }
    // Flat since 2026-09-20: the card is told apart from the page by
    // tone. The step is asserted beside the absence of the ring, or this
    // passes on a card that has merged into the page entirely.
    expect(Number.parseFloat(getComputedStyle(node(card)).borderTopWidth)).toBe(
      0,
    );
    expect(
      contrast(surface("body", card), surface("body")),
    ).toBeGreaterThanOrEqual(1.1);
    // A section's failure notice is toned as an error, apart from the card.
    const notice = '[data-section="export"] [data-notice]';
    const tone = surface(
      "body",
      '[data-section="export"] > .section-body',
      notice,
    );
    expect(contrast(ink(notice), tone)).toBeGreaterThanOrEqual(4.5);
    expect(tone[0]).toBeGreaterThan(tone[1]);
  });

  // The author's mockup (2026-10-06): the section nav at the page's edge,
  // held in view, and one column of sections beside it that stops at
  // 720px, each section titled above its card. Below 768px, the nav sits
  // over the sections and every card spans the page.
  it.each([1440, 600, 414])(
    "lays the nav beside one capped column at %ipx",
    async (width) => {
      await page.viewport(width, 900);
      mount(scheme);
      const sections = [
        ...document.querySelectorAll<HTMLElement>("section[data-section]"),
      ];
      expect(sections.length, "sections to measure").toBe(3);
      const block = node(".page").getBoundingClientRect();
      const gutter = Number.parseFloat(
        getComputedStyle(node(".page")).paddingLeft,
      );
      const nav = node(".section-nav").getBoundingClientRect();
      expect(Math.round(nav.left), "nav on the page edge").toBe(
        Math.round(block.left + gutter),
      );
      const edges = new Set<string>();
      for (const s of sections) {
        const name = s.getAttribute("data-section");
        const head = (
          s.querySelector(":scope > .section-head") as HTMLElement
        ).getBoundingClientRect();
        const card = (
          s.querySelector(":scope > .section-body") as HTMLElement
        ).getBoundingClientRect();
        expect(card.top, `${name} card under its title`).toBeGreaterThan(
          head.bottom,
        );
        expect(Math.round(card.left), `${name} title on the card's edge`).toBe(
          Math.round(head.left),
        );
        expect(
          card.right,
          `${name} card inside the window`,
        ).toBeLessThanOrEqual(document.documentElement.clientWidth);
        if (width >= 768) {
          expect(card.width, `${name} column capped`).toBeLessThanOrEqual(720);
          expect(card.left - nav.right, `${name} beside the nav`).toBeCloseTo(
            48,
            0,
          );
        } else {
          expect(card.top, `${name} under the nav`).toBeGreaterThan(nav.bottom);
          expect(Math.round(card.left), `${name} on the page edge`).toBe(
            Math.round(block.left + gutter),
          );
        }
        edges.add(`${Math.round(card.left)}:${Math.round(card.width)}`);
      }
      expect([...edges], "every card on the same track").toHaveLength(1);
      expect(getComputedStyle(node(".settings-side")).position).toBe(
        width >= 768 ? "sticky" : "static",
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
    },
  );

  /* Settings re-renders the whole page after a switch's write lands, so
     the switch the author clicked is replaced a few milliseconds into its
     slide. Until 2026-10-06 the replacement was born at rest and the
     toggle snapped; the popup, which flips in place, was the only page
     that slid. The page's own render is what is exercised here — the
     slide itself is `shell-switch.test.ts`'s. */
  /* The Brand kit mounts the editor's slider rows; until 2026-10-06 their
     look lived in the editor's sheet alone, and Settings drew Chrome's
     native slider. The thumb is not readable through getComputedStyle
     (editor-cursor-panel.test.ts says why), so what is held is that the
     input takes the shell's styled slider rather than the platform's, at
     the height the editor's rhythm is measured against. */
  it("draws the Brand kit's sliders as the editor's", () => {
    mount(scheme);
    const slider = node(
      '[data-section="brandKit"] input[type="range"][data-padding]',
    ) as HTMLInputElement;
    const style = getComputedStyle(slider);
    expect(style.appearance, "the native slider").toBe("none");
    expect(style.height).toBe("16px");
    // The fill the track paints from: written by the shared row builder,
    // and meaningless without the shell's gradient to read it.
    expect(slider.style.getPropertyValue("--fill")).not.toBe("");
  });

  /* The editor narrowed `.switch-text strong` to a row label's weight on
     2026-09-21 so its inspector reads as one column. That override lives in
     `editor/index.html`, not in the shell, and this is what says so: moving
     it into `assets/shell.css` would flatten this page's switch labels too.
     Asserted against the text around it rather than against 700, which is
     the shell's to change. */
  it("marks the current tab apart from the other", () => {
    mount(scheme);
    const current = '[data-tab="settings"]';
    const other = '[data-tab="library"]';
    expect(node(current).getAttribute("aria-current")).toBe("page");
    // The tabs sit straight on the page's ground since 2026-10-08 (a dark
    // band in both themes before that): composited through the bar, which
    // paints nothing of its own.
    expect(
      surface("body", ".topbar", ".topbar-pages"),
      "the bar paints a ground of its own",
    ).toEqual(surface("body"));
    expect(
      contrast(
        surface("body", ".topbar-pages", current),
        surface("body", ".topbar-pages", other),
      ),
    ).toBeGreaterThanOrEqual(1.15);
    expect(
      contrast(ink(current), surface("body", ".topbar-pages", current)),
    ).toBeGreaterThanOrEqual(7);
    expect(
      contrast(ink(other), surface("body", ".topbar-pages", other)),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the theme attribute", () => {
  // The lane runs light, so `data-theme="dark"` is the only way a dark
  // paint can happen here — which is exactly the toggle's job. The
  // production change that reddens this: dropping the
  // `:root[data-theme="dark"]` block from the shell.
  it("paints dark when the root says dark, and light when it says light", () => {
    mountShell("dark", css, "build");
    document.body.innerHTML = bodyHtml;
    const dark = parse(getComputedStyle(node("body")).backgroundColor);
    mountShell("light", css, "build");
    document.body.innerHTML = bodyHtml;
    const light = parse(getComputedStyle(node("body")).backgroundColor);
    expect(dark[0] + dark[1] + dark[2]).toBeLessThan(200);
    expect(light[0] + light[1] + light[2]).toBeGreaterThan(600);
    expect(getComputedStyle(node("body")).colorScheme).toBe("light");
  });
});

describe("the header on every tabbed page", () => {
  it.each(PAGES)(
    "%s marks itself current, and links the other",
    (page, html, carries) => {
      const parts = pageParts(html, carries);
      mountShell("light", parts.css, "build");
      document.body.innerHTML = parts.body;
      const tabs = [
        ...document.querySelectorAll<HTMLAnchorElement>("[data-tabs] a"),
      ];
      expect(tabs.map((a) => a.getAttribute("data-tab"))).toEqual([
        "library",
        "settings",
      ]);
      expect(tabs.map((a) => a.getAttribute("href"))).toEqual([
        "library.html",
        "settings.html",
      ]);
      // Each tab carries its glyph, hidden from the tree beside its word.
      for (const a of tabs) {
        const svg = a.querySelector("svg");
        expect(svg, `${a.dataset.tab} has no icon`).not.toBeNull();
        expect(svg?.getAttribute("aria-hidden")).toBe("true");
        expect(svg?.getBoundingClientRect().width).toBeGreaterThan(10);
      }
      expect(
        tabs
          .filter((a) => a.getAttribute("aria-current") === "page")
          .map((a) => a.dataset.tab),
      ).toEqual([page]);
    },
  );

  // "The header moves depending on which tab you're on" — the Recordings
  // page was 1200 wide and Settings 760, so the lockup sat at a different x
  // on each. Every tabbed page now shares the shell's bar and page block
  // (2026-10-04), and only the content beneath the header narrows. Measured at two windows, so a
  // page that matched at one width and not the other is caught.
  it.each([1440, 800])(
    "sits at the same place on every page in a %ipx window",
    async (width) => {
      await page.viewport(width, 900);
      const rects = PAGES.map(([name, html, carries]) => {
        const parts = pageParts(html, carries);
        mountShell("light", parts.css, "build");
        document.body.innerHTML = parts.body;
        const at = (sel: string) => {
          const r = node(sel).getBoundingClientRect();
          return [r.left, r.top, r.width, r.height].map((n) => Math.round(n));
        };
        return {
          name,
          bar: at(".topbar"),
          mark: at(".logomark"),
          tab: at('[data-tab="settings"]'),
          // The page's heading edge: the block below the bar, which the
          // template sets on the logomark's own left.
          page: at(".page"),
        };
      });
      const first = rects[0];
      if (first === undefined) throw new Error("no pages");
      // The template's sizes, so the comparison below is between bars that
      // are the bar at all: 64px tall, the full window wide, and the lockup:
      // a 32px disc, a 12px gap, and the wordmark cut 952 × 300 → 101.5 × 32.
      expect(first.bar.slice(2), "the bar's size").toEqual([width, 64]);
      expect(first.mark.slice(2), "the lockup's size").toEqual([146, 32]);
      for (const r of rects) {
        expect(r.bar, `.topbar on ${r.name} vs ${first.name}`).toEqual(
          first.bar,
        );
        expect(r.mark, `.logomark on ${r.name} vs ${first.name}`).toEqual(
          first.mark,
        );
        expect(r.page, `.page on ${r.name} vs ${first.name}`).toEqual(
          first.page,
        );
        expect(r.tab, `the Settings tab on ${r.name} vs ${first.name}`).toEqual(
          first.tab,
        );
      }
    },
  );
});

describe("the section nav", () => {
  // Red if the foot rule goes: Pull requests is short and last, so at the
  // bottom of the page its top never reaches the line the others cross.
  it("marks the section in view, and Pull requests at the foot of the page", async () => {
    await page.viewport(1280, 800);
    mount("light");
    const nav = trackSectionNav(node("#root"));
    const current = () =>
      document.querySelector<HTMLElement>('a[data-nav][aria-current="true"]')
        ?.dataset.nav;
    window.scrollTo(0, 0);
    nav.mark();
    expect(current()).toBe("brand-kit");
    // The title heads the nav's column since 2026-10-08, and at the top of
    // the page it still reads as the page's title: above the nav and the
    // first section, which start level under it.
    const title = node(".settings-side > h1");
    const atTop = {
      title: title.getBoundingClientRect(),
      nav: node(".section-nav").getBoundingClientRect(),
      first: node('[data-section="brandKit"]').getBoundingClientRect(),
    };
    expect(
      Math.abs(atTop.first.top - atTop.nav.top),
      `the first section at ${atTop.first.top}, the nav at ${atTop.nav.top}`,
    ).toBeLessThan(1);
    expect(atTop.title.bottom).toBeLessThanOrEqual(atTop.nav.top);
    window.scrollTo(0, document.documentElement.scrollHeight);
    // Premise: at the foot, Pull requests' top is still under the 30% line.
    expect(
      node('[data-section="pullRequests"]').getBoundingClientRect().top,
    ).toBeGreaterThan(window.innerHeight * 0.3);
    await expect.poll(current).toBe("pull-requests");
    // The title and the nav are both held in view while the page scrolls
    // (the title since 2026-10-08), the nav under the title.
    const head = title.getBoundingClientRect();
    const top = node(".section-nav").getBoundingClientRect().top;
    expect(head.top, `the title is at ${head.top}`).toBeGreaterThanOrEqual(0);
    expect(head.top).toBeLessThan(40);
    expect(top).toBeGreaterThanOrEqual(head.bottom);
    // Premise: the sections really have scrolled past the title's height,
    // or "held in view" is where it started.
    expect(
      node('[data-section="brandKit"]').getBoundingClientRect().top,
    ).toBeLessThan(head.top);
    // And nothing held in view is laid over them: the held column ends
    // before the sections' column begins. A title across the page's whole
    // width cut the sections off under it.
    const side = node(".settings-side").getBoundingClientRect();
    expect(
      side.right,
      `the held column ends at ${side.right}, the sections start at ${node(".content").getBoundingClientRect().left}`,
    ).toBeLessThanOrEqual(node(".content").getBoundingClientRect().left);
    // The window as it stands: an element capture would scroll the page
    // to the element first and move the mark it means to show.
    await page.screenshot({ path: "__screenshots__/settings-nav-foot.png" });
    expect(current(), "still at the foot after the capture").toBe(
      "pull-requests",
    );
    window.scrollTo(0, 0);
  });
});
