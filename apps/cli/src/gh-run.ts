// The one `gh` the CI layer calls. A secret's value travels on stdin only.
import { execFile } from "node:child_process";

export type Gh = (
  args: string[],
  o?: { input?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function realGh(cwd: string): Gh {
  return (args, o) =>
    new Promise((done) => {
      const child = execFile("gh", args, { cwd }, (err, stdout, stderr) =>
        done({
          code: err ? (typeof err.code === "number" ? err.code : 127) : 0,
          stdout,
          stderr: err && typeof err.code !== "number" ? String(err) : stderr,
        }),
      );
      // A gh that exits before reading stdin must not crash us with EPIPE.
      child.stdin?.on("error", () => {});
      child.stdin?.end(o?.input);
    });
}
