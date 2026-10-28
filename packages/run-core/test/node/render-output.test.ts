import type { FrameBundle } from "@demoman/compositor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../compositor/test/fixtures/scene";

const sinks = vi.hoisted(() => ({
  mp4: vi.fn(() => ({ kind: "mp4" })),
  gif: vi.fn(() => ({ kind: "gif" })),
  png: vi.fn(() => ({ kind: "png" })),
}));
const facts = {
  detailViolations: [],
  unavailableSpans: [{ ref: "span-7", reason: "could not decode" }],
  loweredZooms: [],
  clampedRanges: [],
};
const renderScene = vi.hoisted(() => vi.fn());
const renderStills = vi.hoisted(() => vi.fn());
const composeForTarget = vi.hoisted(() => vi.fn());
vi.mock("@demoman/compositor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@demoman/compositor")>()),
  createOffscreenSurface: () => ({}),
  createMp4Sink: sinks.mp4,
  createGifSink: sinks.gif,
  createPngSink: sinks.png,
  renderScene,
  renderStills,
  composeForTarget,
}));

const { renderOutput, RECLAIMED_SPAN_REASON } = await import(
  "../../src/render/output"
);

const scene = readonlyScene();
const bundle = (degradations: FrameBundle["degradations"] = []) =>
  ({ keyframes: [], motionSpans: [], degradations }) as unknown as FrameBundle;
const target = (format: "mp4" | "gif" | "png") =>
  ({ format, width: 800, height: 450, fps: 15 }) as never;
const base = { scene, frames: {} as never, logo: null, wallpaper: null };

beforeEach(() => {
  vi.clearAllMocks();
  // Every width keeps every zoom unless a case says otherwise.
  composeForTarget.mockReturnValue({
    violations: [],
    presentation: { frameRect: { width: 100 } },
    resolved: { cameraKeys: [] },
  });
  renderScene.mockResolvedValue({ bytes: new Uint8Array([1, 2]), ...facts });
  renderStills.mockResolvedValue({
    files: [
      { name: "act-1.png", bytes: new Uint8Array([3]) },
      { name: "act-2.png", bytes: new Uint8Array([4]) },
    ],
    unplacedStills: [{ actionId: "act-3", reason: "cut" }],
    ...facts,
  });
});

describe("renderOutput", () => {
  // Red if gif is routed to the mp4 sink (the CLI's render before D1).
  it("renders a gif through the gif sink, one unnamed file", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "gif",
      target: target("gif"),
      bundle: bundle(),
    });
    expect(sinks.gif).toHaveBeenCalledTimes(1);
    expect(sinks.mp4).not.toHaveBeenCalled();
    expect(renderScene.mock.calls[0]?.[0].ports.gif).toEqual({ kind: "gif" });
    expect(out.files).toEqual([{ name: null, bytes: new Uint8Array([1, 2]) }]);
  });

  it("renders mp4 through the mp4 sink", async () => {
    await renderOutput({
      ...base,
      fileType: "mp4",
      target: target("mp4"),
      bundle: bundle(),
    });
    expect(sinks.mp4).toHaveBeenCalledTimes(1);
    expect(renderStills).not.toHaveBeenCalled();
  });

  // Red if stills go through renderScene, or lose their per-step names.
  it("renders stills through renderStills, keeping each step's name and facts", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "stills",
      target: target("png"),
      bundle: bundle(),
    });
    expect(renderScene).not.toHaveBeenCalled();
    expect(out.files.map((f) => f.name)).toEqual(["act-1.png", "act-2.png"]);
    expect(out.facts.unplacedStills).toEqual([
      { actionId: "act-3", reason: "cut" },
    ]);
  });

  it("adds the bundle's reclaimed ranges after the frame source's own", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "mp4",
      target: target("mp4"),
      bundle: bundle([
        { kind: "motionReclaimed", startMs: 100, endMs: 900 } as never,
      ]),
    });
    expect(out.facts.unavailableSpans).toEqual([
      { ref: "span-7", reason: "could not decode" },
      { ref: "100-900ms", reason: RECLAIMED_SPAN_REASON },
    ]);
  });

  // Review Focus 5. Red if a logo that will not load fails the render.
  it("renders without a logo that could not be loaded, and says so", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "gif",
      target: target("gif"),
      bundle: bundle(),
      logo: { ok: false, error: "acme.svg is not an SVG" },
    });
    expect(renderScene.mock.calls[0]?.[0].logo).toBeNull();
    expect(out.facts.logoWarning).toBe(
      "The logo was left out: acme.svg is not an SVG",
    );
  });

  it("renders without a logo that will not rasterise, and says so", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "mp4",
      target: target("mp4"),
      bundle: bundle(),
      logo: {
        ok: true,
        source: {
          rasterAt: async () => {
            throw new Error("bad svg");
          },
        } as never,
      },
    });
    expect(out.facts.logoWarning).toBe("The logo was left out: bad svg");
  });

  it("has no logo warning when there is no logo", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "mp4",
      target: target("mp4"),
      bundle: bundle(),
    });
    expect(out.facts.logoWarning).toBeNull();
  });
});

