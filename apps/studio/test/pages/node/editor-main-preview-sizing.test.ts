import { madeFromOf, type RenderTarget } from "@demoman/compositor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { frameOf, targetFor } from "../../../pages/src/editor/jobs";
import { PREVIEW_HEIGHT } from "../../../pages/src/editor/preview";
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
 * The preview bitmap's size, as `main.ts` moves it between play, pause and
 * a resized stage — and what an in-flight draw does when it moves.
 *
 * `editor-main-transport.test.ts` covers the play/pause split itself. This
 * file drives the two things that lane cannot: the stage's resize observer
 * (the shared jsdom stub is inert by design, so it is replaced per test
 * here) and a draw held open across a re-target.
 */

/** Its context names it, so a draw's `ctx` says which bitmap it composed. */
class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(): { canvas: FakeOffscreenCanvas } {
    return { canvas: this };
  }
}

const composeCalls = vi.hoisted(() => [] as RenderTarget[]);
/** The target each composition's zoom clamp measured against. */
const detailCalls = vi.hoisted(() => [] as Array<RenderTarget | undefined>);

/**
 * The draw's side of the compositor. `composeMs` makes a draw succeed and
 * cost something (see the transport lane's `drawCost` for why it spins);
 * `gate`, when set, holds the draw inside `renderFrame` until released;
 * `composedInto` is every bitmap a draw actually composed a frame into.
 */
const draws = vi.hoisted(() => ({
  composeMs: 0,
  gate: null as Promise<void> | null,
  reachedGate: 0,
  composedInto: new Set<unknown>(),
}));

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    composeForTarget: (args: Parameters<typeof actual.composeForTarget>[0]) => {
      composeCalls.push(args.target);
      detailCalls.push(args.detailTarget);
      return actual.composeForTarget(args);
    },
    renderFrame: async (args: Parameters<typeof actual.renderFrame>[0]) => {
      if (draws.composeMs <= 0) return actual.renderFrame(args);
      if (draws.gate) {
        draws.reachedGate += 1;
        await draws.gate;
      }
      const until = performance.now() + draws.composeMs;
      while (performance.now() < until) {
        // Spin.
      }
      draws.composedInto.add(
        (args.ctx as unknown as { canvas: unknown }).canvas,
      );
    },
    // The frame refusal below is for the DRAW. Real motion detection reads
    // frames too, so every case with a bundle also failed the hover check and
    // ran under its banner. Neither is what this file measures. Plain
    // functions, so the `restoreAllMocks` in teardown has nothing to strip.
    detectKeyframeMotion: async () => [],
    hoverVerdicts: async () => [],
  };
});

const playButton = (): HTMLButtonElement =>
  document.querySelector("[data-transport-play]") as HTMLButtonElement;

const pressKey = (key: string): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
};

