import type { SceneBranding } from "@demoman/scene-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capNote,
  type KitRowProps,
  renderBrandingControls,
} from "../../../pages/src/branding/controls";
import type {
  BrandKitsRead,
  KitEntry,
} from "../../../pages/src/core/brand-kit";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.replaceChildren(root);
});

const solid: SceneBranding = {
  background: { kind: "solid", color: "#1b2a4a" },
  logo: null,
  padding: 0.08,
};
const gradient: SceneBranding = {
  background: { kind: "gradient", from: "#1b2a4a", to: "#3b5bdb", angle: 135 },
  logo: null,
  padding: 0.08,
};
const handlers = () => ({
  onCommit: vi.fn(),
  onPreview: vi.fn(),
  onLogoFile: vi.fn(),
  onWallpaperFile: vi.fn(),
});
const mount = (branding: SceneBranding, h = handlers(), extra = {}) => {
  renderBrandingControls(
    root,
    {
      branding,
      logoThumb: null,
      logoPlacement: null,
      formatTitle: "Landscape video",
      logoNotes: [],
      wallpaper: {
        thumbUrl: (id: string) => `/wallpapers/${id}-thumb.webp`,
        custom: null,
        loadError: null,
      },
      ...extra,
    },
    h,
  );
  return h;
};
const q = <T extends Element>(sel: string) => {
  const node = root.querySelector<T>(sel);
  if (!node) throw new Error(`no ${sel}`);
  return node;
};

describe("background style", () => {
  it("shows one colour field for a solid and two plus an angle for a gradient", () => {
    mount(solid);
    expect(root.querySelectorAll("[data-colour-field]").length).toBe(1);
    expect(root.querySelector("[data-angle]")).toBeNull();
    mount(gradient);
    expect(root.querySelectorAll("[data-colour-field]").length).toBe(2);
    expect(q<HTMLInputElement>("[data-angle]").value).toBe("135");
  });

  it("switching to gradient seeds From with the solid colour and To with white", () => {
    const h = mount(solid);
    q<HTMLButtonElement>('[data-bg-kind="gradient"]').click();
    const patch = h.onCommit.mock.calls[0]?.[0];
    expect(patch.background.kind).toBe("gradient");
    expect(patch.background.from).toBe("#1b2a4a");
    // To starts at white: the author's default, 2026-09-22.
    expect(patch.background.to).toBe("#ffffff");
  });

  it("swaps From and To", () => {
    const h = mount(gradient);
    q<HTMLButtonElement>("[data-swap]").click();
    // An adjustment, not a whole background: a whole one would carry the
    // angle as drawn, and undo an Angle change committed before a re-render.
    expect(h.onCommit).toHaveBeenCalledWith({ gradient: { swap: true } });
  });
});

describe("colour field", () => {
  it("commits a pasted colour in its canonical form", () => {
    const h = mount(solid);
    const text = q<HTMLInputElement>("[data-colour-text]");
    text.value = "rgb(59, 91, 219)";
    text.dispatchEvent(new Event("change"));
    expect(h.onCommit).toHaveBeenCalledWith({
      background: { kind: "solid", color: "#3b5bdb" },
    });
    expect(text.value).toBe("#3b5bdb");
  });

  it("refuses what is not a colour, keeps the text, and commits nothing", () => {
    const h = mount(solid);
    const text = q<HTMLInputElement>("[data-colour-text]");
    text.value = "rgb(59 91";
    text.dispatchEvent(new Event("change"));
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(text.value).toBe("rgb(59 91");
    expect(q("[data-colour-error]").textContent).toBe(
      '"rgb(59 91" is not a colour',
    );
    expect(text.getAttribute("aria-invalid")).toBe("true");
  });

  it("previews the swatch as it moves and commits when it closes", () => {
    const h = mount(solid);
    const swatch = q<HTMLInputElement>('input[type="color"]');
    swatch.value = "#e03131";
    swatch.dispatchEvent(new Event("input"));
    expect(h.onPreview).toHaveBeenCalledWith({
      background: { kind: "solid", color: "#e03131" },
    });
    expect(h.onCommit).not.toHaveBeenCalled();
    swatch.dispatchEvent(new Event("change"));
    expect(h.onCommit).toHaveBeenCalledWith({
      background: { kind: "solid", color: "#e03131" },
    });
  });

  it("shows the gamut note for a clipped oklch()", () => {
    mount(solid);
    const text = q<HTMLInputElement>("[data-colour-text]");
    text.value = "oklch(0.7 0.4 150)";
    text.dispatchEvent(new Event("change"));
    expect(q("[data-colour-note]").textContent).toBe("Nearest sRGB is #00be58");
  });
});

