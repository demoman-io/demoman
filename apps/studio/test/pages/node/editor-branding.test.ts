import {
  BRANDING_DEFAULTS,
  DEFAULT_WALLPAPER_BLUR,
  DEFAULT_WALLPAPER_ID,
  NEUTRAL_BACKGROUND,
  type SceneBranding,
  WALLPAPERS,
} from "@demoman/scene-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { renderFailure } from "../../../pages/entrypoints/editor/view";
import {
  type BrandingControlsProps,
  renderBrandingControls,
} from "../../../pages/src/branding/controls";
import {
  applyBrandingPatch,
  resolveBrandingPreview,
  sameBranding,
} from "../../../pages/src/editor/branding";
import { StudioError } from "../../../pages/src/platform/http";
import { editorDom } from "../helpers/editor-dom";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// Only the editor-main case below boots the page; the platform it builds is
// the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(): Record<string, never> {
    return {};
  }
}

const withLogo: SceneBranding = {
  background: { kind: "solid", color: "#1b2a4a" },
  logo: { ref: "logo:a", corner: "bottom-right", size: 0.06, opacity: 0.9 },
  padding: 0.08,
};

describe("applyBrandingPatch", () => {
  it("replaces the background whole", () => {
    const next = applyBrandingPatch(withLogo, {
      background: {
        kind: "gradient",
        from: "#000000",
        to: "#ffffff",
        angle: 90,
      },
    });
    expect(next.background).toEqual({
      kind: "gradient",
      from: "#000000",
      to: "#ffffff",
      angle: 90,
    });
    expect(next.logo).toBe(withLogo.logo);
  });

  it("adjusts one logo field and keeps the rest", () => {
    expect(
      applyBrandingPatch(withLogo, { logo: { corner: "top-left" } }).logo,
    ).toEqual({
      ...withLogo.logo,
      corner: "top-left",
    });
  });

  it("sets a whole logo when the patch carries a ref", () => {
    const logo = {
      ref: "logo:b",
      corner: "top-right" as const,
      size: 0.1,
      opacity: 1,
    };
    expect(applyBrandingPatch(BRANDING_DEFAULTS, { logo }).logo).toEqual(logo);
  });

  it("removes the logo on null", () => {
    expect(applyBrandingPatch(withLogo, { logo: null }).logo).toBeNull();
  });

  it("refuses to adjust a logo that is not there, and says so", () => {
    expect(() =>
      applyBrandingPatch(BRANDING_DEFAULTS, { logo: { size: 0.1 } }),
    ).toThrow("there is no logo to adjust — upload one first");
  });

  it("adjusts a gradient in place, and swaps its colours", () => {
    const gradient: SceneBranding = {
      background: {
        kind: "gradient",
        from: "#000000",
        to: "#ffffff",
        angle: 40,
      },
      logo: null,
      padding: 0.08,
    };
    expect(
      applyBrandingPatch(gradient, { gradient: { swap: true } }).background,
    ).toEqual({ kind: "gradient", from: "#ffffff", to: "#000000", angle: 40 });
    expect(
      applyBrandingPatch(gradient, { gradient: { angle: 90 } }).background,
    ).toEqual({ kind: "gradient", from: "#000000", to: "#ffffff", angle: 90 });
  });

  it("refuses to adjust a gradient that is not there, and says so", () => {
    expect(() =>
      applyBrandingPatch(withLogo, { gradient: { angle: 90 } }),
    ).toThrow("the background is not a gradient any more");
  });

  it("leaves branding untouched for an empty patch", () => {
    expect(applyBrandingPatch(withLogo, {})).toEqual(withLogo);
  });
});