/** Paints `#stage-frame` `width` CSS pixels wide at 16:9. */
function paintFrame(width: number): void {
  const frame = document.getElementById("stage-frame") as HTMLElement;
  const height = (width * 9) / 16;
  frame.getBoundingClientRect = () =>
    ({
      width,
      height,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("editor main — preview sizing", () => {
  // The editor reports through `console.error`; anything on it is a path
  // this file did not mean to run. jsdom's own "Not implemented" is
  // excepted: a draw that succeeded is blitted onto a canvas jsdom has no
  // 2D context for, and that is jsdom naming its gap, not the editor.
  let reported: ReturnType<typeof vi.spyOn>;
  let memory: MemoryPlatform;
  let frames: Array<() => void>;
  /** Every callback `main.ts` handed a ResizeObserver. */
  let observers: ResizeObserverCallback[];

  /** Fires every observer, as a layout pass would. */
  const fireResize = (): void => {
    for (const callback of observers) callback([], {} as ResizeObserver);
  };

  async function pump(): Promise<void> {
    const due = frames;
    frames = [];
    for (const fn of due) fn();
    await Promise.resolve();
    await Promise.resolve();
  }

  async function booted(): Promise<void> {
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!playButton() || playButton().disabled) {
        throw new Error("transport not ready");
      }
      if (composeCalls.length === 0) throw new Error("nothing composed yet");
    });
  }

  beforeEach(() => {
    vi.resetModules();
    reported = vi.spyOn(console, "error");
    editorDom();
    composeCalls.length = 0;
    detailCalls.length = 0;
    draws.composeMs = 0;
    draws.gate = null;
    draws.reachedGate = 0;
    draws.composedInto.clear();
    frames = [];
    observers = [];
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal("devicePixelRatio", 2);
    paintFrame(1168);
    memory = createMemoryPlatform();
    state.memory = memory;
    // The deliverable these sizes are measured against is the full-quality
    // one, a choice the studio's Settings offer (its default is "share").
    memory.answer("exportQuality.read", async () => ({ quality: "full" }));
    // A frame reads only when the test has given drawing a cost, as the
    // frame store this file mocked in apps/extension did.
    memory.answer("bundles.load", async () => {
      if (draws.composeMs > 0) return new Uint8Array([0]);
      throw new Error("no frame is read in this test");
    });
    memory.serveScene(() => readonlyScene());
    // No motion spans: the video source needs WebCodecs, which this lane
    // has not got.
    // `madeFrom` matches `readonlyScene()`, the fixed `scene:get` reply
    // below — so the frames read as verifiable and the `afterEach`
    // console guard this file's tests share sees the approximations path
    // (not what any of them test) stay silent.
    memory.serveBundle(
      proceduralBundle({
        motionSpans: [],
        madeFrom: madeFromOf(readonlyScene()),
      }),
      null,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    const said = reported.mock.calls
      .map((c) => c.map(String).join(" "))
      .filter((line) => !line.startsWith("Not implemented: HTMLCanvasElement"));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    expect(said).toEqual([]);
  });

  /**
   * The observer's first fire lands before `session.load()` answers, and a
   * render then reads the placeholder scene and throws — uncaught, onto
   * chrome://extensions' Errors list. Verified failable: dropping the
   * `if (!loaded) return` guard throws `Cannot read properties of undefined`
   * out of `advanceTimersByTime` below.
   */
  it("does not render from a resize before the take has loaded", async () => {
    // A load that never answers: the page sits on the placeholder.
    memory.answer("scenes.get", () => new Promise(() => undefined));
    await import("../../../pages/entrypoints/editor/main");
    // Premise: the observer exists and the take has not loaded.
    expect(observers.length).toBeGreaterThan(0);
    expect(composeCalls).toEqual([]);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // A DPR-2 box 1168 wide wants 1314 rows — not the 720 the page booted on,
    // so an unguarded observer would render.
    expect(() => {
      fireResize();
      vi.advanceTimersByTime(1000);
    }).not.toThrow();
    expect(composeCalls).toEqual([]);
  });

  /**
   * A window drag moves the parked height a pixel or two per frame, and each
   * move was a full recompose (and a blanked canvas). It now waits for the
   * stage to hold still. Verified failable: rendering straight from the
   * observer, as before, composes once per fire and fails the first count.
   */
  /**
   * Final review, Important (2026-10-06), reproduced with a real mouse in
   * Chrome: under Auto the frame's shape follows the padding, so a Padding
   * drag reshapes `#stage-frame`, the observer settles, and its `render()`
   * rebuilt the Background panel from the STORED branding — detaching the
   * slider under the pointer. The drag died wherever the author paused, and
   * nothing committed. Red if the settled observer renders the panels while
   * a panel preview is live.
   */
  /** An Auto take booted with the Background panel open: its Padding
   *  slider, which under Auto reshapes the frame. */
  async function autoPaddingSlider(): Promise<HTMLInputElement> {
    // Draws that succeed. This lane's draws fail by default (no frame is
    // read), and a failed draw renders the panels to say so — which would
    // rebuild the slider for a reason none of these tests are about.
    draws.composeMs = 1;
    const auto = { ...readonlyScene(), canvas: { aspect: "auto" as const } };
    memory.serveScene(() => auto);
    memory.serveBundle(
      proceduralBundle({
        motionSpans: [],
        madeFrom: madeFromOf(auto),
      }),
      null,
    );
    await booted();
    (
      document.querySelector('#rail [data-rail="background"]') as HTMLElement
    ).click();
    return vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>("[data-padding]");
      if (!node) throw new Error("no Padding slider yet");
      return node;
    });
  }

  it("keeps the Padding slider under the pointer when the stage settles mid-drag", async () => {
    const slider = await autoPaddingSlider();
    slider.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    slider.value = "0.15";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await pump();
    const composed = composeCalls.length;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The reshaped frame, painted at a new width: the parked bitmap now
    // wants a different height, so the settle has work to do.
    paintFrame(1100);
    fireResize();
    vi.advanceTimersByTime(1000);
    await pump();
    // Premise: the settle did re-target the preview, or the slider would
    // survive simply because nothing ran.
    expect(composeCalls.length).toBeGreaterThan(composed);
    expect(
      document.querySelector("[data-padding]"),
      "the Padding slider was rebuilt under the pointer",
    ).toBe(slider);
    expect(slider.isConnected).toBe(true);
  });

  /**
   * Review 2026-10-06: the mid-drag test above read "a branding preview is
   * set", but a release that commits nothing — the slider dragged back to
   * where it started, so Blink fires no `change` — leaves that preview set
   * until the next document change. Every settled resize after it took the
   * recompose path and never rebuilt the panels. Red if the settle reads a
   * leftover preview as a drag in progress.
   */
  it("rebuilds the panels on a settle after a drag released without a commit", async () => {
    const slider = await autoPaddingSlider();
    const start = slider.value;
    slider.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    slider.value = "0.15";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.value = start;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("pointerup", { bubbles: true }));
    await pump();
    // Premise: the release committed nothing, so the preview is still set
    // — the state this test is about.
    expect(memory.putCalls()).toEqual([]);
    const composed = composeCalls.length;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    paintFrame(1100);
    fireResize();
    vi.advanceTimersByTime(1000);
    await pump();
    expect(composeCalls.length).toBeGreaterThan(composed);
    // `render` rebuilds the Background panel; the recompose path never does.
    expect(
      document.querySelector("[data-padding]"),
      "the settle recomposed only, as if the drag were still going",
    ).not.toBe(slider);
  });

  /**
   * The other half: a settle that recomposed mid-drag skipped the panels,
   * so the release owes them a render even when it commits nothing. Red if
   * the release leaves the panels as the settle found them.
   */
  it("renders the panels a mid-drag settle skipped once the pointer lifts", async () => {
    const slider = await autoPaddingSlider();
    const start = slider.value;
    slider.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    slider.value = "0.15";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await pump();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    paintFrame(1100);
    fireResize();
    vi.advanceTimersByTime(1000);
    await pump();
    // Premise: the settle ran mid-drag and left the slider alone.
    expect(document.querySelector("[data-padding]")).toBe(slider);
    slider.value = start;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await pump();
    // Premise: dragging back is still mid-drag — nothing but the release
    // may rebuild the panel.
    expect(document.querySelector("[data-padding]")).toBe(slider);
    slider.dispatchEvent(new Event("pointerup", { bubbles: true }));
    // The owed render waits a task, behind the `change` a commit would fire.
    vi.advanceTimersByTime(0);
    await pump();
    expect(
      document.querySelector("[data-padding]"),
      "the release left the panels the settle skipped",
    ).not.toBe(slider);
  });

  it("re-targets a parked preview once the resize settles, not per step", async () => {
    await booted();
    const before = composeCalls.length;
    expect(composeCalls.at(-1)?.height).toBe(1314);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let width = 1170; width <= 1180; width += 1) {
      paintFrame(width);
      fireResize();
      vi.advanceTimersByTime(16);
    }
    expect(composeCalls.length).toBe(before);

    vi.advanceTimersByTime(1000);
    expect(composeCalls.length).toBe(before + 1);
    // The settled size, not an intermediate one: 1180 x 2 = 2360 device
    // pixels wide at 16:9 is 1328 rows (1170, the first step, is 1316).
    expect(composeCalls.at(-1)?.height).toBe(1328);
  });

  /**
   * A take opened and played at once has drawn too few frames to price the
   * machine, so the play latches the floor. Measured 2026-10-23 on the
   * author's Mac: that first play ran at 994x720 against 1575x1141 parked,
   * on a machine with room for the full size. Verified failable: dropping
   * the re-solve after the blit leaves every draw of the play at the floor.
   */
  it("re-solves an uncalibrated play once, as soon as its draws price the machine", async () => {
    draws.composeMs = 1;
    await booted();
    const parked = composeCalls.at(-1) as RenderTarget;
    playButton().click();
    // Premise: too few draws to price the machine, so the play took the floor.
    expect((composeCalls.at(-1) as RenderTarget).height).toBe(PREVIEW_HEIGHT);
    expect(parked.height).toBeGreaterThan(PREVIEW_HEIGHT);
    const heights = new Set<number>();
    for (let i = 0; i < 12; i++) {
      await pump();
      heights.add((composeCalls.at(-1) as RenderTarget).height);
    }
    // A cheap machine affords the parked size, and the play reaches it.
    expect(composeCalls.at(-1)?.height).toBe(parked.height);
    // Once: the floor, then the solved height, and no flicker after it.
    expect([...heights].sort((a, b) => a - b)).toEqual([
      PREVIEW_HEIGHT,
      parked.height,
    ]);
  });

  /**
   * Parked draws that cost more than playback's (each full-size still's first
   * paint) latch the play small; the play's own draws re-solve it. Measured
   * 2026-10-23: plays latched at 994x720 on a Mac whose playback drew at
   * 0.6 ms per megapixel. Verified failable: re-solving from the whole
   * window instead of `own` keeps the floor, the parked costs still in it.
   */
  it("re-solves a play mispriced by parked draws from the play's own draws", async () => {
    draws.composeMs = 40;
    await booted();
    for (let i = 0; i < 10; i++) {
      pressKey("ArrowRight");
      await pump();
    }
    const parked = composeCalls.at(-1) as RenderTarget;
    playButton().click();
    // Premise: parked drawing priced the machine too slow for more than the
    // floor, so the play latched it.
    expect((composeCalls.at(-1) as RenderTarget).height).toBe(PREVIEW_HEIGHT);
    expect(parked.height).toBeGreaterThan(PREVIEW_HEIGHT);
    draws.composeMs = 1;
    for (let i = 0; i < 12; i++) await pump();
    expect(composeCalls.at(-1)?.height).toBe(parked.height);
  });

  /**
   * Under playback the observer solved without the measured cost or the
   * latch, got the floor, and compared it to the latched height — unequal on
   * any calibrated machine, so every fire mid-playback ran a full render.
   * Verified failable: solving in the observer with `previewHeightFor`
   * directly, as before, fails the final count.
   */
  it("leaves a playing preview's latched height alone on resize", async () => {
    draws.composeMs = 12;
    await booted();
    // Calibrate, as parked scrubbing does. See the transport lane's
    // "sizes playback from the cost it measured while parked".
    for (let i = 0; i < 10; i++) {
      pressKey("ArrowRight");
      await pump();
    }
    playButton().click();
    const playing = composeCalls.at(-1) as RenderTarget;
    // Premise: calibrated, so the latched height is NOT the floor the old
    // observer would have compared it with.
    expect(playing.height).toBeGreaterThan(PREVIEW_HEIGHT);

    const before = composeCalls.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    paintFrame(1100);
    fireResize();
    vi.advanceTimersByTime(1000);
    expect(composeCalls.length).toBe(before);
  });

  /**
   * The zoom clamp reads the DELIVERABLE, whatever the bitmap is doing. Cut
   * against the bitmap, one zoom scrubbed at one size parked and another
   * playing. `compose-for-target.test.ts` shows the clamp honours the
   * argument; this is the wiring. Verified failable: dropping `detailTarget`
   * from `refreshDerived` fails the first assertion.
   */
  it("clamps the preview's zoom against the deliverable, parked and playing", async () => {
    await booted();
    const parked = composeCalls.at(-1) as RenderTarget;
    const parkedDetail = detailCalls.at(-1);
    expect(parkedDetail).toEqual(
      targetFor(
        "mp4",
        "16:9",
        proceduralBundle({ motionSpans: [] }),
        frameOf(readonlyScene()),
      ),
    );

    playButton().click();
    const playing = composeCalls.at(-1) as RenderTarget;
    // Premise: the bitmap really did change size across the flip.
    expect(playing.height).not.toBe(parked.height);
    expect(detailCalls.at(-1)).toEqual(parkedDetail);
  });

  /**
   * Play while a parked draw is mid-composite: the re-target swaps the
   * bitmap under it. Read after its awaits, the draw composed into the old
   * bitmap and blitted the new, blank one. Verified failable: reading the
   * globals again after the awaits blits a canvas nothing composed into.
   */
  it("never blits a bitmap no draw composed into", async () => {
    draws.composeMs = 1;
    const blits: unknown[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: (source: unknown) => blits.push(source),
    } as never);
    await booted();

    let release: () => void = () => undefined;
    draws.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pressKey("ArrowRight");
    await pump();
    await vi.waitFor(() => {
      if (draws.reachedGate === 0) throw new Error("draw not in flight yet");
    });

    // Re-targets to the playback floor: a new, blank bitmap.
    playButton().click();
    const retargeted = composeCalls.at(-1) as RenderTarget;
    expect(retargeted.height).toBe(PREVIEW_HEIGHT);

    draws.gate = null;
    release();
    // The held draw finishes; then the redraw the re-target armed runs.
    await vi.waitFor(async () => {
      await pump();
      const last = blits.at(-1) as FakeOffscreenCanvas | undefined;
      if (last?.height !== PREVIEW_HEIGHT) {
        throw new Error(`last blit: ${last?.height ?? "none"}`);
      }
    });
    const blank = blits.filter((b) => !draws.composedInto.has(b));
    expect(
      blank,
      `blitted ${blits.length}, composed ${draws.composedInto.size}`,
    ).toEqual([]);
  });
});
