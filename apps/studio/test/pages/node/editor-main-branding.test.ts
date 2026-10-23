import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { editorDom } from "../helpers/editor-dom";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports (the studio's own copy, such as
// `refilmLine`) stay; only the platform the page builds is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

/**
 * The Background panel's brand-kit actions, from the button to storage and
 * the document. Harness shape as `editor-main-logo.test.ts`, plus a
 * kit storage the memory platform holds.
 */

// jsdom has no `showModal`, so the dialog itself is asserted in
// test/browser/confirm-dialog.test.ts and only its answer is faked here.
const confirmDialog = vi.hoisted(() => ({
  ask: vi.fn<
    (question: {
      title: string;
      body: string;
      confirmLabel: string;
      danger: boolean;
      focus: string;
    }) => Promise<boolean>
  >(),
}));
vi.mock("../../../pages/src/shell/confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askToConfirm: (question: Parameters<typeof confirmDialog.ask>[0]) =>
    confirmDialog.ask(question),
}));

class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): Record<string, never> {
    return {};
  }
}

const KIT = {
  background: { kind: "solid", color: "#1b2a4a" },
  logo: null,
  padding: 0.08,
};

/** The memory platform with the brand kits' storage seeded `stored`, and
 *  the fixture take open. */
function fakeChrome(stored: Record<string, unknown>) {
  const memory = createMemoryPlatform({ kits: stored });
  memory.serveScene(() => readonlyScene());
  state.memory = memory;
  return memory;
}

async function openBackground(): Promise<void> {
  const tab = await vi.waitFor(() => {
    const node = document.querySelector<HTMLButtonElement>(
      '#rail [data-rail="background"]',
    );
    if (!node) throw new Error("rail not rendered yet");
    return node;
  });
  tab.click();
}

const button = (sel: string) =>
  vi.waitFor(() => {
    const node = document.querySelector<HTMLButtonElement>(sel);
    if (!node) throw new Error(`${sel} not rendered yet`);
    return node;
  });

/** The last scene the editor saved. */
function lastPut(memory: MemoryPlatform) {
  const puts = memory.putCalls();
  return puts[puts.length - 1]?.scene as
    | { branding: { background: unknown; padding?: number } }
    | undefined;
}

