// One plan for CI setup, checked from a clean checkout before anything is
// written; then the secrets, the Actions setting, the setup pull request and
// its run. Both doors (the terminal and the MCP `ci` tool) call these two.
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_FILE,
  type AppSpec,
  type KeptVideo,
  parseApp,
  parseReceipt,
  RECEIPT_DIR,
  scriptDigest,
  serializeApp,
} from "@demoman/run-core";
import {
  type AppProposal,
  type AppSource,
  appOriginMismatch,
  type detectApp,
  type GitRunner,
  readKeptFlows,
  SECRET_MIN_LENGTH,
  SECRET_ORIGIN_SUFFIX,
  SECRET_PREFIX,
  type Verified,
  type VerifyDeps,
  type verifySetup,
} from "@demoman/runner/package";
import type {
  ActionsSetting,
  allowActionPullRequests,
  GithubFacts,
  readGithub,
} from "./ci-github.js";
import {
  type openSetupPr,
  SETUP_BRANCH,
  SETUP_TITLE,
  type SetupPr,
} from "./ci-pr.js";
import type {
  envFileValues,
  existingSecrets,
  localValues,
  NeededSecret,
  neededSecrets,
  SecretsSet,
  SecretValues,
  setSecrets,
} from "./ci-secrets.js";
import type { Watched, watchSetupRun } from "./ci-watch.js";
import {
  CI_WORKFLOW_PATH,
  type CiOptions,
  ciWorkflow,
  DEPLOYMENT_MAIN,
  RELEASE_MAIN,
} from "./ci-workflow.js";

export type TriggerOffer = {
  trigger: CiOptions["trigger"];
  label: string;
  offered: boolean;
  why: string;
};

const labelOf = (t: CiOptions["trigger"], branch: string): string =>
  typeof t === "object"
    ? `after a successful deployment${t.deployment ? ` to ${t.deployment}` : ""}`
    : {
        release: "when a release is published",
        daily: "once a day",
        push: `on each merge to ${branch}`,
      }[t];

/** The spec's order: deployment (one per environment), release, daily, push. */
export function triggerOffers(f: GithubFacts): TriggerOffer[] {
  const offer = (
    trigger: CiOptions["trigger"],
    offered: boolean,
    why: string,
  ): TriggerOffer => ({
    trigger,
    label: labelOf(trigger, f.defaultBranch),
    offered,
    why,
  });
  const deployments =
    f.deployments.length === 0
      ? [offer({ deployment: "" }, false, "no successful deployment on record")]
      : f.deployments.map((d) =>
          d.url === null
            ? offer(
                { deployment: d.environment },
                false,
                `${d.environment}'s deployments name no URL to record`,
              )
            : offer(
                { deployment: d.environment },
                true,
                `${d.environment} has a successful deployment on record`,
              ),
        );
  return [
    ...deployments,
    offer(
      "release",
      f.hasReleases,
      f.hasReleases
        ? "the repo has published a release"
        : "no release on record",
    ),
    offer(
      "daily",
      true,
      "records only when something changed since the last run",
    ),
    offer("push", true, "records on every merge, the most runner time"),
  ];
}

/** Decision 3: the first offered of deployment, release, daily; never push. */
export function defaultTrigger(offers: TriggerOffer[]): CiOptions["trigger"] {
  return (
    offers.find((o) => o.offered && o.trigger !== "push")?.trigger ?? "daily"
  );
}

export type CiChoices = {
  trigger?: CiOptions["trigger"];
  route?: "pr" | "main";
  artifact?: boolean;
  /** The agent's, or the person's edited draft. */
  app?: AppSpec;
  /** Who wrote `app`; the person unless said. */
  appBy?: "agent" | "person";
  replaceSecrets?: string[];
  envFile?: { path: string; names: string[] };
};

export type PlanAppSource = AppSource | { kind: "file"; file: typeof APP_FILE };