describe("wholePercent", () => {
  it("reports each whole percent once, and always the last frame", async () => {
    const { wholePercent } = await import("../../src/render/output");
    const seen: number[] = [];
    const tick = wholePercent((done) => void seen.push(done));
    for (let done = 1; done <= 300; done++) tick(done, 300);
    // 0% (frame 1) through 100%: 101 states, as the bar can show.
    expect(seen.length).toBe(101);
    expect(seen[0]).toBe(1);
    expect(seen.at(-1)).toBe(300);
  });

  // Red if a capped MP4's next render, at the same width and percent, is
  // swallowed as a repeat, or loses which render it is.
  it("says a new render's first frame, whatever its percent, with its render", async () => {
    const { wholePercent } = await import("../../src/render/output");
    const seen: unknown[] = [];
    const tick = wholePercent((...args: unknown[]) => void seen.push(args));
    tick(1, 1000, 1920, { render: 1, upTo: 2 });
    tick(2, 1000, 1920, { render: 1, upTo: 2 });
    tick(1, 1000, 1920, { render: 2, upTo: 2 });
    expect(seen).toEqual([
      [1, 1000, 1920, { render: 1, upTo: 2 }],
      [1, 1000, 1920, { render: 2, upTo: 2 }],
    ]);
  });
});

const { GifOverBudgetError } = await import("@demoman/compositor");

