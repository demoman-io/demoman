// Propose `.demoman/app.json` from what the repo already says about running
// its app, naming where each answer came from. Sources, in order, the first
// that answers wins: Playwright config, CI workflows, Copilot setup steps,
// package.json. Nothing here reads `.env`; `.env.example` names only.
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppDraft, AppService } from "@demoman/run-core";
import { parse as parseYaml } from "yaml";

export type AppSource =
  | { kind: "playwright"; file: string }
  | { kind: "workflow"; file: string; job: string }
  | { kind: "copilot"; file: string }
  | { kind: "packageJson"; file: string }
  | { kind: "agent" }
  | { kind: "person" };
export type AppProposal = {
  draft: AppDraft;
  source: AppSource;
  holes: Array<{ field: string; why: string }>;
};
type Hole = AppProposal["holes"][number];
type Found = Omit<AppProposal, "holes"> & { holes?: Hole[] };

const COPILOT = ".github/workflows/copilot-setup-steps.yml";
const LOOKED =
  "playwright.config.{ts,js,mjs,cjs}, .github/workflows/*.yml, .github/workflows/copilot-setup-steps.yml, package.json";

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const readOr = (p: string) => readFile(p, "utf8").catch(() => null);
const draftOf = (over: Partial<AppDraft>): AppDraft => ({
  appVersion: 1,
  install: [],
  start: null,
  url: null,
  timeoutSeconds: 120,
  env: {},
  secrets: [],
  services: {},
  ...over,
});

type Manager = "pnpm" | "yarn" | "bun" | "npm";
async function managerOf(root: string): Promise<Manager | null> {
  const locks: Array<[string, Manager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, pm] of locks) if (await exists(join(root, file))) return pm;
  return (await exists(join(root, "package.json"))) ? "npm" : null;
}
const installOf = (pm: Manager) =>
  pm === "npm" ? "npm ci" : `${pm} install --frozen-lockfile`;
/** The script in a package; `name` filters to a workspace package. */
function runOf(pm: Manager, script: string, name?: string): string {
  if (name === undefined) return `${pm} run ${script}`;
  if (pm === "pnpm" || pm === "bun")
    return `${pm} --filter ${name} run ${script}`;
  if (pm === "yarn") return `yarn workspace ${name} run ${script}`;
  return `npm run ${script} -w ${name}`;
}

