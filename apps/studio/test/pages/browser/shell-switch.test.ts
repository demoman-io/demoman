import { afterAll, describe, expect, it } from "vitest";
import { switchControl } from "../../../pages/src/shell/switch";
import { knobX, mountShell, spin } from "../helpers/shell-css";

/**
 * The shell's switch slides even when the page rebuilds it mid-slide.
 *
 * Settings and the editor re-render with `replaceChildren` after every
 * change, which threw the clicked switch away a few milliseconds into its
 * transition; the replacement was born at rest, so the toggle snapped. The
 * popup, which flips its switch in place, was the only page where it slid.
 *
 * Read on the picture: where the knob is painted (`::after`'s transform).
 * The document timeline does not advance within a task, so a read straight
 * after a rebuild sees the animation's first frame — which is what tells a
 * continued slide (part-way), a restarted one (at the start) and a snap (at
 * the end) apart without racing a frame.
 */

let n = 0;
function host(): HTMLElement {
  mountShell("light", "");
  const box = document.createElement("div");
  document.body.replaceChildren(box);
  return box;
}

afterAll(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
});

describe("the shell's switch", () => {
  it("continues a slide a rebuild interrupted, from where it had reached", async () => {
    const root = host();
    const key = `continue ${n++}`;
    const said: boolean[] = [];
    const build = (checked: boolean) =>
      switchControl({ key, checked, onChange: (on) => said.push(on) });
    root.replaceChildren(build(false));
    // Premise: off rests at the start of the travel.
    expect(knobX(root)).toBe(0);
    (root.querySelector("input") as HTMLInputElement).click();
    expect(said).toEqual([true]);
    // The click-to-render round trip, as a measured gap rather than a
    // sleep: the component reads the same clock.
    const gap = spin(50);
    root.replaceChildren(build(true));
    const x = knobX(root);
    // A restart would paint 0 here, a snap 16.
    expect(
      x,
      `knob at ${x}px after a ${gap.toFixed(1)}ms gap; 0 is a restart, 16 a snap`,
    ).toBeGreaterThan(4);
    expect(x).toBeLessThan(16);
    // And it comes to rest on, at the full travel — the position "part-way"
    // was measured against — with nothing left to override the next click.
    await Promise.all(
      root.getAnimations({ subtree: true }).map((a) => a.finished),
    );
    expect(knobX(root)).toBe(16);
    await expect
      .poll(() => root.querySelector(".switch")?.hasAttribute("data-flip"))
      .toBe(false);
  });

  it("slides back from where the click sent it when the write is refused", async () => {
    const root = host();
    const key = `refused ${n++}`;
    const build = (checked: boolean) =>
      switchControl({ key, checked, onChange: () => {} });
    root.replaceChildren(build(false));
    (root.querySelector("input") as HTMLInputElement).click();
    spin(150); // past the slide: the click's own transition is done
    // The page refused it and rebuilt the switch off.
    root.replaceChildren(build(false));
    const input = root.querySelector("input") as HTMLInputElement;
    expect(input.checked).toBe(false);
    // Still where the click put it, about to slide home — not snapped there.
    expect(knobX(root), "the refused switch snapped back").toBe(16);
    await Promise.all(
      root.getAnimations({ subtree: true }).map((a) => a.finished),
    );
    expect(knobX(root)).toBe(0);
  });

  it("leaves a switch nobody clicked at rest", () => {
    const root = host();
    root.replaceChildren(
      switchControl({ key: `untouched ${n++}`, checked: true, onChange() {} }),
    );
    expect(knobX(root)).toBe(16);
    expect(root.getAnimations({ subtree: true })).toEqual([]);
  });
});