export type CiPlan = {
  root: string;
  repo: { slug: string; defaultBranch: string };
  trigger: CiOptions["trigger"];
  offers: TriggerOffer[];
  route: "pr" | "main";
  artifact: boolean;
  /** null only for a deployment trigger without app.json. */
  app: { spec: AppSpec; source: PlanAppSource; text: string } | null;
  /** A deployment trigger's environment and its URL now; CI records the
   *  deployed app there and starts none. */
  deployment: { environment: string; url: string } | null;
  /** Never a failed check: that is a stop. */
  check: Exclude<Verified, { passed: false }>;
  secrets: Array<{
    name: string;
    status: "set" | "replace" | "keep" | "missing";
  }>;
  actionsSetting: "turnOn" | "alreadyOn" | "notNeeded";
  /** Repo paths the pull request will hold. */
  files: string[];
  /** Flows that go in as the script alone (Decision 5), and why. */
  scriptOnly: Array<{ flow: string; why: string }>;
  branch: typeof SETUP_BRANCH;
  title: typeof SETUP_TITLE;
  /** Only when push is chosen. */
  pushCost: string | null;
  /** The exact bytes the check ran with, which apply commits. Non-enumerable:
   *  JSON.stringify and a spread leave it out, so a door never serializes
   *  them; a copied plan has none, and apply refuses it. */
  readonly contents?: SetupFiles;
};
type SetupFiles = Array<{ path: string; text: string | Uint8Array }>;

export type CiStop = {
  reason: string;
  detail: string;
  /** A failed check's step and output tail. */
  step?: string;
  tail?: string;
  /** `appHoles`: the draft and its holes, for the door to ask. */
  proposal?: AppProposal;
  /** `secretMissing`: each missing name and why it is needed. */
  secrets?: NeededSecret[];
};

/** Every injected function, with `gh` (and `git` where they take it) bound
 *  by the door. */
export type CiDeps = {
  version: string;
  env: NodeJS.ProcessEnv;
  /** Reads HEAD's and the default branch's copies; never writes. */
  git: GitRunner;
  log(line: string): void;
  /** Stops the check (R3). */
  signal?: AbortSignal;
  readGithub(root: string): ReturnType<typeof readGithub>;
  detectApp: typeof detectApp;
  neededSecrets: typeof neededSecrets;
  localValues: typeof localValues;
  envFileValues: typeof envFileValues;
  existingSecrets(slug: string): ReturnType<typeof existingSecrets>;
  verifySetup(
    a: Parameters<typeof verifySetup>[0],
    d: Pick<VerifyDeps, "log" | "signal">,
  ): Promise<Verified>;
  setSecrets(
    ...a: Parameters<typeof setSecrets> extends [unknown, ...infer R]
      ? R
      : never
  ): Promise<SecretsSet>;
  allowActionPullRequests(
    slug: string,
  ): ReturnType<typeof allowActionPullRequests>;
  openSetupPr(a: Parameters<typeof openSetupPr>[0]): Promise<SetupPr>;
  watchSetupRun(a: Parameters<typeof watchSetupRun>[0]): Promise<Watched>;
};

const stop = (
  reason: string,
  detail: string,
  more: Partial<CiStop> = {},
): CiStop => ({
  reason,
  detail,
  ...more,
});
const list = (names: string[]) => names.join(", ");
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function routeRefusal(
  t: CiOptions["trigger"],
  route: "pr" | "main",
): string | null {
  if (route !== "main") return null;
  if (t === "release") return RELEASE_MAIN;
  return typeof t === "object" ? DEPLOYMENT_MAIN : null;
}

function optionsOf(
  p: Pick<
    CiPlan,
    "trigger" | "route" | "artifact" | "app" | "secrets" | "repo"
  >,
  version: string,
): CiOptions {
  const appSecrets = p.app?.spec.secrets ?? [];
  return {
    version,
    trigger: p.trigger,
    route: p.route,
    branch: p.repo.defaultBranch,
    app: p.app?.spec ?? null,
    secrets: {
      accounts: p.secrets
        .map((s) => s.name)
        .filter(
          (n) =>
            n.startsWith(SECRET_PREFIX) &&
            !n.endsWith(SECRET_ORIGIN_SUFFIX) &&
            !appSecrets.includes(n),
        )
        .map((n) => n.slice(SECRET_PREFIX.length)),
      app: appSecrets,
    },
    ...(p.artifact ? { artifact: true } : {}),
  };
}

/** null for a missing path; any other error is thrown, and planCiSetup
 *  says it as a stop. */