describe("renderOutput's GIF size budget", () => {
  const gifTarget = {
    format: "gif",
    width: 800,
    height: 450,
    fps: 15,
    bitrate: 0,
    cornerRadius: 10,
    fit: "contain",
  } as const;
  const widths = () =>
    renderScene.mock.calls.map((c) => [c[0].target.width, c[0].target.height]);
  const refuseAt = (...refused: number[]) =>
    renderScene.mockImplementation(
      async (args: { target: { width: number } }) => {
        if (refused.includes(args.target.width)) {
          throw new GifOverBudgetError(100, 150);
        }
        return { bytes: new Uint8Array([1, 2]), ...facts };
      },
    );
  const withBudget = () =>
    renderOutput({
      ...base,
      fileType: "gif",
      target: gifTarget,
      bundle: bundle(),
      gifBudget: { maxBytes: 100 },
    });

  // Red if the ladder starts at the target (the 800 px GIF that looked soft
  // on a Retina screen, 2026-10-16).
  it("renders at twice the target when that fits, and says what it rendered", async () => {
    const out = await withBudget();
    expect(widths()).toEqual([[1600, 900]]);
    expect(renderScene.mock.calls[0]?.[0].target.cornerRadius).toBe(20);
    expect(sinks.gif).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1600 }),
      { maxBytes: 100 },
    );
    expect(out.facts.rendered).toEqual({ width: 1600, height: 900, fps: 15 });
    expect(out.facts.gifBudget).toEqual({
      maxBytes: 100,
      byteLength: 2,
      refused: [],
    });
  });

  // Red if a width over budget is kept, or skipped without being said.
  it("steps down a width at a time while the GIF is over budget", async () => {
    refuseAt(1600, 1200);
    const out = await withBudget();
    expect(widths()).toEqual([
      [1600, 900],
      [1200, 675],
      [800, 450],
    ]);
    // The narrowest has nowhere left to go: it renders whole, unbudgeted.
    expect(sinks.gif.mock.calls.at(-1)).toEqual([
      expect.objectContaining({ width: 800 }),
      {},
    ]);
    expect(out.facts.rendered).toEqual({ width: 800, height: 450, fps: 15 });
    expect(out.facts.gifBudget?.refused).toEqual([
      { width: 1600, height: 900, limit: "budget" },
      { width: 1200, height: 675, limit: "budget" },
    ]);
    expect(out.files).toHaveLength(1);
  });

  // Red if a file still over budget at the narrowest width reports nothing.
  it("keeps the narrowest file even over budget, with its size", async () => {
    refuseAt(1600, 1200);
    renderScene.mockImplementation(
      async (args: { target: { width: number } }) => {
        if (args.target.width > 800) throw new GifOverBudgetError(100, 150);
        return { bytes: new Uint8Array(250), ...facts };
      },
    );
    const out = await withBudget();
    expect(out.facts.gifBudget?.byteLength).toBe(250);
    expect(out.files[0]?.bytes.byteLength).toBe(250);
  });

  // Red if the ladder catches every failure as "too big".
  it("lets any other failure through on the first width", async () => {
    renderScene.mockRejectedValue(new Error("the decoder died"));
    await expect(withBudget()).rejects.toThrow("the decoder died");
    expect(widths()).toEqual([[1600, 900]]);
  });

  // Red if a span the frame source could not serve is counted once per width
  // tried: the source is shared, and a failed decode is reported each pass.
  it("names each unavailable span once, however many widths were tried", async () => {
    refuseAt(1600);
    renderScene.mockImplementation(
      async (args: { target: { width: number } }) => {
        if (args.target.width === 1600) throw new GifOverBudgetError(100, 150);
        return {
          bytes: new Uint8Array([1]),
          ...facts,
          unavailableSpans: [
            { ref: "span-7", reason: "could not decode" },
            { ref: "span-7", reason: "could not decode" },
          ],
        };
      },
    );
    const out = await withBudget();
    expect(out.facts.unavailableSpans).toEqual([
      { ref: "span-7", reason: "could not decode" },
    ]);
  });

  // Red if a GIF renders wider than its recording can back: on a take filmed
  // at DPR 1 the wide width held a 2.2x zoom near 1x (runner, 2026-10-16).
  it("skips a width that would hold a zoom lower than the target does", async () => {
    const held = {
      outputTimeMs: 2000,
      requestedScale: 2.2,
      grantedScale: 1.1,
      sourceWidth: 1280,
      neededWidth: 1280,
    };
    composeForTarget.mockImplementation(
      (args: { target: { width: number } }) => ({
        violations: args.target.width > 800 ? [held] : [],
        presentation: { frameRect: { width: 100 } },
      }),
    );
    const out = await withBudget();
    // Never rendered: the composition alone says what the width would cost.
    expect(widths()).toEqual([[800, 450]]);
    expect(out.facts.rendered.width).toBe(800);
    expect(out.facts.gifBudget?.refused).toEqual([
      { width: 1600, height: 900, limit: "detail" },
      { width: 1200, height: 675, limit: "detail" },
    ]);
  });

  // Red if the comparison is "no violations at all": a take whose zooms the
  // target's own width already holds would never get a wider GIF.
  it("allows a width that costs no more than the target already does", async () => {
    const held = {
      outputTimeMs: 2000,
      requestedScale: 2.2,
      grantedScale: 1.6,
      sourceWidth: 2560,
      neededWidth: 2560,
    };
    composeForTarget.mockReturnValue({
      violations: [held],
      presentation: { frameRect: { width: 100 } },
    });
    const out = await withBudget();
    expect(widths()).toEqual([[1600, 900]]);
    expect(out.facts.gifBudget?.refused).toEqual([]);
  });

  // Red if a width draws the page wider than the recording, zoom or no
  // zoom: the detail violations only cover zooms, and a 1280 px take at
  // DPR 1 came out 1600 px wide, stretched (runner, 2026-10-16).
  it("skips a width whose window is wider than the keyframes", async () => {
    // The window takes seven eighths of the frame's width.
    composeForTarget.mockImplementation(
      (args: { target: { width: number } }) => ({
        violations: [],
        presentation: { frameRect: { width: args.target.width * 0.875 } },
      }),
    );
    const out = await renderOutput({
      ...base,
      fileType: "gif",
      target: gifTarget,
      bundle: {
        keyframes: [{ width: 1280, height: 800 }],
        motionSpans: [],
        degradations: [],
      } as unknown as FrameBundle,
      gifBudget: { maxBytes: 100 },
    });
    // 1600 draws the window 1400 px wide from 1280; 1200 draws it 1050.
    expect(widths()).toEqual([[1200, 675]]);
    expect(out.facts.gifBudget?.refused).toEqual([
      { width: 1600, height: 900, limit: "detail" },
    ]);
  });

  // Red if the check reads keyframes alone: motion spans follow the
  // display's DPR, keyframes the replay's, so on a DPR-1 display the moving
  // frames are a third of the keyframes' width (review, 2026-10-16).
  it("measures the window against the motion spans, not the keyframes alone", async () => {
    composeForTarget.mockImplementation(
      (args: { target: { width: number } }) => ({
        violations: [],
        presentation: { frameRect: { width: args.target.width * 0.875 } },
      }),
    );
    const out = await renderOutput({
      ...base,
      fileType: "gif",
      target: gifTarget,
      bundle: {
        keyframes: [{ width: 3840, height: 2400 }],
        motionSpans: [{ ref: "span-1", width: 1280, height: 800 }],
        degradations: [],
      } as unknown as FrameBundle,
      gifBudget: { maxBytes: 100 },
    });
    // 1600 draws the window 1400 px wide from 1280 px spans; 1200, 1050.
    expect(widths()).toEqual([[1200, 675]]);
    expect(out.facts.gifBudget?.refused).toEqual([
      { width: 1600, height: 900, limit: "detail" },
    ]);
  });

  // Red if progress restarts at 0 with nothing to say a narrower width began.
  it("says which width each frame of progress belongs to", async () => {
    renderScene.mockImplementation(
      async (args: {
        target: { width: number };
        onFrame?: (d: number, t: number) => void;
      }) => {
        args.onFrame?.(5, 10);
        if (args.target.width === 1600) throw new GifOverBudgetError(100, 150);
        return { bytes: new Uint8Array([1]), ...facts };
      },
    );
    const seen: unknown[] = [];
    await renderOutput({
      ...base,
      fileType: "gif",
      target: gifTarget,
      bundle: bundle(),
      gifBudget: { maxBytes: 100 },
      onFrame: (...args: unknown[]) => seen.push(args),
    });
    expect(seen).toEqual([
      [5, 10, 1600],
      [5, 10, 1200],
    ]);
  });

  // Red if the extension's door (no budget) changes size.
  it("renders the target as given when no budget is passed", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "gif",
      target: gifTarget,
      bundle: bundle(),
    });
    expect(widths()).toEqual([[800, 450]]);
    expect(sinks.gif).toHaveBeenCalledWith(
      expect.objectContaining({ width: 800 }),
      {},
    );
    expect(out.facts.rendered).toEqual({ width: 800, height: 450, fps: 15 });
    expect(out.facts.gifBudget).toBeUndefined();
  });
});