describe("resolveBrandingPreview", () => {
  const s0 = { branding: withLogo } as never as { branding: SceneBranding };
  const s1 = { branding: BRANDING_DEFAULTS } as never as {
    branding: SceneBranding;
  };
  const red = { background: { kind: "solid" as const, color: "#e03131" } };

  it("layers the preview over the scene it was taken against", () => {
    const out = resolveBrandingPreview({ patch: red, scene: s0 }, s0);
    expect(out.branding.background).toEqual(red.background);
    expect(out.preview).not.toBeNull();
  });

  it("drops a preview for good once the document moves, so undo cannot revive it", () => {
    // Review Focus 2. Undo hands back the PREVIOUS scene object — the very
    // one the preview was taken against. Ignoring a stale preview is not
    // enough; it has to be gone by the time that object comes back.
    const afterCommit = resolveBrandingPreview({ patch: red, scene: s0 }, s1);
    expect(afterCommit.preview).toBeNull();
    expect(afterCommit.branding).toBe(s1.branding);
    const afterUndo = resolveBrandingPreview(afterCommit.preview, s0);
    expect(afterUndo.branding).toBe(s0.branding);
  });

  it("drops a preview that no longer applies, and says why", () => {
    const report: string[] = [];
    const out = resolveBrandingPreview(
      { patch: { logo: { size: 0.1 } }, scene: s1 },
      s1,
      (e) => report.push(e.message),
    );
    expect(out.preview).toBeNull();
    expect(out.branding).toBe(s1.branding);
    expect(report).toEqual(["there is no logo to adjust — upload one first"]);
  });
});

describe("sameBranding", () => {
  it("compares field by field, key order aside", () => {
    const reordered: SceneBranding = {
      logo: { opacity: 0.9, size: 0.06, corner: "bottom-right", ref: "logo:a" },
      padding: 0.08,
      background: { color: "#1b2a4a", kind: "solid" },
    };
    expect(sameBranding(withLogo, reordered)).toBe(true);
  });

  it("tells apart a moved logo, a removed one, and a different background", () => {
    expect(
      sameBranding(
        withLogo,
        applyBrandingPatch(withLogo, { logo: { size: 0.1 } }),
      ),
    ).toBe(false);
    expect(sameBranding(withLogo, { ...withLogo, logo: null })).toBe(false);
    expect(
      sameBranding(withLogo, {
        ...withLogo,
        background: {
          kind: "gradient",
          from: "#1b2a4a",
          to: "#1b2a4a",
          angle: 0,
        },
      }),
    ).toBe(false);
  });
});

describe("applyBrandingPatch keeps padding", () => {
  const branding: SceneBranding = {
    background: {
      kind: "gradient",
      from: "#1b2a4a",
      to: "#3b5bdb",
      angle: 135,
    },
    logo: { ref: "logo:a", corner: "top-left", size: 0.06, opacity: 1 },
    padding: 0.13,
  };
  // Red if the merge rebuilds branding from background and logo alone: every
  // colour, angle or logo edit would then reset the author's padding.
  it.each([
    ["a whole background", { background: { kind: "solid", color: "#000000" } }],
    ["a gradient angle", { gradient: { angle: 10 } }],
    ["a swap", { gradient: { swap: true } }],
    ["a logo adjustment", { logo: { size: 0.1 } }],
    ["removing the logo", { logo: null }],
  ] as const)("through %s", (_name, patch) => {
    expect(applyBrandingPatch(branding, patch as never).padding).toBe(0.13);
  });
});

describe("padding edits", () => {
  const branding: SceneBranding = {
    background: { kind: "solid", color: "#1b2a4a" },
    logo: null,
    padding: 0.08,
  };
  it("a padding patch sets padding and nothing else", () => {
    const next = applyBrandingPatch(branding, { padding: 0.15 });
    expect(next).toEqual({ ...branding, padding: 0.15 });
  });
  // Review Focus 2, the half that lives here: a branding that differs only
  // in padding is a different picture. Red if `sameBranding` ignores it,
  // which turns Reset-to-kit and the slider's commit into no-ops.
  it("sameBranding tells two paddings apart", () => {
    expect(sameBranding(branding, { ...branding, padding: 0.09 })).toBe(false);
    expect(sameBranding(branding, { ...branding })).toBe(true);
  });
});

