import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../../../pages/src/platform/types";
import { editorDom } from "../helpers/editor-dom";

/**
 * Review Focus 2 (Launch D2): Export pressed while an edit is still being
 * written. The page waits for `session.settled()`, then names the revision
 * that write returned — on the studio, posting before it would name the
 * revision from before the edit and be refused `sceneNotSaved` for a scene
 * the page had in fact saved.
 *
 * Against the real `entrypoints/editor/main.ts`, with `#platform` replaced
 * by a platform that answers revisions the way the studio's does (the
 * extension's always answers null, so it cannot show which revision went).
 *
 * Production changes that redden it, made and watched go red:
 * - drop the `await session.settled()` from `startExport`: the export posts
 *   while the write is pending, naming "r-open";
 * - drop the `if (!sceneRevisionRead)` guard in `loadScene`: the write
 *   carries "r-other", the revision of another window's write that
 *   `persist()`'s re-read saw, and would overwrite it (Review Focus 1).
 *
 * The second block boots the same page with no frames on a platform that
 * answers the re-film line (the studio's `nav.rerun`), and asserts no
 * surface says "in Runs" (ruling R18). Red: drop `rerunLine:` at any of
 * main.ts's three call sites.
 */

const LINE =
  'Ask your agent to re-record this take — `run({ takeId: "scene-readonly-001" })`';
const LINE_WORDS = LINE.replaceAll("`", "");

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    // As editor-main-keyboard.test.ts: the hover check and the video
    // source would read frames this lane has none of; neither is what this
    // file is about.
    detectKeyframeMotion: async () => [],
    hoverVerdicts: async () => [],
    createVideoFrameSource: async (
      ...args: Parameters<typeof actual.createImageFrameSource>
    ) => actual.createImageFrameSource(...args),
  };
});

/** What the fake platform saw, and the one write the test holds open. */
const seen = vi.hoisted(() => ({
  puts: [] as { revision: string | null }[],
  starts: [] as {
    revision: string | null;
    fileType: string;
    quality?: string;
  }[],
  releasePut: null as ((revision: string) => void) | null,
  gets: 0,
  withFrames: true,
  qualityRead: { quality: "share" } as {
    quality: "share" | "high" | "full";
    unreadable?: string;
  },
}));

vi.mock("#platform", async (importOriginal) => {
  const actual = await importOriginal<object>();
  const { readonlyScene: scene } = await import(
    "../../../../../packages/replay-engine/test/helpers/scenes"
  );
  const { proceduralBundle: bundle } = await import(
    "../../../../../packages/replay-engine/test/helpers/bundles"
  );
  const platform: Platform = {
    // The studio's take folder; nothing here lists takes.
    folder: {
      read: async () => ({
        scenes: [],
        sizes: {},
        unreadable: [],
        unwatched: null,
      }),
      onChange: () => () => {},
      thumb: async () => {
        throw new Error("no thumbnails in this test");
      },
    },
    scenes: {
      // The open reads "r-open"; every read after it sees another window's
      // write, "r-other" — which `persist()` re-reads before each save.
      get: async () => {
        seen.gets += 1;
        return {
          scene: scene(),
          revision: seen.gets === 1 ? "r-open" : "r-other",
          notes: [],
        };
      },
      put: (_doc, revision) => {
        seen.puts.push({ revision });
        return new Promise((resolve) => {
          seen.releasePut = (next) => resolve({ revision: next });
        });
      },
      list: async () => [],
      remove: async () => ({ ok: true }),
    },
    bundles: {
      active: async () => ({
        bundle: seen.withFrames ? bundle() : null,
        replay: null,
        capture: null,
      }),
      // Never settles: nothing here is about the picture, and a failure
      // would reach the page's console.
      load: () => new Promise<never>(() => {}),
    },
    outputs: { list: async () => [] },
    logos: {
      put: async () => ({ ref: "assets/x.png" }),
      load: async () => ({ ok: false, error: "no logo in this test" }),
    },
    kits: {
      read: async () => ({
        state: "ready",
        kits: [],
        defaultId: null,
        migrationPending: false,
      }),
      update: async () => null,
      readStored: async () => ({ kits: [], defaultId: null }),
      reset: async () => ({ backup: null }),
      onChange: () => () => undefined,
      unwatched: () => null,
    },
    pullRequests: {
      read: async () => ({ value: null }),
      write: async () => ({}),
    },
    exportQuality: {
      read: async () => seen.qualityRead,
      write: async () => ({}),
    },
    exports: {
      start: async (_takeId, job) => {
        seen.starts.push({
          revision: job.revision,
          fileType: job.fileType,
          ...(job.quality === undefined ? {} : { quality: job.quality }),
        });
        return { jobId: "job-1" };
      },
      onEvent: () => () => undefined,
    },
    files: { reveal: async () => undefined },
    nav: {
      editor: (id) => `/editor.html?scene=${id}`,
      library: () => "/",
      firstTakeHint: () => "",
      rerun: (id) => ({
        kind: "line",
        text: `Ask your agent to re-record this take — \`run({ takeId: "${id}" })\``,
      }),
      kits: () => "/settings.html",
      onOpen: () => undefined,
    },
  };
  return { ...actual, createPlatform: () => platform };
});

