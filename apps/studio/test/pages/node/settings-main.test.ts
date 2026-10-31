import { BRANDING_DEFAULTS } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioError } from "../../../pages/src/platform/http";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

/**
 * `entrypoints/settings/main.ts`'s Brand kit section against the memory
 * platform: the real entrypoint, the real view, the kits' storage in
 * memory. What this pins is the "report before you forgive" shape of the
 * kit editor — a kit list that will not read says so and renders no control
 * that would lie, a refused write says why after the re-render.
 *
 * Moved from apps/extension on 2026-10-20. There it ran against a faked
 * `chrome` and also covered the extension's own Settings (theme, Rewind,
 * sites, agent runs, allowed sites); those sections are not the studio's
 * and left with the extension, as did the move of a pre-list single kit
 * (`brandKit`), which only the extension's storage ever held.
 */

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports stay; only the platform is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

function mountDom(): void {
  document.body.innerHTML = `
    <header class="topbar"><div class="topbar-actions">
      <div class="topbar-theme" data-theme-slot></div>
    </div></header>
    <div id="notice" class="hidden" role="alert"></div>
    <main id="root"></main>
  `;
  delete document.documentElement.dataset.theme;
}

const confirmDialog = vi.hoisted(() => ({
  ask: vi.fn<(question: Record<string, unknown>) => Promise<boolean>>(),
}));
vi.mock("../../../pages/src/shell/confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askToConfirm: (question: Record<string, unknown>) =>
    confirmDialog.ask(question),
}));

const q = (sel: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(sel);
  if (found === null) throw new Error(`no ${sel}`);
  return found;
};

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * `document` outlives `vi.resetModules()`, and `main.ts` registers its
 * `visibilitychange` refresh at module scope — so every earlier test's copy
 * of the page was still listening when a later test flipped visibility.
 * Each of them re-rendered against the current test's fake (inflating its
 * message count, the premise of one case below) and then, once
 * `afterEach` had unstubbed `chrome`, logged `chrome is not defined` sixteen
 * times into the CI log. Recorded on the way in, detached on the way out;
 * the same pattern as `editor-main-keyboard.test.ts`.
 */
const documentListeners: [string, EventListenerOrEventListenerObject][] = [];

let memory: MemoryPlatform;
/** The kits' storage as the kit store holds it (`brandKits`,
 *  `defaultKitId`). */
let bucket: Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  mountDom();
  const addListener = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(
    (type, listener, options) => {
      if (listener) documentListeners.push([type, listener]);
      addListener(type, listener, options);
    },
  );
  memory = createMemoryPlatform();
  state.memory = memory;
  bucket = memory.kitStorage.data;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [type, listener] of documentListeners.splice(0)) {
    document.removeEventListener(type, listener);
  }
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** How many times the page read the kits: one per render of the section. */
const kitReads = (): number =>
  memory.calls.filter((c) => c.member === "kits" && c.method === "read").length;

