import type { FrameBundle } from "@demoman/compositor";
import { messageOf } from "../report.js";
import type { Library } from "./library.js";
import type { VideoRecord, VideoStore } from "./videos.js";

/** A flow's latest video, as `latestOf` answers it. */
export type LatestVideo = Awaited<ReturnType<typeof latestOf>>;

/**
 * The size a flow's later runs lay the page out at: what its latest video's
 * run reported (`report.size`), decided on the flow's first run and read here
 * rather than asked of the screen again (spec 2026-11-13 part 1). The latest
 * is the one a re-record builds from (`refilmFromVideo`), so the two agree.
 *
 * `size` is absent when there is nothing to carry: no video yet, or a size
 * measured off the window because the screen could not be read (`window`,
 * which a later run asks the screen about again). A report that cannot be
 * read does not stop the run; it records as a first run would and `why` says
 * so, for the caller to log.
 */
export async function flowSizeOf(
  store: VideoStore,
  library: Library,
  video: VideoRecord,
  /** The flow's latest video when the caller has already asked: listing a
   *  flow's versions reads the whole library. */
  known?: Promise<LatestVideo>,
): Promise<{ size?: { width: number; height: number }; why?: string }> {
  try {
    const latest = await (known ?? latestOf(store, video));
    if (latest === undefined) return {};
    const read = await library.getJson(latest.takeId, "report.json");
    if (!("value" in read)) {
      return {
        why: `video ${latest.takeId}'s run report ${"missing" in read ? "is missing" : `could not be read (${read.unreadable})`}`,
      };
    }
    const size = (read.value as { size?: unknown } | null)?.size as
      | { width?: unknown; height?: unknown; from?: unknown }
      | null
      | undefined;
    if (size === null || size === undefined) {
      return { why: `video ${latest.takeId}'s run report names no size` };
    }
    if (size.from === "window") return {};
    const { width, height } = size;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !(width >= 1) ||
      !(height >= 1)
    ) {
      return {
        why: `video ${latest.takeId}'s run report names a size that is not one (${JSON.stringify(size)})`,
      };
    }
    return { size: { width, height } };
  } catch (error) {
    return {
      why: `the flow's latest video could not be read (${messageOf(error)})`,
    };
  }
}

/** The flow's latest video: its last complete one, else its last. The size
 *  and the scale a later run reads come from it, and a re-record builds from
 *  it (`refilmFromVideo`): one choice, made here. */
export async function latestOf(store: VideoStore, video: VideoRecord) {
  const all = await store.versions(video.id);
  return all.filter((v) => v.complete).at(-1) ?? all.at(-1);
}

/**
 * The scale a flow's later headless runs record motion at: what its latest
 * video recorded (`meta.capture.displayScale`, as `keep` reads it), so a flow
 * first recorded at 1x stays 1x when the constant says 2 (spec 2026-11-13
 * part 2). Absent with no video yet. A video that does not say, or cannot be
 * read, is `why`, for the run to say where it records at the constant.
 */
export async function flowScaleOf(
  store: VideoStore,
  library: Library,
  video: VideoRecord,
  known?: Promise<LatestVideo>,
): Promise<{ scale?: number; why?: string }> {
  try {
    const latest = await (known ?? latestOf(store, video));
    if (latest === undefined) return {};
    const scene = await library.getScene(latest.takeId);
    if (scene === null) return { why: `video ${latest.takeId} is missing` };
    const { displayScale, viewport } = scene.meta.capture;
    const scale =
      displayScale ??
      filmedScale(
        await library.frameStore(latest.takeId).getBundle(latest.takeId),
        viewport.width,
      );
    return scale === null
      ? {
          why: `video ${latest.takeId} does not say the scale it was recorded at and has no motion frames to read one from`,
        }
      : { scale };
  } catch (error) {
    return {
      why: `the flow's latest video could not be read (${messageOf(error)})`,
    };
  }
}

/**
 * The scale the take's motion was filmed at, or null with no motion frames:
 * for takes filmed before `meta.capture.displayScale` was recorded.
 * Screencast spans follow the display's DPR; `meta.capture.dpr` is
 * REPLAY_DPR on every authored take, the stills' scale, not the display's.
 * The widest span, since the encoder may keep a span smaller than it
 * arrived; to the nearest quarter, since an encoder's even-pixel width is
 * not another display and displays come at 1, 1.25, 1.5, 2; never under 1.
 */
export function filmedScale(
  bundle: FrameBundle | null,
  viewportWidth: number,
): number | null {
  const widest = Math.max(
    0,
    ...(bundle?.motionSpans ?? []).map((s) => s.width),
  );
  if (widest === 0) return null;
  return Math.max(1, Math.round((widest / viewportWidth) * 4) / 4);
}