// ------------------------------------------------------------ wallpapers
//
// The Background panel's third style (spec 2026-10-28, "Editor and Brand kit
// UI"): the built-in set as tiles, one tile to upload, the uploaded image's
// tile once there is one, and the load failure said in the panel.

const onWallpaper = (
  background: SceneBranding["background"],
): SceneBranding => ({ background, logo: null, padding: 0.08 });

function mountControls(
  branding: SceneBranding,
  wallpaper: Partial<BrandingControlsProps["wallpaper"]> = {},
) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const handlers = {
    onCommit: vi.fn(),
    onPreview: vi.fn(),
    onLogoFile: vi.fn(),
    onWallpaperFile: vi.fn(),
  };
  renderBrandingControls(
    root,
    {
      branding,
      logoThumb: null,
      logoPlacement: null,
      formatTitle: "Landscape video",
      logoNotes: [],
      wallpaper: {
        thumbUrl: (id) => `/wallpapers/${id}-thumb.webp`,
        custom: null,
        loadError: null,
        ...wallpaper,
      },
    },
    handlers,
  );
  const q = <T extends Element>(sel: string): T => {
    const node = root.querySelector<T>(sel);
    if (node === null) throw new Error(`no ${sel}`);
    return node;
  };
  return { root, handlers, q };
}

