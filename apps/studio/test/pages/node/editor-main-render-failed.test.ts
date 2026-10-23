import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { editorDom } from "../helpers/editor-dom";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports (the studio's own copy, such as
// `refilmLine`) stay; only the platform the page builds is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

/**
 * The render-progress broadcast, driven against the real
 * `entrypoints/editor/main.ts` with a faked `chrome` and a faked store.
 *
 * The offscreen renderer reports per output; what only this file can catch
 * is the editor's listener reading the report and saying nothing — the
 * dead-wire class this package's entrypoint tests exist for. The harness
 * is the one `editor-main-share.test.ts` uses.
 */

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(): Record<string, never> {
    return {};
  }
}

/** The job id the platform answers this page's Export with. */
const OWN_JOB = "job-own";

/** Presses Export and returns the job id the platform answered it with. */
async function startExport(memory: MemoryPlatform): Promise<string> {
  const button = await vi.waitFor(() => {
    const node = document.querySelector("[data-export-start]");
    if (!node) throw new Error("Export button not rendered yet");
    return node as HTMLButtonElement;
  });
  button.click();
  return await vi.waitFor(() => {
    const sent = memory.calls.find(
      (c) => c.member === "exports" && c.method === "start",
    );
    if (!sent) throw new Error("the export was not started yet");
    return OWN_JOB;
  });
}

describe("editor main — a failed render output speaks", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => readonlyScene());
    // A take WITH frames: since plan 2's Task 7 a frameless take's Export is
    // disabled beside the Runs route, so a press on one sends nothing.
    memory.serveBundle(proceduralBundle(), null);
    memory.answer("exports.start", async () => ({ jobId: OWN_JOB }));
    // The take has frames, so the preview reads them; nothing here is about
    // the picture, so the reads never settle rather than fail (a failure
    // would reach `reportError`).
    memory.answer("bundles.load", () => new Promise(() => {}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /**
   * The renderer's failure arrives as `{kind:"failed", detail}` (the
   * studio's; in the extension, the offscreen renderer's per-output
   * `{kind:"failed", error}`). The editor's listener used to read only
   * `kind` and re-list the outputs, so a failed encode ended exactly like a
   * successful one: the Export button came back, no new row, no sentence.
   * CLAUDE.md's table records this shape as fixed once.
   */
  it("shows the offscreen renderer's error for a failed output", async () => {
    // jsdom has no popover API. The failure is drawn inside `#notes`, a
    // closed popover, so drawing it is only half of showing it.
    const shown: Element[] = [];
    HTMLElement.prototype.showPopover = function (this: HTMLElement) {
      shown.push(this);
    };
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      return selector === ":popover-open"
        ? shown.includes(this)
        : matches.call(this, selector);
    });
    await import("../../../pages/entrypoints/editor/main");
    const jobId = await startExport(memory);

    memory.emitExport({
      kind: "failed",
      jobId,
      detail: "the encoder rejected the configuration",
    });
    memory.emitExport({ kind: "outputsChanged" });

    await vi.waitFor(() => {
      const failure = document.getElementById("failure");
      if (
        !failure?.textContent?.includes(
          "the encoder rejected the configuration",
        )
      ) {
        throw new Error("render failure not shown yet");
      }
    });
    // ...and opened where the author will see it, not left behind the
    // header button. MutationObserver callbacks are microtasks.
    await vi.waitFor(() => {
      expect(shown.map((e) => e.id)).toEqual(["notes"]);
    });
  });
});
