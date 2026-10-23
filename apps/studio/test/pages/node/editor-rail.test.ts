import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderExportDoor,
  renderRail,
} from "../../../pages/entrypoints/editor/rail";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("nav");
});

const buttons = () => [
  ...root.querySelectorAll<HTMLButtonElement>("button[data-rail]"),
];

describe("renderRail", () => {
  it("offers Background, Cursor and Selection, in that order, with the open one pressed", () => {
    renderRail(
      root,
      { rail: "background", panelOpen: true, hasSelection: false },
      { onPick: vi.fn() },
    );
    expect(buttons().map((b) => b.dataset.rail)).toEqual([
      "background",
      "cursor",
      "selection",
    ]);
    expect(buttons().map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    for (const b of buttons()) {
      expect(b.getAttribute("aria-label")).toMatch(/\S/);
      expect(b.querySelector("svg[data-icon]")).not.toBeNull();
    }
  });

  it("draws no Export entry — Export's door is the header's button", () => {
    renderRail(
      root,
      { rail: "export", panelOpen: true, hasSelection: false },
      { onPick: vi.fn() },
    );
    expect(root.querySelector('[data-rail="export"]')).toBeNull();
    // Export open is still a state the rail must render: nothing on it is
    // pressed, because the pressed door is the header's.
    expect(buttons()).toHaveLength(3);
    expect(
      buttons().every((b) => b.getAttribute("aria-pressed") === "false"),
    ).toBe(true);
  });

  it("gives Cursor its own glyph, not Selection's", () => {
    renderRail(
      root,
      { rail: "export", panelOpen: true, hasSelection: false },
      { onPick: vi.fn() },
    );
    const iconOf = (entry: string) =>
      root
        .querySelector(`button[data-rail="${entry}"] svg[data-icon]`)
        ?.getAttribute("data-icon");
    expect(iconOf("cursor")).not.toBe(iconOf("selection"));
    // The author's call, 2026-10-19: Cursor styles the arrow the video
    // paints, so it is the bare arrow; Selection is what was clicked.
    expect(iconOf("cursor")).toBe("mousePointer2");
    expect(iconOf("selection")).toBe("mousePointerClick");
  });

  it("leaves Cursor enabled with nothing selected — it is demo-wide", () => {
    renderRail(
      root,
      { rail: "export", panelOpen: true, hasSelection: false },
      { onPick: vi.fn() },
    );
    const cursor = root.querySelector<HTMLButtonElement>(
      'button[data-rail="cursor"]',
    );
    expect(cursor?.disabled).toBe(false);
    expect(cursor?.title).toMatch(/\S/);
  });

  it("presses nothing while the panel is closed", () => {
    renderRail(
      root,
      { rail: "export", panelOpen: false, hasSelection: false },
      { onPick: vi.fn() },
    );
    expect(
      buttons().every((b) => b.getAttribute("aria-pressed") === "false"),
    ).toBe(true);
  });

  it("disables Selection until something is selected, and says why", () => {
    renderRail(
      root,
      { rail: "export", panelOpen: true, hasSelection: false },
      { onPick: vi.fn() },
    );
    const selection = root.querySelector<HTMLButtonElement>(
      '[data-rail="selection"]',
    );
    expect(selection?.disabled).toBe(true);
    expect(selection?.title).toBe(
      "Select a step, zoom or mask on the timeline",
    );
    renderRail(
      root,
      { rail: "export", panelOpen: true, hasSelection: true },
      { onPick: vi.fn() },
    );
    const enabled = root.querySelector<HTMLButtonElement>(
      '[data-rail="selection"]',
    );
    expect(enabled?.disabled).toBe(false);
    // Spec §1 asks for a title on every entry, not only the disabled one:
    // the rail is icon-only, so an empty title leaves a pointer user with
    // no name for the button at all.
    expect(enabled?.title).toBe("Selection");
    expect(
      root.querySelector<HTMLButtonElement>('[data-rail="background"]')?.title,
    ).toBe("Background");
  });

  it("reports the entry that was picked", () => {
    const onPick = vi.fn();
    renderRail(
      root,
      { rail: "export", panelOpen: true, hasSelection: true },
      { onPick },
    );
    root.querySelector<HTMLButtonElement>('[data-rail="selection"]')?.click();
    expect(onPick).toHaveBeenCalledWith("selection");
  });
});

describe("renderExportDoor", () => {
  const door = () => {
    const button = document.createElement("button");
    button.setAttribute("data-rail", "export");
    return button;
  };

  it("is pressed exactly while the Export panel is the open one", () => {
    const button = door();
    renderExportDoor(
      button,
      { rail: "export", panelOpen: true },
      { onPick: vi.fn() },
    );
    expect(button.getAttribute("aria-pressed")).toBe("true");
    renderExportDoor(
      button,
      { rail: "export", panelOpen: false },
      { onPick: vi.fn() },
    );
    expect(button.getAttribute("aria-pressed")).toBe("false");
    renderExportDoor(
      button,
      { rail: "background", panelOpen: true },
      { onPick: vi.fn() },
    );
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("carries one glyph and the word, however often it is drawn", () => {
    const button = door();
    for (let i = 0; i < 3; i++) {
      renderExportDoor(
        button,
        { rail: "export", panelOpen: true },
        { onPick: vi.fn() },
      );
    }
    expect(button.querySelectorAll("svg[data-icon]")).toHaveLength(1);
    expect(button.textContent).toBe("Export");
  });

  it("reports export to the last render's handler only", () => {
    const button = door();
    const first = vi.fn();
    const second = vi.fn();
    renderExportDoor(
      button,
      { rail: "export", panelOpen: true },
      { onPick: first },
    );
    renderExportDoor(
      button,
      { rail: "export", panelOpen: true },
      { onPick: second },
    );
    button.click();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("export");
  });
});
