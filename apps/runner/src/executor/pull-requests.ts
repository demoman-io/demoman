import { join } from "node:path";
import {
  PULL_REQUESTS_DEFAULT,
  type PullRequestsValue,
} from "@demoman/run-core";
import { findDemomanFile } from "./accounts.js";
import { parsePullRequests, readUserSettings } from "./user-settings.js";

export type PullRequestsSetting =
  | {
      value: PullRequestsValue;
      from: "repo" | "user" | "default";
      file?: string;
    }
  /** `file` null: no file was read, because the `project` status was given
   *  could not be used (`unreadable` says why). */
  | { unreadable: string; file: string | null };

/** The repo's file name under `.demoman/`. */
export const REPO_CONFIG = "config.json";

/**
 * The pull-request video setting: the repo's `.demoman/config.json` (found as
 * accounts.json is) over the user's `<home>/settings.json`, else
 * `PULL_REQUESTS_DEFAULT`. A file that cannot be used answers `unreadable`
 * naming it: never the default, and an
 * unusable repo file never falls through to the user's value.
 */
export async function resolvePullRequests(
  from: string,
  home: string,
): Promise<PullRequestsSetting> {
  const repo = await findDemomanFile(from, REPO_CONFIG);
  if (repo.kind === "unreadable") {
    return {
      unreadable: `${repo.path} could not be read (${repo.detail})`,
      file: repo.path,
    };
  }
  if (repo.kind === "found") {
    const parsed = parsePullRequests(repo.path, repo.text);
    if ("unreadable" in parsed) {
      return { unreadable: parsed.unreadable, file: repo.path };
    }
    if (parsed.value !== null) {
      return { value: parsed.value, from: "repo", file: repo.path };
    }
  }
  const user = await readUserSettings(home);
  const file = join(home, "settings.json");
  if (user.problems?.pullRequests !== undefined)
    return { unreadable: user.problems.pullRequests, file };
  if (user.pullRequests !== null) {
    return { value: user.pullRequests, from: "user", file };
  }
  return { value: PULL_REQUESTS_DEFAULT, from: "default" };
}
