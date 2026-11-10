// The MCP `ci` tool's door (Task 13): the same plan and apply as the
// terminal's `setup --ci`, driven by an agent. The first call answers the
// plan; only `confirmed: true` with the same choices applies, and it applies
// the plan object shown, whose checked bytes never leave this process
// (Decision 4). A secret's value is never asked of the agent: values come
// from this machine's environment and secrets.env, and every line, answer
// and stop is redacted over them.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CiApproval } from "@demoman/mcp/serve-cli";
import {
  APP_FILE,
  type AppSpec,
  parseApp,
  serializeApp,
} from "@demoman/run-core";
import { PLAN_KEPT_MS } from "@demoman/studio";
import { SETUP_BRANCH } from "./ci-pr.js";
import type { SecretValues } from "./ci-secrets.js";
import {
  applyCiSetup,
  type CiChoices,
  type CiDeps,
  type CiPlan,
  type CiStop,
  checkCommands,
  planCiSetup,
  planLines,
  redact,
} from "./ci-setup.js";
import type { Watched } from "./ci-watch.js";
import { watchedLines } from "./ci-workflow.js";

/** What the person runs to give a value the agent must never see. */
export const CI_COMMAND = "npx demoman setup --ci";

export type { CiApproval };

export type CiToolArgs = {
  trigger?: CiChoices["trigger"];
  route?: "pr" | "main";
  artifact?: boolean;
  /** The agent's `.demoman/app.json`, as an object. */
  app?: Record<string, unknown>;
  replaceSecrets?: string[];
  confirmed?: boolean;
  /** Watch the newest run on the setup branch; takes no other choice. */
  watch?: boolean;
  project?: string;
};
type Answer = Record<string, unknown>;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CONFIRM =
  "show the person these lines; only on their yes, call ci again with the same choices and confirmed: true. The pull request carries the files as checked here: an edit made after this plan is not in it; plan again to include it";

/** A shown plan's check goes stale: past this, confirmed plans again. The
 *  Studio's apply keeps the same limit. */
export { PLAN_KEPT_MS };

/** What `watch: true` cannot go with: it plans and applies nothing. */
const NOT_WITH_WATCH = [
  "trigger",
  "route",
  "artifact",
  "app",
  "replaceSecrets",
  "confirmed",
] as const;

