import { checkCurrent, execGit, type GitRunner } from "@demoman/runner/package";

/** `demoman refresh --check` in the repo at `root`: prints a line per flow
 *  and returns the exit code, 3 when nothing is new since the last refresh
 *  and 0 when something must be recorded. */
export async function refreshCheck(
  root: string,
  previous: string | undefined,
  since: string | undefined,
  io: { say(line: string): void; git?: GitRunner },
): Promise<0 | 3> {
  const git = io.git ?? execGit;
  const r = await checkCurrent(
    {
      repoRoot: root,
      ...(previous === undefined ? {} : { previous }),
      ...(since === undefined ? {} : { since }),
    },
    {
      changedSince: async (commit) => {
        const d = await git(
          ["diff", "--name-only", "-z", commit, "HEAD", "--"],
          root,
        );
        return d.code === 0
          ? d.stdout.split("\0").filter((p) => p !== "")
          : { none: d.stderr.trim() || `git exited ${d.code}` };
      },
    },
  );
  for (const line of r.lines) io.say(line);
  return r.current ? 3 : 0;
}
