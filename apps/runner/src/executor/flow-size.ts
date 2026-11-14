import { messageOf } from "../report.js";
import type { Library } from "./library.js";
import type { VideoRecord, VideoStore } from "./videos.js";

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
): Promise<{ size?: { width: number; height: number }; why?: string }> {
  try {
    const all = await store.versions(video.id);
    const latest = all.filter((v) => v.complete).at(-1) ?? all.at(-1);
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