// 1. Playwright -------------------------------------------------------------
// shortcut: reads the config as text, brace-matching without regard to
// braces inside strings; upgrade to a real parse if a config trips it.
function webServerBody(src: string): string | "array" | null {
  const at = src.search(/\bwebServer\s*:/);
  if (at < 0) return null;
  const open = src.slice(at).search(/[{[]/);
  if (open < 0) return null;
  if (src[at + open] === "[") return "array";
  let depth = 0;
  for (let i = at + open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(at + open, i + 1);
  }
  return null;
}
const plain = (
  body: string,
  key: string,
): { value: string } | "other" | null => {
  const m = body.match(new RegExp(`\\b${key}\\s*:\\s*([^\\n]*)`));
  if (!m) return null;
  const lit = (m[1] ?? "").match(/^(?:(['"])(.*?)\1|(\d+))\s*(?:,|\}|$)/);
  const value = lit?.[2] ?? lit?.[3];
  return value === undefined ? "other" : { value };
};

async function fromPlaywright(root: string): Promise<Found | null> {
  for (const ext of ["ts", "js", "mjs", "cjs"]) {
    const file = `playwright.config.${ext}`;
    const src = await readOr(join(root, file));
    const body = src === null ? null : webServerBody(src);
    if (body === null) continue;
    const holes: Hole[] = [];
    const notPlain = (key: string, field: string) =>
      holes.push({
        field,
        why: `\`webServer.${key}\` is not a plain string in ${file}`,
      });
    let start: string | null = null;
    let url: string | null = null;
    let timeoutSeconds = 120;
    if (body === "array") {
      notPlain("command", "start");
      notPlain("url", "url");
    } else {
      const command = plain(body, "command");
      if (command && command !== "other") start = command.value;
      else notPlain("command", "start");
      const u = plain(body, "url");
      const port = plain(body, "port");
      if (u && u !== "other") url = u.value;
      else if (port && port !== "other") url = `http://localhost:${port.value}`;
      else notPlain(u ? "url" : "port", "url");
      const t = plain(body, "timeout");
      const ms = t && t !== "other" ? Number(t.value) : 0;
      // '0', or not a number: not a wait app.json can hold, so the default.
      if (ms > 0) timeoutSeconds = Math.ceil(ms / 1000);
    }
    const pm = await managerOf(root);
    return {
      source: { kind: "playwright", file },
      draft: draftOf({
        install: pm ? [installOf(pm)] : [],
        start,
        url,
        timeoutSeconds,
      }),
      holes,
    };
  }
  return null;
}

// 2. Workflows --------------------------------------------------------------
type Step = { run?: string; uses?: string; with?: Record<string, unknown> };
type Job = {
  steps?: Step[];
  services?: Record<string, Record<string, unknown>>;
};
async function workflowJobs(
  root: string,
  bad: string[],
  only?: string,
): Promise<Array<{ file: string; name: string; job: Job }>> {
  const dir = ".github/workflows";
  const names = (await readdir(join(root, dir)).catch(() => [] as string[]))
    .filter(
      (n) =>
        /\.ya?ml$/.test(n) &&
        (only ? `${dir}/${n}` === only : `${dir}/${n}` !== COPILOT),
    )
    .sort();
  const out: Array<{ file: string; name: string; job: Job }> = [];
  for (const n of names) {
    let jobs: Record<string, Job> = {};
    try {
      const doc = parseYaml(await readFile(join(root, dir, n), "utf8")) as {
        jobs?: Record<string, Job>;
      } | null;
      jobs = doc?.jobs ?? {};
    } catch (e) {
      bad.push(`${dir}/${n} could not be parsed: ${oneLine(e)}`);
      continue;
    }
    for (const [name, job] of Object.entries(jobs))
      out.push({ file: `${dir}/${n}`, name, job });
  }
  return out;
}
const runs = (steps: Step[]) =>
  steps.flatMap((s) => (typeof s.run === "string" ? [s.run.trim()] : []));

const oneLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0];
/** wait-on options that take a value, so the value is not the target. */
const WAIT_ON_VALUE_FLAGS = new Set([
  "-t",
  "--timeout",
  "-i",
  "--interval",
  "-d",
  "--delay",
  "-w",
  "--window",
  "-c",
  "--config",
  "-s",
  "--simultaneous",
  "--httpTimeout",
  "--tcpTimeout",
  "--proxy",
  "--auth",
  "--header",
  "-l",
  "--log",
  "-v",
  "--verbose",
]);
/** The first target wait-on is given, as an http URL; null when it is not
 *  an http(s) URL or host:port (tcp:3000, file:, socket: are not). */
function waitOnUrl(run: string): string | null {
  const tokens = run.split(/\bwait-on\s+/)[1]?.split(/\s+/) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (t.startsWith("-")) {
      if (WAIT_ON_VALUE_FLAGS.has(t)) i++;
      continue;
    }
    const url = t.match(/^(?:https?|https?-get):\/\/\S+$/)
      ? t.replace(/^(https?)-get:/, "$1:")
      : null;
    if (url) return url;
    const hostPort = t.match(/^([A-Za-z0-9.-]+):\d+$/);
    if (hostPort && !/^(tcp|file|socket|unix)$/.test(hostPort[1] ?? ""))
      return `http://${t}`;
    return null;
  }
  return null;
}

async function fromWorkflows(
  root: string,
  bad: string[],
): Promise<Found | null> {
  for (const { file, name, job } of await workflowJobs(root, bad)) {
    const steps = job.steps ?? [];
    const source: AppSource = { kind: "workflow", file, job: name };
    const cy = steps.findIndex((s) =>
      s.uses?.startsWith("cypress-io/github-action"),
    );
    const w = steps[cy]?.with;
    if (cy >= 0 && typeof w?.start === "string") {
      const build = typeof w.build === "string" ? [w.build] : [];
      // The action waits on a comma list; the first is the app's URL.
      const waitOn =
        typeof w["wait-on"] === "string"
          ? w["wait-on"].split(",")[0]?.trim()
          : undefined;
      return {
        source,
        draft: draftOf({
          install: [...runs(steps.slice(0, cy)), ...build],
          start: w.start,
          url: typeof waitOn === "string" ? waitOn : null,
        }),
        holes:
          typeof waitOn === "string"
            ? []
            : [
                {
                  field: "url",
                  why: `the Cypress step in ${file} has no wait-on`,
                },
              ],
      };
    }
    const wait = steps.findIndex((s) => /\bwait-on\s+\S+/.test(s.run ?? ""));
    if (wait < 0) continue;
    const url = waitOnUrl(steps[wait]?.run ?? "");
    const bg = steps.findIndex(
      (s, i) => i < wait && /&\s*$/.test(s.run?.trim() ?? ""),
    );
    if (bg < 0) continue;
    return {
      source,
      draft: draftOf({
        install: runs(steps.slice(0, bg)),
        start: (steps[bg]?.run ?? "").trim().replace(/\s*&$/, ""),
        url,
      }),
      holes: url
        ? []
        : [
            {
              field: "url",
              why: `the wait-on line in ${file} does not name an http(s) URL or host:port`,
            },
          ],
    };
  }
  return null;
}

// 3. Copilot setup steps ----------------------------------------------------
async function fromCopilot(root: string, bad: string[]): Promise<Found | null> {
  const [first] = await workflowJobs(root, bad, COPILOT);
  if (!first) return null;
  const services: Record<string, AppService> = {};
  for (const [name, s] of Object.entries(first.job.services ?? {})) {
    services[name] = {
      image: String(s.image ?? ""),
      ports: ((s.ports as unknown[]) ?? []).map(String),
      env: Object.fromEntries(
        Object.entries((s.env as Record<string, unknown>) ?? {}).map(
          ([k, v]) => [k, String(v)],
        ),
      ),
      options: typeof s.options === "string" ? s.options : null,
    };
  }
  return {
    source: { kind: "copilot", file: COPILOT },
    draft: draftOf({ install: runs(first.job.steps ?? []), services }),
    holes: [
      {
        field: "start",
        why: `${COPILOT} sets the machine up but does not start the app`,
      },
      { field: "url", why: `${COPILOT} does not say where the app answers` },
    ],
  };
}

// 4. package.json -----------------------------------------------------------
type Pkg = {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: unknown;
};
const readPkg = async (dir: string): Promise<Pkg | null> => {
  const text = await readOr(join(dir, "package.json"));
  try {
    return text === null ? null : (JSON.parse(text) as Pkg);
  } catch {
    return null;
  }
};
const startScript = (p: Pkg) =>
  p.scripts?.start ? "start" : p.scripts?.dev ? "dev" : null;
const namesPort = (cmd: string, port: string) =>
  new RegExp(`(?:--port[ =]|-p |PORT=)${port}(?!\\d)`).test(cmd);

// shortcut: workspace globs are `dir/*` or a plain directory; upgrade to
// a glob library for nested patterns.
async function workspaceDirs(
  root: string,
  root_: Pkg,
): Promise<string[] | null> {
  let globs: string[] | null = null;
  const ws = await readOr(join(root, "pnpm-workspace.yaml"));
  if (ws !== null)
    globs = (parseYaml(ws) as { packages?: string[] } | null)?.packages ?? [];
  else if (Array.isArray(root_.workspaces))
    globs = root_.workspaces as string[];
  else if (
    Array.isArray(
      (root_.workspaces as { packages?: string[] } | undefined)?.packages,
    )
  )
    globs = (root_.workspaces as { packages: string[] }).packages;
  if (globs === null) return null;
  const dirs: string[] = [];
  for (const g of globs) {
    if (g.endsWith("/*")) {
      const base = g.slice(0, -2);
      for (const e of await readdir(join(root, base), {
        withFileTypes: true,
      }).catch(() => [])) {
        if (e.isDirectory()) dirs.push(`${base}/${e.name}`);
      }
    } else dirs.push(g);
  }
  return dirs.sort();
}

async function fromPackageJson(
  root: string,
  origin: string | null,
): Promise<Found | { none: string } | null> {
  const pkg = await readPkg(root);
  if (!pkg) return null;
  const pm = (await managerOf(root)) ?? "npm";
  let dirs: string[] | null;
  try {
    dirs = await workspaceDirs(root, pkg);
  } catch (e) {
    return { none: `pnpm-workspace.yaml could not be parsed: ${oneLine(e)}` };
  }
  if (dirs) {
    const port = origin ? new URL(origin).port : "";
    const candidates = [];
    for (const d of dirs) {
      const p = await readPkg(join(root, d));
      const script = p && startScript(p);
      if (p && script)
        candidates.push({ dir: d, pkg: p, script, name: p.name ?? d });
    }
    const hits = candidates.filter(
      (c) => port && namesPort(c.pkg.scripts?.[c.script] ?? "", port),
    );
    if (hits.length !== 1 || !hits[0]) {
      const list =
        candidates
          .map((c) => c.name)
          .sort()
          .join(", ") || "no package has a start or dev script";
      return {
        none: `cannot tell which package serves ${origin ?? "(no recorded origin)"}: ${list}`,
      };
    }
    const { dir, pkg: p, script, name } = hits[0];
    return {
      source: { kind: "packageJson", file: `${dir}/package.json` },
      draft: draftOf({
        install: [
          installOf(pm),
          ...(p.scripts?.build ? [runOf(pm, "build", name)] : []),
        ],
        start: runOf(pm, script, name),
        url: origin,
      }),
    };
  }
  const script = startScript(pkg);
  return {
    source: { kind: "packageJson", file: "package.json" },
    draft: draftOf({
      install: [
        installOf(pm),
        ...(pkg.scripts?.build ? [runOf(pm, "build")] : []),
      ],
      start: script ? runOf(pm, script) : null,
      url: origin,
    }),
  };
}

// ---------------------------------------------------------------------------
export async function detectApp(
  root: string,
  recordedOrigin: string | null,
): Promise<AppProposal | { none: string }> {
  let found: Found | { none: string } | null = null;
  const bad: string[] = []; // workflow files that did not parse, said in the answer
  for (const source of [
    () => fromPlaywright(root),
    () => fromWorkflows(root, bad),
    () => fromCopilot(root, bad),
    () => fromPackageJson(root, recordedOrigin),
  ]) {
    found = await source();
    if (found) break;
  }
  const said = bad.length ? `; ${bad.join("; ")}` : "";
  if (!found)
    return { none: `nothing to propose from: looked in ${LOOKED}${said}` };
  if ("none" in found) return { none: `${found.none}${said}` };
  const holes = [...(found.holes ?? [])];
  for (const b of bad) holes.push({ field: b.split(" ")[0] ?? b, why: b });
  for (const f of ["start", "url"] as const) {
    if (found.draft[f] === null && !holes.some((h) => h.field === f))
      holes.push({
        field: f,
        why:
          f === "url"
            ? "no recorded origin to serve"
            : "no start or dev script",
      });
  }
  const example = await readOr(join(root, ".env.example"));
  for (const m of (example ?? "").matchAll(
    /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/gm,
  )) {
    holes.push({
      field: `env.${m[1]}`,
      why: ".env.example names it with no value; give it one or list it under secrets",
    });
  }
  return { draft: found.draft, source: found.source, holes };
}
