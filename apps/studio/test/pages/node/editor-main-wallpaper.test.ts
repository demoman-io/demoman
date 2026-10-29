import type { SceneBackground, SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { editorDom } from "../helpers/editor-dom";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

/**
 * The background's image in the real `entrypoints/editor/main.ts`: what the
 * preview is composed with, and what the author is told when the image
 * cannot be had. The compositor paints the neutral for a missing image, so
 * a failure that is not said looks like a choice, and a late decode that
 * lands over a newer choice paints a wallpaper the scene does not hold.
 */

const state = vi.hoisted(() => ({
  memory: null as MemoryPlatform | null,
  composed: [] as unknown[],
}));
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));
vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    // What each composition was handed as its wallpaper: the image the
    // preview paints.
    composeForTarget: (args: Parameters<typeof actual.composeForTarget>[0]) => {
      state.composed.push(args.wallpaper ?? null);
      return actual.composeForTarget(args);
    },
    detectKeyframeMotion: vi.fn().mockResolvedValue([]),
    hoverVerdicts: vi.fn().mockResolvedValue([]),
  };
});

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

const sceneOn = (background: SceneBackground): SceneDocument => {
  const scene = readonlyScene();
  return { ...scene, branding: { ...scene.branding, background } };
};
const failureText = () => document.getElementById("failure")?.textContent ?? "";
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function openBackground(): Promise<void> {
  const entry = await vi.waitFor(() => {
    const node = document.querySelector<HTMLButtonElement>(
      '#rail [data-rail="background"]',
    );
    if (!node) throw new Error("rail not rendered yet");
    return node;
  });
  entry.click();
}

const tile = (id: string) =>
  vi.waitFor(() => {
    const node = document.querySelector<HTMLButtonElement>(
      `[data-wallpaper-id="${id}"]`,
    );
    if (!node) throw new Error(`no ${id} tile yet`);
    return node;
  });

describe("editor main — the background's image", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    state.composed = [];
    memory = createMemoryPlatform();
    state.memory = memory;
  });

  afterEach(() => {
    vi.doUnmock("../../../pages/src/branding/wallpaper");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  describe("A, then B, then A again before B's image lands", () => {
    type Pending = {
      id: string;
      resolve(v: unknown): void;
      reject(e: Error): void;
    };
    let decodes: Pending[];
    const image = (name: string) => ({
      // Wider than any preview needs, so nothing re-decodes for size.
      image: { name, close: vi.fn() },
      width: 100_000,
      height: 75_000,
      sourceTimeMs: 0,
    });

    async function toBAndBack(): Promise<{ a: ReturnType<typeof image> }> {
      decodes = [];
      vi.doMock("../../../pages/src/branding/wallpaper", async (actual) => ({
        ...(await actual<
          typeof import("../../../pages/src/branding/wallpaper")
        >()),
        decodeBackground: (bg: { id: string }) =>
          new Promise((resolve, reject) =>
            decodes.push({ id: bg.id, resolve, reject }),
          ),
      }));
      memory.serveScene(() => sceneOn({ kind: "wallpaper", id: "vivid-1" }));
      memory.serveBundle(proceduralBundle({ motionSpans: [] }), null);
      await import("../../../pages/entrypoints/editor/main");
      const a = image("vivid-1");
      await vi.waitFor(() => {
        if (decodes[0]?.id !== "vivid-1") throw new Error("A not asked yet");
      });
      decodes[0]?.resolve({ image: a, natural: null });
      await vi.waitFor(() => {
        if (state.composed.at(-1) !== a) throw new Error("A not painted yet");
      });
      await openBackground();
      (await tile("vivid-2")).click();
      await vi.waitFor(() => {
        if (decodes[1]?.id !== "vivid-2") throw new Error("B not asked yet");
      });
      (await tile("vivid-1")).click();
      // The premise: the scene is back on A while B is still decoding.
      await vi.waitFor(() => {
        if (
          document
            .querySelector('[data-wallpaper-id="vivid-1"]')
            ?.getAttribute("aria-pressed") !== "true"
        )
          throw new Error("not back on A yet");
      });
      expect(decodes).toHaveLength(2);
      return { a };
    }

    it("paints A when B's image lands late, and lets B's go", async () => {
      const { a } = await toBAndBack();
      const b = image("vivid-2");
      decodes[1]?.resolve({ image: b, natural: null });
      await flush();
      expect(state.composed.at(-1)).toBe(a);
      expect(state.composed).not.toContain(b);
      expect(b.image.close).toHaveBeenCalled();
      // A was held: it is not decoded again.
      expect(decodes).toHaveLength(2);
    });

    it("does not say B's failure under A", async () => {
      const { a } = await toBAndBack();
      decodes[1]?.reject(new Error("vivid-2 would not decode"));
      await flush();
      expect(failureText()).not.toContain("vivid-2 would not decode");
      // The panel never says a load failure; the band is where it would be.
      expect(document.querySelector("[data-wallpaper-error]")).toBeNull();
      expect(state.composed.at(-1)).toBe(a);
    });
  });

  // The band alone says it (the author, 2026-10-28): red if the panel's
  // own line under the grid comes back.
  it("says an uploaded image that cannot be loaded in the band, not again in the panel", async () => {
    // The memory platform answers a ref it never stored with a reason, as
    // the studio answers one that moved.
    memory.serveScene(() =>
      sceneOn({ kind: "image", ref: "assets/moved.webp" }),
    );
    memory.serveBundle(null, null);
    const reason = "no wallpaper at assets/moved.webp in the memory platform";
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!failureText().includes(reason))
        throw new Error(`band: ${failureText()}`);
    });
    expect(
      document.querySelector("[data-wallpaper-load-error]")?.textContent,
    ).toContain("The background image could not be loaded");
    // Announced: the panel's alert line is gone, so the card carries it.
    expect(
      document
        .querySelector("[data-wallpaper-load-error]")
        ?.getAttribute("role"),
    ).toBe("alert");
    // The premise: it was the platform's answer, not a decode, that failed.
    expect(
      memory.calls.filter(
        (c) => c.member === "wallpapers" && c.method === "load",
      ),
    ).toHaveLength(1);
    await openBackground();
    // The premise: the panel is open on this image's grid.
    await vi.waitFor(() => {
      if (document.querySelector("[data-wallpaper-custom]") === null)
        throw new Error("no grid yet");
    });
    expect(document.querySelector("[data-wallpaper-error]")).toBeNull();
    expect(failureText()).toContain(reason);
    // The custom tile says it, to a screen reader as well.
    expect(
      document
        .querySelector("[data-wallpaper-custom]")
        ?.getAttribute("aria-label"),
    ).toContain(reason);
  });
});
