// apps/studio/pages/src/library/preview.ts
import type { KeyframeEntry } from "@demoman/compositor";
import { type EditedLength, formatLength } from "./length";

/**
 * How many keyframes one row's flipbook may hold.
 *
 * Every frame here is a full-viewport JPEG decode, paid per hovered row, so
 * the cap is what keeps a long take from costing forty of them. Eight at
 * PREVIEW_FRAME_MS reads as a ~3 second loop, which is long enough to show
 * where a demo goes and short enough to repeat while the pointer rests.
 */
export const PREVIEW_FRAME_CAP = 8;

/** One sampled frame: the ref to load, and when in the take it was taken. */
export interface PreviewFrame {
  ref: string;
  sourceTimeMs: number;
}

/**
 * Up to `cap` keyframes spread evenly across the take, first and last kept.
 *
 * Evenly rather than the first `cap`: a take's keyframes are one per action,
 * and the first eight of forty are all the opening seconds of a long demo —
 * a preview of the login screen for every demo that starts at one.
 */
export function sampleKeyframes(
  keyframes: readonly KeyframeEntry[],
  cap: number,
): PreviewFrame[] {
  const pick = (k: KeyframeEntry): PreviewFrame => ({
    ref: k.ref,
    sourceTimeMs: k.sourceTimeMs,
  });
  if (keyframes.length <= cap) return keyframes.map(pick);
  // Selected by index set and filtered, rather than read out by index: the
  // indices below are provably in range, and indexing would need a non-null
  // assertion or a guard that can never fire to say so. A wrong step shows
  // up as a short or misplaced result, which the tests assert exactly.
  const step = cap > 1 ? (keyframes.length - 1) / (cap - 1) : 0;
  const wanted = new Set(
    Array.from({ length: Math.max(0, cap) }, (_, i) => Math.round(i * step)),
  );
  return keyframes.filter((_, i) => wanted.has(i)).map(pick);
}

/**
 * What a row's preview box currently is.
 *
 * Four of these five are not a picture, and each is a different fact about
 * the demo: nothing was ever stored for it, something was stored and holds
 * no keyframes, the read threw, or the read is still running. They are kept
 * apart here rather than collapsed into one "no preview" so the box can say
 * which — see `previewText`.
 */
export type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; frames: PreviewFrame[] }
  | { kind: "noBundle" }
  | { kind: "noKeyframes" }
  | { kind: "failed"; reason: string };

/** The bundle fields a preview reads. Narrowed so tests need no whole bundle. */
export type PreviewBundle = { keyframes: readonly KeyframeEntry[] };

export function previewFromBundle(bundle: PreviewBundle | null): PreviewState {
  // `null` is the background's answer for a scene no bundle row names, and
  // an empty `keyframes` is a row that exists and holds none. The frame
  // store casts rows rather than parsing them, so the schema's
  // "at least one keyframe" refinement never runs on a read and the second
  // case is reachable on disk.
  if (bundle === null) return { kind: "noBundle" };
  if (bundle.keyframes.length === 0) return { kind: "noKeyframes" };
  return {
    kind: "ready",
    frames: sampleKeyframes(bundle.keyframes, PREVIEW_FRAME_CAP),
  };
}

/**
 * The sentence the preview box shows, or null when there is a picture.
 *
 * No `??` fallback and no shared default: a fallback that fires whether or
 * not anything is wrong is how two of these outcomes would come to read
 * alike, and the point of the union above is that they must not.
 */
export function previewText(state: PreviewState): string | null {
  switch (state.kind) {
    case "ready":
      return null;
    case "loading":
      return "Loading preview…";
    case "noBundle":
      return "No frames stored — nothing to preview.";
    case "noKeyframes":
      return "This demo has no keyframes.";
    case "failed":
      return `Preview unavailable — ${state.reason}`;
  }
}

/**
 * How long one flipbook frame rests before the next.
 *
 * A keyframe is one action, so this is a flipbook of steps rather than a
 * playback of the take — 400ms reads as deliberate rather than as a
 * stuttering video, which is the honest thing for a picture that is not one.
 */
export const PREVIEW_FRAME_MS = 400;

/** The next frame in the loop. `0` when there is no frame to move to, so a
 *  one-frame or empty flipbook holds rather than running off the end. */
export function advanceFrame(index: number, count: number): number {
  if (count <= 1) return 0;
  return (index + 1) % count;
}

/**
 * Put a state into a row's preview box.
 *
 * Both halves are set on every call, never only the one that changed: a
 * note left standing over a canvas that later succeeded is the same defect
 * as the library page's `#notice` banner, which used to survive the pass it
 * was written for and told authors their successful delete had failed.
 */