const press = (key: string): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
};

describe("editor main — Export waits for the edit being written", () => {
  beforeEach(() => {
    vi.resetModules();
    seen.puts.length = 0;
    seen.starts.length = 0;
    seen.releasePut = null;
    seen.gets = 0;
    seen.withFrames = true;
    seen.qualityRead = { quality: "share" };
    editorDom();
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return {};
        }
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Boots the real editor; the first import pays for the module graph
  // (~1 s here, editor-main-keyboard.test.ts measures the same), and CI is
  // ~5x slower.
  it("posts only after the pending write lands, naming the revision it returned", async () => {
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector('[data-tick="act-1"]')) {
        throw new Error("timeline not rendered yet");
      }
    });

    // An edit: a pause after act-2, typed in its panel. Its write is held
    // open.
    (document.querySelector('[data-tick="act-2"]') as HTMLElement).click();
    const gap = document.querySelector<HTMLInputElement>('[data-gap="act-2"]');
    if (gap === null) throw new Error("no pause field on act-2");
    gap.value = "500";
    gap.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      if (seen.releasePut === null) throw new Error("no scene write yet");
    });
    // Premise: the save re-read the take first, and that read saw another
    // window's revision.
    expect(seen.gets).toBeGreaterThanOrEqual(2);
    // The write carried the revision the page opened on, not that one: the
    // studio then refuses it (409) rather than letting it overwrite.
    expect(seen.puts).toEqual([{ revision: "r-open" }]);
    // The selection holds the rail; clearing it brings Export back.
    press("Escape");

    const button = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        "[data-export-start]",
      );
      if (node === null) throw new Error("Export button not rendered yet");
      return node;
    });
    // Premise: the take has frames, so Export is enabled and a press posts.
    expect(button.disabled, "Export is enabled on a take with frames").toBe(
      false,
    );
    button.click();
    // Every await the press makes before posting, and more: still nothing.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(seen.starts, "posted while the write was pending").toEqual([]);

    seen.releasePut?.("r-after-edit");
    await vi.waitFor(() => {
      if (seen.starts.length === 0) throw new Error("not posted yet");
    });
    // Nothing picked: the setting the panel shows, so a setting changed
    // before the job runs cannot make another size than the panel named.
    expect(seen.starts).toEqual([
      { revision: "r-after-edit", fileType: "mp4", quality: "share" },
    ]);
  }, 20_000);

  // Red if an unread setting is sent as though read: the studio then could
  // not say, in the export's own answer, why it was not followed.
  it("sends no quality when the setting could not be read", async () => {
    seen.qualityRead = {
      quality: "high",
      unreadable: "settings.json is not valid JSON",
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await import("../../../pages/entrypoints/editor/main");
    // Premise: the read answered, and the page said so.
    await vi.waitFor(() => {
      if (
        !info.mock.calls.some((c) => String(c[0]).includes("not valid JSON"))
      ) {
        throw new Error("the unreadable setting was not read yet");
      }
    });
    const button = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        "[data-export-start]",
      );
      if (node === null || node.disabled) throw new Error("no Export yet");
      return node;
    });
    button.click();
    await vi.waitFor(() => {
      if (seen.starts.length === 0) throw new Error("not posted yet");
    });
    expect(seen.starts).toEqual([{ revision: "r-open", fileType: "mp4" }]);
    expect(seen.starts[0]).not.toHaveProperty("quality");
  }, 20_000);

  // Red if the Quality row stops starting at the setting, a pick stops
  // reaching the readout, or the export stops carrying it.
  it("the panel's Quality starts at the setting, and a pick is this export's", async () => {
    await import("../../../pages/entrypoints/editor/main");
    const checked = () =>
      document
        .querySelector('[data-export-quality][aria-checked="true"]')
        ?.getAttribute("data-export-quality");
    // The setting reads "share" (the platform above), not the default.
    await vi.waitFor(() => {
      if (checked() !== "share") {
        throw new Error(`Quality shows ${checked() ?? "nothing"}`);
      }
    });
    const readout = () =>
      document.querySelector("[data-size-readout]")?.textContent ?? "";
    const atShare = readout();
    (
      document.querySelector('[data-export-quality="full"]') as HTMLElement
    ).click();
    await vi.waitFor(() => {
      if (checked() !== "full") throw new Error("the pick did not show");
    });
    // The readout names the size the pick makes, not the setting's.
    expect(readout()).not.toBe(atShare);
    expect(atShare).not.toBe("");
    (document.querySelector("[data-export-start]") as HTMLElement).click();
    await vi.waitFor(() => {
      if (seen.starts.length === 0) throw new Error("not posted yet");
    });
    expect(seen.starts).toEqual([
      { revision: "r-open", fileType: "mp4", quality: "full" },
    ]);
  }, 20_000);
});

