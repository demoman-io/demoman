import { page } from "@vitest/browser/context";
import { describe, expect, it, vi } from "vitest";
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderStageBar } from "../../../pages/entrypoints/editor/view";
import { mountShell, pageParts } from "../helpers/shell-css";

// Throws if the page stops linking the shell or carrying the stage bar's
// rules, so a drifted stylesheet fails loudly instead of the assertions
// below measuring unstyled buttons.
const { css } = pageParts(shell, "#stage-bar");

// `editor-view.test.ts`'s `stageState()` / `stageHandlers()`: copied, since
// this browser lane cannot import from a node test.
const STAGE = {
  positionMs: 0,
  durationMs: 12_000,
  aspect: "16:9" as const,
  enabled: true,
  fullscreen: false,
  error: null,
  zoom: "fit" as const,
  authored: false,
};
const HANDLERS = {
  onAspect: vi.fn(),
  onFullscreen: vi.fn(),
  onZoom: vi.fn(),
  onDismissError: vi.fn(),
};

/* Two copies since 2026-10-07: the timeline toolbar's (`#stage-tools`),
   which the author uses, and the floating row on the picture
   (`#stage-bar`), which the stylesheet shows only in full screen — so the
   second is mounted under `#stage[data-fullscreen]`, the attribute
   `main.ts` mirrors `:fullscreen` onto. `#stage` clips, and with nothing
   in flow it has no height of its own, so it is given one. */
const ROOTS = [
  {
    name: "toolbar",
    markup:
      '<section id="dock"><div id="transport"><div class="transport-end"><div id="stage-tools"></div></div></div></section>',
    root: "stage-tools",
  },
  {
    name: "fullscreen",
    markup:
      '<div id="stage" data-fullscreen="" style="height: 120px"><div id="stage-bar"></div></div>',
    root: "stage-bar",
  },
] as const;

describe("the stage's shape switch, as painted", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const { name, markup, root } of ROOTS) {
      it(`draws Auto | 16:9 | 9:16 on one line, Auto checked, in the ${name} copy in ${scheme}`, async () => {
        mountShell(scheme, css);
        document.body.innerHTML = markup;
        const bar = document.getElementById(root) as HTMLElement;
        renderStageBar(bar, { ...STAGE, aspect: "auto" }, HANDLERS);
        const toggle = bar.querySelector("[data-aspect-toggle]") as HTMLElement;
        // Fixture guard: a hidden switch has no boxes, so every top below
        // would be 0 and "one line" would hold on nothing.
        expect(toggle.checkVisibility(), `the ${name} switch is hidden`).toBe(
          true,
        );
        const buttons = [...bar.querySelectorAll<HTMLElement>("[data-aspect]")];
        expect(buttons.map((b) => b.textContent)).toEqual([
          "Auto",
          "16:9",
          "9:16",
        ]);
        const tops = buttons.map((b) =>
          Math.round(b.getBoundingClientRect().top),
        );
        expect(new Set(tops).size, "one line").toBe(1);
        // The checked one is told apart from the others by more than a
        // border.
        const bg = (el: Element) => getComputedStyle(el).backgroundColor;
        expect(bg(buttons[0] as Element)).not.toBe(bg(buttons[1] as Element));
        await page.screenshot({
          path: `__screenshots__/stage-aspect-${name}-${scheme}.png`,
          element: toggle,
        });
      });
    }
  }
});
