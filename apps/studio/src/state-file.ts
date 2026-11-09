import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./files.js";

export interface StudioState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
}

export function studioStatePath(home: string): string {
  return join(home, "studio.json");
}

/** Mode 0600 (it holds the token; `writeAtomic` writes every file so). */
export function writeStudioState(home: string, s: StudioState): Promise<void> {
  return writeAtomic(studioStatePath(home), `${JSON.stringify(s)}\n`);
}

function isState(v: unknown): v is StudioState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.pid === "number" &&
    typeof o.port === "number" &&
    typeof o.token === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.version === "string"
  );
}

/**
 * null: no file. `{ unreadable }`: a file is there and says nothing usable;
 * the caller must say so, not treat it as absent.
 */
export async function readStudioState(
  home: string,
): Promise<StudioState | null | { unreadable: string }> {
  let text: string;
  try {
    text = await readFile(studioStatePath(home), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { unreadable: `studio.json could not be read: ${String(e)}` };
  }
  try {
    const v: unknown = JSON.parse(text);
    if (isState(v)) return v;
    return { unreadable: "studio.json is missing fields the Studio writes" };
  } catch {
    return { unreadable: "studio.json is not valid JSON" };
  }
}

/** Removes the file only while it still names `pid`: a newer studio's stays. */
export async function removeStudioState(
  home: string,
  pid: number,
): Promise<void> {
  const s = await readStudioState(home);
  if (s === null) return;
  if ("unreadable" in s) return;
  if (s.pid !== pid) return;
  await rm(studioStatePath(home), { force: true });
}
