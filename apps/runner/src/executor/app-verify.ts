// apps/runner/src/executor/app-verify.ts
//
// The clean-checkout check: before a CI setup writes anything to the repo or
// GitHub, check it out of HEAD into a temporary worktree, write the proposed
// files there, start the app (services through Docker), refresh one repo
// flow into a throwaway library, and say pass or fail with what failed. The
// person's checkout, its ignored files and its uncommitted edits are never
// read: the check sees what CI will.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { APP_FILE, type AppSpec, messageOf } from "@demoman/run-core";
import { type AppStarted, dockerInfoSaid, startApp } from "./app-start.js";
import { readKeptFlows } from "./kept-flows.js";
import type { RefreshResult, RefreshVideo, refreshKept } from "./refresh.js";
import type { GitRunner } from "./repo.js";

export type VerifyTarget =
  | { app: AppSpec }
  | { baseUrl: string; environment: string };
type Step = "checkout" | "app" | "refresh";
export type Verified =
  | {
      passed: true;
      flow: string;
      outcome: RefreshVideo["outcome"];
      recordSeconds: number;
      appSeconds: number;
      lines: string[];
    }
  | { passed: false; step: Step; reason: string; detail: string; tail: string }
  /** Services declared and no Docker answers locally. */
  | { skipped: string };

export interface VerifyDeps {
  git: GitRunner;
  startApp?: typeof startApp;
  /** `env` is the check's: process.env without any DEMOMAN_SECRET_*, plus
   *  the secrets given; it becomes the refresh's `RefreshDeps.env`. */
  refresh(
    args: Parameters<typeof refreshKept>[0],
    env: NodeJS.ProcessEnv,
    /** The started app's reset, run before each flow as refresh runs it
     *  (DEM-57); absent when the check starts no app. */
    beforeFlow?: AppStarted["reset"],
    /** The instant the started app was given (DEM-79), so the check records
     *  as CI's refresh does; absent when none. */
    pinnedNow?: string,
  ): Promise<RefreshResult>;
  /** Only for the check's own `docker info`; startApp has its own. */
  docker(args: string[]): Promise<{ code: number }>;
  log(l: string): void;
  /** Aborting stops the app, removes the checkout, and answers
   *  `checkStopped` with the step it was on. */
  signal?: AbortSignal;
}

const STOPPED = Symbol("stopped");