describe("logo", () => {
  const withLogo: SceneBranding = {
    ...solid,
    logo: { ref: "logo:a", corner: "bottom-right", size: 0.06, opacity: 0.9 },
  };

  // The author's pick (2026-10-08, mockup A): the logo in a well with
  // Replace and Remove stacked beside it, each with its glyph. Red if the
  // three go back to one wrapping row.
  it("puts the logo in a well with Replace and Remove stacked beside it, each with a glyph", () => {
    mount(withLogo, handlers(), {
      logoThumb: { kind: "ready", url: "data:image/png;base64,AA==" },
    });
    const row = q(".logo-row");
    expect([...row.children].map((c) => c.className)).toEqual([
      "logo-thumb",
      "logo-stack",
    ]);
    const stack = q(".logo-stack");
    const replace = stack.children[0] as HTMLElement;
    const remove = stack.children[1] as HTMLElement;
    expect(replace.textContent).toBe("Replace");
    expect(replace.querySelector('svg[data-icon="upload"]')).not.toBeNull();
    expect(remove.hasAttribute("data-logo-remove")).toBe(true);
    expect(remove.querySelector('svg[data-icon="trash"]')).not.toBeNull();
  });

  it("offers Upload logo, with its glyph, and no well when there is no logo", () => {
    mount(solid);
    expect(root.querySelector(".logo-thumb")).toBeNull();
    const upload = q(".logo-controls label.btn");
    expect(upload.textContent).toBe("Upload logo");
    expect(upload.querySelector('svg[data-icon="upload"]')).not.toBeNull();
  });

  // Mockup A: the corner picker is the video frame itself. Red if it goes
  // back to the 2x2 grid of small swatches.
  it("draws the corner picker as a frame with a corner button in each corner", () => {
    mount(withLogo);
    const frame = q(".corner-frame");
    expect(frame.getAttribute("role")).toBe("radiogroup");
    expect(frame.getAttribute("aria-label")).toBe("Logo corner");
    expect(frame.querySelector(".corner-frame-rec")).not.toBeNull();
    expect(
      [...frame.querySelectorAll("[data-logo-corner]")].map((b) => [
        b.getAttribute("data-logo-corner"),
        b.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["top-left", "false"],
      ["top-right", "false"],
      ["bottom-left", "false"],
      ["bottom-right", "true"],
    ]);
    expect(root.querySelector(".corner-grid")).toBeNull();
  });

  it("offers Upload with no logo, and Replace, Remove, corner, size, opacity with one", () => {
    mount(solid);
    expect(root.querySelector("[data-logo-remove]")).toBeNull();
    expect(root.querySelector("[data-logo-corner]")).toBeNull();
    mount(withLogo);
    expect(root.querySelector("[data-logo-remove]")).not.toBeNull();
    expect(root.querySelectorAll("[data-logo-corner]").length).toBe(4);
    expect(q<HTMLInputElement>("[data-logo-size]").value).toBe("0.06");
    expect(q<HTMLInputElement>("[data-logo-opacity]").value).toBe("0.9");
  });

  it("commits a corner, and a removal", () => {
    const h = mount(withLogo);
    q<HTMLButtonElement>('[data-logo-corner="top-left"]').click();
    expect(h.onCommit).toHaveBeenCalledWith({ logo: { corner: "top-left" } });
    q<HTMLButtonElement>("[data-logo-remove]").click();
    expect(h.onCommit).toHaveBeenCalledWith({ logo: null });
  });

  it("names SVG first in what it accepts", () => {
    mount(solid);
    expect(q<HTMLInputElement>('input[type="file"]').accept).toBe(
      "image/svg+xml,image/png,image/webp,image/jpeg",
    );
  });

  // Red if the tile is dropped, put after the buttons, or drawn without
  // the image it was handed.
  it("shows the logo before Replace and Remove, like a file upload", () => {
    mount(withLogo, handlers(), {
      logoThumb: { kind: "ready", url: "data:image/png;base64,AAAA" },
    });
    const actions = q<HTMLElement>("[data-logo-thumb]")
      .parentElement as HTMLElement;
    expect(actions.firstElementChild).toBe(q<HTMLElement>("[data-logo-thumb]"));
    expect(q<HTMLElement>("[data-logo-thumb]").dataset.logoThumb).toBe("ready");
    expect(q<HTMLImageElement>("[data-logo-thumb] img").src).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(actions.textContent).toContain("Replace");
    expect(actions.textContent).toContain("Remove");
  });

  it("has no tile with no logo", () => {
    mount(solid);
    expect(root.querySelector("[data-logo-thumb]")).toBeNull();
  });

  it("says why when the logo cannot be shown", () => {
    mount(withLogo, handlers(), {
      logoThumb: { kind: "failed", reason: "the logo is not in storage" },
    });
    expect(q<HTMLElement>("[data-logo-thumb]").dataset.logoThumb).toBe(
      "failed",
    );
    expect(q<HTMLElement>("[data-logo-thumb]").title).toContain(
      "the logo is not in storage",
    );
    expect(root.querySelector("[data-logo-thumb] img")).toBeNull();
  });

  // A logo set and no thumbnail given is the page's omission, and must not
  // read as a load still in progress or as an empty logo.
  it("says the page never loaded it rather than looking busy", () => {
    mount(withLogo, handlers(), { logoThumb: null });
    expect(q<HTMLElement>("[data-logo-thumb]").dataset.logoThumb).toBe(
      "failed",
    );
    expect(q<HTMLElement>("[data-logo-thumb]").title).toContain("did not load");
  });

  it("shows the notes it is given", () => {
    mount(withLogo, handlers(), {
      logoNotes: [
        "JPEG has no transparency — the logo shows as a box on the background",
      ],
    });
    expect(q("[data-logo-notes]").textContent).toContain(
      "JPEG has no transparency",
    );
  });
});

describe("capNote", () => {
  it("says nothing when the logo fits", () => {
    expect(
      capNote(
        {
          rect: { x: 0, y: 0, width: 1, height: 1 },
          effectiveSize: 0.06,
          capped: false,
        },
        "Landscape video",
      ),
    ).toBeNull();
  });
  it("names the size and the format when capped", () => {
    expect(
      capNote(
        {
          rect: { x: 0, y: 0, width: 1, height: 1 },
          effectiveSize: 0.08,
          capped: true,
        },
        "Vertical cut",
      ),
    ).toBe("Shown at 8% in Vertical cut to stay clear of your recording");
  });
  it("says there is no room when nothing can be drawn", () => {
    expect(
      capNote(
        {
          rect: { x: 0, y: 0, width: 0, height: 0 },
          effectiveSize: 0,
          capped: true,
        },
        "GIF preview",
      ),
    ).toBe(
      "No room for the logo in GIF preview — the recording fills the frame",
    );
  });
});

describe("groups", () => {
  it("groups the controls as Background, Frame, Logo, with padding under Frame", () => {
    mount(solid, handlers(), { groupTitles: true });
    expect(
      [...root.querySelectorAll("[data-group]")].map((g) =>
        g.getAttribute("data-group"),
      ),
    ).toEqual(["background", "frame", "logo"]);
    expect(
      root.querySelector('[data-group="frame"] [data-padding]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-group="background"] [data-bg-kind]'),
    ).not.toBeNull();
    expect(
      [...root.querySelectorAll(".branding-group-title")].map(
        (h) => h.textContent,
      ),
    ).toEqual(["Background", "Frame", "Logo"]);
  });

  // The author's call (2026-10-08): on the Settings card the gradient's
  // Angle sits under Frame, which balances the three columns. Red if it
  // stays under Background there, or moves in the editor's panel.
  it("puts Angle under Frame on the Settings card, and under Background in the editor", () => {
    mount(gradient, handlers(), { groupTitles: true });
    expect(
      root.querySelector('[data-group="frame"] [data-angle]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-group="background"] [data-angle]'),
    ).toBeNull();
    mount(gradient);
    expect(
      root.querySelector('[data-group="background"] [data-angle]'),
    ).not.toBeNull();
  });

  // "Logo" over "Logo" repeated itself: under a titled group the logo row
  // drops its own label. Red if it is drawn there, or dropped in the editor.
  it("drops the logo row's own label under a titled Logo group only", () => {
    const labels = () =>
      [...root.querySelectorAll('[data-group="logo"] .control-label')].map(
        (l) => l.textContent,
      );
    mount(solid, handlers(), { groupTitles: true });
    // Premise: the group's title is there to say it.
    expect(q('[data-group="logo"] .branding-group-title').textContent).toBe(
      "Logo",
    );
    expect(labels()).not.toContain("Logo");
    mount(solid);
    expect(labels()).toContain("Logo");
  });

  it("draws no group titles in the editor", () => {
    mount(solid);
    expect(root.querySelectorAll("[data-group]").length).toBe(3);
    expect(root.querySelector(".branding-group-title")).toBeNull();
  });
});

describe("the editor's kit picker (mockup A, 2026-10-08)", () => {
  const ready = (id: string, name: string, kit = solid): KitEntry => ({
    id,
    name,
    read: { state: "ready", kit },
  });
  const list = (kits: KitEntry[], defaultId: string | null): BrandKitsRead => ({
    state: "ready",
    kits,
    defaultId,
    migrationPending: false,
  });
  const DARK = ready("a", "Dark");
  const LIGHT = ready("b", "Light", {
    ...solid,
    background: { kind: "solid", color: "#f4f1ea" },
  });
  const row = (over: Partial<KitRowProps> = {}): KitRowProps => ({
    read: list([DARK, LIGHT], "a"),
    standing: { kit: DARK, edited: false },
    naming: null,
    onApply: vi.fn(),
    onUpdate: vi.fn(),
    onStartNew: vi.fn(),
    onNameInput: vi.fn(),
    onConfirmNew: vi.fn(),
    onCancelNew: vi.fn(),
    ...over,
  });
  const open = () => q<HTMLButtonElement>("[data-kit-picker]").click();

  it("sits above the groups", () => {
    mount(solid, handlers(), { kit: row() });
    expect(
      q(".branding-controls").firstElementChild?.hasAttribute("data-kit-row"),
    ).toBe(true);
  });

  it("names the kit the take is on, with its swatch, and no Edited mark", () => {
    mount(solid, handlers(), { kit: row() });
    const picker = q("[data-kit-picker]");
    expect(q("[data-kit-picker] .kit-picker-name").textContent).toBe("Dark");
    expect(
      (q("[data-kit-picker] .kit-swatch") as HTMLElement).style.background,
    ).toMatch(/27, 42, 74|#1b2a4a/);
    expect(picker.querySelector("[data-kit-edited]")).toBeNull();
    expect(picker.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("marks a take that differs from its kit as Edited", () => {
    mount(solid, handlers(), {
      kit: row({ standing: { kit: DARK, edited: true } }),
    });
    expect(q("[data-kit-edited]").textContent).toBe("Edited");
  });

  it("reads Custom look for a take that matches no kit", () => {
    mount(solid, handlers(), { kit: row({ standing: null }) });
    expect(q("[data-kit-picker] .kit-picker-name").textContent).toBe(
      "Custom look",
    );
  });

  it("keeps its menu shut until the picker is pressed, then lists the kits and the two saves", () => {
    mount(solid, handlers(), { kit: row() });
    const menu = q<HTMLElement>("[data-kit-menu]");
    expect(menu.hidden).toBe(true);
    open();
    expect(menu.hidden).toBe(false);
    expect(q("[data-kit-picker]").getAttribute("aria-expanded")).toBe("true");
    const options = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-kit-option]"),
    ];
    expect(
      options.map((o) => [
        o.getAttribute("data-kit-option"),
        o.getAttribute("aria-checked"),
        o.querySelector('[data-icon="star"]') !== null,
      ]),
    ).toEqual([
      ["a", "true", true],
      ["b", "false", false],
    ]);
    expect(q("[data-kit-update]").textContent).toBe('Update "Dark"');
    expect(q("[data-kit-new]").textContent).toBe("Save as new kit…");
  });

  // Red if Update can be pressed with nothing to update, or if a line of
  // supporting text comes back under it (the author, 2026-10-08: the greyed
  // item says enough).
  it("greys Update out, with no supporting text, while the take matches its kit", () => {
    mount(solid, handlers(), { kit: row() });
    open();
    expect(q<HTMLButtonElement>("[data-kit-update]").disabled).toBe(true);
    expect(q("[data-kit-menu]").querySelector("p")).toBeNull();
  });

  it("offers Update for an edited take, and closes the menu on it", () => {
    const props = row({ standing: { kit: DARK, edited: true } });
    mount(solid, handlers(), { kit: props });
    open();
    q<HTMLButtonElement>("[data-kit-update]").click();
    expect(props.onUpdate).toHaveBeenCalledOnce();
    expect(q<HTMLElement>("[data-kit-menu]").hidden).toBe(true);
  });

  it("offers no Update for a custom look", () => {
    mount(solid, handlers(), { kit: row({ standing: null }) });
    open();
    expect(root.querySelector("[data-kit-update]")).toBeNull();
    expect(root.querySelector("[data-kit-new]")).not.toBeNull();
  });

  it("applies a kit chosen from the menu, and closes it", () => {
    const props = row();
    mount(solid, handlers(), { kit: props });
    open();
    q<HTMLButtonElement>('[data-kit-option="b"]').click();
    expect(props.onApply).toHaveBeenCalledWith("b");
    expect(q<HTMLElement>("[data-kit-menu]").hidden).toBe(true);
  });

  it("disables an unreadable kit in the menu, with its reason", () => {
    const bad: KitEntry = {
      id: "c",
      name: "Broken",
      read: { state: "invalid", reason: "bad colour" },
    };
    mount(solid, handlers(), {
      kit: row({ read: list([DARK, bad], "a") }),
    });
    open();
    const option = q<HTMLButtonElement>('[data-kit-option="c"]');
    expect(option.disabled).toBe(true);
    expect(option.title).toBe("bad colour");
  });

  // The editor re-renders on every session emit; an open menu that shut
  // on each would be unusable during an export.
  it("stays open across a re-render, and closes on Escape and outside clicks", () => {
    const props = row();
    mount(solid, handlers(), { kit: props });
    open();
    mount(solid, handlers(), { kit: props });
    expect(q<HTMLElement>("[data-kit-menu]").hidden).toBe(false);
    q("[data-kit-menu]").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(q<HTMLElement>("[data-kit-menu]").hidden).toBe(true);
    expect(document.activeElement).toBe(q("[data-kit-picker]"));
    open();
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    expect(q<HTMLElement>("[data-kit-menu]").hidden).toBe(true);
  });

  it("with no kits, reads No brand kit and offers only Save as new kit", () => {
    mount(solid, handlers(), {
      kit: row({ read: list([], null), standing: null }),
    });
    expect(q("[data-kit-picker] .kit-picker-name").textContent).toBe(
      "No brand kit",
    );
    open();
    expect(root.querySelectorAll("[data-kit-option]")).toHaveLength(0);
    expect(root.querySelector("[data-kit-update]")).toBeNull();
    q<HTMLButtonElement>("[data-kit-new]").click();
  });

  it("says the list could not be read, and offers no picker", () => {
    mount(solid, handlers(), {
      kit: row({ read: { state: "invalid", reason: "r" }, standing: null }),
    });
    expect(q("[data-kit-error]").textContent).toBe(
      "Your brand kits could not be read: r",
    );
    expect(root.querySelector("[data-kit-picker]")).toBeNull();
  });

  it("Save as new kit asks for a name in the picker's place", () => {
    const props = row();
    mount(solid, handlers(), { kit: props });
    open();
    q<HTMLButtonElement>("[data-kit-new]").click();
    expect(props.onStartNew).toHaveBeenCalledOnce();
    mount(solid, handlers(), {
      kit: { ...props, naming: { text: "", error: null } },
    });
    expect(root.querySelector("[data-kit-picker]")).toBeNull();
    expect(document.activeElement).toBe(q("[data-kit-new-name]"));
    // No supporting line under the field (the author, 2026-10-08).
    expect(q("[data-kit-row]").querySelector("p")).toBeNull();
  });

  // Review Focus 4: the field and its refusal are the editor's state.
  it("keeps a typed kit name and its refusal across a re-render", () => {
    const props = row({
      naming: { text: "Dar", error: 'a kit is already named "Dark"' },
    });
    mount(solid, handlers(), { kit: props });
    mount(solid, handlers(), { kit: props });
    expect(q<HTMLInputElement>("[data-kit-new-name]").value).toBe("Dar");
    expect(q("[data-kit-new-error]").textContent).toBe(
      'a kit is already named "Dark"',
    );
  });

  // Final review, Important 1. Red if every re-render pulls focus into the
  // open field: the editor re-renders on every session emit and export
  // progress tick, and its shortcuts stand down while an input has focus.
  it("leaves focus where the author put it when the open field re-renders", () => {
    const props = row({ naming: { text: "Dar", error: null } });
    mount(solid, handlers(), { kit: props });
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);
    mount(solid, handlers(), { kit: props });
    expect(document.activeElement).toBe(elsewhere);
  });

  it("keeps focus and the caret in the field when it re-renders mid-typing", () => {
    const props = row({ naming: { text: "Darker", error: null } });
    mount(solid, handlers(), { kit: props });
    const input = q<HTMLInputElement>("[data-kit-new-name]");
    input.focus();
    input.setSelectionRange(2, 2);
    mount(solid, handlers(), { kit: props });
    const again = q<HTMLInputElement>("[data-kit-new-name]");
    expect(again).not.toBe(input);
    expect(document.activeElement).toBe(again);
    expect([again.selectionStart, again.selectionEnd]).toEqual([2, 2]);
  });

  it("reports typing without re-rendering, confirms on Enter and Save, cancels on Escape", () => {
    const props = row({ naming: { text: "", error: null } });
    mount(solid, handlers(), { kit: props });
    const input = q<HTMLInputElement>("[data-kit-new-name]");
    input.value = "Blue";
    input.dispatchEvent(new Event("input"));
    expect(props.onNameInput).toHaveBeenCalledWith("Blue");
    expect(q("[data-kit-new-name]")).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(props.onConfirmNew).toHaveBeenCalledWith("Blue");
    q<HTMLButtonElement>("[data-kit-new-save]").click();
    expect(props.onConfirmNew).toHaveBeenCalledTimes(2);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(props.onCancelNew).toHaveBeenCalledOnce();
    q<HTMLButtonElement>("[data-kit-new-cancel]").click();
    expect(props.onCancelNew).toHaveBeenCalledTimes(2);
  });
});

describe("the gamut note across the commit's re-render", () => {
  it("still shows after the page re-renders with the committed colour", () => {
    // Both pages re-render the controls on every commit (the editor from
    // the session emit, Settings from `act`), so a note written only into
    // the DOM was gone before the author could read it.
    const rerender = (branding: SceneBranding) =>
      renderBrandingControls(
        root,
        {
          branding,
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
          onCommit: (patch) =>
            rerender({
              ...branding,
              background: patch.background ?? branding.background,
            }),
          onPreview: vi.fn(),
          onLogoFile: vi.fn(),
          onWallpaperFile: vi.fn(),
        },
      );
    rerender(solid);
    const text = q<HTMLInputElement>("[data-colour-text]");
    text.value = "oklch(0.7 0.4 150)";
    text.dispatchEvent(new Event("change"));
    // Premise: the commit re-rendered — a fresh text box holds the hex.
    expect(q<HTMLInputElement>("[data-colour-text]")).not.toBe(text);
    expect(q<HTMLInputElement>("[data-colour-text]").value).toBe("#00be58");
    expect(q("[data-colour-note]").textContent).toBe("Nearest sRGB is #00be58");
  });
});

describe("a colour box across an unrelated re-render", () => {
  // The editor re-renders these controls on every export progress message
  // and session emit; each case re-mounts with the same stored branding.
  const type = (text: HTMLInputElement, value: string) => {
    text.value = value;
    text.dispatchEvent(new Event("input"));
  };

  it("keeps a half-typed value, the focus and the caret", () => {
    mount(gradient);
    const from = q<HTMLInputElement>('[aria-label="From"]');
    from.focus();
    type(from, "oklch(0.6 0.15");
    from.setSelectionRange(6, 6);
    mount(gradient);
    const again = q<HTMLInputElement>('[aria-label="From"]');
    // Premise: the box was rebuilt, so what it holds came from the draft.
    expect(again).not.toBe(from);
    expect(again.value).toBe("oklch(0.6 0.15");
    expect(document.activeElement).toBe(again);
    expect([again.selectionStart, again.selectionEnd]).toEqual([6, 6]);
    // The other field is untouched.
    expect(q<HTMLInputElement>('[aria-label="To"]').value).toBe("#3b5bdb");
  });

  it("keeps a refused value and its reason", () => {
    mount(solid);
    const text = q<HTMLInputElement>("[data-colour-text]");
    type(text, "rgb(59 91");
    text.dispatchEvent(new Event("change"));
    mount(solid);
    const again = q<HTMLInputElement>("[data-colour-text]");
    expect(again).not.toBe(text);
    expect(again.value).toBe("rgb(59 91");
    expect(q("[data-colour-error]").textContent).toBe(
      '"rgb(59 91" is not a colour',
    );
    expect(again.getAttribute("aria-invalid")).toBe("true");
  });

  it("drops the draft once the stored colour moves on", () => {
    mount(gradient);
    type(q<HTMLInputElement>('[aria-label="From"]'), "oklch(0.6");
    // A Swap (or another tab's edit) changed what the draft was typed over.
    mount({
      ...gradient,
      background: {
        kind: "gradient",
        from: "#3b5bdb",
        to: "#1b2a4a",
        angle: 135,
      },
    });
    expect(q<HTMLInputElement>('[aria-label="From"]').value).toBe("#3b5bdb");
    // …and it does not come back when the colour returns.
    mount(gradient);
    expect(q<HTMLInputElement>('[aria-label="From"]').value).toBe("#1b2a4a");
  });
});

describe("padding", () => {
  it("shows the branding's padding as a whole percentage", () => {
    mount({ ...solid, padding: 0.12 });
    const slider = q<HTMLInputElement>("[data-padding]");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("0.2");
    expect(slider.step).toBe("0.01");
    expect(Number(slider.value)).toBeCloseTo(0.12, 6);
    expect(slider.closest(".slider-row")?.textContent).toContain("12%");
  });

  it("previews while dragging and commits on release, with padding alone", () => {
    const h = mount(solid);
    const slider = q<HTMLInputElement>("[data-padding]");
    slider.value = "0.15";
    slider.dispatchEvent(new Event("input"));
    expect(h.onPreview).toHaveBeenLastCalledWith({ padding: 0.15 });
    expect(h.onCommit).not.toHaveBeenCalled();
    slider.dispatchEvent(new Event("change"));
    expect(h.onCommit).toHaveBeenLastCalledWith({ padding: 0.15 });
  });

  it("is there with no logo and with a gradient", () => {
    mount(gradient);
    expect(root.querySelector("[data-padding]")).not.toBeNull();
  });
});
