// The one `gh` the CI layer calls. A secret's value travels on stdin only.
import { execFile } from "node:child_process";
import { guardedGitEnv } from "@demoman/runner/package";

export type Gh = (
  args: string[],
  o?: { input?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function realGh(cwd: string): Gh {
  return (args, o) =>
    new Promise((done) => {
      // gh starts git in `cwd` itself (pr create counts uncommitted
      // changes): the guard has to travel in the environment (DEM-90).
      const env = guardedGitEnv(process.env);
      const child = execFile("gh", args, { cwd, env }, (err, stdout, stderr) =>
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
