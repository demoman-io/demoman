import { commands } from "@vitest/browser/context";
import { describe, expect, it, vi } from "vitest";
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderTimelineTools } from "../../../pages/entrypoints/editor/timeline-view";
import { fitAll, type Viewport } from "../../../pages/src/editor/viewport";
import { mountShell, pageParts } from "../helpers/shell-css";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    /** See `test/helpers/drag-command.ts`; registered in `vitest.config.ts`. */
    dragAcross: (selector: string, steps: number) => Promise<void>;
  }
}

const { css } = pageParts(shell, ".zoom-control");

/**
 * The timeline's zoom slider, dragged with a real mouse.
 *
 * `main.ts` answers every `onViewport` with a full `render()`, which calls
 * `renderTimelineTools` again — so the slider's own `input` redraws the row
 * it sits in. Until 2026-09-22 that rebuilt the slider, and a range input
 * removed from the document mid-drag loses the gesture: a drag moved it one
 * notch and stopped. The handler below does exactly what `main.ts` does, so
 * this is the page's loop in miniature.
 *
 * A real mouse because nothing else can lose the drag: a synthetic `input`
 * dispatched at a retained reference takes no pointer and so cannot drop
 * one (see `drag-command.ts`, and CLAUDE.md's "Tests must be able to
 * fail" for what that cost on the Cursor panel).
 */
describe("the timeline zoom slider under a real drag", () => {
  const STEPS = 20;
  const DURATION_MS = 12_000;

  it("tracks the whole gesture while each value re-renders the row", async () => {
    mountShell("light", css);
    document.body.innerHTML =
      '<section id="dock"><div id="transport"><div id="timeline-tools" style="display: flex"></div></div></section>';
    const host = document.querySelector("#timeline-tools") as HTMLElement;
    // On the host, which no re-render replaces, so the count survives any
    // rebuilding of what is under it.
    const inputs: string[] = [];
    host.addEventListener("input", (event) => {
      inputs.push((event.target as HTMLInputElement).value);
    });
    let viewport: Viewport = fitAll(DURATION_MS);
    const render = () =>
      renderTimelineTools(
        host,
        { durationMs: DURATION_MS },
        { snapping: true, viewport, positionMs: DURATION_MS / 2 },
        {
          onGesture: vi.fn(),
          onSnapping: vi.fn(),
          onSplit: vi.fn(),
          onViewport: (next) => {
            viewport = next;
            render();
          },
        },
      );
    render();
    const before = host.querySelector<HTMLInputElement>("[data-zoom-slider]");
    // Fixture guard: the knob starts at the far left, so reaching the right
    // end is the whole travel rather than a nudge.
    expect(Number(before?.value)).toBeCloseTo(0, 3);

    await commands.dragAcross("[data-zoom-slider]", STEPS);

    const after = host.querySelector<HTMLInputElement>("[data-zoom-slider]");
    expect(
      inputs.length,
      `the drag was dropped after ${inputs.length} values: ${inputs.join(", ")}`,
    ).toBeGreaterThan(STEPS / 2);
    expect(Number(after?.value)).toBeCloseTo(1, 2);
    // And the window followed the knob, not just the knob itself.
    expect(viewport.endMs - viewport.startMs).toBeLessThan(DURATION_MS / 10);
    // The slider under the pointer is the one that was there before.
    expect(after, "the slider was rebuilt under the drag").toBe(before);
  });
});
