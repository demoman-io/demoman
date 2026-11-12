// Temporary CI diagnostic for PR #67 (remove with the walk's `__dbg`): the
// walk's still decisions and screencast frames, from DEMOMAN_STILL_LOG.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STILL_LOG = join(tmpdir(), `demoman-still-log-${process.pid}.jsonl`);
process.env.DEMOMAN_STILL_LOG = STILL_LOG;

/** Each walk's events in its first 3 s, oldest walk first. */
export function stillLog(): unknown {
  try {
    const takes: unknown[][] = [];
    for (const line of readFileSync(STILL_LOG, "utf8").split("\n")) {
      if (line === "") continue;
      const e = JSON.parse(line) as Record<string, number | string>;
      if (e.ev === "walkStart") {
        takes.push([]);
        continue;
      }
      const t = Number(e.atMs ?? e.nowMs ?? e.settledAt ?? 0);
      if (t < 3000) takes.at(-1)?.push(e);
    }
    return takes;
  } catch (error) {
    return `unread: ${String(error)}`;
  }
}
