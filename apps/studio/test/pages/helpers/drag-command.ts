/// <reference types="@vitest/browser/providers/playwright" />
import type { BrowserCommand } from "vitest/node";

/**
 * A real Blink mouse drag from an element's left edge to its right edge,
 * driven from node through the browser lane's own Playwright.
 *
 * The browser lane runs INSIDE the page, where the only mouse events it can
 * make are untrusted ones — and an untrusted `pointerdown` moves no range
 * slider and takes no implicit pointer capture, so the one hazard a slider
 * drag has (the element being replaced mid-gesture) cannot be reproduced
 * from in there. A custom command is the only door in this setup that
 * reaches `page.mouse`.
 *
 * `boundingBox()` on a locator inside the tester iframe already returns
 * main-frame coordinates, so no offset arithmetic is needed here.
 */
export const dragAcross: BrowserCommand<
  [selector: string, steps: number]
> = async (context, selector, steps) => {
  const box = await context.iframe.locator(selector).boundingBox();
  if (!box) throw new Error(`nothing to drag at ${selector}`);
  // Two pixels in from each end: the thumb's own half-width is what maps
  // to the extremes, and Chromium clamps beyond the track either way.
  const from = box.x + 2;
  const to = box.x + box.width - 2;
  const y = box.y + box.height / 2;
  const { mouse } = context.page;
  await mouse.move(from, y);
  await mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await mouse.move(from + ((to - from) * step) / steps, y);
  }
  await mouse.up();
};
