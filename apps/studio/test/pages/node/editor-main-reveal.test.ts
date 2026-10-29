import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../../../pages/src/platform/types";
import { editorDom } from "../helpers/editor-dom";

/**
 * Final review I2: a Show in Finder press that showed nothing. The editor
 * used to `.catch(reportError)` it — a `console.error` and nothing on the
 * page — for a file moved since its export, which on the studio is an
 * expected 404 `revealRefused`.
 *
 * Against the real `entrypoints/editor/main.ts`, with `#platform` replaced
 * by one that lists one file and refuses its reveal the way the studio's
 * HTTP side does (a `StudioError`: `reason`, `status`, the detail as its
 * message).
 *
 * Production changes that redden it, made and watched go red:
 * - put back `.catch(reportError)`: no `[data-reveal-error]` line, and the
 *   404 goes to `console.error`;
 * - log every `revealRefused` at error (drop `expected`): the 404 case's
 *   `console.info` assertion fails.
 */

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    detectKeyframeMotion: async () => [],
    hoverVerdicts: async () => [],
  };
});

class StudioLikeError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
    readonly status: number,
  ) {
    super(detail);
  }
}

const seen = vi.hoisted(() => ({
  reveals: [] as unknown[],
  refuseWith: null as Error | null,
}));

const PATH = "/Users/a/Downloads/Checkout.mp4";

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
        videos: [],
        videoOf: {},
        unwatched: null,
      }),
      onChange: () => () => {},
      thumb: async () => {
        throw new Error("no thumbnails in this test");
      },
    },
    scenes: {
      get: async () => ({ scene: scene(), revision: "r1", notes: [] }),
      put: async () => ({ revision: "r2" }),
      list: async () => [],
      remove: async () => ({ ok: true }),
    },
    videos: {
      rename: async () => {},
      remove: async () => ({ ok: true }),
    },
    bundles: {
      active: async () => ({ bundle: bundle(), replay: null, capture: null }),
      load: () => new Promise<never>(() => {}),
    },
    outputs: {
      list: async () => [
        {
          kind: "file",
          key: "k1",
          name: "Checkout.mp4",
          byteLength: 1000,
          path: PATH,
          exists: true,
          // Not this page's digest, so the row also wears "Outdated";
          // nothing here is about that.
          sceneDigest: "d",
          renderedAt: "2026-10-19T14:14:00.000Z",
          detail: null,
          caveats: [],
        },
      ],
    },
    logos: {
      put: async () => ({ ref: "assets/x.png" }),
      load: async () => ({ ok: false, error: "no logo in this test" }),
    },
    wallpapers: {
      put: async () => ({ ref: "assets/x.webp" }),
      load: async () => ({ ok: false, error: "no wallpaper in this test" }),
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
      read: async () => ({ quality: "share" }),
      write: async () => ({}),
    },
    exports: {
      start: async () => ({ jobId: "job-1" }),
      onEvent: () => () => undefined,
    },
    files: {
      reveal: async (target) => {
        seen.reveals.push(target);
        if (seen.refuseWith !== null) throw seen.refuseWith;
      },
    },
    nav: {
      editor: (id) => `/editor.html?scene=${id}`,
      library: () => "/",
      firstTakeHint: () => "",
      rerun: (id) => ({ kind: "line", text: `re-film ${id}` }),
      kits: () => "/settings.html",
      onOpen: () => undefined,
    },
  };
  return { ...actual, createPlatform: () => platform };
});

async function pressReveal(): Promise<void> {
  const button = await vi.waitFor(
    () => {
      const node =
        document.querySelector<HTMLButtonElement>('[data-reveal="k1"]');
      if (node === null) throw new Error("file row not drawn yet");
      return node;
    },
    { timeout: 5_000 },
  );
  button.click();
}

async function revealLine(): Promise<string> {
  return vi.waitFor(() => {
    const node = document.querySelector("[data-reveal-error]");
    if (node === null) throw new Error("no reveal line yet");
    return node.textContent ?? "";
  });
}

describe("editor main — a reveal that showed nothing", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    seen.reveals.length = 0;
    seen.refuseWith = null;
    editorDom();
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
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const said = (spy: ReturnType<typeof vi.spyOn>, needle: string) =>
    spy.mock.calls.some((args: unknown[]) =>
      args.some((a) => String(a).includes(needle)),
    );

  // The first import pays for the module graph (~1 s here); CI is ~5x slower.
  it("a file moved since its export: said on the panel, logged at info", async () => {
    seen.refuseWith = new StudioLikeError(
      "revealRefused",
      `${PATH} was moved or deleted.`,
      404,
    );
    await import("../../../pages/entrypoints/editor/main");
    await pressReveal();
    expect(await revealLine()).toBe(`Not shown: ${PATH} was moved or deleted.`);
    // Premise: the press reached the platform with the file's path.
    expect(seen.reveals).toEqual([{ kind: "path", path: PATH }]);
    expect(said(info, "was moved or deleted")).toBe(true);
    expect(said(error, "was moved or deleted")).toBe(false);
  }, 20_000);

  it("open -R failing: said on the panel, and a fault at console.error", async () => {
    seen.refuseWith = new StudioLikeError(
      "revealRefused",
      `${PATH} could not be shown in Finder (open exited 1).`,
      500,
    );
    await import("../../../pages/entrypoints/editor/main");
    await pressReveal();
    expect(await revealLine()).toBe(
      `Not shown: ${PATH} could not be shown in Finder (open exited 1).`,
    );
    expect(said(error, "open exited 1")).toBe(true);
    expect(said(info, "open exited 1")).toBe(false);
  }, 20_000);

  it("the next press takes the line down; one that works leaves none", async () => {
    seen.refuseWith = new StudioLikeError(
      "revealRefused",
      `${PATH} was moved or deleted.`,
      404,
    );
    await import("../../../pages/entrypoints/editor/main");
    await pressReveal();
    await revealLine();
    seen.refuseWith = null;
    await pressReveal();
    await vi.waitFor(() => {
      if (seen.reveals.length !== 2) throw new Error("second press not sent");
    });
    await vi.waitFor(() => {
      if (document.querySelector("[data-reveal-error]") !== null)
        throw new Error("the old line is still drawn");
    });
  }, 20_000);
});
