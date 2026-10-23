import { page, userEvent } from "@vitest/browser/context";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";
import { mountShell, pageParts } from "../helpers/shell-css";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports (the studio's own copy, such as
// `refilmLine`) stay; only the platform the page builds is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

/**
 * The header, booted for real (review 2026-10-19): Escape in a field, and
 * the Take info button's open state.
 *
 * Escape in a field the author is typing in cancels the edit. The fields save on `change`, and a blur over a changed value
 * fires it, so an Escape that only blurred SAVED the half-typed name as an
 * undoable edit. In Chromium, so the blur and its `change` are the browser's
 * own and not a synthetic event that fires whatever the value says.
 *
 * Boots the real `main.ts` against the memory platform.
 */

const { css, body } = pageParts(shell, "#stage");
if (!body.includes('id="name"')) {
  throw new Error("editor/index.html no longer carries #name");
}

const TAKE = "take-escape";
const memory = createMemoryPlatform();
memory.serveScene(() => readonlyScene());
state.memory = memory;

/** The names the page wrote, in order. */
const writtenNames = (): string[] =>
  memory.puts().map((scene) => scene.meta.name);

const originalUrl = location.href;
afterAll(async () => {
  history.replaceState({}, "", originalUrl);
  await page.viewport(414, 896);
});

/** Boots the real `main.ts` once for this file: module state cannot be
 *  re-imported, so the cases share the page. */
let booted: Promise<HTMLInputElement> | null = null;
function bootOnce(): Promise<HTMLInputElement> {
  booted ??= boot();
  return booted;
}

async function boot(): Promise<HTMLInputElement> {
  const url = new URL(location.href);
  url.searchParams.set("scene", TAKE);
  history.replaceState({}, "", url.href);
  await page.viewport(1440, 900);
  mountShell("light", css);
  document.body.innerHTML = body;
  await import("../../../pages/entrypoints/editor/main");
  return vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("#name");
    if (!input?.value) throw new Error("not loaded yet");
    return input;
  });
}

describe("editor main — Escape in a field", () => {
  it("puts the value back and leaves the field without saving the edit", async () => {
    const field = await bootOnce();
    const original = field.value;
    // Premise: the take loaded with a name, and nothing has been written.
    expect(original.length, "the fixture's name").toBeGreaterThan(0);
    expect(writtenNames()).toEqual([]);

    await userEvent.click(field);
    await userEvent.keyboard("{End} half-typ");
    expect(field.value).toBe(`${original} half-typ`);
    await userEvent.keyboard("{Escape}");

    expect(field.value, "the value Escape left").toBe(original);
    expect(document.activeElement, "the focus after Escape").not.toBe(field);

    // The positive control, and the sync point for "nothing was written":
    // the same field, edited and left by a blur, saves. Writes go out in
    // order, so had Escape saved the half-typed name it would come first.
    await userEvent.click(field);
    await userEvent.keyboard("{End} kept");
    field.blur();
    await vi.waitFor(() => {
      if (writtenNames().length === 0) throw new Error("no write yet");
    });
    expect(writtenNames(), JSON.stringify(writtenNames())).toEqual([
      `${original} kept`,
    ]);
  });
});

describe("editor main — the Take info button", () => {
  // `popovertarget` tells assistive tech the popover is open but writes no
  // `aria-expanded`, so the button's open look, keyed on it, never drew.
  // Red: drop the `toggle` listener in `main.ts`.
  it("says it is open while Take info is, and wears the open look", async () => {
    await bootOnce();
    const button = document.querySelector<HTMLButtonElement>("#take-meta");
    const popover = document.querySelector<HTMLElement>("#take-info");
    if (button === null || popover === null) {
      throw new Error("no #take-meta or #take-info");
    }
    // Premise: the button reads the take, and its name says so as well.
    await vi.waitFor(() => {
      if (button.textContent === "") throw new Error("no meta yet");
    });
    expect(button.getAttribute("aria-label")).toBe(
      `Take info: ${button.textContent}`,
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const closedLook = getComputedStyle(button).backgroundColor;

    await userEvent.click(button);
    await vi.waitFor(() => {
      if (!popover.matches(":popover-open")) throw new Error("not open yet");
      const said = button.getAttribute("aria-expanded");
      if (said !== "true") throw new Error(`open, aria-expanded ${said}`);
    });
    // Off the hover look: the pointer leaves for the page's corner first.
    await userEvent.hover(document.body, { position: { x: 1, y: 1 } });
    expect(getComputedStyle(button).backgroundColor).not.toBe(closedLook);

    popover.hidePopover();
    // `toggle` is queued, not dispatched inside `hidePopover`.
    await vi.waitFor(() => {
      const said = button.getAttribute("aria-expanded");
      if (said !== "false") throw new Error(`aria-expanded is ${said}`);
    });
  });
});
