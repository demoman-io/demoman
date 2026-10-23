/// <reference types="@vitest/browser/providers/playwright" />
import type { BrowserCommand } from "vitest/node";

/** A point in the tested page's own CSS pixels — what `getBoundingClientRect`
 *  and `innerWidth` report from inside it. */
export interface PagePoint {
  x: number;
  y: number;
}

/**
 * A real Blink mouse press at one point and release at another (or the same
 * one), for the gestures that are about WHERE a press lands rather than on
 * which element: a click on a modal dialog's backdrop, which no locator can
 * name because the backdrop is not an element.
 *
 * `pressDown` and `dragAcross` take a selector; this takes coordinates in the
 * tester iframe's own viewport and offsets them by the iframe's origin, which
 * the `html` locator's box gives in main-frame coordinates.
 */
export const pressBetween: BrowserCommand<
  [from: PagePoint, to: PagePoint | null]
> = async (context, from, to) => {
  const origin = await context.iframe.locator("html").boundingBox();
  if (!origin) throw new Error("the tested page has no box");
  // The runner scales the tester iframe to fit its own window, so a page
  // pixel is not a main-frame pixel. The ratio is the html box's main-frame
  // width over the width the page itself reports.
  const frame = await context.frame();
  const pageWidth = await frame.evaluate(
    () => document.documentElement.clientWidth,
  );
  const scale = origin.width / pageWidth;
  const at = (p: PagePoint) => ({
    x: origin.x + p.x * scale,
    y: origin.y + p.y * scale,
  });
  const start = at(from);
  const end = at(to ?? from);
  const { mouse } = context.page;
  await mouse.move(start.x, start.y);
  await mouse.down();
  await mouse.move(end.x, end.y, { steps: 4 });
  await mouse.up();
};