const orMissing = <T>(p: Promise<T>): Promise<T | null> =>
  p.catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
const readOrNull = (path: string) => orMissing(readFile(path));

async function shown(git: GitRunner, root: string, ref: string, path: string) {
  const r = await git(["show", `${ref}:${path}`], root);
  return r.code === 0 ? r.stdout : null;
}

/** What a flow not yet on the default branch brings: the script (and its
 *  logo and wallpaper); its receipt, screens and committed outputs only when
 *  the local delivery matches the script (Decision 5). */
async function flowFiles(
  root: string,
  file: string,
  kept: KeptVideo,
): Promise<{ paths: string[]; scriptOnly: string | null }> {
  const script = [file, kept.logo, kept.wallpaper].filter(
    (p): p is string => p !== null,
  );
  if (kept.deliver !== "commit") return { paths: script, scriptOnly: null };
  const receiptFile = `${RECEIPT_DIR}/${file.split("/").pop()}`;
  const text = await readOrNull(join(root, receiptFile));
  if (text === null)
    return { paths: script, scriptOnly: `${receiptFile} is missing` };
  const parsed = parseReceipt(text.toString("utf8"), receiptFile);
  if (!parsed.ok) return { paths: script, scriptOnly: parsed.detail };
  const { receipt } = parsed;
  if (receipt.flow !== kept.flow)
    return {
      paths: script,
      scriptOnly: `${receiptFile} is flow ${receipt.flow}'s receipt`,
    };
  // R24: the delivery goes in only when it is of the script being committed.
  const mismatch =
    receipt.scriptDigest === undefined
      ? "no script digest in its receipt"
      : receipt.scriptDigest !== scriptDigest(kept.script)
        ? "does not match the script being committed"
        : null;
  if (mismatch !== null) return { paths: script, scriptOnly: mismatch };
  const screens: string[] = [];
  if (receipt.screensDir !== null) {
    const dir = `${RECEIPT_DIR}/${receipt.screensDir}`;
    const names = await orMissing(readdir(join(root, dir)));
    if (names === null)
      return { paths: script, scriptOnly: `${dir} is missing` };
    screens.push(...names.sort().map((n) => `${dir}/${n}`));
  }
  const outputs = [
    ...kept.outputs.map((o) => o.path),
    ...(kept.report === null ? [] : [kept.report]),
  ];
  for (const o of outputs) {
    if ((await orMissing(access(join(root, o)))) === null)
      return { paths: script, scriptOnly: `${o} is missing` };
  }
  return {
    paths: [...script, receiptFile, ...screens, ...outputs],
    scriptOnly: null,
  };
}

/** Every value but an account's origin (not secret) as `<redacted>`. */
export function redact(text: string, values: SecretValues): string {
  const secret = [...values]
    .filter(([n, v]) => v !== "" && !n.endsWith(SECRET_ORIGIN_SUFFIX))
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
  return secret.reduce((t, v) => t.replaceAll(v, "<redacted>"), text);
}

export async function planCiSetup(
  root: string,
  choices: CiChoices,
  deps: CiDeps,
  /** In: the values the door was given. Out: also every value read here
   *  (environment, secrets.env, the env file), so the same map goes to
   *  applyCiSetup. Never in the plan, a line or a stop. */
  values: SecretValues,
): Promise<CiPlan | CiStop> {
  try {
    return await makePlan(root, choices, deps, values);
  } catch (e) {
    // A read that failed (a folder that cannot be listed, git that would
    // not start): said, never a rejection.
    return stop(
      "setupUnreadable",
      `${redact(messageOf(e), values)}; nothing was written. Check that path or command works, then run setup again`,
    );
  }
}