const { LANDSCAPE_4K, SHARE_LANDSCAPE } = await import("@demoman/compositor");
describe("renderOutput's MP4 size cap", () => {
  /** Bytes per render, keyed by what the ladder lowers: the frame rate,
   *  the frame's width, and the encoder's quality. */
  const sizes = (bySpec: Record<string, number>) =>
    renderScene.mockImplementation(
      async (args: {
        target: { width: number; fps: number; encoder?: { quality?: number } };
      }) => {
        const t = args.target;
        const key = `${t.width}@${t.fps}${t.encoder?.quality === undefined ? "" : `q${t.encoder.quality}`}`;
        const n = bySpec[key];
        if (n === undefined) throw new Error(`no size for ${key}`);
        // Each render's facts name it, so a case can tell whose facts the
        // output carries.
        return {
          bytes: new Uint8Array(n),
          ...facts,
          loweredZooms: [{ from: key }],
          detailViolations: [{ from: key }],
        };
      },
    );
  const rendersAt = () =>
    renderScene.mock.calls.map((c) => {
      const t = c[0].target;
      return [t.width, t.height, t.fps, t.encoder?.quality ?? null];
    });
  const capped = (maxBytes: number, extra: object = {}) =>
    renderOutput({
      ...base,
      fileType: "mp4",
      target: LANDSCAPE_4K,
      bundle: bundle(),
      mp4Cap: { maxBytes, share: SHARE_LANDSCAPE },
      ...extra,
    });

  // Red if a cap that fit first time renders again or names a step.
  it("a file that fits at the first render is kept, with no steps", async () => {
    sizes({ "3840@60": 90 });
    const out = await capped(100);
    expect(rendersAt()).toEqual([[3840, 2160, 60, null]]);
    expect(out.facts.videoCap).toEqual({
      maxBytes: 100,
      met: true,
      steps: [],
      keptQuality: null,
    });
    expect(out.files[0]?.bytes.byteLength).toBe(90);
  });

  // Red if the ladder lowers more than it must, or keeps a file over the cap
  // when a later one fit.
  it("steps down while over, stops at the first that fits, and names each step", async () => {
    sizes({ "3840@60": 300, "3840@30": 150, "1920@30q0.5": 80 });
    const out = await capped(100);
    expect(rendersAt()).toEqual([
      [3840, 2160, 60, null],
      [3840, 2160, 30, null],
      [1920, 1080, 30, 0.5],
    ]);
    expect(out.facts.videoCap).toEqual({
      maxBytes: 100,
      met: true,
      steps: [
        { kind: "fps", from: 60, to: 30 },
        {
          kind: "share",
          from: { width: 3840, height: 2160 },
          to: { width: 1920, height: 1080 },
          quality: 0.5,
        },
      ],
      keptQuality: 0.5,
    });
    expect(out.facts.rendered).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(out.files[0]?.bytes.byteLength).toBe(80);
    // The sink was built for the target each render ran at.
    expect(sinks.mp4.mock.calls.map((c) => (c as unknown[])[0])).toEqual(
      renderScene.mock.calls.map((c) => c[0].target),
    );
  });

  // Red if a cap that cannot be met loops, fails the render, or keeps the
  // last file rather than the smallest.
  it("still over after the last step: four renders, the smallest kept, met false", async () => {
    sizes({
      "3840@60": 400,
      "3840@30": 300,
      "1920@30q0.5": 150,
      "1920@30q0.35": 160,
    });
    const out = await capped(100);
    expect(renderScene).toHaveBeenCalledTimes(4);
    expect(out.facts.videoCap?.met).toBe(false);
    expect(out.facts.videoCap?.steps.map((s) => s.kind)).toEqual([
      "fps",
      "share",
      "quality",
    ]);
    // The smallest is the share render, not the last: the facts name it.
    expect(out.files[0]?.bytes.byteLength).toBe(150);
    expect(out.facts.rendered).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(out.facts.videoCap?.keptQuality).toBe(0.5);
  });

  // Red if the warnings come from the last render (or the first) rather
  // than the one whose file was kept: they describe a different video.
  it("the warnings are the kept render's", async () => {
    sizes({
      "3840@60": 400,
      "3840@30": 300,
      "1920@30q0.5": 150,
      "1920@30q0.35": 160,
    });
    const out = await capped(100);
    // The premise: four renders, each saying something different.
    const said = await Promise.all(
      renderScene.mock.results.map(async (r) =>
        JSON.stringify(
          (await (r.value as Promise<{ loweredZooms: unknown }>)).loweredZooms,
        ),
      ),
    );
    expect(new Set(said).size, said.join(" ")).toBe(4);
    expect(out.facts.loweredZooms).toEqual([{ from: "1920@30q0.5" }]);
    expect(out.facts.detailViolations).toEqual([{ from: "1920@30q0.5" }]);
  });

  // Ruling (2026-10-18): a later rung that throws must not cost the file an
  // earlier one made. Red if the throw escapes (renderFailed), or the
  // failure is kept quiet.
  it("a later rung that throws keeps the smallest file so far, and says which rung failed", async () => {
    sizes({ "3840@60": 400 });
    renderScene
      .mockImplementationOnce(async () => ({
        bytes: new Uint8Array(400),
        ...facts,
      }))
      .mockImplementationOnce(async () => {
        throw new Error("the encoder died.");
      });
    const out = await capped(100);
    expect(renderScene).toHaveBeenCalledTimes(2);
    expect(out.files[0]?.bytes.byteLength).toBe(400);
    expect(out.facts.rendered).toEqual({ width: 3840, height: 2160, fps: 60 });
    expect(out.facts.videoCap).toEqual({
      maxBytes: 100,
      met: false,
      steps: [],
      keptQuality: null,
      failed: {
        step: { kind: "fps", from: 60, to: 30 },
        error: "the encoder died.",
      },
    });
  });

  // Red if the first render's failure is forgiven: there is no file then.
  it("a first render that throws is still a failed render", async () => {
    renderScene.mockRejectedValue(new Error("the decoder died"));
    await expect(capped(100)).rejects.toThrow("the decoder died");
    expect(renderScene).toHaveBeenCalledTimes(1);
  });

  // Red if a re-render's progress reads as the same render going back:
  // the fps step and the quality step keep the width, so the width alone
  // cannot tell two renders apart (review, 2026-10-18).
  const progressOf = async (
    target: typeof LANDSCAPE_4K,
    big: (t: { fps: number; encoder?: { quality?: number } }) => boolean,
  ) => {
    renderScene.mockImplementation(
      async (args: {
        target: { fps: number; encoder?: { quality?: number } };
        onFrame?: (d: number, t: number) => void;
      }) => {
        args.onFrame?.(5, 10);
        return {
          bytes: new Uint8Array(big(args.target) ? 300 : 80),
          ...facts,
        };
      },
    );
    const seen: unknown[] = [];
    await renderOutput({
      ...base,
      fileType: "mp4",
      target,
      bundle: bundle(),
      mp4Cap: { maxBytes: 100, share: SHARE_LANDSCAPE },
      onFrame: (...args: unknown[]) => seen.push(args),
    });
    return seen;
  };

  it("says which render each frame of progress belongs to, out of how many it may take", async () => {
    const seen = await progressOf(LANDSCAPE_4K, (t) => t.fps === 60);
    expect(seen).toEqual([
      [5, 10, 3840, { render: 1, upTo: 4 }],
      [5, 10, 3840, { render: 2, upTo: 4 }],
    ]);
  });

  // From the share default the quality step is the only one, and keeps
  // both the width and the frame rate.
  it("tells the share default's two renders apart", async () => {
    const seen = await progressOf(
      SHARE_LANDSCAPE,
      (t) => t.encoder?.quality === 0.5,
    );
    expect(seen).toEqual([
      [5, 10, 1920, { render: 1, upTo: 2 }],
      [5, 10, 1920, { render: 2, upTo: 2 }],
    ]);
  });

  // Red if the extension's door (no cap) renders more than once or reports
  // a cap it never asked for.
  it("renders once and reports no cap without one", async () => {
    sizes({ "3840@60": 900 });
    const out = await renderOutput({
      ...base,
      fileType: "mp4",
      target: LANDSCAPE_4K,
      bundle: bundle(),
    });
    expect(renderScene).toHaveBeenCalledTimes(1);
    expect(out.facts.videoCap).toBeUndefined();
  });
});