describe("editor main — the brand kit", () => {
  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("a Padding drag is one undoable edit", async () => {
    const memory = fakeChrome({});
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    // Premise: the fixture starts at the default.
    expect(readonlyScene().branding.padding).toBe(0.08);
    const slider = (await button(
      "[data-padding]",
    )) as unknown as HTMLInputElement;
    slider.value = "0.15";
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      if (lastPut(memory)?.branding.padding !== 0.15) {
        throw new Error("padding not saved yet");
      }
    });
    (document.getElementById("undo") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (lastPut(memory)?.branding.padding !== 0.08) {
        throw new Error("not undone yet");
      }
    });
  });

  const DARK = { id: "a", name: "Dark", branding: KIT };
  const LIGHT = {
    id: "b",
    name: "Light",
    branding: { ...KIT, background: { kind: "solid", color: "#f4f4f4" } },
  };
  /** A kit whose look IS the fixture take's: the kit it was recorded on. */
  const ON = () => ({
    id: "o",
    name: "Dark",
    branding: readonlyScene().branding,
  });
  type Stored = typeof DARK;
  const kitsOf = (memory: MemoryPlatform) =>
    memory.kitStorage.data.brandKits as Stored[];
  const openMenu = async () => {
    const picker = await button("[data-kit-picker]");
    const menu = await button("[data-kit-menu]");
    if ((menu as unknown as HTMLElement).hidden) picker.click();
  };
  const choose = async (id: string) => {
    await openMenu();
    (await button(`[data-kit-option="${id}"]`)).click();
  };
  const pickerReads = async (name: string, edited: boolean) =>
    vi.waitFor(async () => {
      const picker = await button("[data-kit-picker]");
      const got = picker.querySelector(".kit-picker-name")?.textContent;
      const mark = picker.querySelector("[data-kit-edited]") !== null;
      if (got !== name || mark !== edited) {
        throw new Error(`picker reads ${got}${mark ? " (Edited)" : ""}`);
      }
    });
  const nudgePadding = async (memory: MemoryPlatform) => {
    const slider = (await button(
      "[data-padding]",
    )) as unknown as HTMLInputElement;
    const next = slider.value === "0.15" ? "0.16" : "0.15";
    slider.value = next;
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      if (String(lastPut(memory)?.branding.padding) !== next) {
        throw new Error("padding not saved yet");
      }
    });
  };
  const typeName = async (text: string) => {
    await openMenu();
    (await button("[data-kit-new]")).click();
    const input = (await button(
      "[data-kit-new-name]",
    )) as unknown as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event("input"));
    return input;
  };
  const failure = () => document.getElementById("failure")?.textContent ?? "";

  // A kit that differs from the demo only in padding: Apply must apply it,
  // as one undo step. Red if the patch leaves padding out, or if
  // sameBranding calls the two equal.
  it("applying a kit applies its padding when only the padding differs", async () => {
    const kit = { ...readonlyScene().branding, padding: 0.15 };
    const memory = fakeChrome({
      brandKits: [{ id: "p", name: "Wide", branding: kit }],
      defaultKitId: "p",
    });
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await choose("p");
    await vi.waitFor(() => {
      if (lastPut(memory)?.branding.padding !== 0.15) {
        throw new Error("kit padding not applied yet");
      }
    });
    (document.getElementById("undo") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (lastPut(memory)?.branding.padding !== 0.08) {
        throw new Error("not undone yet");
      }
    });
  });

  it("applying a kit is one undo step, and the picker then names it", async () => {
    const memory = fakeChrome({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    const before = readonlyScene().branding;
    expect(before.background, "premise: the take is not on Light").not.toEqual(
      LIGHT.branding.background,
    );
    // Premise: the fixture take matches neither kit.
    await pickerReads("Custom look", false);
    await choose("b");
    await vi.waitFor(() => {
      if (
        JSON.stringify(lastPut(memory)?.branding.background) !==
        JSON.stringify(LIGHT.branding.background)
      ) {
        throw new Error("not applied yet");
      }
    });
    await pickerReads("Light", false);
    (document.getElementById("undo") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (
        JSON.stringify(lastPut(memory)?.branding) !== JSON.stringify(before)
      ) {
        throw new Error("not undone yet");
      }
    });
  });

  // Mockup A. Red if the picker does not match the take to its kit by
  // look, or does not mark the change.
  it("names the kit the take was recorded on, and marks it Edited after a change", async () => {
    const memory = fakeChrome({ brandKits: [ON(), LIGHT], defaultKitId: "o" });
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await pickerReads("Dark", false);
    await openMenu();
    expect(
      ((await button("[data-kit-update]")) as unknown as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await nudgePadding(memory);
    await pickerReads("Dark", true);
    expect(
      ((await button("[data-kit-update]")) as unknown as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("Update writes the take's look over its kit, after asking, and nothing else", async () => {
    const memory = fakeChrome({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await choose("b");
    await pickerReads("Light", false);
    await nudgePadding(memory);
    await pickerReads("Light", true);
    await openMenu();
    expect((await button("[data-kit-update]")).textContent).toBe(
      'Update "Light"',
    );
    (await button("[data-kit-update]")).click();
    await vi.waitFor(() => {
      const light = kitsOf(memory).find((k) => k.id === "b");
      if (
        (light?.branding as { padding?: number } | undefined)?.padding !== 0.15
      ) {
        throw new Error("Light not written yet");
      }
    });
    expect(confirmDialog.ask.mock.calls[0]?.[0]).toMatchObject({
      title: 'Replace "Light"',
      confirmLabel: "Replace",
      danger: false,
      // Enter replaces: the author's call on 2026-10-04.
      focus: "confirm",
      body: 'This demo\'s background, logo and padding will replace the brand kit "Light".',
    });
    expect(kitsOf(memory)[0]).toEqual(DARK);
    // The take matches its kit again.
    await pickerReads("Light", false);
  });

  // Review Focus 3, under mockup A: the kit an edited take came from is
  // gone, so there is nothing to update — never another kit in its place.
  it("an edited take whose kit is deleted elsewhere reads Custom look, with no Update", async () => {
    const memory = fakeChrome({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await choose("b");
    await nudgePadding(memory);
    await pickerReads("Light", true);
    memory.kitStorage.data.brandKits = [DARK];
    memory.emitKits();
    await pickerReads("Custom look", false);
    await openMenu();
    expect(document.querySelector("[data-kit-update]")).toBeNull();
  });

  it("writes nothing on No", async () => {
    const memory = fakeChrome({ brandKits: [ON()], defaultKitId: "o" });
    confirmDialog.ask.mockReset().mockResolvedValue(false);
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await nudgePadding(memory);
    await openMenu();
    (await button("[data-kit-update]")).click();
    await vi.waitFor(() => {
      if (confirmDialog.ask.mock.calls.length === 0) {
        throw new Error("not asked yet");
      }
    });
    expect(kitsOf(memory)).toEqual([ON()]);
    expect(memory.kitStorage.area.set).not.toHaveBeenCalled();
  });

  it("says the kit was not saved when its question could not open", async () => {
    const memory = fakeChrome({ brandKits: [ON()], defaultKitId: "o" });
    confirmDialog.ask
      .mockReset()
      .mockRejectedValue(new Error("dialog refused"));
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await nudgePadding(memory);
    await openMenu();
    (await button("[data-kit-update]")).click();
    await vi.waitFor(() => {
      if (
        !failure().includes(
          'The brand kit "Dark" was not saved: dialog refused',
        )
      ) {
        throw new Error("failure not shown yet");
      }
    });
    expect(memory.kitStorage.area.set).not.toHaveBeenCalled();
  });

  it("says the kit was not saved when storage refuses the write", async () => {
    const memory = fakeChrome({ brandKits: [ON()], defaultKitId: "o" });
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await nudgePadding(memory);
    await openMenu();
    memory.kitStorage.refuse.set = new Error("quota");
    (await button("[data-kit-update]")).click();
    await vi.waitFor(() => {
      if (!failure().includes('The brand kit "Dark" was not saved: quota')) {
        throw new Error("failure not shown yet");
      }
    });
    expect(kitsOf(memory)).toEqual([ON()]);
  });

  // Review 2026-10-08: a press that raced a change (here an undo, between
  // the menu drawing Update and the click landing) returned without a word,
  // which looks the same as a save. The retained button stands in for the
  // click that was already on its way. Red if updateKit returns silently.
  it("says no kit was updated when the take stopped being edited before the press", async () => {
    const memory = fakeChrome({ brandKits: [ON()], defaultKitId: "o" });
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await nudgePadding(memory);
    await pickerReads("Dark", true);
    await openMenu();
    const update = await button("[data-kit-update]");
    expect(
      (update as unknown as HTMLButtonElement).disabled,
      "premise: Update is offered",
    ).toBe(false);
    (document.getElementById("undo") as HTMLButtonElement).click();
    await pickerReads("Dark", false);
    update.click();
    await vi.waitFor(() => {
      if (!failure().includes("No brand kit was updated")) {
        throw new Error(`failure reads: ${failure()}`);
      }
    });
    expect(failure()).toContain('already matches "Dark"');
    expect(confirmDialog.ask).not.toHaveBeenCalled();
    expect(kitsOf(memory)).toEqual([ON()]);
  });

  // The same race for the picker: the kit is deleted in another tab while
  // its menu item is on the way to being clicked. Red if onApply returns
  // silently.
  it("says a kit deleted elsewhere was not applied", async () => {
    const memory = fakeChrome({ brandKits: [DARK, LIGHT], defaultKitId: "a" });
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await openMenu();
    const light = await button('[data-kit-option="b"]');
    memory.kitStorage.data.brandKits = [DARK];
    memory.emitKits();
    await vi.waitFor(() => {
      if (document.querySelector('[data-kit-option="b"]') !== null) {
        throw new Error("Light still listed");
      }
    });
    const puts = memory.kitStorage.area.set.mock.calls.length;
    light.click();
    await vi.waitFor(() => {
      if (!failure().includes("That brand kit was not applied")) {
        throw new Error(`failure reads: ${failure()}`);
      }
    });
    expect(failure()).toContain("deleted in another tab");
    expect(memory.kitStorage.area.set.mock.calls.length).toBe(puts);
  });

  it("Save as new kit adds a named kit, leaves the default alone, and the picker names it", async () => {
    const memory = fakeChrome({ brandKits: [DARK], defaultKitId: "a" });
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await typeName("Launch");
    (await button("[data-kit-new-save]")).click();
    await vi.waitFor(() => {
      if (kitsOf(memory).length !== 2) throw new Error("not added yet");
    });
    expect(kitsOf(memory)[1]).toMatchObject({
      name: "Launch",
      branding: readonlyScene().branding,
    });
    expect(memory.kitStorage.data.defaultKitId).toBe("a");
    await pickerReads("Launch", false);
  });

  it("the first kit saved becomes the default", async () => {
    const memory = fakeChrome({});
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await pickerReads("No brand kit", false);
    const input = await typeName("Mine");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => {
      if (!memory.kitStorage.data.defaultKitId)
        throw new Error("no default yet");
    });
    expect(memory.kitStorage.data.defaultKitId).toBe(kitsOf(memory)[0]?.id);
    expect(kitsOf(memory)[0]?.name).toBe("Mine");
  });

  it("refuses a clashing name beside the field and writes nothing", async () => {
    const memory = fakeChrome({ brandKits: [DARK], defaultKitId: "a" });
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await typeName("dark");
    (await button("[data-kit-new-save]")).click();
    expect((await button("[data-kit-new-error]")).textContent).toBe(
      'a kit is already named "Dark"',
    );
    expect(memory.kitStorage.area.set).not.toHaveBeenCalled();
    expect(
      ((await button("[data-kit-new-name]")) as unknown as HTMLInputElement)
        .value,
    ).toBe("dark");
  });

  // Review Focus 4.
  it("keeps a half-typed kit name when another page changes the kits", async () => {
    const memory = fakeChrome({ brandKits: [DARK], defaultKitId: "a" });
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await typeName("Laun");
    const reads = memory.kitStorage.area.get.mock.calls.length;
    memory.kitStorage.data.brandKits = [DARK, LIGHT];
    memory.emitKits();
    // Premise: the page re-read the kits, and so re-rendered.
    await vi.waitFor(() => {
      if (memory.kitStorage.area.get.mock.calls.length <= reads) {
        throw new Error("not re-read yet");
      }
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(
      ((await button("[data-kit-new-name]")) as unknown as HTMLInputElement)
        .value,
    ).toBe("Laun");
  });

  it("Cancel closes the name field, brings the picker back, and writes nothing", async () => {
    const memory = fakeChrome({ brandKits: [DARK], defaultKitId: "a" });
    await import("../../../pages/entrypoints/editor/main");
    await openBackground();
    await typeName("Nope");
    (await button("[data-kit-new-cancel]")).click();
    await button("[data-kit-picker]");
    expect(memory.kitStorage.area.set).not.toHaveBeenCalled();
  });
});