export async function verifySetup(
  a: {
    root: string;
    files: Array<{ path: string; text: string | Uint8Array }>;
    flow?: string;
    target: VerifyTarget;
    secrets: Record<string, string>;
  },
  deps: VerifyDeps,
): Promise<Verified> {
  const { target } = a;
  if ("app" in target) {
    const services = Object.keys(target.app.services);
    if (services.length > 0) {
      const info = await deps.docker(["info"]);
      if (info.code !== 0)
        return {
          skipped: `${APP_FILE} needs ${services.join(", ")}, and Docker does not answer here (${dockerInfoSaid(info.code)}), so the setup was not checked locally; start Docker to check it, or let the first CI run check it`,
        };
    }
  }
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.startsWith("DEMOMAN_SECRET_"),
      ),
    ),
    ...a.secrets,
  };
  const signal = deps.signal;
  const aborted = new Promise<typeof STOPPED>((done) => {
    if (signal?.aborted) done(STOPPED);
    signal?.addEventListener("abort", () => done(STOPPED), { once: true });
  });
  const orStop = <T>(p: Promise<T>) =>
    signal === undefined ? p : Promise.race([p, aborted]);

  const tmp = await mkdtemp(join(tmpdir(), "demoman-verify-"));
  const outDir = await mkdtemp(join(tmpdir(), "demoman-verify-out-"));
  let step: Step = "checkout";
  let app = null as AppStarted | null;
  let stopped = false;
  let made = false;
  const fail = (
    reason: string,
    detail: string,
    tail = "",
  ): Verified & { passed: false } => ({
    passed: false,
    step,
    reason,
    detail,
    tail,
  });

  const check = async (): Promise<Verified> => {
    const added = await deps.git(
      ["worktree", "add", "--detach", tmp, "HEAD"],
      a.root,
    );
    if (added.code !== 0)
      return fail(
        "checkoutFailed",
        `\`git worktree add --detach ${tmp} HEAD\` exited with code ${added.code}, so the setup could not be checked from a clean checkout; check that the repo has a commit and git works, then run again`,
        added.stderr.trim(),
      );
    made = true;
    for (const f of a.files) {
      const to = resolve(tmp, f.path);
      const rel = relative(tmp, to);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        return fail(
          "checkoutFailed",
          `${f.path} is outside the repo, so it was not written; give its path from the repo's root, then run again`,
        );
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, f.text);
    }
    if (signal?.aborted) return stop();

    let appSeconds = 0;
    const lines: string[] = [];
    if ("app" in target) {
      step = "app";
      const starting = (deps.startApp ?? startApp)(target.app, {
        root: tmp,
        env,
        mode: "own",
        services: "docker",
        log: deps.log,
      });
      const r = await orStop(starting);
      if (r === STOPPED) {
        // shortcut: waits for startApp to settle (its services' docker run
        // and health waits, every install command, then up to timeoutSeconds
        // for the URL) so whatever it started can be stopped; pass the signal
        // into startApp if Ctrl-C during an install waits too long.
        const late = await starting;
        if (!("reason" in late)) app = late;
        return stop();
      }
      if ("reason" in r) return fail(r.reason, r.detail, r.tail);
      app = r;
      appSeconds = r.seconds;
      lines.push(r.said);
    }

    step = "refresh";
    let flow = a.flow;
    if (flow === undefined) {
      const kept = (await readKeptFlows(tmp)).entries.flatMap((e) =>
        "kept" in e ? [e.kept] : [],
      );
      // The first of the fewest steps, in the order refresh reads them.
      flow = kept.reduce<(typeof kept)[number] | undefined>(
        (best, k) =>
          best === undefined || k.script.steps.length < best.script.steps.length
            ? k
            : best,
        undefined,
      )?.name;
      if (flow === undefined)
        return fail(
          "noRepoFlow",
          "the clean checkout has no repo flow that reads, so there is nothing to refresh; add one with `npx demoman add`, then run again",
        );
    }
    const t0 = performance.now();
    const refreshing = deps.refresh(
      {
        repoRoot: tmp,
        only: [flow],
        library: "throwaway",
        outDir,
        ...("baseUrl" in target ? { baseUrl: target.baseUrl } : {}),
      },
      env,
      app?.reset ?? undefined,
      app?.pinnedNow ?? undefined,
    );
    const result = await orStop(refreshing);
    if (result === STOPPED) {
      // shortcut: refreshKept takes no signal, so this waits for its one run
      // and export to settle before the checkout and outDir it writes into
      // are removed; thread a signal through refreshKept if that waits too
      // long.
      deps.log(
        "stopping: waiting for the run in progress to end, then removing the clean checkout",
      );
      await refreshing.catch((error: unknown) =>
        deps.log(`the stopped refresh threw: ${messageOf(error)}`),
      );
      return stop();
    }
    const recordSeconds = Math.round((performance.now() - t0) / 100) / 10;
    const bad = result.videos.find((v) => v.outcome === "failed");
    if (bad !== undefined) return fail("refreshFailed", bad.detail);
    if (result.listError !== undefined)
      return fail("refreshFailed", result.listError);
    const video = result.videos.find((v) => v.name === flow);
    if (video === undefined)
      return fail(
        "refreshFailed",
        `refresh answered no video for "${flow}", so whether it records is unknown; run \`npx demoman refresh "${flow}"\` in the repo to see why, then run again`,
      );
    return {
      passed: true,
      flow,
      outcome: video.outcome,
      recordSeconds,
      appSeconds,
      lines,
    };
  };
  const stop = (): Verified => {
    stopped = true;
    return fail("checkStopped", "");
  };

  let verdict: Verified;
  try {
    verdict = await check();
  } catch (error) {
    verdict = fail(
      "checkThrew",
      `the check threw while on its ${step} step: ${messageOf(error)}`,
    );
  }

  // Cleanup: each failure is a line, never swallowed.
  const left: string[] = [];
  if (app !== null) {
    const cannot = await app.stop();
    if (cannot.length > 0) left.push(`could not stop ${cannot.join(", ")}`);
  }
  // A checkout git never made is the empty folder mkdtemp made.
  const removed = made
    ? await deps
        .git(["worktree", "remove", "--force", tmp], a.root)
        .catch((error: unknown) => ({ code: -1, stderr: messageOf(error) }))
    : await rm(tmp, { recursive: true, force: true }).then(
        () => ({ code: 0, stderr: "" }),
        (error: unknown) => ({ code: -1, stderr: messageOf(error) }),
      );
  if (removed.code !== 0)
    left.push(
      `could not remove the checkout at ${tmp} (${removed.stderr.trim()}); delete that folder, then run \`git worktree prune\``,
    );
  await rm(outDir, { recursive: true, force: true }).catch((error: unknown) =>
    left.push(`could not remove ${outDir} (${messageOf(error)})`),
  );

  if ("lines" in verdict)
    return { ...verdict, lines: [...verdict.lines, ...left] };
  if (!("passed" in verdict)) return verdict;
  const said = stopped
    ? [
        removed.code === 0
          ? `stopped; removed the checkout at ${tmp}`
          : "stopped",
        ...left,
      ]
    : [verdict.detail, ...left];
  return { ...verdict, detail: said.join("; ") };
}
