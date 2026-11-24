// `demoman setup --ci` as a command: read and propose, ask the holes and
// missing values, check, show the plan, confirm, apply, watch. Apart from
// ci-workflow.ts, which only writes the workflow, so ci-setup.ts and
// ci-workflow.ts no longer import each other (DEM-199): this file drives
// both, and neither imports it.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { APP_FILE, type AppSpec, parseApp } from "@demoman/run-core";
import type { AppProposal } from "@demoman/runner/package";
import { SETUP_BRANCH } from "./ci-pr.js";
import { envFileNames, type SecretValues } from "./ci-secrets.js";
import {
  applyCiSetup,
  type CiChoices,
  type CiDeps,
  type CiPlan,
  type CiStop,
  checkQuestion,
  planCiSetup,
  planLines,
  redact,
  type TriggerOffer,
  triggerNote,
  triggerOffers,
} from "./ci-setup.js";
import type { Watched } from "./ci-watch.js";
import { type CiOptions, foundWorkflow } from "./ci-workflow.js";

/** The terminal's questions; null (or false from confirm) is a cancel. */
export type CiAsk = {
  /** Only the offered triggers, the default chosen first. */
  /** `note`: triggerNote's environments setup did not look for. */
  trigger(
    offers: TriggerOffer[],
    note: string | null,
  ): Promise<CiOptions["trigger"] | null>;
  route(branch: string): Promise<"pr" | "main" | null>;
  appHole(field: string, why: string): Promise<string | null>;
  /** Typed unseen. */
  secret(name: string, why: string): Promise<string | null>;
  /** Which of `names` to take from the file. */
  envFile(path: string, names: string[]): Promise<string[] | null>;
  confirm(lines: string[]): Promise<boolean>;
  /** The check's commands, asked apart from the plan: a yes runs them. */
  runCommands(lines: string[]): Promise<boolean>;
};

