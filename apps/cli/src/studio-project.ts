import { execGit, type GitRunner, readRepo } from "@demoman/runner/package";

/** The repo `cwd` is in, which the Studio opens on. `why` is set when the
 *  repo could not be read for any reason but "this is not a git checkout"
 *  (git missing, a broken repo): the Studio still opens, and the caller says
 *  why it did not land on a project. */
/** The folder this process works in, or why it cannot be read: a server
 *  started in a folder since deleted gets uv_cwd from process.cwd() (DEM-51,
 *  review of #35). */
export function workingFolder(
  cwd: () => string = () => process.cwd(),
): { dir: string } | { none: string } {
  try {
    return { dir: cwd() };
  } catch (e) {
    return {
      none: `this server's working folder no longer exists (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

export async function callerProject(
  cwd: string | (() => string),
  git: GitRunner = execGit,
): Promise<{ key?: string; why?: string }> {
  // A folder that cannot be read: the Studio still opens, on no project.
  const where = typeof cwd === "string" ? { dir: cwd } : workingFolder(cwd);
  if ("none" in where) return { why: where.none };
  const repo = await readRepo(where.dir, git);
  if (repo.ok) return { key: repo.repo.key };
  return /not a git repository/i.test(repo.none) ? {} : { why: repo.none };
}