describe("renderOutput's stills size and framing", () => {
  const stillTarget = {
    format: "png",
    width: 2560,
    height: 1440,
    fps: 0,
    bitrate: 0,
    cornerRadius: 24,
    fit: "contain",
  } as const;
  // The window takes seven eighths of the frame's width: 2240 at 2560.
  beforeEach(() => {
    composeForTarget.mockImplementation(
      (args: { target: { width: number } }) => ({
        violations: [],
        presentation: { frameRect: { width: args.target.width * 0.875 } },
      }),
    );
  });
  const recordedAt = (width: number) =>
    ({
      keyframes: [{ width, height: Math.round(width * 0.66) }],
      motionSpans: [],
      degradations: [],
    }) as unknown as FrameBundle;
  const stillsOf = (
    recorded: number,
    stills?: { width?: number | "native"; zoom?: "none" | "step" },
  ) =>
    renderOutput({
      ...base,
      fileType: "stills",
      target: stillTarget,
      bundle: recordedAt(recorded),
      ...(stills === undefined ? {} : { stills }),
    });
  const asked = () => renderStills.mock.calls[0]?.[0];

  // Red if the default stretches a narrow recording to fill the target:
  // a 1280 px take at DPR 1 was drawn 2240 px wide.
  it("by default draws the window no wider than the recording", async () => {
    const out = await stillsOf(1280, {});
    // 1280 / 2240 of the target.
    expect(asked()?.target.width).toBe(Math.round(2560 * (1280 / 2240)));
    expect(out.facts.rendered.width).toBe(asked()?.target.width);
  });

  it("by default keeps the target when the recording is wider", async () => {
    const out = await stillsOf(3420, {});
    expect(asked()?.target.width).toBe(2560);
    expect(out.facts.rendered).toEqual({ width: 2560, height: 1440, fps: 0 });
  });

  // Red if `native` is ignored or not capped.
  it("native draws the window at the recording's own size, up to 4K", async () => {
    await stillsOf(3000, { width: "native" });
    expect(asked()?.target.width).toBe(Math.round(2560 * (3000 / 2240)));
    renderStills.mockClear();
    await stillsOf(3420, { width: "native" });
    // 3420 / 2240 of 2560 is 3909: past 3840, so held there.
    expect(asked()?.target.width).toBe(3840);
    expect(asked()?.target.height).toBe(2160);
  });

  // Red if a width the cap cut is reported as the width asked for.
  it("says when the 4K cap cut the width asked for", async () => {
    const native = await stillsOf(3420, { width: "native" });
    expect(native.facts.stillsCapped).toEqual({ askedWidth: 3909 });
    const fits = await stillsOf(3420, { width: 1280 });
    expect(fits.facts.stillsCapped).toBeUndefined();
    const byDefault = await stillsOf(3420, {});
    expect(byDefault.facts.stillsCapped).toBeUndefined();
  });

  it("a width is that canvas width", async () => {
    await stillsOf(3420, { width: 1280 });
    expect(asked()?.target).toMatchObject({ width: 1280, height: 720 });
    expect(asked()?.target.cornerRadius).toBe(12);
  });

  // Red if the CLI's stills keep the video's mid-move camera.
  it("frames the whole window by default, and the step's zoom when asked", async () => {
    await stillsOf(3420, {});
    expect(asked()?.camera).toBe("none");
    renderStills.mockClear();
    await stillsOf(3420, { zoom: "step" });
    expect(asked()?.camera).toBe("step");
  });

  // Red if the extension's door (no stills options) changes size or framing.
  it("renders the target as given, framed as the video, with no options", async () => {
    const out = await stillsOf(1280);
    expect(asked()?.target.width).toBe(2560);
    expect(asked()?.camera).toBeUndefined();
    expect(out.facts.rendered.width).toBe(2560);
  });
});

