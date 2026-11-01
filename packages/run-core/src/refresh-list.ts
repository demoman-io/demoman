// demoman-refresh.json: what one `demoman refresh --out-dir` made. The one
// format a user's own upload step and a future Demoman uploader both read.
import type { KeptDeliver } from "./kept/file.js";
import type { FilmedCode } from "./replay/report.js";

export const REFRESH_LIST_FILE = "demoman-refresh.json";
export const REFRESH_LIST_VERSION = 1;

export type RefreshListEntry = {
  flow: string | null;
  name: string;
  /** The kept file, repo-relative. */
  kept: string;
  deliver: KeptDeliver | null;
  /** The new film's take id; null when nothing was filmed clean. */
  video: string | null;
  filmedCode: FilmedCode | null;
  outcome: "changed" | "added" | "uncompared" | "unchanged" | "failed";
  /** Why it failed, or what the comparison found. */
  detail: string;
  /** The film the committed (or previously delivered) judged output is: the
   *  receipt's video, and the commit this run filmed and whether its tree
   *  was dirty (null with no commit). */
  sameAs: {
    video: string;
    commit: string | null;
    dirty: boolean | null;
  } | null;
  /** What this run wrote: a `files` flow's names, relative to the folder
   *  the list is in; a `commit` flow's repo paths. */
  files: Array<{
    path: string;
    fileType: "mp4" | "gif" | "json";
    aspect: "auto" | "16:9" | "9:16" | null;
  }>;
  report: unknown | null;
};

export type RefreshList = {
  refreshVersion: 1;
  videos: RefreshListEntry[];
};

/** The part of a refresh result the list is made from. */
export type RefreshListSource = {
  videos: Array<
    Omit<RefreshListEntry, "kept" | "sameAs"> & {
      file: string;
      sameAs: { video: string } | null;
    }
  >;
};

export function refreshListOf(result: RefreshListSource): RefreshList {
  return {
    refreshVersion: REFRESH_LIST_VERSION,
    videos: result.videos.map((v) => ({
      flow: v.flow,
      name: v.name,
      kept: v.file,
      deliver: v.deliver,
      video: v.video,
      filmedCode: v.filmedCode,
      outcome: v.outcome,
      detail: v.detail,
      // The commit is this run's, decided once by the run report.
      sameAs:
        v.sameAs === null
          ? null
          : {
              video: v.sameAs.video,
              ...(v.filmedCode !== null && "commit" in v.filmedCode
                ? { commit: v.filmedCode.commit, dirty: v.filmedCode.dirty }
                : { commit: null, dirty: null }),
            },
      files: v.files,
      report: v.report,
    })),
  };
}

export function serializeRefreshList(l: RefreshList): string {
  return `${JSON.stringify(l, null, 2)}\n`;
}
