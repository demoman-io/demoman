import type { exportTake as ExportTake } from "@demoman/runner/studio";
import { readUserSettings } from "@demoman/runner/studio";
import type { RunExport } from "./queue.js";

type Deps = Parameters<typeof ExportTake>[1];

/**
 * The studio's `run`: `exportTake` with the user's Export quality, read from
 * `<home>/settings.json` on each export so a change on the Settings page
 * applies to the next one. A file or value that cannot be read exports at
 * share (the default) and the log says why: never silently.
 *
 * Only an MP4 has a quality; a GIF or stills export refuses one, so none is
 * passed for them.
 */
export function createRunExport(a: {
  exportTake: typeof ExportTake;
  deps: Omit<Deps, "jobId">;
}): RunExport {
  const { exportTake, deps } = a;
  return async (takeId, fileType, jobId, onProgress) => {
    const settings = await readUserSettings(deps.home);
    if (settings.problems?.exportQuality !== undefined) {
      deps.log(
        `studio: exporting at Sharing quality: ${settings.problems.exportQuality}`,
      );
    }
    return exportTake(
      {
        takeId,
        fileType,
        ...(fileType === "mp4" ? { quality: settings.exportQuality } : {}),
      },
      { ...deps, jobId },
      onProgress,
    );
  };
}
