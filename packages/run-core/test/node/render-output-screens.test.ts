import type { FrameBundle } from "@demoman/compositor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../compositor/test/fixtures/scene";

const renderScreens = vi.hoisted(() => vi.fn());
const renderScene = vi.hoisted(() => vi.fn());
const composeForTarget = vi.hoisted(() => vi.fn());
vi.mock("@demoman/compositor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@demoman/compositor")>()),
  createOffscreenSurface: () => ({}),
  createMp4Sink: () => ({}),
  createGifSink: () => ({}),
  createPngSink: () => ({ kind: "png" }),
  renderScreens,
  renderScene,
  composeForTarget,
}));

const { renderOutput, screenImageName } = await import(
  "../../src/render/output"
);

const screens = {
  moments: [
    { step: 0, ms: 100 },
    { step: 2, ms: 900 },
    { step: null, ms: 1500 },
  ],
} as never;
const target = (format: "mp4" | "gif") =>
  ({ format, width: 800, height: 450, fps: 15 }) as never;
const base = {
  scene: readonlyScene(),
  bundle: {
    keyframes: [],
    motionSpans: [],
    degradations: [],
  } as unknown as FrameBundle,
  frames: {} as never,
  logo: null,
  wallpaper: null,
};

// The page's canvas, recorded: what the scaler draws and at what width.
const drawn: { width: number; height: number; from: number }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  drawn.length = 0;
  composeForTarget.mockReturnValue({
    violations: [],
    presentation: { frameRect: { width: 100 } },
    resolved: { cameraKeys: [] },
  });
  renderScreens.mockResolvedValue({
    screens,
    images: [
      { step: 0, bytes: new Uint8Array([0]) },
      { step: 2, bytes: new Uint8Array([2]) },
      { step: null, bytes: new Uint8Array([9]) },
    ],
    detailViolations: [],
    unavailableSpans: [],
  });
  renderScene.mockResolvedValue({
    bytes: new Uint8Array([1]),
    detailViolations: [],
    unavailableSpans: [],
    loweredZooms: [],
    clampedRanges: [],
    deepestScale: 1,
    screens,
  });
  vi.stubGlobal("createImageBitmap", async () => ({
    width: 2560,
    height: 1440,
    close() {},
  }));
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return {
          drawImage: (img: { width: number }) =>
            drawn.push({
              width: this.width,
              height: this.height,
              from: img.width,
            }),
        };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([this.width & 255])]);
      }
    },
  );
});

describe("screenImageName", () => {
  it("names a step and the final screen", () => {
    expect(screenImageName(null)).toBe("final.png");
    expect(screenImageName(3)).toBe("step-3.png");
  });
});

describe("renderOutput with screensOnly", () => {
  // Red if the names do not follow the moments, or the images are not scaled
  // to the width asked (2560 drawn onto 1280).
  it("returns one scaled image per moment, named by its step", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "mp4",
      target: target("mp4"),
      screensOnly: { width: 1280 },
    });
    expect(out.facts.screens?.moments.map((m) => m.step)).toEqual([0, 2, null]);
    expect(out.files.map((f) => f.name)).toEqual([
      "step-0.png",
      "step-2.png",
      "final.png",
    ]);
    expect(drawn).toEqual(
      [0, 1, 2].map(() => ({ width: 1280, height: 720, from: 2560 })),
    );
    expect(renderScene).not.toHaveBeenCalled();
    // rendered is the output target's own size, not the image width.
    expect(out.facts.rendered).toEqual({ width: 800, height: 450, fps: 15 });
  });

  it("reports the same screens as the full render", async () => {
    const full = await renderOutput({
      ...base,
      fileType: "gif",
      target: target("gif"),
    });
    const only = await renderOutput({
      ...base,
      fileType: "gif",
      target: target("gif"),
      screensOnly: { width: 1280 },
    });
    expect(full.facts.screens?.moments.length).toBe(3);
    expect(only.facts.screens).toEqual(full.facts.screens);
  });

  it("refuses stills", async () => {
    await expect(
      renderOutput({
        ...base,
        fileType: "stills",
        target: target("mp4"),
        screensOnly: { width: 1280 },
      }),
    ).rejects.toThrow(
      "screensOnly applies to an mp4 or gif output, not stills",
    );
    expect(renderScreens).not.toHaveBeenCalled();
  });

  it("says a logo that could not load was left out", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "mp4",
      target: target("mp4"),
      logo: { ok: false, error: "acme.svg is not an SVG" },
      screensOnly: { width: 1280 },
    });
    expect(renderScreens.mock.calls[0]?.[0].logo).toBeNull();
    expect(out.facts.logoWarning).toBe(
      "The logo was left out: acme.svg is not an SVG",
    );
  });
});