describe("editor main — no frames, on a platform with no Runs page", () => {
  beforeEach(() => {
    vi.resetModules();
    seen.gets = 0;
    seen.withFrames = false;
    editorDom();
    // The take the page is on, so the line names it.
    history.replaceState(null, "", "?scene=scene-readonly-001");
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width = 0;
        height = 0;
        getContext() {
          return {};
        }
      },
    );
  });

  afterEach(() => {
    history.replaceState(null, "", "?");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("says the re-film line wherever it would have named Runs", async () => {
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector('[data-tick="act-1"]')) {
        throw new Error("timeline not rendered yet");
      }
      if (!document.querySelector("[data-transport-play]")) {
        throw new Error("transport not rendered yet");
      }
    });
    const play = document.querySelector<HTMLElement>("[data-transport-play]");
    const zoom = document.querySelector<HTMLElement>("[data-stage-zoom]");
    // Premise: the take has no frames, so both carry their no-frames title.
    expect(play?.title).toContain("no frames yet");
    expect(play?.title).toBe(
      `This demo has no frames yet, so there is nothing to play. ${LINE_WORDS}`,
    );
    expect(zoom?.title).toBe(
      `This demo has no frames yet, so there is nothing to zoom into. ${LINE_WORDS}`,
    );
    // The timeline's own note on an unrendered take.
    expect(document.body.textContent).toContain(
      `Timing from the take, not from a render. ${LINE_WORDS}`,
    );
    // Drawn as code, not as literal backticks (R20).
    expect(document.body.textContent ?? "").not.toContain("`");
    expect(
      [...document.querySelectorAll("code")].map((c) => c.textContent),
    ).toContain('run({ takeId: "scene-readonly-001" })');
    const titled = [...document.querySelectorAll<HTMLElement>("[title]")];
    expect(titled.length, "premise: titles were drawn").toBeGreaterThan(3);
    const runs = titled
      .map((e) => e.getAttribute("title") ?? "")
      .filter((t) => /in Runs/.test(t));
    expect(runs, "titles naming Runs").toEqual([]);
    expect(document.body.textContent ?? "").not.toMatch(/in Runs/);
  }, 20_000);
});