export function applyPreviewState(box: HTMLElement, state: PreviewState): void {
  const canvas = box.querySelector(
    "[data-preview-canvas]",
  ) as HTMLCanvasElement | null;
  const note = box.querySelector("[data-preview-note]") as HTMLElement | null;
  const text = previewText(state);
  if (canvas !== null) canvas.hidden = text !== null;
  if (note !== null) note.textContent = text ?? "";
}

/** How wide a thumbnail is drawn, in device pixels. The height follows the
 *  keyframe's own aspect ratio — a preview letterboxed by CSS is honest
 *  about the demo's shape, one stretched to a fixed box is not. */
export const PREVIEW_WIDTH_PX = 320;

export interface PreviewPorts<B extends PreviewBundle = PreviewBundle> {
  /** The scene's active bundle, or null when no row names it. */
  bundle(sceneId: string): Promise<B | null>;
  /**
   * How long the take's export runs, for the badge on the thumbnail.
   *
   * Handed the bundle the preview already read rather than reading its
   * own: a second `bundle:active` per card would double the page's
   * messages for a number the first read already holds. A port because it
   * needs the scene document too, which the page holds and this does not.
   */
  length(sceneId: string, bundle: B): Promise<EditedLength>;
  /**
   * One keyframe ref, decoded.
   *
   * The bitmap becomes the mounter's to close — it is drawn down to a
   * thumbnail and released immediately, because a library of full-viewport
   * bitmaps would otherwise stay live for the life of the page. So every
   * call must mint a FRESH bitmap; handing back a shared one leaves the
   * second caller drawing a detached image, which paints nothing.
   */
  image(ref: string): Promise<ImageBitmap>;
  /**
   * Run `paint` once the box is worth painting, and return a cancel.
   *
   * A port rather than an IntersectionObserver in here so a library of
   * thirty demos decodes only what is on screen while a test can still say
   * "now" without racing an observer.
   */
  whenVisible(box: HTMLElement, paint: () => void): () => void;
}

export interface PreviewMounter {
  mount(sceneId: string, box: HTMLElement): void;
  /** Stop every mounted row: intervals cleared, listeners removed. The
   *  library re-renders its whole list on each action, so without this each
   *  pass would leave the previous pass's flipbooks running. */
  dispose(): void;
}

