import { join } from "node:path";
import {
  EXPORT_QUALITY_VALUES,
  isExportQuality,
  isPullRequestsValue,
} from "@demoman/run-core";
import type { Refusal } from "@demoman/studio-protocol";
import {
  createChains,
  messageOf,
  readIfPresent,
  writeAtomic,
} from "./files.js";

/**
 * The studio's settings. There is no theme: the studio is dark only (spec
 * 2026-10-19 §6), and a `theme` key an older studio left in the file is kept
 * by every save and read by nothing.
 */
export type SettingKey = "pullRequests" | "exportQuality";

export const settingsPath = (home: string): string =>
  join(home, "settings.json");

/**
 * Saves one key of `<home>/settings.json`. A bad `pullRequests` is
 * `pullRequestsInvalid`, a bad
 * `exportQuality` is `exportQualityInvalid`. A file that cannot be read
 * (anything but absent) refuses the write as `studioUnwritable`, naming the
 * file and why, and writes nothing. A file that reads but is not a JSON
 * object is replaced, and `replaced` says so: its other keys are gone. A
 * write that fails is `studioUnwritable` too. Other keys of a good file are
 * kept.
 */
export function writeSetting(
  home: string,
  key: SettingKey,
  value: unknown,
): Promise<{ replaced?: string } | Refusal> {
  // One chain per file: two PUTs read-modify-write the same JSON, and
  // unordered they each keep the file they read, losing the other's key.
  return settingsWrites(settingsPath(home), () =>
    writeSettingNow(home, key, value),
  );
}

const settingsWrites = createChains();

async function writeSettingNow(
  home: string,
  key: SettingKey,
  value: unknown,
): Promise<{ replaced?: string } | Refusal> {
  if (key === "pullRequests" && !isPullRequestsValue(value)) {
    return {
      reason: "pullRequestsInvalid",
      detail: `"${String(value)}" is not a choice — choose off, ask or attach.`,
    };
  }
  if (key === "exportQuality" && !isExportQuality(value)) {
    return {
      reason: "exportQualityInvalid",
      detail: `"${String(value)}" is not a choice — choose ${EXPORT_QUALITY_VALUES.join(", ")}.`,
    };
  }
  const path = settingsPath(home);
  const what =
    key === "exportQuality"
      ? "The Export quality setting"
      : "The Pull requests setting";
  let kept: Record<string, unknown> = {};
  let replaced: string | undefined;
  let bytes: Buffer | null;
  try {
    bytes = await readIfPresent(path);
  } catch (error) {
    return {
      reason: "studioUnwritable",
      detail: `${what} was not saved: ${path} could not be read (${messageOf(error)}), so nothing was written.`,
    };
  }
  if (bytes !== null) {
    let raw: unknown;
    let why: string | null = null;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      why = `was not valid JSON (${messageOf(error)})`;
    }
    if (why === null) {
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        kept = raw as Record<string, unknown>;
      } else {
        why = "did not hold a JSON object";
      }
    }
    if (why !== null) {
      replaced = `${path} ${why}; it was replaced and its other settings were not kept`;
    }
  }
  try {
    await writeAtomic(
      path,
      `${JSON.stringify({ ...kept, [key]: value }, null, 2)}\n`,
    );
  } catch (error) {
    return {
      reason: "studioUnwritable",
      detail: `${what} was not saved: ${messageOf(error)}.`,
    };
  }
  return replaced === undefined ? {} : { replaced };
}
