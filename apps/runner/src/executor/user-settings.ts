import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_EXPORT_QUALITY,
  EXPORT_QUALITY_VALUES,
  type ExportQuality,
  isExportQuality,
  isPullRequestsValue,
  type PullRequestsValue,
} from "@demoman/run-core";
import { messageOf } from "../report.js";

// The values each key takes are run-core's lists (`EXPORT_QUALITY_VALUES`,
// `PULL_REQUESTS_VALUES`), the one definition every door reads.

export interface UserSettings {
  /** `DEFAULT_EXPORT_QUALITY` ("high") when not set, and when set to something unusable (then
   *  `problems.exportQuality` says why). */
  exportQuality: ExportQuality;
  /** null: not set, or set to something unusable (then `problems` says why). */
  pullRequests: PullRequestsValue | null;
  /** The folder exports are saved in (DEM-180); null: not set, or set to
   *  something unusable (then `problems.exportFolder` says why). Where an
   *  export lands is `exportFolderOf`'s answer. */
  exportFolder?: string | null;
  /** Why the file or a value could not be used, one sentence per key that
   *  could not. Absent when all is well. A file that will not read or parse
   *  names both keys. */
  problems?: {
    exportQuality?: string;
    pullRequests?: string;
    exportFolder?: string;
  };
  /** Every sentence of `problems` in one, for a log. Absent when all is well. */
  unreadable?: string;
  /** The file itself would not read or parse: every key is its default and
   *  `problems` names this for each. Absent when the file read. */
  fileUnreadable?: string;
}

const settingsWith = (
  settings: Pick<
    UserSettings,
    "exportQuality" | "pullRequests" | "exportFolder"
  >,
  problems: NonNullable<UserSettings["problems"]>,
): UserSettings => {
  const said = [
    problems.exportQuality,
    problems.pullRequests,
    problems.exportFolder,
  ].filter((p): p is string => p !== undefined);
  if (said.length === 0) return settings;
  return { ...settings, problems, unreadable: [...new Set(said)].join("; ") };
};

/**
 * `<home>/settings.json` (the studio's file). A missing file or key is "not
 * set" (`exportQuality` high, `pullRequests` null); a file that will not
 * read or parse, or a value that is not one of the key's choices, gives the
 * same defaults but says why in `problems`, so no caller can mistake it for
 * "not set". One key's bad value does not unset the other.
 */
export async function readUserSettings(home: string): Promise<UserSettings> {
  const path = join(home, "settings.json");
  const defaults = {
    exportQuality: DEFAULT_EXPORT_QUALITY,
    pullRequests: null,
    exportFolder: null,
  } as const;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    const said = `${path} could not be read (${messageOf(error)})`;
    return {
      ...settingsWith(defaults, {
        exportQuality: said,
        pullRequests: said,
        exportFolder: said,
      }),
      fileUnreadable: said,
    };
  }
  // Parsed once; both keys are read from `raw`.
  const raw = settingsObject(path, text);
  if ("unreadable" in raw) {
    // Not a JSON object at all: neither key is readable.
    return {
      ...settingsWith(defaults, {
        exportQuality: raw.unreadable,
        pullRequests: raw.unreadable,
        exportFolder: raw.unreadable,
      }),
      fileUnreadable: raw.unreadable,
    };
  }
  // The file is a JSON object from here: each key stands on its own.
  const pr = pullRequestsIn(path, raw.object);
  const quality = raw.object.exportQuality;
  const qualityBad = quality !== undefined && !isExportQuality(quality);
  const folder = raw.object.exportFolder;
  // null is the Studio's "back to the default".
  const folderBad =
    folder !== undefined && folder !== null && !isExportFolder(folder);
  return settingsWith(
    {
      exportQuality: isExportQuality(quality)
        ? quality
        : DEFAULT_EXPORT_QUALITY,
      pullRequests: "unreadable" in pr ? null : pr.value,
      exportFolder: isExportFolder(folder) ? folder : null,
    },
    {
      ...(qualityBad
        ? {
            exportQuality: `${path}: exportQuality must be ${EXPORT_QUALITY_VALUES.join(", ")}; got ${JSON.stringify(quality)}`,
          }
        : {}),
      ...("unreadable" in pr ? { pullRequests: pr.unreadable } : {}),
      ...(folderBad
        ? {
            exportFolder: `${path}: exportFolder must be an absolute path; got ${JSON.stringify(folder)}`,
          }
        : {}),
    },
  );
}

/** An Export folder the settings file may hold: an absolute path. */
export const isExportFolder = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && isAbsolute(v);

/** Where exports land when nothing chose a folder. */
export const defaultExportFolder = (): string => join(homedir(), "Downloads");

/**
 * The one answer to "where does this export land" (DEM-180): the folder the
 * caller was given (`--out-dir`, a temporary folder), else the user's Export
 * folder, else ~/Downloads. An exportFolder value that cannot be used is
 * `unusable`, never ~/Downloads in its place: the person chose a folder. A
 * settings file that will not read at all may never have held one, so it
 * goes to ~/Downloads with `unread` saying why, for the export to say.
 */
export async function exportFolderOf(
  home: string,
  given: string | undefined,
): Promise<
  | {
      folder: string;
      from: "given" | "setting" | "default";
      unread?: string;
    }
  | { unusable: string }
> {
  if (given !== undefined) return { folder: given, from: "given" };
  const settings = await readUserSettings(home);
  if (settings.fileUnreadable !== undefined)
    return {
      folder: defaultExportFolder(),
      from: "default",
      unread: settings.fileUnreadable,
    };
  const why = settings.problems?.exportFolder;
  if (why !== undefined) return { unusable: why };
  const set = settings.exportFolder ?? null;
  return set === null
    ? { folder: defaultExportFolder(), from: "default" }
    : { folder: set, from: "setting" };
}

/** A settings file's text as the JSON object it must hold, or `unreadable`
 *  naming the file and why. Anything but a JSON object (null, an array, a
 *  number, a string) is unreadable: it is not "every key is absent". */
export function settingsObject(
  path: string,
  text: string,
): { object: Record<string, unknown> } | { unreadable: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { unreadable: `${path} is not valid JSON (${messageOf(error)})` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { unreadable: `${path} must hold a JSON object` };
  }
  return { object: raw as Record<string, unknown> };
}

/** The `pullRequests` of a settings object: its value, null when the key is
 *  absent, or `unreadable` when it is not one of the choices. */
function pullRequestsIn(
  path: string,
  object: Record<string, unknown>,
): { value: PullRequestsValue | null } | { unreadable: string } {
  const value = object.pullRequests;
  if (value === undefined) return { value: null };
  if (!isPullRequestsValue(value)) {
    return {
      unreadable: `${path}: pullRequests must be off, ask or attach; got ${JSON.stringify(value)}`,
    };
  }
  return { value };
}

/**
 * The `pullRequests` of one settings file's text: its value, null when the
 * key is absent, or `unreadable` naming the file and why. Anything but a JSON
 * object (null, an array, a number, a string) is unreadable too: it is not
 * "the key is absent", so it never falls through to another source.
 */
export function parsePullRequests(
  path: string,
  text: string,
): { value: PullRequestsValue | null } | { unreadable: string } {
  const raw = settingsObject(path, text);
  return "unreadable" in raw ? raw : pullRequestsIn(path, raw.object);
}
