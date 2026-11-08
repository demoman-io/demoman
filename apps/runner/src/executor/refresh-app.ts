// What `refresh` does about the app: read `.demoman/app.json`, refuse when it
// serves some repo flows but not all, and start the app around the refresh.
// A local refresh never starts services (it assumes they are up); CI's job
// provides them. Only the clean-checkout check starts them through Docker.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_FILE, type AppSpec, messageOf, parseApp } from "@demoman/run-core";
import {
  type AppStartDeps,
  type AppStarted,
  type AppStartRefusal,
  startApp,
} from "./app-start.js";
import { readKeptFlows } from "./kept-flows.js";

export type AppPlan =
  | {
      kind: "none";
      said: string;
      /** Said once when app.json pins `now` and this refresh cannot (DEM-79). */
      note?: string;
    }
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
  let text: string;
  try {
    text = await readFile(join(root, APP_FILE), "utf8");
  } catch (error) {
    // With --base-url the file is not used, readable or not.
    if (o.baseUrl !== undefined)
      return { kind: "none", said: `--base-url given; ${APP_FILE} not used` };
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        kind: "none",
        said: `no ${APP_FILE}; the app must already answer`,
      };
    return {
      kind: "refused",
      reason: "appInvalid",
      detail: `${APP_FILE} could not be read (${messageOf(error)})`,
    };
  }
  const parsed = parseApp(text, APP_FILE);
  if (o.baseUrl !== undefined) {
    const said = `--base-url given; ${APP_FILE} not used`;
    // Read only to say a pin it asks for cannot happen: Demoman does not
    // start an app at --base-url, so it cannot hand it the instant (DEM-79).
    // An invalid file is ignored, as --base-url always has.
    const now = parsed.ok ? parsed.app.now : undefined;
    return now === undefined
      ? { kind: "none", said }
      : {
          kind: "none",
          said,
          note: `${APP_FILE} pins now to ${now}, but --base-url records an app Demoman did not start, so the date is not pinned`,
        };
  }
  if (!parsed.ok)
    return { kind: "refused", reason: "appInvalid", detail: parsed.detail };
  const mismatch = appOriginMismatch(
    parsed.app.url,
    (await readKeptFlows(root)).entries.flatMap((e) =>
      "kept" in e ? [e.kept] : [],
    ),
  );
  if (mismatch !== null)
    return { kind: "refused", reason: "appOriginMismatch", detail: mismatch };
  return { kind: "start", app: parsed.app };
}

/** Why app.json cannot serve every flow (each flow elsewhere and its
 *  origin), or null when it serves them all. */
export function appOriginMismatch(
  appUrl: string,
  flows: Array<{ name: string; script: { target: string } }>,
): string | null {
  const served = new URL(appUrl).origin;
  const elsewhere: string[] = [];
  for (const f of flows) {
    const origin = new URL(f.script.target).origin;
    if (origin !== served) elsewhere.push(`${f.name} (${origin})`);
  }
  if (elsewhere.length === 0) return null;
  return `${APP_FILE} starts the app at ${served}, but ${elsewhere.join(", ")} ${elsewhere.length === 1 ? "records" : "record"} elsewhere; point those flows at ${served}, or change the url in ${APP_FILE}`;
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
  /** Gets the started app's reset, to run before each flow (DEM-57), a
   *  no-op when no app is started here; and the instant it was started at
   *  (DEM-79), null when none or none started here. */
  run: (reset: AppStarted["reset"], pinnedNow: string | null) => Promise<T>,
  deps: Partial<AppStartDeps> & { startApp?: typeof startApp } = {},
): Promise<
  | { ok: true; value: T; lines: string[] }
  | {
      ok: false;
      refusal: AppStartRefusal | { reason: string; detail: string };
    }
> {
  if (plan.kind === "none")
    return {
      ok: true,
      value: await run(async () => ({ ok: true }), null),
      lines: plan.note === undefined ? [] : [plan.note],
    };
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
  let returned = false;
  try {
    const value = await run(started.reset, started.pinnedNow);
    returned = true;
    return { ok: true, value, lines };
  } finally {
    const left = await started.stop();
    if (left.length > 0) {
      const line = `could not stop ${left.join(", ")}`;
      // A run that threw returns no lines to carry it: said here instead.
      if (returned) lines.push(line);
      else o.log(line);
    }
  }
}
