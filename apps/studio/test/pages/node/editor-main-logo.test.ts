import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { LOGO_THUMB_HEIGHT_PX } from "../../../pages/src/adapters/logo";
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
 * The branding logo, from the file picker to the store. `addLogo` stored
 * whatever the picker handed it and wrote the ref into the scene; the first
 * thing that ever decoded the bytes was `loadLogo` on the render path, whose
 * `catch { return null }` is right for a render — a logo is decoration — and
 * wrong as the only report the author gets: a file that was not an image
 * became a logo ref that drew nothing, silently, on every render after.
 */

/** The logos the editor stored, through the platform. */
const logoPuts = () =>
  state.memory?.calls.filter(
    (c) => c.member === "logos" && c.method === "put",
  ) ?? [];

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

/**
 * Hands `file` to the logo picker.
 *
 * One click to get there as of 2026-09-14: the rail opens on Export, and
 * the branding panel is the Background entry's. (Task 12 had removed the
 * tabs and put branding on the one demo panel every test booted into; the
 * rail split that panel in two.)
 */
async function pickLogo(file: File): Promise<void> {
  const background = await vi.waitFor(() => {
    const node = document.querySelector<HTMLButtonElement>(
      '#rail [data-rail="background"]',
    );
    if (!node) throw new Error("rail not rendered yet");
    return node;
  });
  background.click();
  const input = await vi.waitFor(() => {
    const node = document.querySelector('input[type="file"]');
    if (!node) throw new Error("logo picker not rendered yet");
    return node as HTMLInputElement;
  });
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change"));
}

const failureText = () => document.getElementById("failure")?.textContent ?? "";