describe("the Background panel's Wallpaper", () => {
  const solid = onWallpaper({ kind: "solid", color: "#1b2a4a" });

  it("the Wallpaper style commits the default wallpaper", () => {
    const { q, handlers } = mountControls(solid);
    q<HTMLButtonElement>('[data-bg-kind="wallpaper"]').click();
    expect(handlers.onCommit).toHaveBeenCalledWith({
      background: {
        kind: "wallpaper",
        id: DEFAULT_WALLPAPER_ID,
        blur: DEFAULT_WALLPAPER_BLUR,
      },
    });
    expect(DEFAULT_WALLPAPER_ID).toBe("vivid-1");
    expect(DEFAULT_WALLPAPER_BLUR).toBe(0.3);
  });

  it("Gradient to Wallpaper commits the default blur too", () => {
    const { q, handlers } = mountControls(
      onWallpaper({
        kind: "gradient",
        from: "#000000",
        to: "#ffffff",
        angle: 90,
      }),
    );
    q<HTMLButtonElement>('[data-bg-kind="wallpaper"]').click();
    expect(handlers.onCommit).toHaveBeenCalledWith({
      background: {
        kind: "wallpaper",
        id: DEFAULT_WALLPAPER_ID,
        blur: DEFAULT_WALLPAPER_BLUR,
      },
    });
  });

  it("the Blur slider is there only under Wallpaper, at the background's blur", () => {
    for (const bg of [
      { kind: "solid", color: "#1b2a4a" },
      { kind: "gradient", from: "#000000", to: "#ffffff", angle: 90 },
    ] as const) {
      const { root } = mountControls(onWallpaper(bg));
      // The control: these panels draw their own sliders, just not Blur.
      expect(root.querySelector("[data-padding]"), bg.kind).not.toBeNull();
      expect(root.querySelector("[data-wallpaper-blur]"), bg.kind).toBeNull();
    }
    const on = (bg: SceneBranding["background"]) =>
      mountControls(onWallpaper(bg)).q<HTMLInputElement>(
        "input[data-wallpaper-blur]",
      );
    const slider = on({ kind: "wallpaper", id: "vivid-2", blur: 0.3 });
    expect([slider.type, slider.min, slider.max, slider.value]).toEqual([
      "range",
      "0",
      "1",
      "0.3",
    ]);
    expect(slider.getAttribute("aria-label")).toBe("Blur");
    // A take saved before blur reads sharp; an upload has the slider too.
    expect(on({ kind: "wallpaper", id: "vivid-2" }).value).toBe("0");
    expect(on({ kind: "image", ref: "assets/a.webp", blur: 0.7 }).value).toBe(
      "0.7",
    );
  });

  it("dragging Blur previews, and releasing commits the whole background", () => {
    const { q, root, handlers } = mountControls(
      onWallpaper({ kind: "image", ref: "assets/a.webp", blur: 0.4 }),
    );
    const slider = q<HTMLInputElement>("input[data-wallpaper-blur]");
    slider.value = "0.83";
    slider.dispatchEvent(new Event("input"));
    expect(handlers.onPreview).toHaveBeenLastCalledWith({
      background: { kind: "image", ref: "assets/a.webp", blur: 0.83 },
    });
    expect(handlers.onCommit).not.toHaveBeenCalled();
    expect(root.textContent).toContain("83%");
    slider.dispatchEvent(new Event("change"));
    expect(handlers.onCommit).toHaveBeenCalledWith({
      background: { kind: "image", ref: "assets/a.webp", blur: 0.83 },
    });
  });

  it("picking another wallpaper keeps the blur", () => {
    const { q, handlers } = mountControls(
      onWallpaper({ kind: "image", ref: "assets/a.webp", blur: 0.2 }),
    );
    q<HTMLButtonElement>('[data-wallpaper-id="dark-2"]').click();
    expect(handlers.onCommit).toHaveBeenCalledWith({
      background: { kind: "wallpaper", id: "dark-2", blur: 0.2 },
    });
  });

  it("draws one tile per built-in, each from its thumbnail, and the chosen one pressed", () => {
    const { root } = mountControls(
      onWallpaper({ kind: "wallpaper", id: "vivid-1" }),
    );
    const tiles = [
      ...root.querySelectorAll<HTMLButtonElement>("button[data-wallpaper-id]"),
    ];
    expect(tiles.map((t) => t.getAttribute("data-wallpaper-id"))).toEqual(
      WALLPAPERS.map((w) => w.id),
    );
    expect(
      tiles.map((t) => t.querySelector("img")?.getAttribute("src")),
    ).toEqual(WALLPAPERS.map((w) => `/wallpapers/${w.id}-thumb.webp`));
    expect(
      tiles
        .filter((t) => t.getAttribute("aria-pressed") === "true")
        .map((t) => t.getAttribute("data-wallpaper-id")),
    ).toEqual(["vivid-1"]);
    expect(
      root
        .querySelector('[data-bg-kind="wallpaper"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(root.querySelector("button[data-wallpaper-upload]")).not.toBeNull();
    // No custom tile with no upload to show.
    expect(root.querySelector("[data-wallpaper-custom]")).toBeNull();
    // No colour fields under a wallpaper.
    expect(root.querySelector("[data-colour-field]")).toBeNull();
  });

  it("a tile commits its id", () => {
    const { q, handlers } = mountControls(
      onWallpaper({ kind: "wallpaper", id: "vivid-1" }),
    );
    q<HTMLButtonElement>('[data-wallpaper-id="dark-2"]').click();
    expect(handlers.onCommit).toHaveBeenCalledWith({
      background: { kind: "wallpaper", id: "dark-2" },
    });
  });

  it("leaving a wallpaper for Solid or Gradient starts from its swatch", () => {
    const swatch = WALLPAPERS.find((w) => w.id === "vivid-3")?.swatch;
    if (swatch === undefined) throw new Error("no vivid-3");
    // The premise: the two swatch colours differ, so From and To are told
    // apart below.
    expect(swatch.from).not.toBe(swatch.to);
    const { q, handlers } = mountControls(
      onWallpaper({ kind: "wallpaper", id: "vivid-3" }),
    );
    q<HTMLButtonElement>('[data-bg-kind="solid"]').click();
    expect(handlers.onCommit).toHaveBeenLastCalledWith({
      background: { kind: "solid", color: swatch.from },
    });
    q<HTMLButtonElement>('[data-bg-kind="gradient"]').click();
    expect(handlers.onCommit).toHaveBeenLastCalledWith({
      background: {
        kind: "gradient",
        from: swatch.from,
        to: swatch.to,
        angle: 135,
      },
    });
  });

  it("leaving an uploaded image starts from the neutral colours", () => {
    const { q, handlers } = mountControls(
      onWallpaper({ kind: "image", ref: "assets/a.webp" }),
      { custom: { ref: "assets/a.webp", thumb: { kind: "loading" } } },
    );
    q<HTMLButtonElement>('[data-bg-kind="solid"]').click();
    expect(handlers.onCommit).toHaveBeenLastCalledWith({
      background: { kind: "solid", color: NEUTRAL_BACKGROUND.from },
    });
    q<HTMLButtonElement>('[data-bg-kind="gradient"]').click();
    expect(handlers.onCommit).toHaveBeenLastCalledWith({
      background: {
        kind: "gradient",
        from: NEUTRAL_BACKGROUND.from,
        to: NEUTRAL_BACKGROUND.to,
        angle: 135,
      },
    });
  });

  it("an uploaded image is the pressed tile, and the Wallpaper style is checked", () => {
    const { root, q } = mountControls(
      onWallpaper({ kind: "image", ref: "assets/a.webp" }),
      {
        custom: {
          ref: "assets/a.webp",
          thumb: { kind: "ready", url: "blob:thumb" },
        },
      },
    );
    expect(q('[data-bg-kind="wallpaper"]').getAttribute("aria-checked")).toBe(
      "true",
    );
    const custom = q<HTMLButtonElement>("button[data-wallpaper-custom]");
    expect(custom.getAttribute("aria-pressed")).toBe("true");
    expect(custom.querySelector("img")?.getAttribute("src")).toBe("blob:thumb");
    expect(
      [...root.querySelectorAll('[aria-pressed="true"]')].length,
      "one pressed tile",
    ).toBe(1);
  });

  it("an upload kept from earlier is offered, unpressed, and commits its ref", () => {
    const { q, handlers } = mountControls(
      onWallpaper({ kind: "wallpaper", id: "vivid-1" }),
      { custom: { ref: "assets/a.webp", thumb: null } },
    );
    const custom = q<HTMLButtonElement>("button[data-wallpaper-custom]");
    expect(custom.getAttribute("aria-pressed")).toBe("false");
    custom.click();
    expect(handlers.onCommit).toHaveBeenCalledWith({
      background: { kind: "image", ref: "assets/a.webp" },
    });
  });

  it("the upload tile hands its file over", () => {
    const { q, handlers } = mountControls(
      onWallpaper({ kind: "wallpaper", id: "vivid-1" }),
    );
    const input = q<HTMLInputElement>("input[data-wallpaper-file]");
    expect(input.accept).toBe("image/svg+xml,image/png,image/webp,image/jpeg");
    const file = new File(["x"], "bg.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(handlers.onWallpaperFile).toHaveBeenCalledWith(file);
    expect(handlers.onCommit).not.toHaveBeenCalled();
  });

  it("says why the image could not be loaded, and nothing when it could", () => {
    const failed = mountControls(
      onWallpaper({ kind: "wallpaper", id: "vivid-1" }),
      { loadError: 'the built-in wallpaper "vivid-1" answered HTTP 404' },
    );
    const band = failed.q("[data-wallpaper-error]");
    expect(band.textContent).toContain(
      'the built-in wallpaper "vivid-1" answered HTTP 404',
    );
    expect(band.getAttribute("role")).toBe("alert");
    const fine = mountControls(
      onWallpaper({ kind: "wallpaper", id: "vivid-1" }),
    );
    expect(fine.root.querySelector("[data-wallpaper-error]")).toBeNull();
  });
});

describe("the failure band names a background image that did not load", () => {
  it("draws its own box with the reason, and none without one", () => {
    const box = document.createElement("div");
    const base = {
      error: null,
      replaySentence: null,
      replayRecoverable: false,
      captureSentence: null,
    };
    renderFailure(box, { ...base, wallpaperLoadError: "HTTP 404" });
    const notice = box.querySelector("[data-wallpaper-load-error]");
    expect(notice?.textContent).toContain(
      "The background image could not be loaded",
    );
    expect(notice?.textContent).toContain("HTTP 404");
    renderFailure(box, { ...base, wallpaperLoadError: null });
    expect(box.querySelector("[data-wallpaper-load-error]")).toBeNull();
  });
});

describe("editor main — a refused wallpaper upload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("says why, and leaves the background as it was", async () => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const memory = createMemoryPlatform();
    state.memory = memory;
    const scene = readonlyScene();
    const before = scene.branding.background;
    memory.serveScene(() => scene);
    memory.serveBundle(null, null);
    const reason =
      'The file "bg.gif" is a image/gif file — use SVG, PNG, WebP or JPEG';
    memory.answer("wallpapers.put", async () => {
      throw new StudioError("wallpaperRefused", reason, 400);
    });
    await import("../../../pages/entrypoints/editor/main");
    const rail = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        '#rail [data-rail="background"]',
      );
      if (!node) throw new Error("rail not rendered yet");
      return node;
    });
    rail.click();
    // Into the Wallpaper style, where the upload tile lives.
    const style = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        '[data-bg-kind="wallpaper"]',
      );
      if (!node) throw new Error("no Wallpaper style yet");
      return node;
    });
    style.click();
    const input = await vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>(
        "input[data-wallpaper-file]",
      );
      if (!node) throw new Error("no upload tile yet");
      return node;
    });
    // The premise: the Wallpaper click landed and was saved, so the refusal
    // below is measured against a scene the panel really edited.
    expect(before.kind).toBe("gradient");
    const backgroundBefore = await vi.waitFor(() => {
      const bg = memory.puts().at(-1)?.branding.background;
      if (bg?.kind !== "wallpaper") throw new Error("not saved yet");
      return bg;
    });
    expect(backgroundBefore).toEqual({
      kind: "wallpaper",
      id: DEFAULT_WALLPAPER_ID,
      blur: DEFAULT_WALLPAPER_BLUR,
    });
    const putsBefore = memory.puts().length;
    const file = new File(["gif"], "bg.gif", { type: "image/gif" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      const text = document.getElementById("failure")?.textContent ?? "";
      if (!text.includes(reason)) throw new Error(`not said yet: ${text}`);
    });
    expect(
      memory.calls.filter(
        (c) => c.member === "wallpapers" && c.method === "put",
      ),
    ).toHaveLength(1);
    expect(memory.puts().length).toBe(putsBefore);
    expect(memory.puts().at(-1)?.branding.background).toEqual(backgroundBefore);
  });
});

