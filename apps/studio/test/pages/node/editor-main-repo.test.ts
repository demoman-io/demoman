import {
  DEFAULT_LIBRARY_VIEW,
  type VideoSummary,
} from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../../../pages/src/platform/types";
import { editorDom } from "../helpers/editor-dom";

/**
 * The editor's Repo section (Export panel), against the real
 * `entrypoints/editor/main.ts`: a failed add says `Couldn't add: ...` on the
 * panel, and a remove that works toasts its exact words. The dialogs are
 * faked (jsdom has no `showModal`); their own behaviour is in the browser lane.
 */

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    detectKeyframeMotion: async () => [],
    hoverVerdicts: async () => [],
  };
});

const seen = vi.hoisted(() => ({
  kept: false,
  removes: 0,
  /** What repoAddable answers; the listing answers nothing (DEM-47). */
  addable: null as unknown,
  asked: 0,
  video: (): VideoSummary =>
    ({
      id: "v1",
      name: "Checkout",
      repo: { unknown: true },
      startPage: "https://app.test/",
      versions: 1,
      current: null,
      pages: [],
      steps: [],
      exports: [],
      kept: seen.kept
        ? { file: "c.json", root: "/r", deliver: "commit", key: "k" }
        : null,
      addedTo: null,
    }) as unknown as VideoSummary,
}));
const sheet = vi.hoisted(() => ({
  open: vi.fn(async (_args: unknown) => ({
    added: null,
    prOpened: null,
    failed: "The repo is full.",
  })),
}));
vi.mock("../../../pages/src/shell/repo-sheet", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openRepoSheet: sheet.open,
}));
vi.mock("../../../pages/src/shell/confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askToConfirm: async () => true,
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
        videos: [seen.video()],
        videoOf: {
          t1: {
            videoId: "v1",
            version: 1,
            expired: false,
            exports: [],
            filmedCode: null,
          },
        },
        addable: {},
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
      repo: {
        folders: async () => ({ folders: [], more: false }),
        addable: async () => {
          seen.asked += 1;
          return (seen.addable ?? {
            ok: true,
            root: "/r",
            defaultPath: "docs/demos/c.mp4",
          }) as never;
        },
        onRepo: () => () => {},
        add: async () => ({ jobId: "none" }),
        remove: async () => {
          seen.removes += 1;
          seen.kept = false;
          return { removed: ["c.json"], exportsLeft: [], notes: [] };
        },
      },
      remove: async () => ({ ok: true }),
    },
    repoCi: {
      state: async () => ({ kind: "notSetUp" }),
      plan: async () => ({ jobId: "none" }),
      apply: async () => ({ jobId: "none" }),
      openPr: async () => ({ failed: "pr", detail: "" }),
      onCi: () => () => {},
    },
    bundles: {
      active: async () => ({ bundle: bundle(), replay: null, capture: null }),
      load: () => new Promise<never>(() => {}),
    },
    outputs: {
      list: async () => [],
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
    libraryView: {
      read: async () => ({ view: DEFAULT_LIBRARY_VIEW }),
      write: async () => ({}),
    },
    exports: {
      start: async () => ({ jobId: "job-1" }),
      onEvent: () => () => undefined,
    },
    files: { reveal: async () => {} },
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

const press = async (action: string): Promise<void> => {
  const button = await vi.waitFor(
    () => {
      const node = document.querySelector<HTMLButtonElement>(
        `[data-repo-section] [data-action="${action}"]`,
      );
      if (node === null) throw new Error(`no ${action} yet`);
      return node;
    },
    { timeout: 5_000 },
  );
  button.click();
};

describe("editor main: the Repo section", () => {
  beforeEach(() => {
    vi.resetModules();
    seen.kept = false;
    seen.removes = 0;
    seen.addable = null;
    seen.asked = 0;
    history.pushState({}, "", "/?scene=t1");
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
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    document.querySelector("[data-toast]")?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Red if a failed add stops landing on the panel's status as `Couldn't add: <detail>.`
  it("says a failed add on the panel", async () => {
    await import("../../../pages/entrypoints/editor/main");
    await press("repo-add");
    await vi.waitFor(() => {
      expect(
        document.querySelector("[data-repo-section] [data-status]")
          ?.textContent,
      ).toBe("Couldn't add: The repo is full.");
    });
    expect(document.querySelector("[data-toast]")).toBeNull();
  }, 20_000);

  // Red if the section reads the listing, which no longer checks (DEM-47): its button would vanish.
  it("asks repoAddable for its one flow, and draws the refusal's words", async () => {
    seen.addable = {
      ok: false,
      reason: "notCarried",
      label: "has a trim",
      detail: "the trim would be left behind",
    };
    await import("../../../pages/entrypoints/editor/main");
    const off = await vi.waitFor(
      () => {
        const node = document.querySelector<HTMLButtonElement>(
          '[data-repo-section] [data-action="repo-add"]',
        );
        if (node === null) throw new Error("no repo-add yet");
        return node;
      },
      { timeout: 5_000 },
    );
    expect(off.textContent).toBe("Can't add: has a trim");
    expect(off.getAttribute("aria-disabled")).toBe("true");
    expect(seen.asked).toBeGreaterThan(0);
  }, 20_000);

  // Red if an In repo flow is checked for an add it cannot make.
  it("does not ask an In repo flow whether it can be added", async () => {
    seen.kept = true;
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (
        document.querySelector(
          '[data-repo-section] [data-action="repo-remove"]',
        ) === null
      )
        throw new Error("no section yet");
    });
    expect(seen.asked).toBe(0);
  }, 20_000);

  // Red if a remove that works stops toasting its exact words.
  it("toasts a successful remove", async () => {
    seen.kept = true;
    await import("../../../pages/entrypoints/editor/main");
    await press("repo-remove");
    await vi.waitFor(() => {
      expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
        'Removed "Checkout" from the repo. Its exports stay',
      );
    });
  }, 20_000);
});
