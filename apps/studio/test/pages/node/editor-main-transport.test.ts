import {
  GIF_800,
  LANDSCAPE_1080P,
  madeFromOf,
  type RenderTarget,
} from "@demoman/compositor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import {
  authoredScene,
  readonlyScene,
} from "../../../../../packages/replay-engine/test/helpers/scenes";
import {
  PLAYBACK_HEIGHT_STEP,
  PREVIEW_HEIGHT,
} from "../../../pages/src/editor/preview";
import {
  SHORTCUT_LEGEND,
  ZOOM_STEP,
} from "../../../pages/src/editor/shortcuts";
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
 * The transport wiring, driven against the real
 * `entrypoints/editor/main.ts`.
 *
 * `createPlayer` and `renderTransport` are unit-tested on their own; what
 * only this file can catch is the two of them not being connected to each
 * other, to the scrubber, or to the failure box — the dead-wire class this
 * package's entrypoint tests exist for.
 */

// Every `scene:get` in this file answers with `readonlyScene()` — there is
// no override — so one `madeFrom` matches every `bundle:active` reply in
// it, keeping the frames verifiable and this file's strict `console.error`
// guards quiet on the approximations path none of these tests are about.
const MADE_FROM = madeFromOf(readonlyScene());

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
 * Which target the compositor was actually handed, per composition.
 *
 * The preview's shape is not observable from the DOM beyond the canvas
 * bitmap's width and height, and the field the format switch has to carry
 * — `cornerRadius` — does not move the bitmap at all. `previewTarget`
 * scales GIF to the same 1280x720/contain landscape gets, so a switch that
 * dropped it would look identical on the canvas
 * and draw a different picture. This records what `refreshDerived` passed.
 */
const composeCalls = vi.hoisted(() => [] as RenderTarget[]);

/**
 * Makes a draw SUCCEED, and cost something, for the one test that needs the
 * preview to have measured its machine.
 *
 * Every other test in this file wants the refusals below: the lane has no
 * IndexedDB and no canvas, and the named failures are the path those tests
 * exercise. But a draw that never completes never calibrates
 * `msPerMegapixel`, so with refusals alone the adaptive playback height can
 * only ever be observed at its uncalibrated floor — and the whole feature
 * could be disconnected in `main.ts` with the suite still green. Measured:
 * replacing the estimate with a literal `null` there left 104 tests passing.
 *
 * `composeMs` is spent in a real busy-wait rather than a stubbed clock.
 * `performance.now` is also the transport's clock, and a fake one there
 * makes the player's own arithmetic the thing under test.
 */
const drawCost = vi.hoisted(() => ({ composeMs: 0 }));

/** The frame rect every preview draw was handed, in order. */
const drawnFrames = vi.hoisted(
  () => [] as { x: number; y: number; width: number; height: number }[],
);

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    // A plain wrapper rather than a spy: the real composition still has to
    // run (the preview under test is the one this file boots), and a spy
    // would be stripped by a global restore.
    composeForTarget: (args: Parameters<typeof actual.composeForTarget>[0]) => {
      composeCalls.push(args.target);
      return actual.composeForTarget(args);
    },
    // Pass-through unless a test has asked for a costed draw: this lane's
    // canvas is `{}`, so the real `renderFrame` throws, which is exactly
    // what every other test here wants.
    renderFrame: async (args: Parameters<typeof actual.renderFrame>[0]) => {
      drawnFrames.push(args.presentation.frameRect);
      if (drawCost.composeMs <= 0) return actual.renderFrame(args);
      const until = performance.now() + drawCost.composeMs;
      while (performance.now() < until) {
        // Spin. See `drawCost`.
      }
    },
    // The refusals above are for the preview's DRAW. The hover check shares
    // the preview's frame source, and the real video source decodes every
    // span when it is built — so the same refusal failed the check too, and
    // every test with a bundle ran under the hover-check-failed banner with
    // "no frame is read in this test" on the console. Neither is what this
    // file tests. The lazy image source loads nothing until a draw asks, so
    // a draw still meets the refusal; motion detection and the hover check
    // answer nothing. Plain functions, as in editor-main-keyboard.test.ts,
    // so a global mock restore has nothing to strip.
    createVideoFrameSource: async (
      ...args: Parameters<typeof actual.createImageFrameSource>
    ) => actual.createImageFrameSource(...args),
    detectKeyframeMotion: async () => [],
    hoverVerdicts: async () => [],
  };
});

// The editor page reads frames straight from IndexedDB, which the node lane
// has no implementation of; every read used to fail with "indexedDB is not
// defined" and print a stack. A named refusal keeps the failure path these
// tests exercise, and says what it is.
const playButton = (): HTMLButtonElement =>
  document.querySelector("[data-transport-play]") as HTMLButtonElement;

/**
 * Where the playhead is, as the percentage `renderTransportRow` writes.
 *
 * The transport clock is `m:ss`, so a 100ms nudge does not move it at all and
 * an assertion on the readout would pass whether or not the nudge landed.
 */
const playheadLeft = (): number =>
  Number.parseFloat(
    (
      document.querySelector("[data-playhead]") as HTMLElement
    ).style.left.replace("%", ""),
  );

const pressKey = (key: string, init: KeyboardEventInit = {}): void => {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
  );
};

const selectedBeat = (): string | null =>
  document
    .querySelector("[data-tick][data-selected]")
    ?.getAttribute("data-tick") ?? null;

