/// <reference types="@vitest/browser/providers/playwright" />
import type { BrowserCommand } from "vitest/node";

/**
 * A real Blink mouse press, split in two so the page can run between the
 * button going down and coming back up.
 *
 * A human click is two input events tens of milliseconds apart, and whatever
 * the mousedown sets off — a blur that commits a field, a write, a re-render
 * — can land in that gap. `userEvent.click` presses and releases back to
 * back, and a synthetic `click()` on a retained element has no mousedown at
 * all, so neither can put a re-render between the two halves. These can:
 * the test presses, waits for the condition it needs in the page, then
 * releases at the same point.
 *
 * Like `drag-command.ts`, this is node-side because only `page.mouse`
 * produces trusted input; `boundingBox()` on a locator inside the tester
 * iframe already returns main-frame coordinates.
 *
 * It presses the middle of the element's first line box, not of its
 * bounding box. A link that wraps has a bounding box spanning both lines,
 * and its middle falls between them, on the text around the link: CI's
 * fonts wrap the editor's Runs link where this Mac's do not, and the press
 * missed it on every run from 2026-10-08. For anything on one line the two
 * are the same point.
 */
export const pressDown: BrowserCommand<[selector: string]> = async (
  context,
  selector,
) => {
  const locator = context.iframe.locator(selector);
  const box = await locator.boundingBox();
  if (!box) throw new Error(`nothing to press at ${selector}`);
  const { whole, line } = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    // The first box with area: a link that wraps right at its start can
    // open with an empty box at the end of the line above.
    const first =
      [...el.getClientRects()].find((b) => b.width > 0 && b.height > 0) ?? r;
    return {
      whole: { left: r.left, top: r.top, width: r.width, height: r.height },
      line: {
        left: first.left,
        top: first.top,
        width: first.width,
        height: first.height,
      },
    };
  });
  // The tester iframe may be scaled to fit the window: in-page CSS px times
  // this is main-frame px.
  const scale = whole.width > 0 ? box.width / whole.width : 1;
  const { mouse } = context.page;
  await mouse.move(
    box.x + (line.left - whole.left + line.width / 2) * scale,
    box.y + (line.top - whole.top + line.height / 2) * scale,
  );
  await mouse.down();
};

/** Releases the button `pressDown` pressed, where the pointer still is. */
export const pressUp: BrowserCommand<[]> = async (context) => {
  await context.page.mouse.up();
};
