// apps/studio/test/pages/node/settings-view.test.ts
import { describe, expect, it, vi } from "vitest";
import type {
  BrandKitsRead,
  KitEntry,
} from "../../../pages/src/core/brand-kit";
import type { SettingsModel } from "../../../pages/src/settings/state";
import type { SettingsActions } from "../../../pages/src/settings/view";
import { renderSettings } from "../../../pages/src/settings/view";

const model: SettingsModel = {
  brandKits: {
    state: "ready",
    kits: [],
    defaultId: null,
    migrationPending: false,
  },
  selectedKitId: null,
  brandKitLogo: null,
  brandKitPlacement: null,
  brandKitLogoThumb: null,
  brandKitNotes: [],
  brandKitWallpaper: { custom: null, loadError: null },
  pullRequests: "off",
  exportQuality: "share",
  kitsUnwatched: null,
};

const actions = (): SettingsActions &
  Record<string, ReturnType<typeof vi.fn>> => ({
  setPullRequests: vi.fn(),
  setExportQuality: vi.fn(),
  setBrandKit: vi.fn(),
  previewBrandKit: vi.fn(),
  uploadKitLogo: vi.fn(),
  uploadKitWallpaper: vi.fn(),
  selectKit: vi.fn(),
  newKit: vi.fn(),
  duplicateKit: vi.fn(),
  deleteKit: vi.fn(),
  renameKit: vi.fn(),
  setDefaultKit: vi.fn(),
  resetKits: vi.fn(),
});

const q = <T extends Element>(root: ParentNode, sel: string): T => {
  const found = root.querySelector<T>(sel);
  if (found === null) throw new Error(`no ${sel}`);
  return found;
};