export function createPreviewMounter<B extends PreviewBundle>(
  ports: PreviewPorts<B>,
): PreviewMounter {
  const teardown: Array<() => void> = [];
  let disposed = false;

  function mount(sceneId: string, box: HTMLElement): void {
    const canvas = box.querySelector(
      "[data-preview-canvas]",
    ) as HTMLCanvasElement | null;
    if (canvas === null) {
      // Not forgiven silently: the box comes from `previewBox()` in this
      // same module's view, so a box without a canvas means that markup
      // changed out from under this and every row would show a permanent
      // "Loading preview…" with nothing to say why.
      console.error(
        `demoman library: preview box for ${sceneId} has no canvas to paint into`,
      );
      applyPreviewState(box, {
        kind: "failed",
        reason: "this row has no canvas to paint into",
      });
      return;
    }

    let frames: PreviewFrame[] = [];
    const cache: Array<HTMLCanvasElement | undefined> = [];
    let index = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopTimer = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    teardown.push(stopTimer);

    const fail = (what: string, error: unknown): void => {
      stopTimer();
      // `console.error`, not `warn`: this page is an extension page, where
      // `error` is the level that reaches the chrome://extensions Errors
      // list, and a keyframe on disk that will not decode is a real fault.
      console.error(`demoman library: ${what} for ${sceneId} —`, error);
      applyPreviewState(box, {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    };

    const thumbnail = async (i: number): Promise<HTMLCanvasElement> => {
      const cached = cache[i];
      if (cached !== undefined) return cached;
      const frame = frames[i];
      // Thrown rather than skipped: every caller of this routes a throw to
      // `fail`, which names it in the box. A silently skipped frame would
      // freeze the flipbook with nothing saying why.
      if (frame === undefined) {
        throw new Error(`preview frame ${i} is past the end of the take`);
      }
      const bitmap = await ports.image(frame.ref);
      const small = document.createElement("canvas");
      small.width = PREVIEW_WIDTH_PX;
      small.height = Math.max(
        1,
        Math.round((PREVIEW_WIDTH_PX * bitmap.height) / bitmap.width),
      );
      small
        .getContext("2d")
        ?.drawImage(bitmap, 0, 0, small.width, small.height);
      // A full-viewport keyframe bitmap dwarfs the thumbnail drawn from it,
      // and thirty rows of them would stay live for the life of the page.
      // Only the small canvas survives the decode.
      bitmap.close();
      cache[i] = small;
      return small;
    };

    const show = async (i: number): Promise<void> => {
      const small = await thumbnail(i);
      if (disposed) return;
      canvas.width = small.width;
      canvas.height = small.height;
      // The library's CSS sizes the canvas to the picture inside its 16:9
      // box with this, so the picture's own edge can be drawn.
      canvas.style.setProperty(
        "--thumb-ratio",
        String(small.width / small.height),
      );
      canvas.getContext("2d")?.drawImage(small, 0, 0);
    };

    const tick = (): void => {
      index = advanceFrame(index, frames.length);
      show(index).catch((error: unknown) => fail("drawing a keyframe", error));
    };

    /**
     * There is deliberately no `prefers-reduced-motion` gate here.
     *
     * That setting is aimed at decorative motion the viewer did not ask
     * for. This flipbook never autoplays: it runs only while the pointer
     * rests on the row or the row holds focus, which makes it user-initiated
     * playback of the content itself — the same category as a video someone
     * presses play on, and the same thing YouTube's own hover previews do
     * under reduced motion. A gate here was tried and removed on
     * 2026-09-13: it silently froze every preview for authors who had the
     * setting on, and looked exactly like a feature that did not work.
     *
     * A single-frame take skips the timer because the picture would be
     * identical either way — nothing is being withheld, there is simply no
     * second frame to show.
     */
    const start = (): void => {
      if (timer !== null || frames.length <= 1) return;
      timer = setInterval(tick, PREVIEW_FRAME_MS);
    };

    const rest = (): void => {
      stopTimer();
      index = 0;
      show(0).catch((error: unknown) =>
        fail("drawing the first keyframe", error),
      );
    };

    const listen = (): void => {
      // The whole card, not the thumbnail inside it: an author whose pointer
      // is anywhere on the row — reading the name, reaching for Edit — has
      // already shown interest in this demo, and should not have to find the
      // picture to make it move. `mouseenter`/`mouseleave` do not bubble, so
      // this has to be bound to the card itself rather than delegated.
      const article = box.closest("article");
      if (article === null) {
        // Not forgiven silently: the box comes from `previewBox()`, which
        // only ever builds one inside a row, so a box with no card around it
        // means that markup moved — and the preview would then answer to
        // nothing at all, looking exactly like a still image.
        console.error(
          `demoman library: preview box for ${sceneId} has no row to hover`,
        );
        return;
      }
      article.addEventListener("mouseenter", start);
      article.addEventListener("mouseleave", rest);
      // Focus as well as hover, so the flipbook is reachable by keyboard:
      // tabbing to the row's own Edit button runs it.
      article.addEventListener("focusin", start);
      article.addEventListener("focusout", rest);
      teardown.push(() => {
        article.removeEventListener("mouseenter", start);
        article.removeEventListener("mouseleave", rest);
        article.removeEventListener("focusin", start);
        article.removeEventListener("focusout", rest);
      });
    };

    /**
     * The duration badge, after the first frame is up: the picture is what
     * the author is waiting on, the number can follow it.
     *
     * The badge stays hidden unless there is a length, and each way of not
     * having one says why: a take with nothing left to render at `info` —
     * the author made that on purpose, and the export says so in its own
     * words — and a length that could not be worked out at `warn`. An
     * absent badge alone would read the same for both, and the same as a
     * page that never asked.
     */
    const measure = (bundle: B): void => {
      const badge = box.querySelector("[data-duration]") as HTMLElement | null;
      if (badge === null) {
        console.error(
          `demoman library: preview box for ${sceneId} has no duration badge`,
        );
        return;
      }
      ports
        .length(sceneId, bundle)
        .then((length) => {
          if (disposed) return;
          if (length.kind === "nothing") {
            console.info(
              `demoman library: no length on ${sceneId}'s card — ${length.reason}`,
            );
            return;
          }
          badge.textContent = formatLength(length.ms);
          badge.title = "Length of the exported video";
          badge.hidden = false;
        })
        .catch((error: unknown) => {
          console.warn(
            `demoman library: could not work out ${sceneId}'s length —`,
            error,
          );
        });
    };

    const load = async (): Promise<void> => {
      let bundle: B | null;
      try {
        bundle = await ports.bundle(sceneId);
      } catch (error) {
        fail("reading the frame bundle", error);
        return;
      }
      if (disposed) return;
      const state = previewFromBundle(bundle);
      if (state.kind !== "ready") {
        applyPreviewState(box, state);
        return;
      }
      frames = state.frames;
      try {
        await show(0);
      } catch (error) {
        fail("drawing the first keyframe", error);
        return;
      }
      if (disposed) return;
      applyPreviewState(box, state);
      listen();
      // Never null here — `previewFromBundle` answers `noBundle` for that —
      // and narrowed rather than cast so the compiler holds it to that.
      if (bundle !== null) measure(bundle);
    };

    teardown.push(
      ports.whenVisible(box, () => {
        void load();
      }),
    );
  }

  return {
    mount,
    dispose(): void {
      disposed = true;
      for (const undo of teardown) undo();
      teardown.length = 0;
    },
  };
}