describe("editor main — an accepted wallpaper upload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps the blur the background had", async () => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const memory = createMemoryPlatform();
    state.memory = memory;
    const scene = readonlyScene();
    const blurred = {
      ...scene,
      branding: {
        ...scene.branding,
        background: { kind: "wallpaper", id: "vivid-2", blur: 0.3 } as const,
      },
    };
    memory.serveScene(() => blurred);
    memory.serveBundle(null, null);
    await import("../../../pages/entrypoints/editor/main");
    const rail = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        '#rail [data-rail="background"]',
      );
      if (!node) throw new Error("rail not rendered yet");
      return node;
    });
    rail.click();
    const input = await vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>(
        "input[data-wallpaper-file]",
      );
      if (!node) throw new Error("no upload tile yet");
      return node;
    });
    // The premise: the panel is on the blurred wallpaper, not the default.
    expect(
      document.querySelector<HTMLInputElement>("input[data-wallpaper-blur]")
        ?.value,
    ).toBe("0.3");
    const file = new File(["png"], "bg.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    const saved = await vi.waitFor(() => {
      const bg = memory.puts().at(-1)?.branding.background;
      if (bg?.kind !== "image") throw new Error("not saved yet");
      return bg;
    });
    expect(saved.blur).toBe(0.3);
  });
});
