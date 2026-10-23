import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installTooltips,
  SHOW_DELAY_MS,
  WARM_MS,
  withoutTip,
  withTip,
} from "../../../pages/src/shell/tooltip";

/**
 * The page's one tooltip (the author, 2026-10-19): a control's name and its
 * key as caps, built never to be in the way of the click it describes. The
 * timing is what makes it unobtrusive, so the timing is what these pin.
 *
 * Production changes that redden these, each made and watched go red:
 * - showing on `pointerover` without the delay: "waits" finds it shown.
 * - dropping the warm window: "shows a neighbour at once" waits instead.
 * - `pointerdown` not hiding: "a press takes it away" finds it shown.
 */

const pointer = (type: string, target: Element, pointerType = "mouse") => {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  Object.defineProperty(event, "relatedTarget", { value: null });
  target.dispatchEvent(event);
};

let tip: HTMLElement;
let undo: HTMLButtonElement;
let redo: HTMLButtonElement;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  undo = document.createElement("button");
  redo = document.createElement("button");
  undo.title = "Undo";
  withTip(undo, "Undo", ["Mod", "Z"]);
  withTip(redo, "Redo", ["Shift", "Mod", "Z"]);
  document.body.append(undo, redo);
  tip = installTooltips();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the tooltip", () => {
  it("waits before it shows, so passing over a control shows nothing", () => {
    pointer("pointerover", undo);
    vi.advanceTimersByTime(SHOW_DELAY_MS - 1);
    expect(tip.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tip.hidden).toBe(false);
  });

  it("shows nothing for a pointer that left before the wait was up", () => {
    pointer("pointerover", undo);
    vi.advanceTimersByTime(SHOW_DELAY_MS / 2);
    pointer("pointerout", undo);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tip.hidden).toBe(true);
  });

  it("names the control, then its keys as caps", () => {
    pointer("pointerover", redo);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tip.firstChild?.textContent).toBe("Redo");
    const caps = [...tip.querySelectorAll("kbd")];
    // jsdom is not a Mac: the command key reads Ctrl, and Shift as a word.
    expect(caps.map((c) => c.textContent)).toEqual(["Shift", "Ctrl", "Z"]);
  });

  it("shows a neighbour at once after one has shown, and waits again later", () => {
    pointer("pointerover", undo);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    pointer("pointerout", undo);
    expect(tip.hidden).toBe(true);
    pointer("pointerover", redo);
    expect(tip.hidden).toBe(false);
    expect(tip.firstChild?.textContent).toBe("Redo");
    // Past the warm window, the next one waits its full delay again.
    pointer("pointerout", redo);
    vi.advanceTimersByTime(WARM_MS + 1);
    pointer("pointerover", undo);
    expect(tip.hidden).toBe(true);
  });

  it("is taken away by a press, which also ends the warm window", () => {
    pointer("pointerover", undo);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tip.hidden).toBe(false);
    pointer("pointerdown", undo);
    expect(tip.hidden).toBe(true);
    pointer("pointerout", undo);
    pointer("pointerover", redo);
    expect(tip.hidden).toBe(true);
  });

  it("is taken away by a key", () => {
    pointer("pointerover", undo);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
    expect(tip.hidden).toBe(true);
  });

  it("never shows for a touch", () => {
    pointer("pointerover", undo, "touch");
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2);
    expect(tip.hidden).toBe(true);
  });

  // Review 2026-10-19. Red: let `pointerover` return early on an element
  // with no tooltip, as it did — the removed control gets no `pointerout`.
  it("goes when its control is redrawn away and the pointer moves on", () => {
    pointer("pointerover", undo);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tip.hidden, "premise: it showed for Undo").toBe(false);
    // A render replaces the control: no pointerout reaches the old one.
    undo.remove();
    const plain = document.createElement("div");
    document.body.append(plain);
    pointer("pointerover", plain);
    expect(tip.hidden).toBe(true);
  });

  // Review 2026-10-19. Red: drop the `control === pending` check, and the
  // wait starts over at the icon inside the button.
  it("keeps waiting, not starting over, when the pointer crosses into a child", () => {
    const glyph = document.createElement("span");
    undo.append(glyph);
    pointer("pointerover", undo);
    vi.advanceTimersByTime(SHOW_DELAY_MS - 100);
    pointer("pointerover", glyph);
    vi.advanceTimersByTime(100);
    expect(tip.hidden).toBe(false);
    expect(tip.firstChild?.textContent).toBe("Undo");
  });

  // Review 2026-10-19: with nothing showing, `current` and an untipped
  // field's tooltip were both null, so focus leaving that field cancelled
  // the wait. Red: drop `current !== null` from the focusout handler.
  it("keeps its wait when focus leaves a field with no tooltip", () => {
    const field = document.createElement("input");
    document.body.append(field);
    pointer("pointerover", undo);
    vi.advanceTimersByTime(SHOW_DELAY_MS / 2);
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    vi.advanceTimersByTime(SHOW_DELAY_MS / 2);
    expect(tip.hidden).toBe(false);
  });

  it("is one element for the page, however often it is started", () => {
    installTooltips();
    installTooltips();
    expect(document.querySelectorAll("[data-tooltip]")).toHaveLength(1);
  });
});

describe("withTip and withoutTip", () => {
  it("drop the native title and say the key to a screen reader", () => {
    expect(undo.hasAttribute("title")).toBe(false);
    expect(undo.getAttribute("aria-keyshortcuts")).toBe("Control+Z");
    withoutTip(undo);
    expect(undo.dataset.tip).toBeUndefined();
    expect(undo.hasAttribute("aria-keyshortcuts")).toBe(false);
  });
});
