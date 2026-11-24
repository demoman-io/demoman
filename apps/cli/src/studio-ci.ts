// The Studio's CI door (Part C, Task 5): `StudioCi` built from Part B's
// orchestrator, which `demoman studio --serve` hands to runServe. Like the
// `ci` tool (ci-tool.ts), it holds each plan shown, live, with the values it
// read, and answers the Studio a handle (R8); every line it forwards is
// redacted over those values (R9). Each result is assigned to the Studio's
// wire type here, so this typecheck fails if B and the wire drift apart.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  CiAppliedWire,
  CiPlanWire,
  CiStopWire,
  StudioCi,
} from "@demoman/studio";
import type { SecretValues } from "./ci-secrets.js";
import {
  applyCiSetup,
  type CiChoices,
  type CiDeps,
  type CiPlan,
  type CiStop,
  planCiSetup,
  planLines,
  redact,
} from "./ci-setup.js";
import { runOf } from "./ci-tool.js";
import { foundWorkflow, watchedLines } from "./ci-workflow.js";

/** Whether release `a` is older than `b` (x.y.z, a pre-release before its
 *  release); null when either is not one (`latest`, `next`). Never a plain
 *  string difference, which would offer a newer workflow a downgrade. */
export function releaseOlder(a: string, b: string): boolean | null {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v);
    return m === null
      ? null
      : { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = (x.n[i] ?? 0) - (y.n[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  if (x.pre === y.pre) return false;
  if (x.pre === null) return false;
  if (y.pre === null) return true;
  // Per semver: dot-separated parts, numbers as numbers (rc.9 < rc.10).
  const xs = x.pre.slice(1).split(".");
  const ys = y.pre.slice(1).split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return true;
    if (q === undefined) return false;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q);
    if (pn !== qn) return pn;
    return p < q;
  }
  return false;
}

