// What `refresh` does about the app: read `.demoman/app.json`, refuse when it
// serves some repo flows but not all, and start the app around the refresh.
// A local refresh never starts services (it assumes they are up); CI's job
// provides them. Only the clean-checkout check starts them through Docker.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_FILE, type AppSpec, parseApp } from "@demoman/run-core";
import {
  type AppStartDeps,
  type AppStartRefusal,
  startApp,
} from "./app-start.js";
import { readKeptFlows } from "./kept-flows.js";

export type AppPlan =
  | { kind: "none"; said: string }
  | { kind: "start"; app: AppSpec }
  | {
      kind: "refused";
      reason: "appInvalid" | "appOriginMismatch";
      detail: string;
    };

export async function appPlanFor(
  root: string,
  o: { baseUrl?: string },
): Promise<AppPlan> {
  if (o.baseUrl !== undefined)
    return {
      kind: "none",
      said: `--base-url given; ${APP_FILE} not used`,
    };
  let text: string;
  try {
    text = await readFile(join(root, APP_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        kind: "none",
        said: `no ${APP_FILE}; the app must already answer`,
      };
    return {
      kind: "refused",
      reason: "appInvalid",
      detail: `${APP_FILE} could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const parsed = parseApp(text, APP_FILE);
  if (!parsed.ok)
    return { kind: "refused", reason: "appInvalid", detail: parsed.detail };
  const served = new URL(parsed.app.url).origin;
  const elsewhere: string[] = [];
  for (const e of (await readKeptFlows(root)).entries) {
    if (!("kept" in e)) continue;
    const origin = new URL(e.kept.script.target).origin;
    if (origin !== served) elsewhere.push(`${e.kept.name} (${origin})`);
  }
  if (elsewhere.length > 0)
    return {
      kind: "refused",
      reason: "appOriginMismatch",
      detail: `${APP_FILE} starts the app at ${served}, but ${elsewhere.join(", ")} ${elsewhere.length === 1 ? "records" : "record"} elsewhere; point those flows at ${served}, or change the url in ${APP_FILE}`,
    };
  return { kind: "start", app: parsed.app };
}

const hostPort = (p: string) => {
  const s = p.split(":");
  return s.length > 1 ? s[s.length - 2] : s[0];
};

export async function withApp<T>(
  plan: AppPlan,
  o: {
    root: string;
    env: NodeJS.ProcessEnv;
    ci: boolean;
    log: (l: string) => void;
  },
  run: () => Promise<T>,
  deps: Partial<AppStartDeps> & { startApp?: typeof startApp } = {},
): Promise<
  | { ok: true; value: T; lines: string[] }
  | {
      ok: false;
      refusal: AppStartRefusal | { reason: string; detail: string };
    }
> {
  if (plan.kind === "none") return { ok: true, value: await run(), lines: [] };
  if (plan.kind === "refused")
    return {
      ok: false,
      refusal: { reason: plan.reason, detail: plan.detail },
    };
  const { startApp: start = startApp, ...startDeps } = deps;
  const started = await start(
    plan.app,
    {
      root: o.root,
      env: o.env,
      mode: o.ci ? "own" : "reuse",
      services: "provided",
      log: o.log,
    },
    startDeps,
  );
  if ("reason" in started) {
    const named = Object.entries(plan.app.services).map(([name, s]) => {
      const port = s.ports[0] === undefined ? "" : hostPort(s.ports[0]);
      return port === "" ? name : `${name} (${port})`;
    });
    if (
      !o.ci &&
      named.length > 0 &&
      (started.reason === "appStartExited" ||
        started.reason === "appNeverAnswered")
    )
      return {
        ok: false,
        refusal: {
          ...started,
          detail: `${started.detail}; ${APP_FILE} needs ${named.join(" and ")}: start them, then run refresh again`,
        },
      };
    return { ok: false, refusal: started };
  }
  const lines = [started.said];
  try {
    return { ok: true, value: await run(), lines };
  } finally {
    const left = await started.stop();
    if (left.length > 0) lines.push(`could not stop ${left.join(", ")}`);
  }
}