async function makePlan(
  root: string,
  choices: CiChoices,
  deps: CiDeps,
  values: SecretValues,
): Promise<CiPlan | CiStop> {
  const facts = await deps.readGithub(root);
  if ("reason" in facts) return stop(facts.reason, facts.detail);
  if (facts.workflowOnDefault)
    return stop(
      "alreadySetUp",
      `${CI_WORKFLOW_PATH} is already on ${facts.defaultBranch}, so Demoman is set up here; to set it up again, delete it there first`,
    );
  if (facts.setupBranch !== null)
    return facts.setupBranch.pr !== null
      ? stop(
          "setupPrOpen",
          `the setup pull request is already open: ${facts.setupBranch.pr.url}; merge or close it, then run setup again`,
        )
      : stop(
          "setupBranchExists",
          `the branch ${SETUP_BRANCH} is on origin with no open pull request; delete it (git push origin --delete ${SETUP_BRANCH}), then run setup again`,
        );

  const offers = triggerOffers(facts);
  const trigger = choices.trigger ?? defaultTrigger(offers);
  const route = choices.route ?? "pr";
  const refused = routeRefusal(trigger, route);
  if (refused !== null) return stop("routeRefused", refused);
  if (trigger === "release" && !facts.hasReleases)
    return stop(
      "noRelease",
      `${facts.slug} has no published release on record, so there is nothing to record after; choose another trigger`,
    );
  let deployment: { environment: string; url: string } | null = null;
  if (typeof trigger === "object") {
    const d = facts.deployments.find(
      (x) => x.environment === trigger.deployment,
    );
    if (d?.url == null)
      return stop(
        "noDeployment",
        d === undefined
          ? `${facts.slug} has no successful deployment to ${trigger.deployment} on record, so there is nothing to record after; choose another trigger`
          : `${trigger.deployment}'s successful deployment names no environment URL, so there is no deployed app to record; choose another trigger`,
      );
    deployment = { environment: d.environment, url: d.url };
  }

  const { entries } = await readKeptFlows(root);
  const unreadable = entries.flatMap((e) =>
    "unreadable" in e ? [e.unreadable] : [],
  );
  if (unreadable.length > 0)
    return stop(
      "flowUnreadable",
      `${unreadable.join("; ")}; fix or remove it, then run setup again`,
    );
  const flows = entries.flatMap((e) =>
    "kept" in e ? [{ file: e.file, kept: e.kept }] : [],
  );
  if (flows.length === 0)
    return stop(
      "noRepoFlows",
      "the repo has no repo flow for CI to refresh; add one with `npx demoman add`, then run setup again",
    );

  // The app: the door's, else the working tree's app.json (R6), else detected.
  let app: CiPlan["app"] = null;
  if (choices.app !== undefined) {
    app = {
      spec: choices.app,
      source: { kind: choices.appBy ?? "person" },
      text: serializeApp(choices.app),
    };
  } else {
    const raw = await readOrNull(join(root, APP_FILE));
    if (raw !== null) {
      const parsed = parseApp(raw.toString("utf8"), APP_FILE);
      if (!parsed.ok)
        return stop(
          "appInvalid",
          `${parsed.detail}; fix it, then run setup again`,
        );
      app = {
        spec: parsed.app,
        source: { kind: "file", file: APP_FILE },
        text: raw.toString("utf8"),
      };
    } else if (deployment === null) {
      const origin = originOf(flows[0]?.kept.script.target);
      const proposal = await deps.detectApp(root, origin);
      if ("none" in proposal)
        return stop(
          "appUnknown",
          `${proposal.none}; write ${APP_FILE} (install, start and url), then run setup again`,
        );
      if (proposal.holes.length > 0)
        return stop(
          "appHoles",
          `${APP_FILE} cannot be proposed whole; still unknown: ${proposal.holes.map((h) => `${h.field} (${h.why})`).join("; ")}`,
          { proposal },
        );
      const spec = proposal.draft as AppSpec;
      app = { spec, source: proposal.source, text: serializeApp(spec) };
    }
  }

  // Refresh refuses an app.json that serves some flows but not all (R31):
  // said here, before the check records only the first of them.
  if (app !== null && deployment === null) {
    const mismatch = appOriginMismatch(
      app.spec.url,
      flows.map((f) => f.kept),
    );
    if (mismatch !== null)
      return stop("appOriginMismatch", `${mismatch}; then run setup again`);
  }

  // Secrets: named here, values never leave `values`.
  const need = await deps.neededSecrets(root, app?.spec ?? null);
  if ("refused" in need)
    return stop(
      "secretsUnknown",
      `${need.refused}; fix it, then run setup again`,
    );
  const existing = await deps.existingSecrets(facts.slug);
  if (!Array.isArray(existing))
    return stop(
      "secretsUnreadable",
      `could not list ${facts.slug}'s secrets on GitHub (${existing.failed}); nothing was assumed, run setup again`,
    );
  const local =
    need.needed.length === 0
      ? {
          values: new Map<string, string>(),
          missing: [],
          tooShort: [] as string[],
        }
      : await deps.localValues(root, need.needed, deps.env);
  let fromFile: SecretValues = new Map();
  if (choices.envFile !== undefined) {
    try {
      fromFile = await deps.envFileValues(
        choices.envFile.path,
        choices.envFile.names,
      );
    } catch (e) {
      return stop(
        "envFileUnreadable",
        `could not read ${choices.envFile.path} (${messageOf(e)}); check the path, then run setup again`,
      );
    }
  }
  const merged = new Map([...local.values, ...fromFile, ...values]);
  const missing: NeededSecret[] = [];
  const short: string[] = [];
  for (const n of need.needed) {
    const v = merged.get(n.name);
    if (v === undefined) {
      if (local.tooShort.includes(n.name)) short.push(n.name);
      else missing.push(n);
    } else if (
      !n.name.endsWith(SECRET_ORIGIN_SUFFIX) &&
      v.length < SECRET_MIN_LENGTH
    )
      short.push(n.name);
    else values.set(n.name, v);
  }
  if (short.length > 0)
    return stop(
      "secretTooShort",
      `${list(short)} ${short.length === 1 ? "is" : "are"} shorter than ${SECRET_MIN_LENGTH} characters, which a run refuses; give longer values, then run setup again`,
    );
  if (missing.length > 0)
    return stop(
      "secretMissing",
      `no value for ${list(missing.map((m) => m.name))}${"unread" in local && local.unread ? ` (${local.unread})` : ""}; set each in the environment (an account's can also go in .demoman/secrets.env, without the ${SECRET_PREFIX} prefix), or give it when setup asks, then run setup again`,
      { secrets: missing },
    );
  const replace = choices.replaceSecrets ?? [];
  const secrets: CiPlan["secrets"] = need.needed.map((n) => ({
    name: n.name,
    status: !existing.includes(n.name)
      ? "set"
      : replace.includes(n.name)
        ? "replace"
        : "keep",
  }));

  const shape = {
    trigger,
    route,
    artifact: choices.artifact === true,
    app,
    secrets,
    repo: { slug: facts.slug, defaultBranch: facts.defaultBranch },
  };
  let workflow: string;
  try {
    workflow = ciWorkflow(optionsOf(shape, deps.version));
  } catch (e) {
    return stop("workflowRefused", messageOf(e));
  }

  // The files: the workflow, app.json unless committed as is, and each flow
  // not yet on the default branch.
  const base = `origin/${facts.defaultBranch}`;
  // Only the flow folders: the whole tree can exceed git's output buffer.
  const tree = await deps.git(
    ["ls-tree", "-r", "--name-only", base, "--", ".demoman"],
    root,
  );
  // shortcut: an unreadable default branch reads as empty, so every flow is
  // listed; files identical to the base add nothing to the commit.
  const onDefault = new Set(tree.code === 0 ? tree.stdout.split("\n") : []);
  const files: string[] = [CI_WORKFLOW_PATH];
  if (app !== null) {
    for (const ref of ["HEAD", base]) {
      if ((await shown(deps.git, root, ref, APP_FILE)) !== app.text) {
        files.push(APP_FILE);
        break;
      }
    }
  }
  const scriptOnly: CiPlan["scriptOnly"] = [];
  for (const { file, kept } of flows) {
    if (onDefault.has(file)) continue;
    const got = await flowFiles(root, file, kept);
    files.push(...got.paths.filter((p) => !files.includes(p)));
    if (got.scriptOnly !== null)
      scriptOnly.push({ flow: kept.name, why: got.scriptOnly });
  }
  const texts = await fileTexts(root, files, workflow, app);
  if ("failed" in texts) return stop("filesUnreadable", texts.failed);

  // The check (Decision 1, R3): said before it runs, and stoppable.
  deps.log(
    deployment !== null
      ? `Checking from a clean checkout against the ${deployment.environment} deployment at ${deployment.url}`
      : `Checking from a clean checkout: ${checkWords(app?.spec as AppSpec)}`,
  );
  const check = await deps.verifySetup(
    {
      root,
      files: texts.files,
      target:
        deployment !== null
          ? { baseUrl: deployment.url, environment: deployment.environment }
          : { app: (app as NonNullable<typeof app>).spec },
      secrets: Object.fromEntries(values),
    },
    { log: deps.log, ...(deps.signal ? { signal: deps.signal } : {}) },
  );
  // verifySetup gives the app every value, so its output can echo one.
  const hide = (t: string) => redact(t, values);
  if ("passed" in check && !check.passed)
    return check.reason === "checkStopped"
      ? stop(check.reason, `${hide(check.detail)}; nothing was written`)
      : stop(
          check.reason,
          `the check failed on its ${check.step} step: ${hide(check.detail)}`,
          { step: check.step, tail: hide(check.tail) },
        );
  const checked: CiPlan["check"] =
    "passed" in check
      ? { ...check, lines: check.lines.map(hide) }
      : { skipped: hide(check.skipped) };

  let pushCost: string | null = null;
  if (trigger === "push") {
    if ("passed" in checked) {
      // CI starts the app once per run, then records each flow.
      const { appSeconds: a, recordSeconds: r } = checked;
      const k = flows.length;
      pushCost = `about ${Math.round(a + k * r)} s of runner time per merge: ${a > 0 ? `the app starts in ${a} s, then ` : ""}${k} flow${k === 1 ? "" : "s"} × ${r} s measured here`;
    } else pushCost = `not measured: ${checked.skipped}`;
  }

  const made: CiPlan = {
    root,
    ...shape,
    deployment,
    offers,
    check: checked,
    actionsSetting: route === "pr" ? "turnOn" : "notNeeded",
    files,
    scriptOnly,
    branch: SETUP_BRANCH,
    title: SETUP_TITLE,
    pushCost,
  };
  return Object.defineProperty(made, "contents", {
    value: texts.files,
    enumerable: false,
  });
}

