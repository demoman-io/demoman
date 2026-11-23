import {
  isRecordingFrameRate,
  RECORDING_FRAME_RATE_DEFAULT,
  RECORDING_FRAME_RATE_VALUES,
  type RecordingFrameRate,
} from "@demoman/run-core";
import { findDemomanFile } from "./accounts.js";
import { REPO_CONFIG } from "./pull-requests.js";
import { settingsObject } from "./user-settings.js";

export type RecordingFrameRateSetting =
  | {
      value: RecordingFrameRate;
      from: "repo" | "default";
      file?: string;
      /** The repo's file could not be read or parsed at all, so `value` is
       *  the default; the sentence names the file and why. */
      unread?: string;
    }
  /** A `recordingFrameRate` that is not one of the choices, which refuses a
   *  run. `file` null: no file was read, because the `project` status was
   *  given could not be used (`unreadable` says why). */
  | { unreadable: string; file: string | null };

/**
 * The recording frame rate: the repo's `.demoman/config.json`, else
 * `RECORDING_FRAME_RATE_DEFAULT`. Repo only (ruling B, 2026-11-23), so every
 * machine and CI record a repo at the same rate. A value that is not one of
 * the choices answers `unreadable` naming the file; a file that cannot be
 * read or parsed at all is the default with `unread` saying why (ruling A).
 */
export async function resolveRecordingFrameRate(
  from: string,
): Promise<RecordingFrameRateSetting> {
  const repo = await findDemomanFile(from, REPO_CONFIG);
  const unread = (why: string, file: string) =>
    ({
      value: RECORDING_FRAME_RATE_DEFAULT,
      from: "default",
      unread: why,
      file,
    }) as const;
  if (repo.kind === "unreadable") {
    return unread(`${repo.path} could not be read (${repo.detail})`, repo.path);
  }
  if (repo.kind === "found") {
    const raw = settingsObject(repo.path, repo.text);
    if ("unreadable" in raw) return unread(raw.unreadable, repo.path);
    const value = raw.object.recordingFrameRate;
    if (value !== undefined) {
      if (!isRecordingFrameRate(value)) {
        return {
          unreadable: `${repo.path}: recordingFrameRate must be ${RECORDING_FRAME_RATE_VALUES.join(" or ")}; got ${JSON.stringify(value)}`,
          file: repo.path,
        };
      }
      return { value, from: "repo", file: repo.path };
    }
  }
  return { value: RECORDING_FRAME_RATE_DEFAULT, from: "default" };
}