describe("editor main — preview transport", () => {
  let memory: MemoryPlatform;
  let frames: Array<() => void>;

  /** Runs one round of whatever the player and scrubber scheduled, then lets
   *  the draw promises settle. */
  async function pump(): Promise<void> {
    const due = frames;
    frames = [];
    for (const fn of due) fn();
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    vi.resetModules();
    reported = vi.spyOn(console, "error");
    editorDom();
    composeCalls.length = 0;
    drawnFrames.length = 0;
    drawCost.composeMs = 0;
    frames = [];
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    });
    memory = createMemoryPlatform();
    state.memory = memory;
    // The deliverable these sizes are measured against is the full-quality
    // one, a choice the studio's Settings offer (its default is "share").
    memory.answer("exportQuality.read", async () => ({ quality: "full" }));
    // A frame reads only when the test has given drawing a cost, as the
    // frame store this file mocked in apps/extension did.
    memory.answer("bundles.load", async () => {
      if (drawCost.composeMs > 0) return new Uint8Array([0]);
      throw new Error("no frame is read in this test");
    });
    memory.serveScene(() => readonlyScene());
  });

  // The editor reports through `console.error`. A failed DRAW is not among
  // what it reports there, so anything that lands on it is a path this file
  // did not mean to run. jsdom's own "Not implemented" is excepted: the
  // costed-draw cases blit a draw that succeeded onto a canvas jsdom has no
  // 2D context for, and that is jsdom naming its gap, not the editor.
  let reported: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    const said = reported.mock.calls
      .map((c) => c.map(String).join(" "))
      .filter((line) => !line.startsWith("Not implemented: HTMLCanvasElement"));
    reported.mockRestore();
    vi.unstubAllGlobals();
    vi.resetModules();
    expect(said).toEqual([]);
  });

  /** The play control's accessible name. It carried the word "Play" or
   *  "Pause" as text until 2026-09-20, when the glyph replaced it and
   *  `aria-label` became the ONLY name it has — so this is what "the button
   *  says Pause" means here now. Asserting it matters more than it did, not
   *  less: a stale label is invisible to anyone reading the control rather
   *  than looking at it. */
  const playName = (button = playButton()) =>
    button?.getAttribute("aria-label") ?? null;

  it("renders a disabled Play button when the take has no frames", async () => {
    memory.serveBundle(null, null);
    await import("../../../pages/entrypoints/editor/main");

    const play = await vi.waitFor(() => {
      const button = playButton();
      if (!button) throw new Error("transport not rendered yet");
      return button;
    });
    expect(playName(play)).toBe("Play");
    expect(play.disabled).toBe(true);
  });

  // The frameless surfaces main.ts wires (transport row, stage bar, the trim
  // refusal) each read the take's capture mode. Driven through the real page
  // because the flag has to travel from the scene to each of them; goes red
  // if any one stops passing it on.
  describe("a take with no frames", () => {
    const boot = async (scene: ReturnType<typeof readonlyScene>) => {
      memory.serveScene(() => scene);
      memory.serveBundle(null, null);
      await import("../../../pages/entrypoints/editor/main");
      await vi.waitFor(() => {
        if (!playButton()) throw new Error("transport not rendered yet");
      });
      // Premise for every assertion below: no frames, so the surfaces are the
      // frameless ones.
      expect(playButton().disabled).toBe(true);
    };

    const surfaces = (): string[] => [
      playButton().title,
      (document.querySelector("[data-transport-skip]") as HTMLElement).title,
      (document.querySelector("#stage-tools [data-stage-zoom]") as HTMLElement)
        .title,
      document.querySelector("#timeline")?.textContent ?? "",
    ];

    // The studio has no Runs page: a take with no frames is filmed again by
    // the agent, and every surface says how (`nav.rerun`, the studio's
    // `refilmLine`). Until 2026-10-20 these said the extension's "Run its
    // script again in Runs" / "Re-shoot it in Runs".
    it("names the agent's re-film on every surface, for an authored take", async () => {
      await boot(authoredScene(readonlyScene()));
      pressKey("i");
      const said = surfaces();
      // Premise: the trim refusal actually drew (`i` is the head trim key).
      expect(said[3]).toMatch(/nothing to trim to/);
      for (const text of said) {
        expect(text).toContain("Ask your agent to film");
        expect(text).not.toMatch(/in Runs|re-shoot/i);
      }
    });

    it("names the same re-film for a recorded take", async () => {
      await boot(readonlyScene());
      pressKey("i");
      const said = surfaces();
      expect(said[3]).toMatch(/nothing to trim to/);
      for (const text of said) {
        expect(text).toContain("Ask your agent to film");
      }
    });
  });

  it("reports Pause the moment Play is pressed on a take with frames", async () => {
    memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
    await import("../../../pages/entrypoints/editor/main");

    const play = await vi.waitFor(() => {
      const button = playButton();
      if (!button || button.disabled) throw new Error("transport not ready");
      return button;
    });
    play.click();
    expect(playName()).toBe("Pause");
  });

  /**
   * The resolution split, through the real `main.ts`.
   *
   * `previewHeightFor` is unit-tested; what only this file can catch is it
   * not being WIRED — the preview composing at one fixed height whatever the
   * transport is doing, which is exactly the state this replaced. The bug it
   * guards against is also specific: re-targeting resets `canvas.width`,
   * which BLANKS the bitmap, so a pause that re-targets without re-arming
   * the draw leaves an empty stage under a correct-looking transport.
   */
  it("composes a parked preview taller than a playing one", async () => {
    // jsdom gives every element a 0x0 rect, and `previewHeightFor` answers
    // with its floor for a box that has not been painted — so without this
    // the parked and playing heights would be identical and the assertion
    // below would pass against no implementation at all.
    const frame = document.getElementById("stage-frame") as HTMLElement;
    frame.getBoundingClientRect = () =>
      ({
        width: 1168,
        height: 657,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1168,
        bottom: 657,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.stubGlobal("devicePixelRatio", 2);

    memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!playButton() || playButton().disabled) {
        throw new Error("transport not ready");
      }
      if (composeCalls.length === 0) throw new Error("nothing composed yet");
    });

    // Parked: the painted box in device pixels, 1168 x 2 = 2336 wide.
    const parked = composeCalls.at(-1) as RenderTarget;
    expect(parked.width).toBe(2336);

    // Playback takes the UNCALIBRATED floor here, and only here: this lane's
    // frame store refuses every read, so no draw ever completes and nothing
    // feeds `msPerMegapixel`. Which height a calibrated machine gets is
    // `previewHeightFor`'s own arithmetic and is covered in
    // `editor-preview.test.ts` — this file's claim is narrower and is the
    // one only it can make: that the flip re-targets at all, and that the
    // blanked bitmap is drawn again afterwards.
    playButton().click();
    expect(playName()).toBe("Pause");
    const playing = composeCalls.at(-1) as RenderTarget;
    expect(playing.height).toBe(PREVIEW_HEIGHT);
    expect(playing.height).toBeLessThan(parked.height);

    // Pausing re-targets, and re-targeting assigns `canvas.width`, which
    // resets the bitmap to blank. The render tail has to re-arm the draw or
    // the stage goes empty under a transport reporting Play — so the
    // scheduled redraw is asserted, not just the size. Verified failable:
    // dropping `target.height !== drawnTargetHeight` from that tail leaves
    // every size assertion above green and fails exactly this line.
    frames = [];
    playButton().click();
    expect(playName()).toBe("Play");
    const reparked = composeCalls.at(-1) as RenderTarget;
    expect(reparked.height).toBe(parked.height);
    expect(frames.length).toBeGreaterThan(0);
  });

  /**
   * The adaptive playback height, wired end to end.
   *
   * `previewHeightFor` solves for a height from a measured cost, and
   * `editor-preview.test.ts` covers that arithmetic. What only this file can
   * catch is `main.ts` never FEEDING it: the estimate is taken in the
   * scrubber's draw and read in `retarget`, two places with nothing between
   * them, and replacing the read with a literal `null` left 104 tests green.
   *
   * So this makes a draw genuinely succeed and genuinely cost something (see
   * `drawCost`), lets it calibrate while parked, and then asks what playback
   * composes at. A disconnected estimate answers `PREVIEW_HEIGHT` exactly,
   * which is the assertion below that fails first.
   */
  it("sizes playback from the cost it measured while parked", async () => {
    const frame = document.getElementById("stage-frame") as HTMLElement;
    frame.getBoundingClientRect = () =>
      ({
        width: 1168,
        height: 657,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1168,
        bottom: 657,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.stubGlobal("devicePixelRatio", 2);
    // Enough to price the parked bitmap (~3.1 megapixels) out of an 11ms
    // budget without pricing it below the floor — the band where a solved
    // height is distinguishable from both ends.
    drawCost.composeMs = 12;

    // No motion spans: the video source needs WebCodecs, which this lane
    // has not got. The still source is lazy, and `renderFrame` is stubbed
    // above, so nothing here decodes anything.
    memory.serveBundle(
      proceduralBundle({ motionSpans: [], madeFrom: MADE_FROM }),
      null,
    );
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!playButton() || playButton().disabled) {
        throw new Error("transport not ready");
      }
      if (composeCalls.length === 0) throw new Error("nothing composed yet");
    });
    const parked = composeCalls.at(-1) as RenderTarget;
    expect(parked.height).toBe(1314);

    // Scrub, and let each draw run. This is what calibrates — one draw is
    // not enough by design (`COST_MIN_SAMPLES`), and the scrubber collapses
    // requests, so the seeks have to be separated by a pump rather than
    // queued together.
    for (let i = 0; i < 10; i++) {
      pressKey("ArrowRight");
      await pump();
    }
    // Premise: a draw actually COMPLETED. If they were still failing, the
    // estimate would be null and the floor below would be reported for the
    // wrong reason entirely.
    expect(document.querySelector("[data-preview-error]")).toBeNull();

    playButton().click();
    expect(playName()).toBe("Pause");
    const playing = composeCalls.at(-1) as RenderTarget;
    // Solved, not the constant: above the uncalibrated floor, below parked,
    // and on the hysteresis step.
    expect(playing.height).toBeGreaterThan(PREVIEW_HEIGHT);
    expect(playing.height).toBeLessThan(parked.height);
    expect(playing.height % PLAYBACK_HEIGHT_STEP).toBe(0);
  });

  /**
   * The playback latch is per stretch of playback: pausing clears it, so the
   * next play solves again for the stage as it is then. Without the reset a
   * height latched in a wide window outlives a resize to a narrow one —
   * composing a bitmap larger than the box it is painted into, for every
   * play after. Verified failable: dropping `latchedPlaybackHeight = null`
   * from `solvePreviewTarget`'s parked branch fails the last assertion.
   */
  it("solves the playback height again after a pause", async () => {
    let cssWidth = 1168;
    const frame = document.getElementById("stage-frame") as HTMLElement;
    frame.getBoundingClientRect = () =>
      ({
        width: cssWidth,
        height: (cssWidth * 9) / 16,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: cssWidth,
        bottom: (cssWidth * 9) / 16,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.stubGlobal("devicePixelRatio", 2);
    drawCost.composeMs = 12; // as "sizes playback from the cost…" above
    memory.serveBundle(
      proceduralBundle({ motionSpans: [], madeFrom: MADE_FROM }),
      null,
    );
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!playButton() || playButton().disabled) {
        throw new Error("transport not ready");
      }
      if (composeCalls.length === 0) throw new Error("nothing composed yet");
    });
    for (let i = 0; i < 10; i++) {
      pressKey("ArrowRight");
      await pump();
    }

    playButton().click();
    const wide = composeCalls.at(-1) as RenderTarget;
    // Premise: the first stretch latched a height above what the narrow
    // stage below can hold, so a stale latch is visible.
    expect(wide.height).toBeGreaterThan(PREVIEW_HEIGHT);
    playButton().click();
    expect(playName()).toBe("Play");

    // Narrow enough that the parked height is the floor, which caps playback.
    cssWidth = 300;
    playButton().click();
    expect(playName()).toBe("Pause");
    expect((composeCalls.at(-1) as RenderTarget).height).toBe(PREVIEW_HEIGHT);
  });

  it("does not re-render on a resize while playing at the latched height", async () => {
    // The stage's resize observer checks whether the preview needs a new
    // bitmap. It solved that height itself, without the playback latch or
    // the measured cost, so a calibrated playback always disagreed with it
    // and every resize rebuilt every panel — ending any slider drag — for
    // a height the render then left alone.
    // Every observer the editor makes, with what each watches: the
    // timeline's ruler has one of its own, so "the first one made" is not
    // a way to find the stage's.
    const observed: Array<{ callback: () => void; targets: Element[] }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly entry: { callback: () => void; targets: Element[] };
        constructor(callback: () => void) {
          this.entry = { callback, targets: [] };
          observed.push(this.entry);
        }
        observe(target: Element): void {
          this.entry.targets.push(target);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const frame = document.getElementById("stage-frame") as HTMLElement;
    frame.getBoundingClientRect = () =>
      ({
        width: 1168,
        height: 657,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1168,
        bottom: 657,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.stubGlobal("devicePixelRatio", 2);
    drawCost.composeMs = 12; // as "sizes playback from the cost…" above
    memory.serveBundle(
      proceduralBundle({ motionSpans: [], madeFrom: MADE_FROM }),
      null,
    );
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!playButton() || playButton().disabled) {
        throw new Error("transport not ready");
      }
      if (composeCalls.length === 0) throw new Error("nothing composed yet");
    });
    for (let i = 0; i < 10; i++) {
      pressKey("ArrowRight");
      await pump();
    }
    playButton().click();
    const playing = composeCalls.at(-1) as RenderTarget;
    // Premise: playback runs at a calibrated height, not the floor an
    // uncalibrated solve answers — the disagreement this guards against.
    expect(playing.height).toBeGreaterThan(PREVIEW_HEIGHT);
    // Premise: there is a stage observer, and a render replaces the
    // inspector box this watches.
    const stageObserver = observed.find(({ targets }) =>
      targets.includes(frame),
    );
    expect(stageObserver, "nothing observes #stage-frame").toBeDefined();
    const inspector = document.querySelector(".inspector");
    expect(inspector).not.toBeNull();

    stageObserver?.callback();
    expect(document.querySelector(".inspector")).toBe(inspector);
    expect(playName()).toBe("Pause");
  });

  it("toggles playback from the space bar", async () => {
    memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!playButton() || playButton().disabled) {
        throw new Error("transport not ready");
      }
    });
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(playName()).toBe("Pause");
  });

  it("leaves the space bar alone while the author is typing a name", async () => {
    // The demo-name field sits in the same header. A global space handler
    // that swallowed it would make the title untypeable.
    memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!playButton() || playButton().disabled) {
        throw new Error("transport not ready");
      }
    });
    const name = document.getElementById("name") as HTMLInputElement;
    name.focus();
    name.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(playName()).toBe("Play");
  });

  it("stops playback and says so when the preview cannot draw", async () => {
    // The whole point of the reporter. Draws fail here because the frame
    // store cannot be read at all under jsdom, which is the same shape as a
    // bundle whose frames have gone missing in production. Without this the
    // clock would keep counting over a canvas that never changes, and
    // nothing anywhere would say why.
    memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!playButton() || playButton().disabled) {
        throw new Error("transport not ready");
      }
    });
    playButton().click();
    expect(playName()).toBe("Pause");

    await vi.waitFor(async () => {
      await pump();
      if (!document.querySelector("[data-preview-error]")) {
        throw new Error("no preview failure reported yet");
      }
    });
    // Premise: the draw failed on the frame store's refusal, as the comment
    // above says — not on something else this lane lacks.
    expect(
      document.querySelector("[data-preview-error]")?.textContent,
    ).toContain("no frame is read in this test");
    expect(playName()).toBe("Play");
  });

  /**
   * `requestFullscreen`'s rejection, end to end: a lost user gesture, a
   * permissions policy, an element detached between click and call.
   * Unhandled, that rejection would be an uncaught rejection on this
   * extension page, landing on the chrome://extensions Errors list — this
   * is the test that proves it is caught, and that the reason it names
   * reaches `#failure` rather than nowhere.
   */
  it("says so when full screen is refused", async () => {
    memory.serveBundle(null, null);
    await import("../../../pages/entrypoints/editor/main");

    // The toolbar's copy: outside full screen it is the one the author can
    // see and press. `#stage-bar`'s precedes it in document order and is
    // hidden there, so an unscoped query would press the wrong one.
    const button = await vi.waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(
        "#stage-tools [data-stage-fullscreen]",
      );
      if (!el) throw new Error("stage tools not rendered yet");
      return el;
    });

    const stage = document.querySelector<HTMLElement>("#stage") as HTMLElement;
    stage.requestFullscreen = () =>
      Promise.reject(new Error("Permissions check failed"));
    button.click();

    await vi.waitFor(() => {
      expect(document.querySelector("#failure")?.textContent).toMatch(
        /could not go full screen.*Permissions check failed/,
      );
    });
    // Beside the control the author pressed, too: the toolbar's own banner,
    // the copy that is painted outside full screen. `#failure` sits in the
    // `#notes` popover, one click away; this is where the eye already is.
    const toolbarError = document.querySelector<HTMLElement>(
      "#stage-tools [data-stage-error]",
    );
    expect(toolbarError?.hidden, "the toolbar's banner is hidden").toBe(false);
    expect(toolbarError?.textContent).toMatch(
      /could not go full screen.*Permissions check failed/,
    );
    // And the control still reports the state it is actually in: the
    // request was refused, so `fullscreenchange` never fired and the label
    // must not have moved to claim an outcome that did not happen.
    expect(button.getAttribute("aria-label")).toBe("Full screen");
  });

  /**
   * The toolbar's banner hangs over the lanes, so it can be closed — and
   * closing it hides the banner, never the reason. Red if dismiss clears
   * `previewError` (the `#failure` check), if it does nothing (the hidden
   * check), or if a later refusal is born hidden (the last check).
   */
  it("closes the toolbar's banner and keeps the reason in #failure", async () => {
    memory.serveBundle(null, null);
    await import("../../../pages/entrypoints/editor/main");
    const button = await vi.waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(
        "#stage-tools [data-stage-fullscreen]",
      );
      if (!el) throw new Error("stage tools not rendered yet");
      return el;
    });
    const stage = document.querySelector<HTMLElement>("#stage") as HTMLElement;
    stage.requestFullscreen = () =>
      Promise.reject(new Error("Permissions check failed"));
    const banner = () =>
      document.querySelector<HTMLElement>(
        "#stage-tools [data-stage-error]",
      ) as HTMLElement;
    button.click();
    await vi.waitFor(() => expect(banner().hidden).toBe(false));

    banner()
      .querySelector<HTMLButtonElement>("[data-stage-error-dismiss]")
      ?.click();
    expect(banner().hidden, "the banner is still up").toBe(true);
    expect(document.querySelector("#failure")?.textContent).toMatch(
      /could not go full screen.*Permissions check failed/,
    );

    // The same words, but a new attempt: the author pressed again.
    button.click();
    await vi.waitFor(() =>
      expect(banner().hidden, "a new refusal was born hidden").toBe(false),
    );
  });

  /**
   * `main.ts`'s own `fullscreenchange` listener, dispatched at the real
   * `document` — not a copy of the pattern re-registered inside a test.
   * Deleting the listener (or its call to `renderTransportRow`) leaves this
   * red while every other test in this suite, and the format/shell-layout
   * suites, stay green: nothing else in this repo drives `document` itself
   * through a real `fullscreenchange`.
   */
  it("follows the document out of full screen, from main.ts's own listener", async () => {
    memory.serveBundle(null, null);
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!document.querySelector("#stage-tools [data-stage-fullscreen]")) {
        throw new Error("stage tools not rendered yet");
      }
    });
    // Both copies, read apart: the toolbar's and the full-screen row's.
    // Equal labels are what "one state, two roots" has to mean, and a
    // single unscoped query would only ever read the first in document
    // order. Joined, so each comparison below names both.
    const label = () =>
      [
        ...new Set(
          ["#stage-tools", "#stage-bar"].map((root) =>
            document
              .querySelector(`${root} [data-stage-fullscreen]`)
              ?.getAttribute("aria-label"),
          ),
        ),
      ].join(" | ");
    expect(label()).toBe("Full screen");

    const stage = document.querySelector<HTMLElement>("#stage") as HTMLElement;
    try {
      // Real browsers report `null` here until a `requestFullscreen`
      // actually settles; jsdom has no Fullscreen API at all to earn this
      // through, so it is faked directly, the way the browser lane's own
      // version of this test does against real Chromium.
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => stage,
      });
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(label()).toBe("Exit full screen");
      // And the stage is marked: `:fullscreen` mirrored onto an attribute,
      // which is what makes a full-screen rule reachable from a test at
      // all, because the browser lane is refused real full screen
      // ("Permissions check failed") and jsdom has no Fullscreen API
      // whatsoever. It hid the rail while the rail lived inside `#stage`,
      // until 2026-10-07; what is asserted HERE is only that the listener
      // sets the flag a rule can key on.
      expect(
        stage.hasAttribute("data-fullscreen"),
        "the stage is not marked full screen",
      ).toBe(true);

      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => null,
      });
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(label()).toBe("Full screen");
      expect(
        stage.hasAttribute("data-fullscreen"),
        "the mark outlived full screen",
      ).toBe(false);
    } finally {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => undefined,
      });
    }
  });

  /**
   * Focus follows the full-screen button across the swap. Pressed in the
   * toolbar, the button stays focused while the dock goes unpainted, and
   * the keydown guard stands down for Space on a focused button — so Space
   * in full screen re-pressed the invisible button and left full screen
   * instead of playing. Leaving through the floating row's button drops
   * the focus to `body` when the row is hidden. And an author whose focus
   * is elsewhere keeps it.
   */
  it("hands the focus to the shown full-screen button, and only from the hidden one", async () => {
    memory.serveBundle(null, null);
    await import("../../../pages/entrypoints/editor/main");
    const button = (root: string) =>
      document.querySelector<HTMLButtonElement>(
        `${root} [data-stage-fullscreen]`,
      );
    await vi.waitFor(() => {
      if (!button("#stage-tools") || !button("#stage-bar")) {
        throw new Error("both copies not rendered yet");
      }
    });
    const stage = document.querySelector<HTMLElement>("#stage") as HTMLElement;
    const goFullScreen = (on: boolean) => {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => (on ? stage : null),
      });
      document.dispatchEvent(new Event("fullscreenchange"));
    };
    try {
      button("#stage-tools")?.focus();
      // Premise: the toolbar's button holds the focus, or the hand-over
      // below proves nothing.
      expect(document.activeElement).toBe(button("#stage-tools"));
      goFullScreen(true);
      expect(document.activeElement, "entering left the focus behind").toBe(
        button("#stage-bar"),
      );
      goFullScreen(false);
      expect(document.activeElement, "leaving did not hand it back").toBe(
        button("#stage-tools"),
      );

      // Focus elsewhere is not stolen, either way.
      const name = document.querySelector<HTMLElement>("#name") as HTMLElement;
      name.focus();
      expect(document.activeElement, "premise: #name has the focus").toBe(name);
      goFullScreen(true);
      expect(document.activeElement).toBe(name);
      goFullScreen(false);
      expect(document.activeElement).toBe(name);
    } finally {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => undefined,
      });
    }
  });

  /**
   * The exit branch's refusal, specifically: `document.fullscreenElement`
   * is faked to the stage element (the state a real `requestFullscreen`
   * success would have left), so the click below takes
   * `toggleFullscreen`'s `document.exitFullscreen()` branch and the
   * document is STILL full screen when the promise rejects — exactly the
   * case `#failure` (outside `#stage`) cannot show, which is why
   * `renderStageBar`'s own `[data-stage-error]` exists.
   */
  it("shows an exit refusal on the picture, where #failure would be invisible", async () => {
    memory.serveBundle(null, null);
    await import("../../../pages/entrypoints/editor/main");

    // The full-screen row's copy: the document is (faked) full screen, so
    // `#stage-bar` is the copy that is painted and the one pressed.
    const button = await vi.waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(
        "#stage-bar [data-stage-fullscreen]",
      );
      if (!el) throw new Error("stage bar not rendered yet");
      return el;
    });
    const stage = document.querySelector<HTMLElement>("#stage") as HTMLElement;
    try {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => stage,
      });
      document.exitFullscreen = () => Promise.reject(new Error("blocked"));
      button.click();

      await vi.waitFor(() => {
        const error = document.querySelector<HTMLElement>(
          "#stage-bar [data-stage-error]",
        );
        if (!error || error.hidden) throw new Error("no on-stage error yet");
        // The exit branch's own wording, not the entry branch's — the
        // author pressed Exit full screen, so a message that says the
        // preview "could not go full screen" would name the wrong
        // operation. The `not.toMatch` below is what pins the two apart:
        // without it, a regression back to the single fixed prefix this
        // test used to (wrongly) assert would still satisfy a loose
        // `/could not .* full screen/` pattern.
        expect(error.textContent).toMatch(
          /could not exit full screen.*blocked/,
        );
        expect(error.textContent).not.toMatch(/could not go full screen/);
      });
      // The label still reads the document's own state (still full screen —
      // the exit failed), the same guarantee the request branch's test
      // makes above.
      expect(button.getAttribute("aria-label")).toBe("Exit full screen");
    } finally {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => undefined,
      });
    }
  });

  /**
   * The stage's aspect toggle, end to end: the shape the author picks has
   * to reach `previewTarget` and reshape the canvas, not merely re-report
   * itself — and, since the aspect is the demo's, reach `scene:put`. A
   * toggle that only moved its own `aria-checked` would look exactly like
   * this one and preview the wrong cut.
   */
  it("redraws the preview as the vertical cut when 9:16 is picked", async () => {
    memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector("#stage-tools [data-aspect-toggle]")) {
        throw new Error("toggle not rendered yet");
      }
      if (!playButton() || playButton().disabled) {
        throw new Error("transport not ready");
      }
    });
    const canvas = document.getElementById("preview") as HTMLCanvasElement;
    expect(canvas.width / canvas.height).toBeCloseTo(16 / 9, 2);
    document
      .querySelector<HTMLButtonElement>('#stage-tools [data-aspect="9:16"]')
      ?.click();
    await vi.waitFor(() =>
      expect(canvas.width / canvas.height).toBeCloseTo(9 / 16, 2),
    );
    // The frame's box follows too: `#stage-frame` sizes itself from this
    // variable, and jsdom lays nothing out, so the canvas ratio above says
    // nothing about the box the stylesheet draws.
    expect(
      document.getElementById("stage")?.style.getPropertyValue("--frame-ratio"),
    ).toBe("1080 / 1920");
    // Saved with the demo, not only drawn: the edit reached scene:put.
    const put = memory.putCalls().at(-1) as
      | { scene: { canvas: { aspect: string } } }
      | undefined;
    expect(put?.scene.canvas.aspect).toBe("9:16");
    expect(
      document
        .querySelector('#stage-tools [data-aspect="9:16"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  /**
   * Two roots, one state: the toolbar's copy of the picture's controls is
   * the one the author presses, and `#stage-bar` is the one full screen
   * shows. A pick in one that left the other on the old shape would have
   * the two disagreeing the moment the author went full screen.
   */
  it("draws the same shape checked on the toolbar and the full-screen bar", async () => {
    memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector("#stage-tools [data-aspect-toggle]")) {
        throw new Error("toolbar's toggle not rendered yet");
      }
    });
    // The premise: the bar does not already show 9:16, or the assertion
    // after the click holds without the pick ever reaching it.
    expect(
      document
        .querySelector('#stage-bar [data-aspect="9:16"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
    document
      .querySelector<HTMLButtonElement>('#stage-tools [data-aspect="9:16"]')
      ?.click();
    await vi.waitFor(() =>
      expect(
        document
          .querySelector('#stage-tools [data-aspect="9:16"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(
      document
        .querySelector('#stage-bar [data-aspect="9:16"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      document
        .querySelector('#stage-bar [data-aspect="16:9"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  /**
   * The half the canvas cannot show. GIF previews at 1280x720/contain, the
   * same bitmap landscape gets, and differs only in the corner radius
   * `derivePresentation` draws from (the inset is the branding's padding
   * since 2026-10-05, the same in every format). A retarget that swapped
   * only on a changed bitmap size would leave landscape's picture under the
   * GIF choice — and would still have swapped correctly coming from
   * Vertical, so the same pick would draw two different pictures
   * depending on the change before it.
   */
  it("hands the compositor GIF's own radius when GIF is picked straight from landscape", async () => {
    memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!document.querySelector('[data-file-type="gif"]')) {
        throw new Error("file type not rendered yet");
      }
      if (composeCalls.length === 0) {
        throw new Error("nothing composed yet");
      }
    });
    // The fixture has to actually be composing landscape first, or the
    // assertion below would pass against a preview that never moved.
    // Read off the presets, not written out: the point of this pair is that
    // the two formats differ in radius (padding is the branding's, the same
    // in both), and a literal here pins the test to whatever the numbers
    // happened to be.
    //
    // The radius is compared PER ROW for the same reason: `previewTarget`
    // scales it with the bitmap's height, which is 720 for landscape here and
    // GIF's own 450 (the cap) — so the literals 12 and 16 this carried were
    // the preset radius at whatever height the bitmap happened to be, and 16
    // was GIF's radius at a 720 bitmap, larger than the GIF itself.
    const radiusPerRow = (t: RenderTarget | undefined) =>
      t ? t.cornerRadius / t.height : Number.NaN;
    expect(radiusPerRow(LANDSCAPE_1080P)).not.toBeCloseTo(
      radiusPerRow(GIF_800),
      4,
    );
    expect(radiusPerRow(composeCalls.at(-1))).toBeCloseTo(
      radiusPerRow(LANDSCAPE_1080P),
      4,
    );

    const box = (fileType: string) =>
      document.querySelector<HTMLInputElement>(
        `[data-file-type="${fileType}"]`,
      );
    // Ticked beside MP4, GIF leaves the preview on the MP4: the preview
    // shows the MP4 whenever it is ticked. Red if a tick moves it.
    box("gif")?.click();
    expect(radiusPerRow(composeCalls.at(-1))).toBeCloseTo(
      radiusPerRow(LANDSCAPE_1080P),
      4,
    );
    // Premise: the tick took (the button names both).
    expect(document.querySelector("[data-export-start]")?.textContent).toBe(
      "Export MP4 + GIF",
    );

    // MP4 unticked: GIF is the first ticked, so the preview is the GIF's.
    box("mp4")?.click();
    expect(radiusPerRow(composeCalls.at(-1))).toBeCloseTo(
      radiusPerRow(GIF_800),
      4,
    );
  });

  // Spec 2026-10-05 §7: dragging Padding moves the preview's frame. The
  // saved document is pinned in editor-main-branding.test.ts; this is the
  // picture the author watches while dragging. Red if the preview keeps a
  // presentation derived before the drag, or draws a padding of its own.
  it("redraws the preview at the dragged padding", async () => {
    // No motion spans, as the costed draws above: the video source needs
    // WebCodecs, and the still source draws through the stub.
    memory.serveBundle(
      proceduralBundle({ motionSpans: [], madeFrom: MADE_FROM }),
      null,
    );
    await import("../../../pages/entrypoints/editor/main");
    const insetOf = () => {
      const t = composeCalls.at(-1);
      const f = drawnFrames.at(-1);
      if (!t || !f) throw new Error("nothing drawn yet");
      return f.y / Math.min(t.width, t.height);
    };
    await vi.waitFor(async () => {
      await pump();
      insetOf();
    });
    // Premise: the fixture draws at the document's 8%, on the tight axis.
    expect(insetOf()).toBeCloseTo(0.08, 6);
    const rail = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        '#rail [data-rail="background"]',
      );
      if (!node) throw new Error("rail not rendered yet");
      return node;
    });
    rail.click();
    const slider = await vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>("[data-padding]");
      if (!node) throw new Error("no Padding slider yet");
      return node;
    });
    slider.value = "0.15";
    slider.dispatchEvent(new Event("input"));
    await vi.waitFor(async () => {
      await pump();
      if (Math.abs(insetOf() - 0.15) > 1e-6) {
        throw new Error(`still drawn at ${insetOf()}`);
      }
    });
  });

  // Review Focus 1 (Auto frame plan). Under Auto the frame's shape follows
  // the padding, so a drag must reshape it while dragging, not on release.
  // Red if `deliverable` sizes the frame from the stored branding.
  it("reshapes an Auto preview while Padding is dragged", async () => {
    memory.serveBundle(
      proceduralBundle({ motionSpans: [], madeFrom: MADE_FROM }),
      null,
    );
    memory.serveScene(() => ({
      ...readonlyScene(),
      canvas: { aspect: "auto" },
    }));
    await import("../../../pages/entrypoints/editor/main");
    const ratio = () => {
      const t = composeCalls.at(-1);
      if (!t) throw new Error("nothing composed yet");
      return t.width / t.height;
    };
    await vi.waitFor(async () => {
      await pump();
      ratio();
    });
    const before = ratio();
    // Premise: the preview is Auto, not 16:9.
    expect(before).not.toBeCloseTo(16 / 9, 2);
    const rail = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>(
        '#rail [data-rail="background"]',
      );
      if (!node) throw new Error("rail not rendered yet");
      return node;
    });
    rail.click();
    const slider = await vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>("[data-padding]");
      if (!node) throw new Error("no Padding slider yet");
      return node;
    });
    slider.value = "0.2";
    slider.dispatchEvent(new Event("input"));
    await vi.waitFor(async () => {
      await pump();
      if (Math.abs(ratio() - before) < 0.01) {
        throw new Error(`still ${ratio()}`);
      }
    });
  });

  /**
   * `toggleZoom` is the entire bridge between the chip and the CSS switch
   * `index.html`'s `body[data-zoom="actual"] #stage` rule reads — nothing
   * else in this repo drives `document.body.dataset.zoom` through the real
   * click. A typo (`document.documentElement.dataset.zoom`, say) or a
   * dropped `renderTransportRow()` call would leave the chip's label frozen
   * or the attribute never set, and every browser-lane test would stay
   * green: they all set `data-zoom` themselves rather than clicking.
   */
  it("boots on fit and flips the zoom attribute and the chip's own label on click", async () => {
    memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
    await import("../../../pages/entrypoints/editor/main");

    const button = await vi.waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(
        "#stage-tools [data-stage-zoom]",
      );
      if (!el) throw new Error("stage bar not rendered yet");
      return el;
    });

    // The boot default, asserted before any click: `document.body.dataset.zoom`
    // is set once at startup precisely so this is never absent.
    expect(document.body.dataset.zoom).toBe("fit");
    expect(button.textContent).toBe("Fit");

    button.click();
    expect(document.body.dataset.zoom).toBe("actual");
    expect(button.textContent).toBe("100%");

    // Assigned, not added: a second click after the chip re-rendered must
    // still flip it, the same "click after a render" shape the full-screen
    // and format-select tests above use to catch a listener that stacked.
    button.click();
    expect(document.body.dataset.zoom).toBe("fit");
    expect(button.textContent).toBe("Fit");
  });

  /**
   * The non-pointer path to the playhead.
   *
   * Specced with the timeline and never built: `Home`/`End` were in the
   * design, and the arrows had already been spent on stepping the selection
   * between beats, so the playhead had no keyboard at all. Shift is what
   * keeps both — plain arrows still move the selection.
   */
  describe("seeking from the keyboard", () => {
    const ready = async () => {
      memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
      await import("../../../pages/entrypoints/editor/main");
      await vi.waitFor(() => {
        if (!playButton() || playButton().disabled) {
          throw new Error("transport not ready");
        }
        if (!document.querySelector("[data-playhead]")) {
          throw new Error("timeline not drawn yet");
        }
      });
    };

    it("jumps to the end and back to the start", async () => {
      await ready();
      expect(playheadLeft()).toBe(0);
      pressKey("End");
      expect(playheadLeft()).toBe(100);
      pressKey("Home");
      expect(playheadLeft()).toBe(0);
    });

    it("jumps to the start from the button, the same as the keys do", async () => {
      // The button exists because a MacBook prints neither Home nor End,
      // and \u2318\u2190 is a chord to remember; this is the same action with a
      // face. It goes through `runShortcut` rather than seeking on its own,
      // so what is pinned here is that the two agree.
      await ready();
      pressKey("End");
      // Fixture guard: the playhead really moved, so the click below has
      // somewhere to come back FROM. Without it a button that did nothing
      // at all would pass.
      expect(playheadLeft()).toBe(100);
      const skip = document.querySelector(
        "[data-transport-skip]",
      ) as HTMLButtonElement;
      expect(skip).not.toBeNull();
      skip.click();
      expect(playheadLeft()).toBe(0);
    });

    it("jumps to the ends on the command key and an arrow, like Home and End", async () => {
      // A MacBook has no Home or End key printed on it. This pair reaches
      // the same place without fn — and it is a command-key press, which
      // every other branch of the table hands back to the browser, so this
      // pins that the handler does NOT stand down for it.
      await ready();
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        pressKey("ArrowRight", modifier);
        expect(playheadLeft()).toBe(100);
        pressKey("ArrowLeft", modifier);
        expect(playheadLeft()).toBe(0);
      }
    });

    it("leaves a shifted command arrow to the browser's own selection", async () => {
      await ready();
      pressKey("ArrowRight", { metaKey: true, shiftKey: true });
      expect(playheadLeft()).toBe(0);
    });

    it("nudges by a tenth of a second on a bare arrow", async () => {
      await ready();
      pressKey("ArrowRight");
      const nudged = playheadLeft();
      expect(nudged).toBeGreaterThan(0);
      // A nudge, not a jump: a tenth of a second is a sliver of any take
      // worth editing, and a binding that had landed on the end instead
      // would clear the first assertion just as well.
      expect(nudged).toBeLessThan(50);
      pressKey("ArrowLeft");
      expect(playheadLeft()).toBe(0);
    });

    it("holds at the take's ends rather than running past them", async () => {
      await ready();
      pressKey("ArrowLeft");
      expect(playheadLeft()).toBe(0);
      pressKey("End");
      pressKey("ArrowRight");
      expect(playheadLeft()).toBe(100);
    });

    // The inverse of the assertion this file carried until 2026-09-19, when
    // the NLE layout was adopted: the bare arrows moved the SELECTION and
    // the shifted pair moved the playhead. Premiere, Resolve and Final Cut
    // all step the playhead on a bare arrow, so the two swapped and the
    // beat step moved to the vertical pair, which is what "previous/next cut
    // point" means on a timeline whose unit is the beat.
    it("moves the playhead on the plain arrows, not the selection", async () => {
      await ready();
      pressKey("ArrowRight");
      expect(playheadLeft()).toBeGreaterThan(0);
      expect(selectedBeat()).toBeNull();
    });

    it("steps the selection between beats on the vertical arrows", async () => {
      await ready();
      pressKey("ArrowDown");
      const first = selectedBeat();
      expect(first).not.toBeNull();
      // ...and the playhead stayed where it was, so the two pairs are
      // genuinely separate rather than one doing both.
      expect(playheadLeft()).toBe(0);
      pressKey("ArrowDown");
      expect(selectedBeat()).not.toBe(first);
      pressKey("ArrowUp");
      expect(selectedBeat()).toBe(first);
    });

    it("moves five times as far on a shifted arrow as on a bare one", async () => {
      await ready();
      pressKey("ArrowRight");
      const fine = playheadLeft();
      pressKey("Home");
      pressKey("ArrowRight", { shiftKey: true });
      const coarse = playheadLeft();
      // The playhead's percentage is written at `toFixed(4)`, so the two
      // readings each carry that rounding; 3 places is well inside it and
      // still far tighter than any other binding could land on.
      expect(coarse).toBeCloseTo(fine * 5, 3);
    });
  });

  describe("shuttling from the keyboard", () => {
    const ready = async () => {
      memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
      await import("../../../pages/entrypoints/editor/main");
      await vi.waitFor(() => {
        if (!playButton() || playButton().disabled) {
          throw new Error("transport not ready");
        }
        if (!document.querySelector("[data-playhead]")) {
          throw new Error("timeline not drawn yet");
        }
      });
    };

    it("starts playing forward on L and stops on K", async () => {
      await ready();
      pressKey("l");
      expect(playName()).toMatch(/pause/i);
      pressKey("k");
      expect(playName()).toMatch(/play/i);
    });

    it("says how fast it is going, so a 4x take is not read as a 1x one", async () => {
      // `preview.ts` refuses to show a transport in a state it is not in.
      // A Pause button beside a take crossing the screen four times as fast
      // would be exactly that.
      await ready();
      pressKey("l");
      pressKey("l");
      const row = document.querySelector("#transport") as HTMLElement;
      expect(row.textContent).toMatch(/2x/i);
    });

    it("says it is going backwards, not just fast", async () => {
      // The row's TEXT used to carry the direction, as "◀ 1x" beside the
      // clock. Since 2026-09-20 the speed rides beside the button that is
      // running and says the magnitude alone, so the direction lives in
      // which control is lit — and, for anyone not looking at the colour,
      // in that control's accessible name. Both are asserted: the light on
      // its own is not available to a reader, and the name on its own would
      // pass on a row where nothing is lit at all.
      await ready();
      pressKey("End");
      pressKey("j");
      const back = document.querySelector(
        '[data-transport-shuttle="-1"]',
      ) as HTMLElement;
      const forward = document.querySelector(
        '[data-transport-shuttle="1"]',
      ) as HTMLElement;
      const play = playButton() as HTMLElement;
      expect(back.hasAttribute("data-active")).toBe(true);
      expect(back.getAttribute("aria-label")).toMatch(/backwards/i);
      // And it is the ONLY one lit: "backwards" means this control rather
      // than that one, which a check on rewind alone cannot say.
      expect(forward.hasAttribute("data-active")).toBe(false);
      expect(play.hasAttribute("data-active")).toBe(false);
    });

    it("drops the rate readout once the shuttle stops", async () => {
      await ready();
      pressKey("l");
      pressKey("l");
      pressKey("k");
      const row = document.querySelector("#transport") as HTMLElement;
      expect(row.textContent).not.toMatch(/2x/i);
    });
  });

  describe("the timeline window from the keyboard", () => {
    const ready = async () => {
      memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
      await import("../../../pages/entrypoints/editor/main");
      await vi.waitFor(() => {
        if (!document.querySelector("[data-playhead]")) {
          throw new Error("timeline not drawn yet");
        }
      });
    };

    const snapButton = (): HTMLElement =>
      document.querySelector("[data-snap]") as HTMLElement;

    /** Park the playhead inside the take, not on an end: ten shifted nudges
     *  is 5s into a ~9s take. A zoom is anchored on the playhead, and at
     *  either end the clamp — not the factor — decides where the window
     *  lands. */
    const parkMidTake = (): void => {
      pressKey("Home");
      for (let i = 0; i < 10; i += 1)
        pressKey("ArrowRight", { shiftKey: true });
    };

    /**
     * How far one 100ms nudge moves the playhead, as a percentage of the
     * timeline's width — which is to say, how wide the window is.
     *
     * The window has no direct readout, and the two obvious proxies both
     * fail here. The playhead's own percentage cannot move: the zoom is
     * anchored on it, so holding the instant under it still is precisely
     * what a correct zoom does. A beat's position would work, but the clip
     * lane is rebuilt on each of the boot's four replies and this harness
     * regularly catches it holding one tick rather than the take's three —
     * a flake about rendering, in a test about a keystroke.
     *
     * A fixed nudge is immune to both. At fit it crosses 100ms of the whole
     * take; zoomed in by `ZOOM_STEP` it crosses 100ms of a window that is
     * `ZOOM_STEP` times narrower, so it covers `ZOOM_STEP` times as much of
     * the width. The playhead is put back afterwards, so the anchor the next
     * zoom uses is the one this measurement started from.
     */
    const nudgeSpan = (): number => {
      const before = playheadLeft();
      pressKey("ArrowRight");
      const after = playheadLeft();
      pressKey("ArrowLeft");
      return after - before;
    };

    /**
     * The magnifier buttons are drawn by a full render, and a nudge or a
     * playing clock only repaints the transport row — so a click read the
     * playhead from whenever the timeline was last rebuilt, and zoomed
     * about that instant instead of the one on screen. Verified failable:
     * passing `player.positionMs` as a plain value again moves the anchor.
     */
    it("zooms the magnifier about the live playhead, as + does", async () => {
      await ready();
      parkMidTake();
      const anchor = playheadLeft();
      const fitted = nudgeSpan();
      // Premise: the nudges moved the playhead off where the last full
      // render saw it (the head), so a stale anchor would show.
      expect(anchor).toBeGreaterThan(1);
      expect(anchor).toBeLessThan(99);

      (
        document.querySelector('[data-zoom-step="in"]') as HTMLButtonElement
      ).click();
      expect(nudgeSpan() / fitted).toBeCloseTo(ZOOM_STEP, 2);
      expect(playheadLeft()).toBeCloseTo(anchor, 2);
    });

    it("zooms in on + and back out on -, landing where it started", async () => {
      await ready();
      parkMidTake();
      const anchor = playheadLeft();
      const fitted = nudgeSpan();
      // Fixture guards: a zoom anchored on the playhead says nothing while
      // the playhead is pinned to an edge, and a nudge that moved nothing
      // would make every ratio below 0/0.
      expect(anchor).toBeGreaterThan(1);
      expect(anchor).toBeLessThan(99);
      expect(fitted).toBeGreaterThan(0);

      pressKey("+");
      // One press narrows the window by exactly the factor the trackpad's
      // ⌘-scroll uses, so the two gestures agree about one step.
      expect(nudgeSpan() / fitted).toBeCloseTo(ZOOM_STEP, 2);
      // ...and the instant under the playhead stayed under the playhead.
      expect(playheadLeft()).toBeCloseTo(anchor, 2);

      pressKey("-");
      expect(nudgeSpan()).toBeCloseTo(fitted, 4);
      expect(playheadLeft()).toBeCloseTo(anchor, 2);
    });

    it("zooms on the = key too, which is where + is printed", async () => {
      // A US keyboard sends "=" unless shift is held, so binding the printed
      // character alone leaves the author pressing the key under the + and
      // getting nothing.
      await ready();
      parkMidTake();
      const fitted = nudgeSpan();
      pressKey("=");
      expect(nudgeSpan() / fitted).toBeCloseTo(ZOOM_STEP, 2);
    });

    it("fits the whole take on a shifted Z", async () => {
      await ready();
      parkMidTake();
      const fitted = nudgeSpan();
      pressKey("+");
      pressKey("+");
      expect(nudgeSpan()).toBeGreaterThan(fitted * 1.3);
      pressKey("Z", { shiftKey: true });
      expect(nudgeSpan()).toBeCloseTo(fitted, 4);
    });

    it("keeps the command key's shifted Z on redo rather than fit", async () => {
      // The one collision in the map: ⇧Z fits, ⌘⇧Z redoes. They differ only
      // by the modifier, so a table that read the modifier loosely would put
      // the author's redo on the timeline's window.
      await ready();
      parkMidTake();
      const fitted = nudgeSpan();
      pressKey("+");
      const zoomed = nudgeSpan();
      pressKey("Z", { shiftKey: true, metaKey: true });
      expect(nudgeSpan()).toBeCloseTo(zoomed, 4);
      expect(nudgeSpan()).not.toBeCloseTo(fitted, 4);
    });

    it("toggles snapping on S, and the bar says which way it is set", async () => {
      await ready();
      expect(snapButton().getAttribute("data-snap")).toBe("on");
      pressKey("s");
      expect(snapButton().getAttribute("data-snap")).toBe("off");
      pressKey("s");
      expect(snapButton().getAttribute("data-snap")).toBe("on");
    });
  });

  // Keyboard shortcuts, one of the inspector's panels since 2026-10-19 (a
  // modal, then a panel of its own, before that).
  describe("the shortcuts overlay", () => {
    const ready = async () => {
      memory.serveBundle(proceduralBundle({ madeFrom: MADE_FROM }), null);
      await import("../../../pages/entrypoints/editor/main");
      await vi.waitFor(() => {
        if (!document.querySelector("[data-playhead]")) {
          throw new Error("timeline not drawn yet");
        }
      });
    };

    // The list as the author sees it: drawn in the inspector, with the
    // inspector open. A closed inspector keeps its last panel's contents.
    const overlay = (): HTMLElement | null =>
      document.body.dataset.panel === "open"
        ? document.querySelector("#inspector [data-shortcuts]")
        : null;

    it("stays out of the way until it is asked for", async () => {
      await ready();
      expect(overlay()).toBeNull();
    });

    it("opens on ? and lists the bindings", async () => {
      await ready();
      pressKey("?");
      const help = overlay();
      expect(help).not.toBeNull();
      // Every line comes from the same table `resolveShortcut` reads, so
      // this cannot drift from what the keys actually do.
      expect(help?.textContent).toMatch(/Space/);
      expect(help?.textContent).toMatch(/Shuttle/i);
      expect(help?.querySelectorAll("[data-shortcut-row]").length).toBe(
        SHORTCUT_LEGEND.length,
      );
    });

    // The author, 2026-10-19: Escape undoes the innermost thing, one press
    // each — the selection, then the panel. Red: let one Escape do both.
    it("takes a selection away on Escape, then closes the panel on the next", async () => {
      await ready();
      pressKey("?");
      pressKey("ArrowDown");
      const beat = selectedBeat();
      expect(beat).not.toBeNull();
      pressKey("Escape");
      expect(selectedBeat()).toBeNull();
      // One Escape, one effect: the rail is back on the list, still open.
      expect(overlay()).not.toBeNull();
      pressKey("Escape");
      expect(overlay()).toBeNull();
    });

    it("closes any panel on Escape with nothing selected", async () => {
      await ready();
      // Premise: the editor opens on Export, open.
      expect(document.body.dataset.panel).toBe("open");
      expect(
        document.querySelector("#inspector [data-panel-export]"),
      ).not.toBeNull();
      pressKey("Escape");
      expect(document.body.dataset.panel).toBe("closed");
    });

    it("lets a field take Escape first, then the editor", async () => {
      await ready();
      const name = document.getElementById("name") as HTMLInputElement;
      name.focus();
      name.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      // The field is left; the panel is not touched by that press.
      expect(document.activeElement).not.toBe(name);
      expect(document.body.dataset.panel).toBe("open");
    });

    it("closes on a second ?", async () => {
      await ready();
      pressKey("?");
      pressKey("?");
      expect(overlay()).toBeNull();
    });

    it("names the command key for the keyboard the page is open on", async () => {
      // jsdom's user agent is not a Mac, which is the case this asserts:
      // the binding really is Ctrl there, and ⌘ would name a key the author
      // does not have. The Mac side is covered below.
      await ready();
      pressKey("?");
      expect(overlay()?.textContent).toMatch(/Ctrl/);
      expect(overlay()?.textContent).not.toMatch(/\u2318/);
    });

    it("names it \u2318 on a Mac", async () => {
      const real = navigator.userAgent;
      Object.defineProperty(navigator, "userAgent", {
        value:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        configurable: true,
      });
      try {
        await ready();
        pressKey("?");
        expect(overlay()?.textContent).toMatch(/\u2318/);
        expect(overlay()?.textContent).not.toMatch(/Ctrl\b/);
      } finally {
        Object.defineProperty(navigator, "userAgent", {
          value: real,
          configurable: true,
        });
      }
    });

    // The author, 2026-10-19: a side panel, so the editor's keys work with
    // it open: try one, look back at the list. Red: refuse keys while
    // `helpOpen` again.
    it("leaves every key working while it is open", async () => {
      await ready();
      pressKey("?");
      expect(overlay()).not.toBeNull();
      expect(playName()).toBe("Play");
      pressKey(" ");
      expect(playName()).toBe("Pause");
      // ...and the list stayed open for the next look.
      expect(overlay()).not.toBeNull();
    });

    it("hands keys typed into its search to the search", async () => {
      await ready();
      pressKey("?");
      const field = overlay()?.querySelector(
        "[data-shortcuts-search]",
      ) as HTMLInputElement;
      // Premise: the field is where the keys go.
      expect(document.activeElement).toBe(field);
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
      expect(playName()).toBe("Play");
    });
  });
});
