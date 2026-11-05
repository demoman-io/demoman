// The Studio's CI door (Part C, Task 5): `StudioCi` built from Part B's
// orchestrator, which `demoman studio --serve` hands to runServe. Like the
// `ci` tool (ci-tool.ts), it holds each plan shown, live, with the values it
// read, and answers the Studio a handle (R8); every line it forwards is
// redacted over those values (R9). Each result is assigned to the Studio's
// wire type here, so this typecheck fails if B and the wire drift apart.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { watchedLines } from "./ci-workflow.js";

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
   *  the same live map, which planning grows. */
  const depsOf = (
    root: string,
    values: SecretValues,
    progress: (line: string) => void,
  ): CiDeps => {
    const say = (l: string) => progress(redact(l, values));
    return { ...io.deps(root, say), log: say };
  };

  return {
    async state(root) {
      const facts = await io.deps(root, () => {}).readGithub(root);
      if (!("reason" in facts))
        return { kind: facts.workflowOnDefault ? "setUp" : "notSetUp" };
      return facts.reason === "githubUnreadable"
        ? { kind: "unreadable", detail: facts.detail }
        : { kind: "noGh", detail: facts.detail };
    },

    async plan(root, c, given, progress) {
      // A new plan for the repo replaces the one held.
      for (const [id, h] of held) if (h.root === root) held.delete(id);
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
        depsOf(root, values, progress),
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

    async openPr(root, a) {
      const deps = io.deps(root, () => {});
      const facts = await deps.readGithub(root);
      if ("reason" in facts) return { failed: "pr", detail: facts.detail };
      // shortcut: B's openSetupPr has no branch or title yet, so a.branch
      // and a.title are not used; Task 6 adds them.
      return deps.openSetupPr({
        root,
        slug: facts.slug,
        remote: facts.remote,
        base: facts.defaultBranch,
        files: await Promise.all(
          a.files.map(async (path) => ({
            path,
            text: new Uint8Array(await readFile(join(root, path))),
          })),
        ),
        body: a.body,
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
