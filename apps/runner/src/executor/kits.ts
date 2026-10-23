import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrandKitsRead, coerceBrandKits } from "@demoman/run-core";
import { messageOf } from "../report.js";

/**
 * `<home>/kits.json` — `{ "kits": StoredKit[], "default": "<kit id>" }`, the
 * shape the extension stores, judged by the same `coerceBrandKits`. No file
 * is "no kits" (ready, empty); a file that will not read or parse is
 * `invalid` with the path and the cause, which is what makes `snapshot` say
 * `kits: {ok:false}` and a run naming a kit refuse `kitsUnreadable`.
 */
export async function readKits(home: string): Promise<BrandKitsRead> {
  const path = join(home, "kits.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return coerceBrandKits(undefined, undefined);
    }
    return {
      state: "invalid",
      reason: `${path} could not be read (${messageOf(error)})`,
      storageRefused: true,
    };
  }
  return judgeKitsText(path, text);
}

/**
 * The judgement `readKits` applies to the file's text, apart from the read,
 * so the studio (which needs the bytes for a revision) judges what it read
 * by the same rules rather than a copy of them.
 */
export function judgeKitsText(path: string, text: string): BrandKitsRead {
  let raw: { kits?: unknown; default?: unknown };
  try {
    raw = JSON.parse(text) as { kits?: unknown; default?: unknown };
  } catch (error) {
    return {
      state: "invalid",
      reason: `${path} is not valid JSON (${messageOf(error)})`,
    };
  }
  const wrongShape = `${path} is not a kits file (expected { "kits": [...], "default": "<id>" })`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { state: "invalid", reason: wrongShape };
  }
  // `{}` is an empty file; an object with other keys but no `kits` is not
  // this file's shape and must not read as "no kits".
  if (!("kits" in raw) && Object.keys(raw).length > 0) {
    return { state: "invalid", reason: wrongShape };
  }
  return coerceBrandKits(raw.kits, raw.default);
}