describe("editor main — the branding logo", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => readonlyScene());
    memory.serveBundle(null, null);
  });

  afterEach(() => {
    // The SVG case mocks the logo module; a doMock outlives its test.
    vi.doUnmock("../../../pages/src/adapters/logo");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("refuses a file that does not decode as an image, and says so", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("The source image could not be decoded.");
      }),
    );
    await import("../../../pages/entrypoints/editor/main");
    await pickLogo(new File(["not a png"], "logo.png", { type: "image/png" }));

    await vi.waitFor(() => {
      if (!/logo/i.test(failureText())) {
        throw new Error("logo failure not shown yet");
      }
    });
    expect(failureText()).toContain("The source image could not be decoded.");
    expect(logoPuts()).toEqual([]);
    expect(memory.putCalls().length > 0).toBe(false);
  });

  it("stores a logo that decodes and writes its ref into the scene", async () => {
    // Positive control for the refusal above: the same path, an image the
    // browser accepts, and the store and the scene both see it.
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 40, height: 12, close: () => undefined })),
    );
    await import("../../../pages/entrypoints/editor/main");
    await pickLogo(new File(["png bytes"], "logo.png", { type: "image/png" }));

    const put = await vi.waitFor(() => {
      const sent = memory.putCalls()[0];
      if (!sent) throw new Error("scene not saved yet");
      return sent.scene as { branding: { logo: { ref: string } | null } };
    });
    expect(put.branding.logo?.ref).toMatch(/^logo:/);
    expect(logoPuts()).toHaveLength(1);
    expect(failureText()).not.toMatch(/logo/i);
  });

  it("accepts an SVG, which Chrome's createImageBitmap refuses", async () => {
    // The regression the Background panel spec opened with: the picker
    // advertised SVG and `addLogo` validated it with createImageBitmap,
    // which rejects SVG blobs (test/browser/logo-svg-premise.test.ts), so
    // every SVG was refused. Stubbed the way Chrome behaves; the SVG decode
    // itself is the browser lane's (logo-decode.test.ts), so it is mocked.
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => {
        if (blob.type === "image/svg+xml") {
          throw new Error("The source image could not be decoded.");
        }
        return { width: 40, height: 12, close: () => undefined };
      }),
    );
    const source = {
      contentType: "image/svg+xml",
      aspect: 2,
      naturalHeight: null,
      rasterAt: async () => ({
        image: {},
        width: 2,
        height: 1,
        sourceTimeMs: 0,
      }),
    };
    const decodeLogo = vi.fn(async () => source);
    vi.doMock("../../../pages/src/adapters/logo", async (actual) => ({
      ...(await actual<typeof import("../../../pages/src/adapters/logo")>()),
      decodeLogo,
    }));
    // The read back: the platform's, which decodes what the studio serves.
    memory.answer("logos.load", async () => ({ ok: true, source }));
    await import("../../../pages/entrypoints/editor/main");
    await pickLogo(
      new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "logo.svg", {
        type: "image/svg+xml",
      }),
    );
    await vi.waitFor(() => {
      if (logoPuts().length === 0) throw new Error("not stored yet");
    });
    expect((logoPuts()[0]?.args[0] as File | undefined)?.type).toBe(
      "image/svg+xml",
    );
    expect(decodeLogo).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "image/svg+xml",
    );
    expect(failureText()).not.toMatch(/logo/i);
  });

  it("refuses a GIF by its type, before reading it", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 40, height: 12, close: () => undefined })),
    );
    await import("../../../pages/entrypoints/editor/main");
    await pickLogo(new File(["gif"], "logo.gif", { type: "image/gif" }));
    await vi.waitFor(() => {
      if (!/logo/i.test(failureText())) throw new Error("not refused yet");
    });
    expect(failureText()).toContain(
      'The logo "logo.gif" is a image/gif file — use SVG, PNG, WebP or JPEG',
    );
    expect(logoPuts()).toEqual([]);
  });

  it("says so when the scene's logo is not in storage, rather than drawing none", async () => {
    // Review Focus 4: site data cleared, or the demo opened in another
    // profile. The memory platform holds no logo by that ref.
    const scene = readonlyScene();
    memory.serveScene(() => ({
      ...scene,
      branding: {
        ...scene.branding,
        logo: {
          ref: "logo:gone",
          corner: "bottom-right",
          size: 0.06,
          opacity: 0.9,
        },
      },
    }));
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!/could not be loaded/.test(failureText())) {
        throw new Error("load failure not shown yet");
      }
    });
    expect(failureText()).toContain("The logo could not be loaded");
    // The platform's own reason, said as it gave it.
    expect(failureText()).toContain("no logo at logo:gone");
    // The Background panel's thumbnail says it too, rather than spinning
    // as though the load were still under way.
    (
      document.querySelector('#rail [data-rail="background"]') as HTMLElement
    ).click();
    const tile = await vi.waitFor(() => {
      const node = document.querySelector<HTMLElement>("[data-logo-thumb]");
      if (!node) throw new Error("thumbnail not rendered yet");
      return node;
    });
    expect(tile.dataset.logoThumb).toBe("failed");
    expect(tile.title).toContain("no logo at logo:gone");
  });

  it("clears the failure once the logo draws at another height", async () => {
    // A raster that failed at one height must not keep saying so once the
    // logo draws at the next (play/pause, a resize or a Size change move it).
    const scene = readonlyScene();
    memory.serveScene(() => ({
      ...scene,
      branding: {
        ...scene.branding,
        logo: {
          ref: "logo:svg",
          corner: "bottom-right",
          size: 0.06,
          opacity: 0.9,
        },
      },
    }));
    const heights: number[] = [];
    const source = {
      contentType: "image/svg+xml",
      aspect: 2,
      naturalHeight: null,
      rasterAt: async (height: number) => {
        // The Background panel's thumbnail asks for its own height; only
        // the preview's rasters are what this test is about.
        if (height === LOGO_THUMB_HEIGHT_PX) {
          return { image: {}, width: 2, height: 1, sourceTimeMs: 0 };
        }
        heights.push(height);
        if (heights.length === 1) throw new Error("the SVG would not draw");
        return { image: {}, width: 2, height: 1, sourceTimeMs: 0 };
      },
    };
    memory.answer("logos.load", async () => ({ ok: true, source }));
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!/the SVG would not draw/.test(failureText()))
        throw new Error(`failure not shown yet: ${failureText()}`);
    });
    // A Size change moves the raster height: logoRasterHeight is the size
    // times the target's short side.
    (
      document.querySelector('#rail [data-rail="background"]') as HTMLElement
    ).click();
    const size = await vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>("[data-logo-size]");
      if (!node) throw new Error("size slider not rendered yet");
      return node;
    });
    size.value = "0.2";
    size.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      if (heights.length < 2) throw new Error("not re-rasterised yet");
    });
    // Premise: the second raster was at a different height, and succeeded.
    expect(heights[1]).not.toBe(heights[0]);
    await vi.waitFor(() => {
      if (/could not be loaded/.test(failureText()))
        throw new Error(`failure still shown: ${failureText()}`);
    });
  });

  it("re-reads the sharpness note when the file type changes", async () => {
    // The note is computed for the deliverable's own size, so a file-type
    // switch changes it. It was refreshed only on session emits, and a
    // file-type switch is not one (it is page-local): the note kept naming
    // the old deliverable.
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 40, height: 12, close: () => undefined })),
    );
    await import("../../../pages/entrypoints/editor/main");
    await pickLogo(new File(["png"], "logo.png", { type: "image/png" }));
    const notes = () =>
      document.querySelector("[data-logo-notes]")?.textContent ?? "";
    await vi.waitFor(() => {
      if (!notes().includes("Landscape video")) throw new Error("no note yet");
    });
    // The file type is the Export panel's; the note is Background's.
    const rail = (entry: string) =>
      (document.querySelector(`[data-rail="${entry}"]`) as HTMLElement).click();
    rail("export");
    const gif = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        '[data-file-type="gif"]',
      );
      if (!node) throw new Error("file type not rendered yet");
      return node;
    });
    gif.click();
    rail("background");
    await vi.waitFor(() => {
      // "GIF" and not "Landscape video": `deliverableTitle("gif", "16:9")`.
      if (notes().includes("Landscape video") || !notes().includes("GIF")) {
        throw new Error(`note still reads: ${notes()}`);
      }
    });
  });
});
