import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  /** Why the file or a value could not be used, one sentence per key that
   *  could not. Absent when all is well. A file that will not read or parse
   *  names both keys. */
  problems?: { exportQuality?: string; pullRequests?: string };
  /** Every sentence of `problems` in one, for a log. Absent when all is well. */
  unreadable?: string;
}

const settingsWith = (
  settings: Pick<UserSettings, "exportQuality" | "pullRequests">,
  problems: NonNullable<UserSettings["problems"]>,
): UserSettings => {
  const said = [problems.exportQuality, problems.pullRequests].filter(
    (p): p is string => p !== undefined,
  );
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
  } as const;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    const said = `${path} could not be read (${messageOf(error)})`;
    return settingsWith(defaults, { exportQuality: said, pullRequests: said });
  }
  // Parsed once; both keys are read from `raw`.
  const raw = parsed(path, text);
  if ("unreadable" in raw) {
    // Not a JSON object at all: neither key is readable.
    return settingsWith(defaults, {
      exportQuality: raw.unreadable,
      pullRequests: raw.unreadable,
    });
  }
  // The file is a JSON object from here: each key stands on its own.
  const pr = pullRequestsIn(path, raw.object);
  const quality = raw.object.exportQuality;
  const qualityBad = quality !== undefined && !isExportQuality(quality);
  return settingsWith(
    {
      exportQuality: isExportQuality(quality)
        ? quality
        : DEFAULT_EXPORT_QUALITY,
      pullRequests: "unreadable" in pr ? null : pr.value,
    },
    {
      ...(qualityBad
        ? {
            exportQuality: `${path}: exportQuality must be ${EXPORT_QUALITY_VALUES.join(", ")}; got ${JSON.stringify(quality)}`,
          }
        : {}),
      ...("unreadable" in pr ? { pullRequests: pr.unreadable } : {}),
    },
  );
}

/** A settings file's text as the JSON object it must hold, or `unreadable`
 *  naming the file and why. Anything but a JSON object (null, an array, a
 *  number, a string) is unreadable: it is not "every key is absent". */
function parsed(
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
  const raw = parsed(path, text);
  return "unreadable" in raw ? raw : pullRequestsIn(path, raw.object);
}