function originOf(target: unknown): string | null {
  try {
    return new URL(String(target)).origin;
  } catch {
    return null;
  }
}

function checkWords(a: AppSpec): string {
  const services = Object.keys(a.services);
  return [
    a.install.length > 0
      ? `install with ${a.install.join(" && ")}`
      : "nothing to install",
    `start with ${a.start} (${a.url})`,
    ...(services.length > 0
      ? [`services ${list(services)} through Docker`]
      : []),
  ].join("; ");
}

async function fileTexts(
  root: string,
  paths: string[],
  workflow: string,
  app: CiPlan["app"],
): Promise<{ files: SetupFiles } | { failed: string }> {
  const files: SetupFiles = [];
  for (const path of paths) {
    if (path === CI_WORKFLOW_PATH) files.push({ path, text: workflow });
    else if (path === APP_FILE && app !== null)
      files.push({ path, text: app.text });
    else {
      try {
        files.push({ path, text: await readFile(join(root, path)) });
      } catch (e) {
        return {
          failed: `${path} could not be read (${messageOf(e)}), so nothing was done; check it is there, then run setup again`,
        };
      }
    }
  }
  return { files };
}

export function planLines(p: CiPlan): string[] {
  const offer = p.offers.find(
    (o) => JSON.stringify(o.trigger) === JSON.stringify(p.trigger),
  );
  const label = offer?.label ?? labelOf(p.trigger, p.repo.defaultBranch);
  const src = p.app?.source;
  const source =
    src === undefined ? null : "file" in src ? src.file : `the ${src.kind}`;
  const c = p.check;
  return [
    `Records the repo flows ${label}.`,
    p.route === "pr"
      ? "Delivers what changed as a pull request."
      : `Delivers what changed as a commit on ${p.repo.defaultBranch}.`,
    p.deployment !== null
      ? `Starts no app: records the newest successful ${p.deployment.environment} deployment (now ${p.deployment.url}).`
      : p.app === null
        ? "Starts no app: records the deployed one."
        : `Starts the app with ${p.app.spec.start} at ${p.app.spec.url} (from ${source}).`,
    "passed" in c
      ? `Checked from a clean checkout: ${c.flow} recorded in ${c.recordSeconds} s${c.appSeconds > 0 ? ` (the app started in ${c.appSeconds} s)` : ""}.`
      : `Not checked locally: ${c.skipped}.`,
    ...(p.pushCost === null ? [] : [`Runner time: ${p.pushCost}.`]),
    ...p.secrets.map(
      (s) =>
        `Secret ${s.name}: ${{ set: "set on GitHub", replace: "replaced on GitHub", keep: "kept as GitHub has it", missing: "missing" }[s.status]}.`,
    ),
    p.actionsSetting === "turnOn"
      ? `Turns on "Allow GitHub Actions to create and approve pull requests" for ${p.repo.slug}, if it is off.`
      : p.actionsSetting === "alreadyOn"
        ? "Pull requests from workflows are already allowed."
        : "Needs no Actions setting changed.",
    `Opens the pull request "${p.title}" from ${p.branch} into ${p.repo.defaultBranch} with:`,
    ...p.files.map((f) => `  ${f}`),
    ...p.scriptOnly.map(
      (s) =>
        `${s.flow}: the script alone (${s.why}); the first run delivers it as new.`,
    ),
  ];
}

