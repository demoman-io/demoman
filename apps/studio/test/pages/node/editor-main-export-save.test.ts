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
 * One-click export, driven against the real `entrypoints/editor/main.ts`
 * and the memory platform: the job the button sends, the progress it
 * shows, and the save the studio reports for this page's own job.
 *
 * Moved from apps/extension on 2026-10-20. The extension's half of this
 * file — the save through `chrome.downloads` (its cancelled save, a stills
 * set cancelled at the first file, a Recent exports Download mid-encode),
 * the editor's own "finished without producing a file" check, and its
 * other-tab job filter — left with it: the studio's server saves the file
 * and says so in the job's `saved` or `failed` event, and `http.ts` hands
 * the page its own jobs' events alone (covered in platform-http.test.ts).
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
  await vi.waitFor(() => {
    if (startedJob(memory) === undefined)
      throw new Error("the export was not started yet");
  });
  return OWN_JOB;
}

/** The job the page started, as it handed it to the platform. */
const startedJob = (memory: MemoryPlatform) =>
  memory.calls.find((c) => c.member === "exports" && c.method === "start")
    ?.args[1] as
    | { fileType: string; aspect: string; retexts: unknown[] }
    | undefined;

/** A save the studio reported, as its `saved` event carries it. */
const savedEvent = (jobId: string, name: string) => ({
  kind: "saved" as const,
  jobId,
  save: {
    kind: "saved" as const,
    names: [name],
    byteLength: 3,
    reveal: null,
    summary: null,
    outputRefs: [],
  },
  summary: null,
});

const exportButton = () =>
  document.querySelector("[data-export-start]") as HTMLButtonElement;

describe("editor main — Export saves in one click", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    // jsdom has neither.
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
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

  it("sends the file type and aspect, then shows what its own job saved", async () => {
    await import("../../../pages/entrypoints/editor/main");
    const jobId = await startExport(memory);
    expect(startedJob(memory)).toMatchObject({
      fileType: "mp4",
      aspect: "16:9",
    });

    memory.emitExport({ kind: "rendering", jobId, done: 288, total: 576 });
    await vi.waitFor(() =>
      expect(exportButton().textContent).toBe("Exporting · 50%"),
    );

    memory.emitExport(savedEvent(jobId, "Checkout flow.mp4"));
    await vi.waitFor(() => {
      const row = document.querySelector('[data-save-outcome="saved"]');
      if (!row) throw new Error("no save outcome yet");
      expect(row.textContent).toContain("Saved Checkout flow.mp4");
    });
    expect(exportButton().textContent).toBe("Export MP4");
  });

  it("picks GIF from the panel and exports a GIF", async () => {
    await import("../../../pages/entrypoints/editor/main");
    const gif = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        '[data-file-type="gif"]',
      );
      if (!node) throw new Error("file type not rendered yet");
      return node;
    });
    gif.click();
    await vi.waitFor(() =>
      expect(exportButton().textContent).toBe("Export GIF"),
    );
    await startExport(memory);
    expect(startedJob(memory)).toMatchObject({ fileType: "gif" });
  });

  it("advances progress without re-rendering the page", async () => {
    // Progress is per frame at whole percents — a hundred-odd ticks per
    // export. Each one used to call `render`, which rebuilds the inspector
    // and with it the Cursor panel's `<input type="range">`: a drag riding
    // that slider lost Blink's implicit pointer capture with the discarded
    // element and died with no `change` (see `render`'s comment).
    //
    // Node identity is what tells the two apart. The label alone passes
    // either way, which is why the failing assertion here is `toBe`.
    await import("../../../pages/entrypoints/editor/main");
    const jobId = await startExport(memory);
    memory.emitExport({ kind: "rendering", jobId, done: 144, total: 576 });
    await vi.waitFor(() =>
      expect(exportButton().textContent).toBe("Exporting · 25%"),
    );
    const button = exportButton();
    const bar = document.querySelector("[data-export-progress]");
    // The premise, asserted: there IS a bar on screen for the ticks below
    // to move, so the identity checks are not comparing two nulls.
    expect(bar).not.toBeNull();

    for (const done of [288, 432, 576]) {
      memory.emitExport({ kind: "rendering", jobId, done, total: 576 });
    }
    await vi.waitFor(() =>
      expect(exportButton().textContent).toBe("Exporting · 100%"),
    );
    expect(exportButton()).toBe(button);
    expect(document.querySelector("[data-export-progress]")).toBe(bar);
    expect((bar as HTMLProgressElement).value).toBe(576);
  });

  it("leaves focus on the file type the keyboard just chose", async () => {
    // The panel is rebuilt on a type change — the summary and aspect note
    // above it both change — so the segment that was activated is
    // destroyed and focus fell to `<body>`, losing a keyboard author their
    // place in the radiogroup on every selection.
    await import("../../../pages/entrypoints/editor/main");
    const gif = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        '[data-file-type="gif"]',
      );
      if (!node) throw new Error("file type not rendered yet");
      return node;
    });
    gif.focus();
    // The premise, asserted: focus really is in the group before the
    // change. Without this the case below passes trivially in a DOM where
    // `focus()` did nothing.
    expect(document.activeElement).toBe(gif);
    gif.click();
    await vi.waitFor(() =>
      expect(exportButton().textContent).toBe("Export GIF"),
    );
    const after = document.querySelector<HTMLButtonElement>(
      '[data-file-type="gif"]',
    );
    // A different node — the panel was rebuilt — carrying the focus.
    expect(after).not.toBe(gif);
    expect(document.activeElement).toBe(after);
  });

  it("does not take focus when the change did not come from the group", async () => {
    // The positive control: restoring focus must not become "always focus
    // the segment". An author typing in the take's name field keeps it.
    await import("../../../pages/entrypoints/editor/main");
    const stills = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        '[data-file-type="stills"]',
      );
      if (!node) throw new Error("file type not rendered yet");
      return node;
    });
    const name = document.getElementById("name") as HTMLInputElement;
    name.focus();
    expect(document.activeElement).toBe(name);
    stills.click();
    await vi.waitFor(() =>
      expect(exportButton().textContent).toBe("Export PNG stills"),
    );
    expect(document.activeElement).toBe(name);
  });
});
