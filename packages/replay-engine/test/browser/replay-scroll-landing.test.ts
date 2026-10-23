import { afterEach, describe, expect, it } from "vitest";
import { scrollIntoViewFunction } from "../../src/index.js";

/**
 * The scroll the engine hands `Runtime.callFunctionOn`, run on a real element
 * in real Chromium, the way CDP calls it: `this` is the element, and the
 * promise resolves once the element's rect has stopped moving.
 *
 * The node lane can only read the function as a string. Where the element
 * ends up is a question for a layout engine, and it is the whole question.
 */
async function run(
  el: Element,
  aim: Parameters<typeof scrollIntoViewFunction>[0],
): Promise<{ settled: boolean; movedPx: number }> {
  const fn = new Function(
    `return (${scrollIntoViewFunction(aim, 3_000)})`,
  )() as (this: Element) => Promise<{ settled: boolean; movedPx: number }>;
  return fn.call(el);
}

afterEach(() => {
  document.body.innerHTML = "";
  window.scrollTo(0, 0);
});

describe("a recorded scroll landing, in a real browser", () => {
  // The shape of the author's take of 2026-09-29, scaled to this frame: an
  // anchor taller than the viewport, whose top sat a little way down the
  // screen when the scroll stopped. Centring cannot put it back there.
  it("puts a tall anchor's top back where it was recorded", async () => {
    const vh = window.innerHeight;
    const height = vh + 69;
    const recordedTop = Math.round(vh * 0.38);
    document.body.innerHTML = `
      <div style="height:${vh * 3}px"></div>
      <div id="anchor" style="height:${height}px"></div>
      <div style="height:${vh * 3}px"></div>`;
    const anchor = document.getElementById("anchor") as HTMLElement;

    // The premise: centring this anchor lands it somewhere else, by more than
    // the tolerance below, so the aim is what the assertion measures.
    const centredTop = (vh - height) / 2;
    expect(Math.abs(centredTop - recordedTop)).toBeGreaterThan(20);
    // And the anchor spans the screen's centre at its recorded top, the way
    // an anchor chosen from the centre of the screen does.
    expect(recordedTop).toBeLessThan(vh / 2);
    expect(recordedTop + height).toBeGreaterThan(vh / 2);

    const report = await run(anchor, { top: recordedTop });

    const top = anchor.getBoundingClientRect().top;
    expect(report.settled, JSON.stringify(report)).toBe(true);
    expect(report.movedPx).toBeGreaterThan(0);
    expect(top, JSON.stringify({ top, recordedTop, vh })).toBeCloseTo(
      recordedTop,
      0,
    );
  });

  // Scrolling back up is the other direction of the same aim, and the one the
  // author's take was doing when it landed short.
  it("scrolls up to a recorded landing as well as down", async () => {
    const vh = window.innerHeight;
    const recordedTop = Math.round(vh * 0.2);
    document.body.innerHTML = `
      <div style="height:${vh * 3}px"></div>
      <div id="anchor" style="height:40px"></div>
      <div style="height:${vh * 3}px"></div>`;
    const anchor = document.getElementById("anchor") as HTMLElement;
    window.scrollTo(0, document.documentElement.scrollHeight);
    const before = anchor.getBoundingClientRect().top;
    // The premise: the anchor starts above the screen, so reaching the
    // recorded top means scrolling up.
    expect(before).toBeLessThan(0);

    await run(anchor, { top: recordedTop });

    expect(anchor.getBoundingClientRect().top).toBeCloseTo(recordedTop, 0);
  });

  // The sensor records a scroll inside a panel too (its anchor comes from the
  // centre of that panel), so the aim has to move the panel, not the page.
  it("moves the scroll container the anchor is in, not the document", async () => {
    const vh = window.innerHeight;
    document.body.innerHTML = `
      <div id="panel" style="height:${Math.round(vh * 0.8)}px; overflow-y:auto">
        <div style="height:${vh * 2}px"></div>
        <div id="anchor" style="height:40px"></div>
        <div style="height:${vh * 2}px"></div>
      </div>`;
    const panel = document.getElementById("panel") as HTMLElement;
    const anchor = document.getElementById("anchor") as HTMLElement;
    const recordedTop = Math.round(vh * 0.3);
    // The premise: the page itself cannot scroll, so only the panel can
    // bring the anchor to its recorded top.
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(vh + 1);

    await run(anchor, { top: recordedTop });

    expect(panel.scrollTop).toBeGreaterThan(0);
    expect(anchor.getBoundingClientRect().top).toBeCloseTo(recordedTop, 0);
  });
});