export interface CiIo {
  /** Null when there is no terminal to ask in. */
  ask: CiAsk | null;
  /** The repository's root, or why there is none. */
  root(): Promise<{ root: string } | { none: string }>;
  /** Everything the plan reads and does, `gh` bound to the root. */
  deps(root: string): Omit<CiDeps, "log" | "signal">;
  /** Paths are relative to the root. */
  exists(path: string): boolean;
  /** Ctrl-C while the check runs (R3); answers what restores it. */
  onInterrupt(stop: () => void): () => void;
  say(line: string): void;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `setup --ci [--trigger …] [--route pr|main] [--artifact] [--yes]
 *  [--env-file <path>] [--replace-secret <NAME>]…`: read and propose, ask the
 *  holes and missing values, check, show the plan, one confirmation, apply,
 *  watch. Returns the exit code. */
export async function ciSetup(args: string[], io: CiIo): Promise<number> {
  const stop = (why: string): number => {
    io.say(`Demoman setup stopped: ${why}`);
    return 1;
  };
  const cancelled = (): number => {
    io.say("Setup cancelled; nothing was written.");
    return 1;
  };
  const said = (s: CiStop): number => {
    if (s.reason === "checkStopped") {
      io.say(`Demoman setup ${s.detail}.`);
      return 1;
    }
    stop(s.detail);
    for (const l of (s.tail ?? "").split("\n")) if (l !== "") io.say(`  ${l}`);
    return 1;
  };
  let flags: {
    ci?: boolean;
    trigger?: string;
    route?: string;
    artifact?: boolean;
    yes?: boolean;
    "env-file"?: string;
    "replace-secret"?: string[];
  };
  try {
    ({ values: flags } = parseArgs({
      args,
      options: {
        ci: { type: "boolean" },
        trigger: { type: "string" },
        route: { type: "string" },
        artifact: { type: "boolean" },
        yes: { type: "boolean" },
        "env-file": { type: "string" },
        "replace-secret": { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return stop(`${messageOf(error)}.`);
  }
  const { route } = flags;
  if (route !== undefined && route !== "pr" && route !== "main")
    return stop(`--route is pr or main; got "${route}".`);
  const ask = flags.yes === true ? null : io.ask;
  const given = flags.trigger === undefined ? null : triggerOf(flags.trigger);
  if (ask === null && flags.yes !== true) {
    const missing = [
      ...(given === null
        ? ["--trigger release|daily|push|manual|<environment>"]
        : []),
      // Release and deployment triggers deliver by pull request only.
      ...(route === undefined && (given === null || mainCan(given))
        ? ["--route pr|main"]
        : []),
    ];
    return stop(
      `with no terminal to ask in, nothing was read or written: pass --yes to apply the plan with the defaults${missing.length > 0 ? `, and ${missing.join(" and ")} to choose otherwise` : ""}.`,
    );
  }
  const where = await io.root();
  if ("none" in where)
    return stop(
      `${where.none} — run setup --ci inside the repo the workflow is for.`,
    );
  const { root } = where;

  // Never said: every line the check or this door says is redacted by it.
  const values: SecretValues = new Map();
  const deps: CiDeps = {
    ...io.deps(root),
    log: (l) => io.say(redact(l, values)),
  };
  const choices: CiChoices = {
    ...(given === null ? {} : { trigger: given }),
    ...(route === undefined ? {} : { route }),
    ...(flags.artifact === true ? { artifact: true } : {}),
    ...(flags["replace-secret"] === undefined
      ? {}
      : { replaceSecrets: flags["replace-secret"] }),
  };

  // The trigger and route, asked from what the repo has on GitHub.
  if (
    ask !== null &&
    (choices.trigger === undefined || choices.route === undefined)
  ) {
    const facts = await deps.readGithub(root, { older: true });
    // A repo setup cannot go on with is said by the plan, before any question.
    // A workflow there that setup can read is updated as it runs; one it
    // cannot read is asked about, as a repo without one is.
    const keptAsFound =
      !("reason" in facts) &&
      facts.workflowOnDefault &&
      facts.workflowText !== undefined &&
      !("unreadable" in foundWorkflow(facts.workflowText));
    if (!("reason" in facts) && !keptAsFound && facts.setupBranch === null) {
      if (choices.trigger === undefined) {
        const offers = triggerOffers(facts);
        const t = await ask.trigger(
          route === "main" ? offers.filter((o) => mainCan(o.trigger)) : offers,
          triggerNote(facts),
        );
        if (t === null) return cancelled();
        choices.trigger = t;
      }
      if (choices.route === undefined && mainCan(choices.trigger)) {
        const r = await ask.route(facts.defaultBranch);
        if (r === null) return cancelled();
        choices.route = r;
      }
    }
  }

  // Plan; a hole or a missing value is asked once, then planned again.
  // An app.json the default branch does not hold may be an agent's draft,
  // committed or not: its commands are shown, and asked about, before the
  // check runs them (DEM-110). Not the holes the person just typed here.
  // --yes approves them, as it approves the plan.
  const approveCheck = async (
    app: AppSpec,
    onBase: boolean,
  ): Promise<CiStop | null> => {
    if (onBase || choices.appBy === "person") return null;
    const lines = checkQuestion(app);
    if (ask === null) {
      for (const l of lines) io.say(l);
      return null;
    }
    return (await ask.runCommands(lines))
      ? null
      : {
          reason: "checkDeclined",
          detail: "the app's commands were not approved; nothing was run",
        };
  };
  const handled = new Set<string>();
  let plan: CiPlan | CiStop;
  for (;;) {
    const abort = new AbortController();
    const restore = io.onInterrupt(() => abort.abort());
    try {
      plan = await planCiSetup(
        root,
        choices,
        { ...deps, signal: abort.signal, approveCheck },
        values,
      );
    } finally {
      restore();
    }
    // Only the check stops on the signal; a Ctrl-C anywhere else in the
    // pass still ends setup here, before any further question.
    if (
      abort.signal.aborted &&
      !("reason" in plan && plan.reason === "checkStopped")
    )
      return cancelled();
    if (!("reason" in plan)) break;
    if (handled.has(plan.reason)) return said(plan);
    handled.add(plan.reason);
    if (plan.reason === "appHoles" && plan.proposal !== undefined) {
      if (ask === null)
        return stop(
          `${plan.detail}; write them in ${APP_FILE}, then run setup again.`,
        );
      const filled = await fillHoles(plan.proposal, ask);
      if (filled === null) return cancelled();
      if ("refused" in filled) return stop(filled.refused);
      choices.app = filled.app;
      choices.appBy = "person";
    } else if (plan.reason === "secretMissing" && plan.secrets !== undefined) {
      let missing = plan.secrets;
      const path =
        flags["env-file"] ??
        (ask !== null && io.exists(".env") ? join(root, ".env") : undefined);
      let chosen: string[] = [];
      if (path !== undefined) {
        let names: string[];
        try {
          names = await envFileNames(path, missing);
        } catch (error) {
          return stop(
            `could not read ${path} (${messageOf(error)}); check the path, then run setup again.`,
          );
        }
        const picked =
          names.length === 0 || ask === null
            ? names
            : await ask.envFile(path, names);
        if (picked === null) return cancelled();
        chosen = picked;
        if (chosen.length > 0) choices.envFile = { path, names: chosen };
        missing = missing.filter((m) => !chosen.includes(m.name));
      }
      if (ask === null) {
        if (chosen.length === 0) return said(plan);
      } else {
        for (const m of missing) {
          const v = await ask.secret(m.name, m.why);
          if (v === null) return cancelled();
          values.set(m.name, v);
        }
      }
    } else return said(plan);
  }

  // One confirmation, after the check (Decision 1).
  const lines = planLines(plan);
  if (ask === null) for (const l of lines) io.say(l);
  else if (!(await ask.confirm(lines))) return cancelled();

  const done = await applyCiSetup(plan, deps, values);
  if ("reason" in done) return said(done);
  for (const l of watchedLines(done.watched)) io.say(l);
  return done.watched !== null && "passed" in done.watched ? 0 : 1;
}

/** The setup run's verdict as lines; both doors say these. */
export function watchedLines(w: Watched | null): string[] {
  if (w === null || "unknown" in w)
    return [
      `Whether the setup run passed is unknown: ${w === null ? "it was not watched" : w.unknown.why}`,
    ];
  if ("passed" in w)
    return [
      `The setup run passed: ${w.passed.runUrl}`,
      `Its videos: ${w.passed.artifactUrl}`,
    ];
  if ("cancelled" in w)
    return [
      `The setup run was cancelled: ${w.cancelled.runUrl}; re-run it there.`,
    ];
  const f = w.failed;
  return [
    `The setup run failed on its "${f.step}" step: ${f.runUrl}`,
    ...f.tail
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => `  ${l}`),
    ...(f.failedRuns !== null
      ? [
          f.gaveUp
            ? `${f.failedRuns} setup runs have failed on ${SETUP_BRANCH}, the most setup tries: fix the step above in the pull request yourself, or close it and run setup again.`
            : `${f.failedRuns} of 3 setup runs have failed: fix the step above and push to ${SETUP_BRANCH} to run it again.`,
        ]
      : f.note === undefined
        ? ["How many setup runs have failed is unknown."]
        : []),
    ...(f.note === undefined ? [] : [f.note]),
  ];
}

/** Each hole in the proposed app.json, asked; null is a cancel. */
async function fillHoles(
  p: AppProposal,
  ask: CiAsk,
): Promise<{ app: AppSpec } | { refused: string } | null> {
  const draft: Record<string, unknown> & { env: Record<string, string> } =
    structuredClone(p.draft);
  for (const h of p.holes) {
    const env = /^env\.(.+)$/.exec(h.field)?.[1];
    if (h.field !== "start" && h.field !== "url" && env === undefined)
      return {
        refused: `${h.field}: ${h.why}; fix it, or write ${APP_FILE}, then run setup again.`,
      };
    const got = await ask.appHole(h.field, h.why);
    if (got === null) return null;
    if (env === undefined) draft[h.field] = got;
    else draft.env[env] = got;
  }
  const parsed = parseApp(JSON.stringify(draft), APP_FILE);
  return parsed.ok
    ? { app: parsed.app }
    : {
        refused: `${parsed.detail}; run setup again and answer it, or write ${APP_FILE}.`,
      };
}

/** Whether `--route main` can go with the trigger. */
const mainCan = (t: CiOptions["trigger"]): boolean =>
  t === "push" || t === "daily" || t === "manual";

/** A `--trigger` value: the four words are triggers,
 *  `deployment:<name>` an environment of any name, and any other word an
 *  environment as before. */
function triggerOf(given: string): CiOptions["trigger"] {
  if (
    given === "push" ||
    given === "release" ||
    given === "daily" ||
    given === "manual"
  )
    return given;
  return {
    deployment: given.startsWith("deployment:") ? given.slice(11) : given,
  };
}