export async function applyCiSetup(
  plan: CiPlan,
  deps: CiDeps,
  values: SecretValues,
): Promise<
  | {
      pr: SetupPr;
      secrets: SecretsSet;
      setting: ActionsSetting | null;
      watched: Watched | null;
    }
  | CiStop
> {
  const refused = routeRefusal(plan.trigger, plan.route);
  if (refused !== null) return stop("routeRefused", refused);
  const unset = plan.secrets.filter(
    (s) => s.status !== "keep" && !values.has(s.name),
  );
  if (unset.length > 0)
    return stop(
      "secretMissing",
      `no value for ${list(unset.map((s) => s.name))}, so nothing was done; run setup again`,
    );
  // The bytes the check ran with, never a fresh read: an edit while the
  // confirmation waits must not reach the pull request unchecked.
  const contents = plan.contents;
  if (contents === undefined)
    return stop(
      "planWithoutFiles",
      "this plan carries no checked files (it was copied or sent as JSON), so nothing was done; plan again, then apply that plan",
    );

  const { slug, defaultBranch } = plan.repo;
  const toSet: SecretValues = new Map();
  for (const s of plan.secrets) {
    const v = values.get(s.name);
    if (v !== undefined) toSet.set(s.name, v);
  }
  const secrets = await deps.setSecrets(
    slug,
    toSet,
    plan.secrets.filter((s) => s.status === "replace").map((s) => s.name),
    plan.secrets.filter((s) => s.status !== "set").map((s) => s.name),
  );
  const done = `set: ${list(secrets.set) || "none"}; kept: ${list(secrets.kept) || "none"}`;
  if (secrets.failed.length > 0)
    return stop(
      "secretRefused",
      `GitHub refused ${secrets.failed.map((f) => `${f.name} (${f.said})`).join("; ")}; ${done}. Nothing else was done; fix it, then run setup again`,
    );

  let setting: ActionsSetting | null = null;
  if (plan.route === "pr") {
    setting = await deps.allowActionPullRequests(slug);
    // R21: unknown is never read as turned on.
    if (setting.kind === "refused" || setting.kind === "unknown")
      return stop(
        setting.kind === "refused" ? "actionsRefused" : "actionsUnknown",
        `${setting.detail} (${setting.url}). Secrets ${done}; the pull request was not opened`,
      );
  }

  const pr = await deps.openSetupPr({
    root: plan.root,
    slug,
    base: defaultBranch,
    files: contents,
    body: ["Demoman's CI setup:", "", ...planLines(plan)].join("\n"),
  });
  if ("failed" in pr)
    return stop(
      "prFailed",
      `${pr.detail}. Secrets ${done}${setting === null ? "" : `; the Actions setting is ${setting.kind === "alreadyOn" ? "already on" : "turned on"}`}`,
    );

  // Said before the watch, which can take half an hour.
  deps.log(`Opened the setup pull request: ${pr.opened.url}`);
  const watched = await deps.watchSetupRun({
    slug,
    branch: SETUP_BRANCH,
    sha: pr.opened.sha,
  });
  return { pr, secrets, setting, watched };
}
