import {
  type GitRunner,
  type RefreshResult,
  readRepo,
} from "@demoman/runner/package";
import { deliver, offBase, toCommit, withPushToken } from "./deliver.js";
import type { Gh } from "./gh-run.js";
import { readHandOff, writeHandOff } from "./handoff.js";
import { refreshLines } from "./refresh-lines.js";

type Io = {
  git: GitRunner;
  env: NodeJS.ProcessEnv;
  version: string;
  out: (text: string) => void;
  err: (text: string) => void;
};

const said = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** `demoman deliver <pr|main> <dir>`: the hand-off a refresh left, checked
 *  against this checkout, placed, and delivered by `deliver()`. Returns the
 *  exit code: 2 for a usage error, 1 for a refusal or a failed delivery. */
export async function deliverCommand(
  args: string[],
  deps: Io & { cwd: string; gh: Gh },
): Promise<number> {
  const [route, dir, ...extra] = args;
  if (
    (route !== "pr" && route !== "main") ||
    dir === undefined ||
    extra.length > 0
  ) {
    deps.err("demoman: deliver takes pr or main, then the hand-off folder\n");
    return 2;
  }
  const refuse = (why: string): number => {
    deps.err(`demoman deliver: nothing delivered: ${why}\n`);
    return 1;
  };
  const repo = await readRepo(deps.cwd, deps.git);
  if (!repo.ok) return refuse(`${repo.none}; run deliver inside the repo`);
  const root = repo.repo.root;
  const read = await readHandOff(dir, {
    repoRoot: root,
    version: deps.version,
    git: deps.git,
  });
  if ("refused" in read) return refuse(read.refused);
  const placed = await read.place();
  if ("failed" in placed) return refuse(placed.failed);
  const { result, named } = read.handOff;
  for (const line of refreshLines(result, []).lines) deps.out(`${line}\n`);
  const {
    GITHUB_SERVER_URL: server,
    GITHUB_REPOSITORY: slug,
    GITHUB_RUN_ID: id,
  } = deps.env;
  const git = withPushToken(deps.git, deps.env);
  // Only a pull request has a base to decide; main commits where it stands.
  const target =
    route === "pr"
      ? await offBase(
          root,
          { git, gh: deps.gh },
          deps.env.DEMOMAN_DEFAULT_BRANCH || undefined,
        )
      : undefined;
  if (target !== undefined && "refused" in target)
    return refuse(target.refused);
  const delivered = await deliver(
    {
      route,
      repoRoot: root,
      result,
      named,
      ...(target === undefined ? {} : { target }),
      runUrl:
        server && slug && id ? `${server}/${slug}/actions/runs/${id}` : null,
    },
    { git, gh: deps.gh },
  );
  deps.out(`delivered: ${delivered.delivered}: ${delivered.detail}\n`);
  // A failed flow does not fail this job: the refresh job is red already.
  return delivered.ok ? 0 : 1;
}

/** What `refresh --hand-off` does once the flows are recorded: say each
 *  video, fail on a list that could not be read, leave the hand-off, and
 *  exit 1 when a flow failed. The hand-off is written before that exit, so a
 *  failed flow's sibling videos still reach the deliver job. */
export async function afterRefresh(
  result: RefreshResult,
  appLines: string[],
  a: { handOff?: string; repoRoot: string; named: boolean } & Io,
): Promise<number> {
  const { lines, code } = refreshLines(result, appLines);
  for (const line of lines) a.out(`${line}\n`);
  // The finished flows are said first; the list's failure then fails the run.
  if (result.listError !== undefined) {
    a.err(`demoman refresh: ${result.listError}\n`);
    return 1;
  }
  if (a.handOff === undefined) return code;
  const fail = (why: string): number => {
    a.err(`demoman refresh: ${why}\n`);
    return 1;
  };
  const head = await a.git(["rev-parse", "HEAD"], a.repoRoot).catch((e) => ({
    code: 1,
    stdout: "",
    stderr: said(e),
  }));
  const commit = head.stdout.trim();
  if (head.code !== 0 || commit === "")
    return fail(
      `the commit refreshed could not be read (git rev-parse HEAD: ${head.stderr.trim() || `exit ${head.code}`})`,
    );
  const handed = await writeHandOff(a.handOff, {
    repoRoot: a.repoRoot,
    result,
    named: a.named,
    commit,
    version: a.version,
  });
  if ("failed" in handed)
    return fail(`the hand-off could not be written: ${handed.failed}`);
  a.out(
    `handed off ${result.videos.filter(toCommit).length} video(s) to ${a.handOff}\n`,
  );
  return code;
}