export function createCiTool(io: {
  /** The repo's root (project, else this server's folder), or why none. */
  root(
    project: string | undefined,
  ): Promise<{ root: string } | { none: string }>;
  /** Everything the plan reads and does; `progress` is the watch's. */
  deps(
    root: string,
    progress: (line: string) => void,
  ): Omit<CiDeps, "log" | "signal">;
  now?: () => number;
}): (
  a: CiToolArgs,
  progress: (line: string) => void,
  /** Asks the person, never the agent (DEM-110). */
  approve: (message: string) => Promise<CiApproval>,
) => Promise<Answer> {
  const now = io.now ?? Date.now;
  /** The plan each repo was last shown, when, and the values it read. */
  const shown = new Map<
    string,
    { key: string; plan: CiPlan; values: SecretValues; at: number }
  >();

  return async (a, progress, approve) => {
    // Rebound to a shown plan's own values before it is applied.
    let values: SecretValues = new Map();
    const say = (l: string) => progress(redact(l, values));
    let appFile: string | undefined;
    try {
      const where = await io.root(a.project);
      if ("none" in where)
        return {
          reason: "notInRepo",
          detail: `${where.none}; pass project, the absolute path of the repo to set up`,
        };
      const { root } = where;
      const deps: CiDeps = {
        ...io.deps(root, say),
        log: say,
        approveCheck: (app) => askToCheck(app, approve),
      };
      if (a.watch === true) {
        const others = NOT_WITH_WATCH.filter((k) => a[k] !== undefined);
        if (others.length > 0)
          return {
            reason: "invalidArgs",
            detail: `watch takes no other choice, and was given ${others.join(", ")}; nothing was done. Call ci({ watch: true }) alone, or ci without watch to plan`,
          };
        return await watch(root, deps, values);
      }

      // R7 (Decision 2): the agent's draft waits in the working tree,
      // uncommitted; the terminal's setup reads it from there.
      let app: AppSpec | undefined;
      if (a.app !== undefined) {
        const parsed = parseApp(JSON.stringify(a.app), APP_FILE);
        if (!parsed.ok)
          return {
            reason: "appInvalid",
            detail: `${parsed.detail}; fix app, then call ci again. Nothing was written`,
          };
        app = parsed.app;
        // Never over one already there: it may hold the person's own
        // uncommitted edits, and a plan from app would then commit a file
        // that is not the one in their working tree.
        const text = serializeApp(app);
        await mkdir(join(root, ".demoman"), { recursive: true });
        try {
          await writeFile(join(root, APP_FILE), text, { flag: "wx" });
          appFile = `wrote ${APP_FILE} in the working tree from app, uncommitted`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if ((await readFile(join(root, APP_FILE), "utf8")) !== text)
            return {
              reason: "appInvalid",
              detail: `${APP_FILE} is already in the working tree and differs from app, and is never overwritten; nothing was written. Call ci without app to plan from that file, or show the person the difference and edit the file with their yes`,
            };
          appFile = `${APP_FILE} in the working tree already holds app`;
        }
      }
      const said = (x: Answer): Answer =>
        appFile === undefined ? x : { ...x, appFile };
      const choices: CiChoices = {
        ...(a.trigger === undefined ? {} : { trigger: a.trigger }),
        ...(a.route === undefined ? {} : { route: a.route }),
        // false too: a files flow then refuses it rather than overrule it.
        ...(a.artifact === undefined ? {} : { artifact: a.artifact }),
        ...(a.replaceSecrets === undefined
          ? {}
          : { replaceSecrets: a.replaceSecrets }),
        ...(app === undefined ? {} : { app, appBy: "agent" as const }),
      };
      const key = JSON.stringify([
        choices.trigger ?? null,
        choices.route ?? null,
        choices.artifact ?? null,
        app === undefined ? null : serializeApp(app),
        [...(choices.replaceSecrets ?? [])].sort(),
      ]);

      const last = shown.get(root);
      const stale = last?.key === key && now() - last.at > PLAN_KEPT_MS;
      if (a.confirmed === true && last?.key === key && !stale) {
        // Applied once: a second confirmed plans again.
        shown.delete(root);
        values = last.values;
        const done = await applyCiSetup(last.plan, deps, values);
        if ("reason" in done) return said(stopped(done, values));
        const run = runOf(done.watched, values);
        return said({
          outcome: "opened",
          pr: "opened" in done.pr ? done.pr.opened : done.pr,
          check: last.plan.check,
          secrets: done.secrets,
          setting: done.setting,
          run,
          lines: watchedLines(run),
        });
      }

      // Only a plan answer leaves a plan to confirm: a stop or refusal for
      // these choices must not let an earlier plan of them be applied.
      shown.delete(root);
      const plan = await planCiSetup(root, choices, deps, values);
      if ("reason" in plan) return said(stopped(plan, values));
      shown.set(root, { key, plan, values, at: now() });
      return said({
        outcome: "plan",
        // `contents` (the checked bytes) is not enumerable: never sent.
        plan,
        lines: planLines(plan),
        next:
          a.confirmed !== true
            ? `Nothing was done yet: ${CONFIRM}`
            : stale
              ? `The plan shown was more than ${PLAN_KEPT_MS / 60_000} minutes old, so nothing was done; this is a fresh plan, checked again: ${CONFIRM}`
              : `No plan with these choices was shown by this server, so nothing was done: ${CONFIRM}`,
      });
    } catch (e) {
      return {
        reason: "threw",
        detail: redact(messageOf(e), values),
        ...(appFile === undefined ? {} : { appFile }),
      };
    }
  };
}

/** The check runs the app's commands through sh -c, and the agent may have
 *  written them: only the person's yes starts them (DEM-110). */