export function createStudioCi(io: {
  /** Everything the plan reads and does; `progress` is the watch's. */
  deps(
    root: string,
    progress: (line: string) => void,
  ): Omit<CiDeps, "log" | "signal">;
  /** Tests: stand-ins for B's plan and apply. */
  planCiSetup?: typeof planCiSetup;
  applyCiSetup?: typeof applyCiSetup;
}): StudioCi {
  const plan = io.planCiSetup ?? planCiSetup;
  const apply = io.applyCiSetup ?? applyCiSetup;
  /** Each plan shown, by id: the live object (a copy loses `contents`, and
   *  apply refuses it) and the values it read. */
  const held = new Map<
    string,
    { root: string; plan: CiPlan; values: SecretValues }
  >();
  /** B's deps with every line, the watch's too, redacted over `values`:
   *  the same live map, which planning grows. `signal` stops a plan's
   *  check; an apply takes none (R11). */
  const depsOf = (
    root: string,
    values: SecretValues,
    progress: (line: string) => void,
    signal?: AbortSignal,
  ): CiDeps => {
    const say = (l: string) => progress(redact(l, values));
    return {
      ...io.deps(root, say),
      log: say,
      ...(signal === undefined ? {} : { signal }),
    };
  };
  /** Drops every plan held for `root`. */
  const forget = (root: string): void => {
    for (const [id, h] of held) if (h.root === root) held.delete(id);
  };

  return {
    async state(root) {
      const deps = io.deps(root, () => {});
      const facts = await deps.readGithub(root);
      if (!("reason" in facts)) {
        if (!facts.workflowOnDefault) return { kind: "notSetUp" };
        // DEM-269: an older release's workflow is offered an update, kept
        // as it runs, unless its pull request is already open. One it cannot
        // place is still set up, and `unread` says why (the Studio logs it).
        const found =
          facts.workflowText === undefined
            ? { unreadable: "GitHub sent no content for it" }
            : foundWorkflow(facts.workflowText);
        if ("unreadable" in found)
          return { kind: "setUp", unread: found.unreadable };
        if (found.release === null)
          return {
            kind: "setUp",
            unread: "it names no Demoman release (a packed build?)",
          };
        const older = releaseOlder(found.release, deps.version);
        if (older === null)
          return {
            kind: "setUp",
            unread: `its release ${found.release} cannot be compared with ${deps.version}`,
          };
        if (!older) return { kind: "setUp" };
        // Held back while a setup branch is there, and said: an open pull
        // request, or a branch left with none (the terminal's
        // setupBranchExists).
        if (facts.setupBranch !== null)
          return {
            kind: "setUp",
            unread:
              facts.setupBranch.pr !== null
                ? `its update to ${deps.version} waits on the open setup pull request ${facts.setupBranch.pr.url}`
                : `the branch demoman/setup is on ${facts.remote} with no pull request; delete it to be offered the update to ${deps.version}`,
          };
        return {
          kind: "setUp",
          update: {
            from: found.release,
            to: deps.version,
            trigger: found.trigger,
            route: found.route,
          },
        };
      }
      return facts.reason === "githubUnreadable"
        ? { kind: "unreadable", detail: facts.detail }
        : { kind: "noGh", detail: facts.detail };
    },

    async plan(root, c, given, progress, signal) {
      // A new plan for the repo replaces the one held.
      forget(root);
      // In and out: planCiSetup adds each value it reads.
      const values: SecretValues = new Map(given);
      // Picked: a local env file is the terminal's alone.
      const choices: CiChoices = {
        trigger: c.trigger,
        route: c.route,
        artifact: c.artifact,
        app: c.app,
        appBy: c.appBy,
        replaceSecrets: c.replaceSecrets,
      };
      const p = await plan(
        root,
        choices,
        depsOf(root, values, progress, signal),
        values,
      );
      if ("reason" in p) return stopWire(p, values);
      const planId = randomUUID();
      held.set(planId, { root, plan: p, values });
      return {
        planId,
        plan: planWire(p),
        lines: planLines(p).map((l) => redact(l, values)),
      };
    },

    async apply(root, planId, progress) {
      const h = held.get(planId);
      if (h === undefined || h.root !== root)
        return {
          reason: "planNotFound",
          detail:
            "this plan is not held any more (it was applied, replaced, or the Studio restarted); check again",
        };
      // Applied once.
      held.delete(planId);
      const done = await apply(
        h.plan,
        depsOf(root, h.values, progress),
        h.values,
      );
      if ("reason" in done) return stopWire(done, h.values);
      const watched = runOf(done.watched, h.values);
      const applied: CiAppliedWire = {
        pr: done.pr,
        secrets: done.secrets,
        setting: done.setting,
        watched,
        lines: watchedLines(watched),
      };
      return applied;
    },

    forget,

    async openPr(root, a) {
      const deps = io.deps(root, () => {});
      const facts = await deps.readGithub(root);
      if ("reason" in facts) return { failed: "pr", detail: facts.detail };
      return deps.openSetupPr({
        root,
        slug: facts.slug,
        remote: facts.remote,
        base: facts.defaultBranch,
        files: await Promise.all(
          a.files.map(async ({ path, real }) => ({
            path,
            text: new Uint8Array(await readFile(real)),
          })),
        ),
        body: a.body,
        branch: a.branch,
        title: a.title,
      });
    },
  };
}

/** The plan as the Studio sees it: no root, no app text, no `contents`. */
function planWire(p: CiPlan): CiPlanWire {
  return {
    repo: p.repo,
    trigger: p.trigger,
    offers: p.offers,
    route: p.route,
    artifact: p.artifact,
    app: p.app === null ? null : { spec: p.app.spec, source: p.app.source },
    deployment: p.deployment,
    check: p.check,
    secrets: p.secrets,
    actionsSetting: p.actionsSetting,
    files: p.files,
    scriptOnly: p.scriptOnly,
    branch: p.branch,
    title: p.title,
    pushCost: p.pushCost,
    offBase: p.offBase,
  };
}

/** A stop with its free text redacted; names, never values. */
function stopWire(s: CiStop, values: SecretValues): CiStopWire {
  const h = (t: string) => redact(t, values);
  return {
    reason: s.reason,
    detail: h(s.detail),
    ...(s.step === undefined ? {} : { step: s.step }),
    ...(s.tail === undefined ? {} : { tail: h(s.tail) }),
    ...(s.proposal === undefined ? {} : { proposal: s.proposal }),
    ...(s.secrets === undefined ? {} : { secrets: s.secrets }),
  };
}
