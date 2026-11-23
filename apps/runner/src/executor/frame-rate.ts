import { join } from "node:path";
import {
  RECORDING_FRAME_RATE_DEFAULT,
  type RecordingFrameRate,
} from "@demoman/run-core";
import { findDemomanFile } from "./accounts.js";
import { REPO_CONFIG } from "./pull-requests.js";
import { parseRecordingFrameRate, readUserSettings } from "./user-settings.js";

export type RecordingFrameRateSetting =
  | {
      value: RecordingFrameRate;
      from: "repo" | "user" | "default";
      file?: string;
    }
  /** `file` null: no file was read, because the `project` status was given
   *  could not be used (`unreadable` says why). */
  | { unreadable: string; file: string | null };

/**
 * The recording frame rate: the repo's `.demoman/config.json` over the
 * user's `<home>/settings.json`, else `RECORDING_FRAME_RATE_DEFAULT`. A file
 * that cannot be used answers `unreadable` naming it: never the default, and
 * an unusable repo file never falls through to the user's value.
 */
export async function resolveRecordingFrameRate(
  from: string,
  home: string,
): Promise<RecordingFrameRateSetting> {
  const repo = await findDemomanFile(from, REPO_CONFIG);
  if (repo.kind === "unreadable") {
    return {
      unreadable: `${repo.path} could not be read (${repo.detail})`,
      file: repo.path,
    };
  }
  if (repo.kind === "found") {
    const parsed = parseRecordingFrameRate(repo.path, repo.text);
    if ("unreadable" in parsed) {
      return { unreadable: parsed.unreadable, file: repo.path };
    }
    if (parsed.value !== null) {
      return { value: parsed.value, from: "repo", file: repo.path };
    }
  }
  const user = await readUserSettings(home);
  const file = join(home, "settings.json");
  if (user.problems?.recordingFrameRate !== undefined)
    return { unreadable: user.problems.recordingFrameRate, file };
  if (user.recordingFrameRate !== null) {
    return { value: user.recordingFrameRate, from: "user", file };
  }
  return { value: RECORDING_FRAME_RATE_DEFAULT, from: "default" };
}