describe("settings main — the brand kits", () => {
  const KIT = {
    background: { kind: "solid", color: "#1b2a4a" },
    logo: null,
    padding: 0.08,
  };
  const DARK = { id: "a", name: "Dark", branding: KIT };
  const LIGHT = {
    id: "b",
    name: "Light",
    branding: { ...KIT, background: { kind: "solid", color: "#f4f4f4" } },
  };
  type Stored = { id: string; name: string; branding: typeof KIT };
  const kits = () => bucket.brandKits as Stored[] | undefined;
  /** What the kit strip says about each kit, in the words the extension's
   *  Diagnostics section used to print (the studio draws no Diagnostics):
   *  its name, whether its star is pressed, and whether it reads. Every kit
   *  in this file is logo-less. */
  const lines = (): string[] => {
    const tiles = [
      ...document.querySelectorAll<HTMLElement>("[data-kit-tile]"),
    ];
    if (tiles.length === 0) return ["Brand kits: none saved"];
    return tiles.map((tile) => {
      const name = tile.querySelector(".kit-tile-name")?.textContent ?? "";
      const starred =
        tile.querySelector("[data-kit-star]")?.getAttribute("aria-pressed") ===
        "true";
      const pick = tile.querySelector<HTMLElement>("[data-kit-select]");
      const broken = tile.querySelector(".kit-thumb-broken") !== null;
      const state = broken
        ? `invalid — ${pick?.title ?? ""}`
        : "valid, no logo";
      return `Brand kit "${name}"${starred ? " (default)" : ""}: ${state}`;
    });
  };
  const section = '[data-section="brandKit"]';
  const ready = (what = "the Brand kit section") =>
    until(
      () => document.querySelector(`${section} [data-bg-kind]`) !== null,
      what,
    );
  const boot = async (stored: Record<string, unknown> = {}) => {
    Object.assign(bucket, stored);
    await import("../../../pages/entrypoints/settings/main");
  };

  beforeEach(() => {
    confirmDialog.ask.mockReset().mockResolvedValue(true);
  });

  it("with no kits, shows the defaults, and the first edit saves them as the default kit", async () => {
    await boot();
    await ready();
    // Premise: no kit, and the controls start from the defaults, a
    // wallpaper — so Solid is a real change.
    expect(kits()).toBeUndefined();
    expect(lines()).toEqual(["Brand kits: none saved"]);
    expect(
      q(`${section} [data-bg-kind="wallpaper"]`).getAttribute("aria-checked"),
    ).toBe("true");
    q(`${section} [data-bg-kind="solid"]`).click();
    await until(() => kits() !== undefined, "the kit write");
    expect(kits()?.[0]).toMatchObject({ name: "Brand kit" });
    expect(kits()?.[0]?.branding.background.kind).toBe("solid");
    expect(bucket.defaultKitId).toBe(kits()?.[0]?.id);
    await until(
      () => lines().includes('Brand kit "Brand kit" (default): valid, no logo'),
      "the Diagnostics line",
    );
  });

  it("says why a stored kit is unreadable, and a save replaces it", async () => {
    await boot({
      brandKits: [
        {
          id: "a",
          name: "Dark",
          branding: {
            background: { kind: "solid", color: "navy" },
            logo: null,
          },
        },
      ],
      defaultKitId: "a",
    });
    await until(
      () =>
        document
          .querySelector(section)
          ?.textContent?.includes('"Dark" could not be read') ?? false,
      "the unreadable-kit notice",
    );
    expect(lines()[0]).toMatch(/^Brand kit "Dark" \(default\): invalid — /);
    q(`${section} [data-bg-kind="solid"]`).click();
    await until(
      () => kits()?.[0]?.branding.background.kind === "solid",
      "the replacing write",
    );
    await until(
      () => lines()[0] === 'Brand kit "Dark" (default): valid, no logo',
      "the re-render",
    );
  });

  it("builds a second quick change on the first, not on the last render", async () => {
    await boot();
    await ready();
    // The defaults are a wallpaper: the first edit makes the kit a gradient
    // (from the wallpaper's swatch), and the two quick changes follow it.
    q(`${section} [data-bg-kind="gradient"]`).click();
    await until(
      () => document.querySelector(`${section} [data-angle]`) !== null,
      "the gradient controls",
    );
    const angle = q(`${section} [data-angle]`) as HTMLInputElement;
    const from = (q(`${section} [aria-label="From"]`) as HTMLInputElement)
      .value;
    const to = (q(`${section} [aria-label="To"]`) as HTMLInputElement).value;
    // Premise: the defaults are a gradient with two different colours and
    // an angle other than the one set below, so each change is visible.
    expect(from).not.toBe(to);
    expect(angle.value).not.toBe("40");
    angle.value = "40";
    angle.dispatchEvent(new Event("change"));
    q(`${section} [data-swap]`).click();
    await until(
      () =>
        (kits()?.[0]?.branding.background as { from?: string } | undefined)
          ?.from === to,
      "the Swap's write",
    );
    expect(kits()?.[0]?.branding.background).toEqual({
      kind: "gradient",
      from: to,
      to: from,
      angle: 40,
    });
    // One kit, not two: the second change found the kit the first made.
    expect(kits()).toHaveLength(1);
    await until(
      () => (q(`${section} [data-angle]`) as HTMLInputElement).value === "40",
      "the re-render",
    );
  });

  it("says a refused write was refused, and keeps showing the old kit", async () => {
    memory.kitStorage.refuse.set = new Error("QUOTA_BYTES exceeded");
    await boot();
    await ready();
    q(`${section} [data-bg-kind="solid"]`).click();
    await until(
      () => q("#notice").textContent?.includes("QUOTA_BYTES exceeded") ?? false,
      "the refusal",
    );
    expect(kits()).toBeUndefined();
    expect(lines()).toEqual(["Brand kits: none saved"]);
  });

  // Final review, Minor 3 (a). Red if a page whose list went stale says a
  // kit was deleted: nothing was — another page saved the first kit.
  it("says its list was out of date, not that a kit was deleted, and shows the kits as they are", async () => {
    await boot();
    await ready();
    // Premise: this page drew no kits.
    expect(document.querySelector("[data-kit-tile]")).toBeNull();
    // An editor beside it saves the first kit.
    bucket.brandKits = [DARK];
    bucket.defaultKitId = "a";
    q(`${section} [data-bg-kind="solid"]`).click();
    await until(
      () =>
        q("#notice").textContent?.includes(
          "this page's kit list was out of date, so nothing was changed",
        ) ?? false,
      "the out-of-date refusal",
    );
    expect(q("#notice").textContent).not.toContain("deleted");
    expect(kits()).toEqual([DARK]);
    await until(
      () => document.querySelector('[data-kit-tile="a"]') !== null,
      "the kits as they are now",
    );
  });

  it("selects the default kit on load and edits it", async () => {
    await boot({ brandKits: [LIGHT, DARK], defaultKitId: "a" });
    await ready();
    expect(q('[data-kit-select="a"]').getAttribute("aria-pressed")).toBe(
      "true",
    );
    q(`${section} [data-bg-kind="gradient"]`).click();
    await until(
      () => kits()?.[1]?.branding.background.kind === "gradient",
      "Dark's write",
    );
    expect(kits()?.[0]).toEqual(LIGHT);
  });

  it("edits the kit the author selects", async () => {
    await boot({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    await ready();
    q('[data-kit-select="b"]').click();
    await until(
      () =>
        (q(`${section} [data-colour-text]`) as HTMLInputElement).value ===
        "#f4f4f4",
      "Light's controls",
    );
    q(`${section} [data-bg-kind="gradient"]`).click();
    await until(
      () => kits()?.[1]?.branding.background.kind === "gradient",
      "Light's write",
    );
    expect(kits()?.[0]).toEqual(DARK);
  });

  // Review 2026-10-08: the write read the selection when it ran, not when
  // the author made the edit, so a tile clicked while the write was still
  // on its way (a logo decoding, a write queued ahead) took the edit. Red
  // if writeKit reads `selectedKitId` after any await: Light turns gradient
  // and Dark keeps its solid.
  it("saves an edit to the kit it was made on, though another tile is clicked before it lands", async () => {
    await boot({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    await ready();
    // Premise: Dark is the kit being edited when the change is made.
    expect(q('[data-kit-select="a"]').getAttribute("aria-pressed")).toBe(
      "true",
    );
    q(`${section} [data-bg-kind="gradient"]`).click();
    q('[data-kit-select="b"]').click();
    await until(
      () => kits()?.[0]?.branding.background.kind === "gradient",
      "Dark's write",
    );
    expect(kits()?.[1]).toEqual(LIGHT);
  });

  it("the star makes a kit the default, with no question", async () => {
    await boot({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    await ready();
    q('[data-kit-star="b"]').click();
    await until(() => bucket.defaultKitId === "b", "the default write");
    expect(confirmDialog.ask).not.toHaveBeenCalled();
    await until(
      () => q('[data-kit-star="b"]').getAttribute("aria-pressed") === "true",
      "the star repainted",
    );
    expect(lines()).toContain('Brand kit "Light" (default): valid, no logo');
  });

  it("New kit adds Untitled kit from the defaults and selects it", async () => {
    await boot({ brandKits: [DARK], defaultKitId: "a" });
    await ready();
    q("[data-kit-new]").click();
    await until(() => kits()?.length === 2, "the new kit");
    const added = kits()?.[1];
    expect(added).toMatchObject({
      name: "Untitled kit",
      branding: BRANDING_DEFAULTS,
    });
    expect(bucket.defaultKitId).toBe("a");
    await until(
      () =>
        document
          .querySelector(`[data-kit-select="${added?.id}"]`)
          ?.getAttribute("aria-pressed") === "true",
      "the new kit selected",
    );
  });

  // Found in the D3 author's check: since D1 the page's own kit write raises
  // a refresh (the studio's `kits` event), and that refresh's paint ran
  // `selectFallback` against the list
  // from before the write — which has no new kit — so New kit and Duplicate
  // left the old kit selected. Red if the selection is set before the write
  // lands instead of after: the default stays pressed.
  const echoKitWrites = () =>
    memory.kitStorage.area.set.mockImplementation(
      async (entries: Record<string, unknown>) => {
        Object.assign(bucket, entries);
        if ("brandKits" in entries) memory.emitKits();
      },
    );

  it("New kit selects the new kit when the write raises a refresh", async () => {
    await boot({ brandKits: [DARK], defaultKitId: "a" });
    await ready();
    echoKitWrites();
    q("[data-kit-new]").click();
    await until(() => kits()?.length === 2, "the new kit");
    const added = kits()?.[1];
    // The premise: the write did raise the refresh this case is about.
    expect(
      memory.calls.some((c) => c.member === "kits" && c.method === "onChange"),
    ).toBe(true);
    await until(
      () =>
        (q("[data-kit-name]") as HTMLInputElement).value === "Untitled kit" &&
        document
          .querySelector(`[data-kit-select="${added?.id}"]`)
          ?.getAttribute("aria-pressed") === "true",
      "the new kit selected",
    );
  });

  it("Duplicate selects the copy when the write raises a refresh", async () => {
    await boot({ brandKits: [DARK], defaultKitId: "a" });
    await ready();
    echoKitWrites();
    q("[data-kit-duplicate]").click();
    await until(() => kits()?.length === 2, "the copy");
    await until(
      () => (q("[data-kit-name]") as HTMLInputElement).value === "Dark copy",
      "the copy selected",
    );
  });

  it("Duplicate copies the kit as '<name> copy' and selects it", async () => {
    await boot({ brandKits: [DARK], defaultKitId: "a" });
    await ready();
    q("[data-kit-duplicate]").click();
    await until(() => kits()?.length === 2, "the copy");
    expect(kits()?.[1]).toMatchObject({ name: "Dark copy", branding: KIT });
    await until(
      () => (q("[data-kit-name]") as HTMLInputElement).value === "Dark copy",
      "the copy selected",
    );
  });

  it("Rename refuses a clash and keeps the stored name", async () => {
    await boot({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    await ready();
    const name = q("[data-kit-name]") as HTMLInputElement;
    name.value = "light";
    name.dispatchEvent(new Event("change"));
    await until(
      () =>
        q("#notice").textContent?.includes(
          'Couldn\'t rename the kit: a kit is already named "Light".',
        ) ?? false,
      "the refusal",
    );
    expect(kits()?.[0]?.name).toBe("Dark");
  });

  it("Rename stores a new name", async () => {
    await boot({ brandKits: [DARK], defaultKitId: "a" });
    await ready();
    const name = q("[data-kit-name]") as HTMLInputElement;
    name.value = "  Night ";
    name.dispatchEvent(new Event("change"));
    await until(() => kits()?.[0]?.name === "Night", "the rename");
  });

  // Review Focus 5.
  it("deleting the default asks, names the next default, and hands it over", async () => {
    await boot({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    await ready();
    q("[data-kit-delete]").click();
    await until(() => kits()?.length === 1, "the delete");
    expect(kits()).toEqual([LIGHT]);
    expect(bucket.defaultKitId).toBe("b");
    expect(confirmDialog.ask.mock.calls[0]?.[0]).toMatchObject({
      title: 'Delete "Dark"',
      danger: true,
      focus: "cancel",
      body: '"Dark" will be deleted. "Light" becomes the default kit. Videos already made keep their look.',
    });
  });

  it("deletes nothing on No", async () => {
    confirmDialog.ask.mockReset().mockResolvedValue(false);
    await boot({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    await ready();
    q("[data-kit-delete]").click();
    await until(() => confirmDialog.ask.mock.calls.length === 1, "the ask");
    expect(kits()).toEqual([DARK, LIGHT]);
  });

  it("cannot delete the last kit", async () => {
    await boot({ brandKits: [DARK], defaultKitId: "a" });
    await ready();
    const del = q("[data-kit-delete]") as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toBe("The last kit cannot be deleted");
  });

  it("repairs a default that names no kit on the next write, and says so", async () => {
    await boot({ brandKits: [DARK, LIGHT], defaultKitId: "gone" });
    await ready();
    // Premise: the default names no kit, so no kit's star is pressed.
    expect(
      document.querySelectorAll('[data-kit-star][aria-pressed="true"]'),
    ).toHaveLength(0);
    q(`${section} [data-bg-kind="gradient"]`).click();
    await until(() => bucket.defaultKitId === "a", "the repair");
    await until(
      () =>
        q("#notice").textContent?.includes(
          'Your default kit was missing, so "Dark" is the default now.',
        ) ?? false,
      "the warning",
    );
  });

  // D1 (Launch D3): the page follows `platform.kits.onChange` — the
  // studio's `kits` event — so a kit renamed in an editor window shows here
  // without a tab flip. Red if the page stops listening: it keeps showing
  // "Dark".
  it("re-reads the kits when the platform reports a kit change", async () => {
    await boot({ brandKits: [DARK], defaultKitId: "a" });
    await until(
      () => lines().includes('Brand kit "Dark" (default): valid, no logo'),
      "the first render",
    );
    const renders = kitReads();
    // Written behind the page's back, as another window would.
    bucket.brandKits = [{ ...DARK, name: "Dusk" }];
    // The premise: nothing re-reads without the change event.
    await new Promise((r) => setTimeout(r, 0));
    expect(lines()).toContain('Brand kit "Dark" (default): valid, no logo');
    memory.emitKits();
    await until(
      () => lines().includes('Brand kit "Dusk" (default): valid, no logo'),
      "the re-read after the change",
    );
    expect(kitReads(), "a render landed").toBeGreaterThan(renders);
  });

  it("offers to start a fresh list only when the list itself is unreadable, and asks", async () => {
    await boot({ brandKits: "garbage" });
    await until(
      () =>
        document
          .querySelector(section)
          ?.textContent?.includes("Your brand kits could not be read") ?? false,
      "the unreadable-list notice",
    );
    expect(document.querySelector(`${section} [data-bg-kind]`)).toBeNull();
    q("[data-kit-reset-list]").click();
    await until(() => Array.isArray(bucket.brandKits), "the fresh list");
    expect(bucket.brandKits).toEqual([]);
    expect(confirmDialog.ask).toHaveBeenCalledOnce();
  });

  it("says a kit's uploaded image that cannot be loaded", async () => {
    // The memory platform answers a ref it never stored with a reason, as
    // the studio answers one that moved.
    const ref = "assets/moved.webp";
    await boot({
      brandKits: [
        {
          id: "a",
          name: "Photo",
          branding: { ...KIT, background: { kind: "image", ref } },
        },
      ],
      defaultKitId: "a",
    });
    const reason = `no wallpaper at ${ref} in the memory platform`;
    await until(
      () =>
        document
          .querySelector(`${section} [data-wallpaper-error]`)
          ?.textContent?.includes(reason) ?? false,
      "the load failure in the panel",
    );
    // The premise: the platform was asked for that image.
    expect(
      memory.calls.filter(
        (c) => c.member === "wallpapers" && c.method === "load",
      ),
    ).toHaveLength(1);
    expect(
      q(`${section} [data-wallpaper-custom]`).getAttribute("aria-label"),
    ).toContain(reason);
  });

  it("says why an upload was refused, and writes nothing", async () => {
    const reason =
      'The file "bg.gif" is a image/gif file — use SVG, PNG, WebP or JPEG';
    memory.answer("wallpapers.put", async () => {
      throw new StudioError("wallpaperRefused", reason, 400);
    });
    await boot();
    await ready();
    // The premise: no kit yet, so any write at all would make one.
    expect(kits()).toBeUndefined();
    const input = q(
      `${section} input[data-wallpaper-file]`,
    ) as HTMLInputElement;
    const file = new File(["gif"], "bg.gif", { type: "image/gif" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await until(
      () => q("#notice").textContent?.includes(reason) ?? false,
      "the refusal",
    );
    expect(q("#notice").textContent).toContain("Couldn't add the image");
    expect(
      memory.calls.filter(
        (c) => c.member === "wallpapers" && c.method === "put",
      ),
    ).toHaveLength(1);
    expect(kits()).toBeUndefined();
  });
});