describe("renderSettings", () => {
  // Red if the checked state is not the model's, a click does not reach
  // `setPullRequests`, or null is painted as a choice.
  it("draws Pull requests with the model's choice", () => {
    const root = document.createElement("div");
    const a = actions();
    renderSettings(root, { ...model, pullRequests: "ask" }, a, new Map());
    const group = q<HTMLElement>(
      root,
      '[data-section="pullRequests"] [role="radiogroup"][aria-label="Pull requests"]',
    );
    const choices = [
      ...group.querySelectorAll<HTMLButtonElement>("[role=radio]"),
    ];
    expect(choices.map((c) => c.textContent)).toEqual(["Off", "Ask", "Attach"]);
    expect(choices.map((c) => c.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    q<HTMLButtonElement>(group, '[data-pull-requests="attach"]').click();
    expect(a.setPullRequests).toHaveBeenCalledWith("attach");
    q<HTMLButtonElement>(group, '[data-pull-requests="ask"]').click();
    expect(a.setPullRequests).toHaveBeenCalledTimes(1);

    const unreadable = document.createElement("div");
    renderSettings(
      unreadable,
      { ...model, pullRequests: null },
      actions(),
      new Map([
        ["pullRequests", "Couldn't read: settings.json is not valid JSON"],
      ]),
    );
    expect(
      [
        ...unreadable.querySelectorAll<HTMLButtonElement>(
          '[data-section="pullRequests"] [role=radio]',
        ),
      ].map((c) => c.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "false"]);
    expect(
      q<HTMLElement>(unreadable, '[data-section="pullRequests"] [data-notice]')
        .textContent,
    ).toContain("settings.json is not valid JSON");
  });

  // The studio's Export quality: Sharing, High or Full, one radiogroup and no hint.
  // Red if the checked state is not the model's, a click does not reach
  // `setExportQuality`, or null is painted as a choice.
  it("draws Export quality with the model's choice", () => {
    const root = document.createElement("div");
    const a = actions();
    renderSettings(
      root,
      {
        ...model,
        exportQuality: "share",
        pullRequests: "off",
      },
      a,
      new Map(),
    );
    const section = q<HTMLElement>(root, '[data-section="export"]');
    const group = q<HTMLElement>(
      section,
      '[role="radiogroup"][aria-label="Export quality"]',
    );
    const choices = [
      ...group.querySelectorAll<HTMLButtonElement>("[role=radio]"),
    ];
    expect(choices.map((c) => c.textContent)).toEqual([
      "Sharing",
      "High",
      "Full",
    ]);
    expect(choices.map((c) => c.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    // No helper text: the section holds the heading and the group only.
    expect(section.querySelector(".hint")).toBeNull();
    q<HTMLButtonElement>(group, '[data-export-quality="full"]').click();
    expect(a.setExportQuality).toHaveBeenCalledWith("full");
    q<HTMLButtonElement>(group, '[data-export-quality="share"]').click();
    expect(a.setExportQuality).toHaveBeenCalledTimes(1);

    const unreadable = document.createElement("div");
    renderSettings(
      unreadable,
      {
        ...model,
        exportQuality: null,
        pullRequests: "off",
      },
      actions(),
      new Map([["export", "Couldn't read: settings.json is not valid JSON"]]),
    );
    expect(
      [
        ...unreadable.querySelectorAll<HTMLButtonElement>(
          '[data-section="export"] [role=radio]',
        ),
      ].map((c) => c.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "false"]);
    expect(
      q<HTMLElement>(unreadable, '[data-section="export"] [data-notice]')
        .textContent,
    ).toContain("settings.json is not valid JSON");
  });

  it("links every section from the nav, in the page's order", () => {
    const root = document.createElement("div");
    renderSettings(root, model, actions(), new Map());
    expect(
      [...root.querySelectorAll("[data-section]")].map((s) =>
        s.getAttribute("data-section"),
      ),
    ).toEqual(["brandKit", "export", "pullRequests"]);
    const links = [...root.querySelectorAll<HTMLAnchorElement>("a[data-nav]")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Brand kit", "#brand-kit"],
      ["Export", "#export"],
      ["Pull requests", "#pull-requests"],
    ]);
    // Each link lands on its section.
    for (const a of links) {
      const target = root.querySelector(a.getAttribute("href") ?? "");
      expect(target?.hasAttribute("data-section"), a.href).toBe(true);
    }
  });

  it("warns in the Brand kit section when the kits' feed is down", () => {
    const root = document.createElement("div");
    renderSettings(
      root,
      { ...model, kitsUnwatched: "the watcher stopped" },
      actions(),
      new Map(),
    );
    expect(
      q<HTMLElement>(root, '[data-section="brandKit"] [data-unwatched]')
        .textContent,
    ).toContain("the watcher stopped");
    const quiet = document.createElement("div");
    renderSettings(quiet, model, actions(), new Map());
    expect(quiet.querySelector("[data-unwatched]")).toBeNull();
  });
});

describe("the Brand kit section", () => {
  const KIT = {
    background: { kind: "solid" as const, color: "#1b2a4a" },
    logo: {
      ref: "logo:kit",
      corner: "top-left" as const,
      size: 0.05,
      opacity: 1,
    },
    padding: 0.08,
  };
  const entry = (id: string, name: string, kit = KIT): KitEntry => ({
    id,
    name,
    read: { state: "ready", kit },
  });
  const kits = (
    list: KitEntry[],
    defaultId: string | null = list[0]?.id ?? null,
  ): BrandKitsRead => ({
    state: "ready",
    kits: list,
    defaultId,
    migrationPending: false,
  });
  const section = (m: Partial<SettingsModel>) => {
    const root = document.createElement("div");
    const a = actions();
    renderSettings(root, { ...model, ...m }, a, new Map());
    return { root, a, box: q<HTMLElement>(root, '[data-section="brandKit"]') };
  };

  it("edits the selected kit", () => {
    const { box } = section({
      brandKits: kits([entry("a", "Dark")]),
      selectedKitId: "a",
    });
    expect(q<HTMLInputElement>(box, "[data-colour-text]").value).toBe(
      "#1b2a4a",
    );
    expect(box.querySelector("[data-preview-kit]")).not.toBeNull();
    // The editor's kit row does not belong on the page that IS the kits.
    expect(box.querySelector("[data-kit-row]")).toBeNull();
    // The section's title stands alone (2026-10-08).
    expect(box.querySelector(".section-head")?.children).toHaveLength(1);
  });

  it("starts from the defaults when there are no kits, with New kit", () => {
    const { box } = section({});
    // The defaults' wallpaper, pressed in the grid.
    expect(
      q(box, '[data-wallpaper-id="vivid-1"]').getAttribute("aria-pressed"),
    ).toBe("true");
    expect(box.querySelector("[data-kit-tile]")).toBeNull();
    expect(box.querySelector("[data-kit-new]")).not.toBeNull();
    // No kit to rename, copy or delete yet.
    expect(box.querySelector("[data-kit-name]")).toBeNull();
  });

  it("draws a tile per kit, the default's star pressed, then New kit", () => {
    const { box } = section({
      brandKits: kits([entry("a", "Dark"), entry("b", "Light")], "b"),
      selectedKitId: "a",
    });
    const tiles = [...box.querySelectorAll("[data-kit-tile]")];
    expect(
      tiles.map((t) => t.querySelector(".kit-tile-name")?.textContent),
    ).toEqual(["Dark", "Light"]);
    expect(q(box, '[data-kit-star="b"]').getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(q(box, '[data-kit-star="b"]').getAttribute("aria-label")).toBe(
      '"Light" is the default kit',
    );
    expect(q(box, '[data-kit-star="a"]').getAttribute("aria-label")).toBe(
      'Make "Dark" the default kit',
    );
    // Named for a screen reader, but no hover tooltip (the author,
    // 2026-10-08).
    expect(q(box, '[data-kit-star="a"]').hasAttribute("title")).toBe(false);
    expect(q(box, '[data-kit-select="a"]').getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      box
        .querySelector(".kit-strip > :last-child")
        ?.hasAttribute("data-kit-new"),
    ).toBe(true);
  });

  it("the star calls setDefaultKit, except on the default", () => {
    const { box, a } = section({
      brandKits: kits([entry("a", "Dark"), entry("b", "Light")], "a"),
      selectedKitId: "a",
    });
    q<HTMLButtonElement>(box, '[data-kit-star="b"]').click();
    q<HTMLButtonElement>(box, '[data-kit-star="a"]').click();
    expect(a.setDefaultKit).toHaveBeenCalledOnce();
    expect(a.setDefaultKit).toHaveBeenCalledWith("b");
  });

  it("a tile selects its kit; New, Duplicate and Delete call their actions", () => {
    const { box, a } = section({
      brandKits: kits([entry("a", "Dark"), entry("b", "Light")], "a"),
      selectedKitId: "a",
    });
    q<HTMLButtonElement>(box, '[data-kit-select="b"]').click();
    q<HTMLButtonElement>(box, "[data-kit-new]").click();
    q<HTMLButtonElement>(box, "[data-kit-duplicate]").click();
    q<HTMLButtonElement>(box, "[data-kit-delete]").click();
    expect(a.selectKit).toHaveBeenCalledWith("b");
    expect(a.newKit).toHaveBeenCalledOnce();
    expect(a.duplicateKit).toHaveBeenCalledWith("a");
    expect(a.deleteKit).toHaveBeenCalledWith("a");
  });

  it("disables Delete on the last kit, and says why", () => {
    const { box } = section({
      brandKits: kits([entry("a", "Dark")]),
      selectedKitId: "a",
    });
    const del = q<HTMLButtonElement>(box, "[data-kit-delete]");
    expect(del.disabled).toBe(true);
    expect(del.title).toBe("The last kit cannot be deleted");
  });

  it("puts the hero preview above three titled groups", () => {
    const { box } = section({
      brandKits: kits([entry("a", "Dark")]),
      selectedKitId: "a",
    });
    const hero = q(box, ".kit-hero");
    const controls = q(box, ".kit-controls");
    expect(hero.querySelector("[data-preview-kit]")).not.toBeNull();
    expect(
      hero.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      [...controls.querySelectorAll(".branding-group-title")].map(
        (h) => h.textContent,
      ),
    ).toEqual(["Background", "Frame", "Logo"]);
  });

  it("an unreadable kit's tile warns, and selecting it says why above the controls", () => {
    const bad: KitEntry = {
      id: "c",
      name: "Broken",
      read: { state: "invalid", reason: "background.color: bad" },
    };
    const { box } = section({
      brandKits: kits([entry("a", "Dark"), bad]),
      selectedKitId: "c",
    });
    expect(
      box.querySelector('[data-kit-tile="c"] [data-icon="circleAlert"]'),
    ).not.toBeNull();
    expect(box.querySelector('[data-kit-tile="c"] canvas')).toBeNull();
    expect(q<HTMLButtonElement>(box, '[data-kit-select="c"]').title).toBe(
      "background.color: bad",
    );
    expect(box.textContent).toContain(
      '"Broken" could not be read: background.color: bad',
    );
    expect(box.querySelector("[data-bg-kind]")).not.toBeNull();
  });

  it("an unreadable list offers only to start fresh", () => {
    const { box, a } = section({
      brandKits: { state: "invalid", reason: "r" },
      selectedKitId: null,
    });
    expect(box.textContent).toContain("Your brand kits could not be read: r");
    expect(box.querySelector("[data-kit-tile]")).toBeNull();
    expect(box.querySelector("[data-bg-kind]")).toBeNull();
    q<HTMLButtonElement>(box, "[data-kit-reset-list]").click();
    expect(a.resetKits).toHaveBeenCalledOnce();
  });

  // Final review, Important 2. Red if a storage fault is offered the
  // fresh start: the kits would read fine on the next try, and a refused
  // move still holds the author's original kit under the old key.
  it("offers no fresh start when storage refused the read, and says what to do", () => {
    const { box } = section({
      brandKits: {
        state: "invalid",
        reason: "storage refused the read: busy",
        storageRefused: true,
      },
      selectedKitId: null,
    });
    expect(box.querySelector("[data-kit-reset-list]")).toBeNull();
    expect(box.textContent).toContain(
      "Your brand kits could not be read: storage refused the read: busy",
    );
    expect(box.textContent).toContain(
      "Nothing was changed. Reload this page to try again.",
    );
  });

  it("renames on change, and Escape restores the stored name", () => {
    const { box, a } = section({
      brandKits: kits([entry("a", "Dark")]),
      selectedKitId: "a",
    });
    const name = q<HTMLInputElement>(box, "[data-kit-name]");
    expect(name.value).toBe("Dark");
    name.value = "Night";
    name.dispatchEvent(new Event("change"));
    expect(a.renameKit).toHaveBeenCalledWith("a", "Night");
    name.value = "Nig";
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(name.value).toBe("Dark");
  });

  it("commits through setBrandKit", () => {
    const { box, a } = section({
      brandKits: kits([entry("a", "Dark")]),
      selectedKitId: "a",
    });
    q<HTMLButtonElement>(box, '[data-bg-kind="gradient"]').click();
    expect(a.setBrandKit).toHaveBeenCalledOnce();
  });
});
