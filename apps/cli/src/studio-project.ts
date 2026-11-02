import { execGit, readRepo } from "@demoman/runner/package";

/** The key of the repo `cwd` is in, which the Studio opens on; undefined
 *  outside a repo (the Studio then keeps the window where it is). */
export async function callerProject(cwd: string): Promise<string | undefined> {
  const repo = await readRepo(cwd, execGit);
  return repo.ok ? repo.repo.key : undefined;
}