async function askToCheck(
  app: AppSpec,
  approve: (message: string) => Promise<CiApproval>,
): Promise<CiStop | null> {
  const commands = checkCommands(app);
  const services = Object.values(app.services).map((s) => s.image);
  const got = await approve(
    [
      "Demoman's CI setup will check the refresh from a clean checkout of this repo. It runs these commands on this machine, as you, with the setup's secrets in their environment:",
      "",
      ...commands.map((c) => `  ${c}`),
      "",
      ...(services.length > 0
        ? [`and starts these Docker images: ${services.join(", ")}`]
        : []),
      `then records against ${app.url}. Run them?`,
    ].join("\n"),
  );
  if ("unsupported" in got)
    return {
      reason: "checkNeedsPerson",
      detail:
        "the check runs the app's commands on this machine, and this client cannot ask the person to approve them; nothing was run",
      commands,
    };
  if (!got.approved)
    return {
      reason: "checkDeclined",
      detail: `${got.why} to run the app's commands for the check; nothing was run`,
      commands,
    };
  return null;
}

/** `watch: true`: the newest run on the setup branch, after the agent
 *  pushed a fix there. */
async function watch(
  root: string,
  deps: CiDeps,
  values: SecretValues,
): Promise<Answer> {
  const facts = await deps.readGithub(root);
  if ("reason" in facts) return { reason: facts.reason, detail: facts.detail };
  const head = await deps.git(
    // In full, as readGithub: a short name matches alice/demoman/setup too.
    ["ls-remote", "--heads", facts.remote, `refs/heads/${SETUP_BRANCH}`],
    root,
  );
  if (head.code !== 0)
    return {
      reason: "githubUnreadable",
      detail: `could not read ${facts.remote}'s ${SETUP_BRANCH} (${head.stderr.trim() || `git exited with code ${head.code}`}); nothing was assumed, try again`,
    };
  const sha = head.stdout.split(/\s/)[0] ?? "";
  if (sha === "")
    return {
      reason: "noSetupBranch",
      detail: `${SETUP_BRANCH} is not on ${facts.remote}, so there is no setup run to watch; call ci without watch to set up`,
    };
  const run = runOf(
    await deps.watchSetupRun({ slug: facts.slug, branch: SETUP_BRANCH, sha }),
    values,
  );
  return {
    outcome:
      "passed" in run
        ? "passed"
        : "failed" in run
          ? run.failed.gaveUp
            ? "gaveUp"
            : "failed"
          : "cancelled" in run
            ? "cancelled"
            : "unknown",
    run,
    lines: watchedLines(run),
  };
}

/** The run's verdict with its log lines redacted. */
export function runOf(w: Watched | null, values: SecretValues): Watched {
  const h = (t: string) => redact(t, values);
  if (w === null)
    return { unknown: { runUrl: null, why: "it was not watched" } };
  if ("failed" in w) return { failed: { ...w.failed, tail: h(w.failed.tail) } };
  if ("passed" in w)
    return { passed: { ...w.passed, lines: w.passed.lines.map(h) } };
  return w;
}

/** A stop as the tool answers it: names, never values; a value the agent
 *  cannot give is the person's to give in their terminal. */
function stopped(s: CiStop, values: SecretValues): Answer {
  const h = (t: string) => redact(t, values);
  const person =
    s.reason === "secretMissing" ||
    s.reason === "secretTooShort" ||
    s.reason === "checkNeedsPerson";
  return {
    reason: s.reason,
    detail: h(s.detail),
    ...(s.step === undefined ? {} : { step: s.step }),
    ...(s.tail === undefined ? {} : { tail: h(s.tail) }),
    ...(s.proposal === undefined ? {} : { proposal: s.proposal }),
    ...(s.secrets === undefined
      ? {}
      : { secrets: s.secrets.map(({ name, why }) => ({ name, why })) }),
    ...(s.commands === undefined ? {} : { commands: s.commands }),
    ...(person
      ? {
          command: CI_COMMAND,
          next:
            s.reason === "checkNeedsPerson"
              ? "Only the person may start these commands: show them commands, and ask them to run command in their terminal, which checks, shows the plan and opens the pull request; then call ci({ watch: true })"
              : "A secret's value never passes through you: ask the person to run command in their terminal, which reads the app.json here and asks for each value unseen",
        }
      : {}),
  };
}
