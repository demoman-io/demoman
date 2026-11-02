import { execGit, type GitRunner, readRepo } from "@demoman/runner/package";

/** The repo `cwd` is in, which the Studio opens on. `why` is set when the
 *  repo could not be read for any reason but "this is not a git checkout"
 *  (git missing, a broken repo): the Studio still opens, and the caller says
 *  why it did not land on a project. */
export async function callerProject(
  cwd: string,
  git: GitRunner = execGit,
): Promise<{ key?: string; why?: string }> {
  const repo = await readRepo(cwd, git);
  if (repo.ok) return { key: repo.repo.key };
  return repo.none.startsWith("not a git checkout") ? {} : { why: repo.none };
}
