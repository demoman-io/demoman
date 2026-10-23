import type { exportTake as ExportTake } from "@demoman/runner/studio";
import type { RunExport } from "./queue.js";

type Deps = Parameters<typeof ExportTake>[1];

/**
 * The studio's `run`: `exportTake` with the editor's quality for this
 * export when it sent one. Without one `exportTake` reads the user's Export
 * quality from `<home>/settings.json` on each export, so a change on the
 * Settings page applies to the next one, and a file it cannot read exports
 * at the default and says why in the summary and the log: never silently.
 *
 * Only an MP4 has a quality; the route refuses one on a GIF or stills.
 */
export function createRunExport(a: {
  exportTake: typeof ExportTake;
  deps: Omit<Deps, "jobId">;
}): RunExport {
  const { exportTake, deps } = a;
  return (takeId, fileType, jobId, onProgress, quality) =>
    exportTake(
      { takeId, fileType, ...(quality === undefined ? {} : { quality }) },
      { ...deps, jobId },
      onProgress,
    );
}
