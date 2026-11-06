import { execGit, type GitRunner, readRepo } from "@demoman/runner/package";

/** The repo `cwd` is in, which the Studio opens on. `why` is set when the
 *  repo could not be read for any reason but "this is not a git checkout"
 *  (git missing, a broken repo): the Studio still opens, and the caller says
 *  why it did not land on a project. */
export async function callerProject(
  cwd: string | (() => string),
  git: GitRunner = execGit,
): Promise<{ key?: string; why?: string }> {
  let dir: string;
  try {
    dir = typeof cwd === "string" ? cwd : cwd();
  } catch (e) {
    // A server started in a folder since deleted: process.cwd() throws
    // uv_cwd. The Studio still opens, on no project (DEM-51).
    return {
      why: `this server's working folder no longer exists (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const repo = await readRepo(dir, git);
  if (repo.ok) return { key: repo.repo.key };
  return /not a git repository/i.test(repo.none) ? {} : { why: repo.none };
}