describe("renderOutput's wallpaper", () => {
  const gifTarget = {
    format: "gif",
    width: 800,
    height: 450,
    fps: 15,
    bitrate: 0,
    cornerRadius: 10,
    fit: "contain",
  } as const;
  /** Node has no createImageBitmap: a stand-in that records each resize
   *  and answers a bitmap of that size. */
  const resized: { width: number; height: number; closed: boolean }[] = [];
  beforeEach(() => {
    resized.length = 0;
    vi.stubGlobal(
      "createImageBitmap",
      async (
        _source: unknown,
        o: { resizeWidth: number; resizeHeight: number },
      ) => {
        const made = {
          width: o.resizeWidth,
          height: o.resizeHeight,
          closed: false,
        };
        resized.push(made);
        return {
          ...made,
          close: () => {
            made.closed = true;
          },
        };
      },
    );
    return () => vi.unstubAllGlobals();
  });
  const decoded = (width: number, height: number) => ({
    ok: true as const,
    name: "vivid-1",
    image: { image: { master: true } as never, width, height, sourceTimeMs: 0 },
  });
  const drew = () =>
    renderScene.mock.calls.map((c) => {
      const w = c[0].wallpaper;
      return w === null ? null : [c[0].target.width, w.width, w.height];
    });

  // Ruling R1: every rung of the GIF ladder draws the image at its own
  // raster size. Red if the image is resized once for the manifest's target
  // or passed as decoded.
  it("rasterises the image per GIF rung, and frees each rung's raster", async () => {
    renderScene.mockImplementation(
      async (args: { target: { width: number } }) => {
        if (args.target.width === 1600) throw new GifOverBudgetError(100, 150);
        return { bytes: new Uint8Array([1]), ...facts, deepestScale: 1 };
      },
    );
    const out = await renderOutput({
      ...base,
      fileType: "gif",
      target: gifTarget,
      bundle: bundle(),
      gifBudget: { maxBytes: 100 },
      wallpaper: decoded(9600, 7200),
    });
    // 1600 wide covers at 1/6 of 9600, 2.5x that is 4000; 1200 wide, 3000.
    expect(drew()).toEqual([
      [1600, 4000, 3000],
      [1200, 3000, 2250],
    ]);
    expect(resized.every((r) => r.closed)).toBe(true);
    expect(out.facts.wallpaperWarning).toBeNull();
  });

  it("draws the decoded image itself when the target needs all of it", async () => {
    renderScene.mockResolvedValue({
      bytes: new Uint8Array([1]),
      ...facts,
      deepestScale: 2.5,
    });
    await renderOutput({
      ...base,
      fileType: "mp4",
      target: {
        ...gifTarget,
        format: "mp4",
        width: 3840,
        height: 2160,
      } as never,
      bundle: bundle(),
      wallpaper: decoded(9600, 7200),
    });
    expect(renderScene.mock.calls[0]?.[0].wallpaper.image).toEqual({
      master: true,
    });
    expect(resized).toEqual([]);
  });

  it("passes the image to stills, and frees their raster", async () => {
    await renderOutput({
      ...base,
      fileType: "stills",
      target: { ...gifTarget, format: "png" } as never,
      bundle: bundle(),
      wallpaper: decoded(9600, 7200),
    });
    const w = renderStills.mock.calls[0]?.[0].wallpaper;
    expect([w?.width, w?.height]).toEqual([2000, 1500]);
    expect(resized.map((r) => r.closed)).toEqual([true]);
  });

  // Report before you forgive. Red if the reason is dropped.
  it("renders the gradient for an image that could not be had, and says why", async () => {
    renderScene.mockResolvedValue({
      bytes: new Uint8Array([1]),
      ...facts,
      deepestScale: 1,
    });
    const out = await renderOutput({
      ...base,
      fileType: "mp4",
      target: { ...gifTarget, format: "mp4" } as never,
      bundle: bundle(),
      wallpaper: {
        ok: false,
        error: "/h/assets/gone.webp could not be read (ENOENT)",
      },
    });
    expect(renderScene.mock.calls[0]?.[0].wallpaper).toBeNull();
    expect(out.facts.wallpaperWarning).toBe(
      "The wallpaper was left out: /h/assets/gone.webp could not be read (ENOENT); the video uses the plain gradient.",
    );
  });

  // Red if the warning ignores the render's own deepest zoom: 1600x1200
  // covers 800x450 at zoom 1 (800x600) and not at 2.5 (2000x1500).
  it("says an image too small for the deepest zoom will look soft, and only then", async () => {
    const at = (deepestScale: number) => {
      renderScene.mockResolvedValue({
        bytes: new Uint8Array([1]),
        ...facts,
        deepestScale,
      });
      return renderOutput({
        ...base,
        fileType: "mp4",
        target: { ...gifTarget, format: "mp4" } as never,
        bundle: bundle(),
        wallpaper: { ...decoded(1600, 1200), name: "/h/assets/small.webp" },
      });
    };
    expect((await at(1)).facts.wallpaperWarning).toBeNull();
    expect((await at(2.5)).facts.wallpaperWarning).toBe(
      'The wallpaper "/h/assets/small.webp" is 1600×1200, smaller than this export\'s deepest zoom needs (2000×1500), so it will look soft.',
    );
  });

  it("has no wallpaper warning without a wallpaper", async () => {
    const out = await renderOutput({
      ...base,
      fileType: "mp4",
      target: { ...gifTarget, format: "mp4" } as never,
      bundle: bundle(),
    });
    expect(renderScene.mock.calls[0]?.[0].wallpaper).toBeNull();
    expect(out.facts.wallpaperWarning).toBeNull();
  });
});
