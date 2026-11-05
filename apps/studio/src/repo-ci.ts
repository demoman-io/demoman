// CI setup in the Studio (Part C, Task 5). `StudioCi` is declared here and
// implemented by the CLI bin from Part B's orchestrator: the Studio never
// imports apps/cli. Plan and apply run as jobs of this server's own, so an
// apply's watch (up to about half an hour) outlives the window that asked.
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { scrubSecrets } from "@demoman/run-core";
import type {
  CiAnswerWire,
  CiAppliedWire,
  CiChoicesWire,
  CiPlannedWire,
  CiState,
  CiStopWire,
  Refusal,
  SetupPrWire,
  StudioEvent,
  StudioReason,
} from "@demoman/studio-protocol";
import type { Handler } from "./server.js";

export interface StudioCi {
  /** Never `running` or `finished`: those are this server's. */
  state(root: string): Promise<CiState>;
  /** `values` is the person's typed secrets; the CLI holds the live plan
   *  and its values under `planId` (R8). */
  plan(
    root: string,
    choices: CiChoicesWire,
    values: Map<string, string>,
    progress: (line: string) => void,
  ): Promise<CiPlannedWire | CiStopWire>;
  /** Applies the plan held under `planId`, once. */
  apply(
    root: string,
    planId: string,
    progress: (line: string) => void,
  ): Promise<CiAppliedWire | CiStopWire>;
  openPr(
    root: string,
    a: { branch: string; title: string; body: string; files: string[] },
  ): Promise<SetupPrWire>;
}

export type CiRoute = "repoCiState" | "repoCiPlan" | "repoCiApply" | "repoPr";
export interface CiJobs {
  handlers: Record<CiRoute, Handler>;
  /** CI jobs running now. */
  running(): number;
  /** Resolves once no CI job runs. */
  drained(): Promise<void>;
}

const refuse = (
  status: number,
  reason: StudioReason,
  detail: string,
): { status: number; json: Refusal } => {
  const body: Refusal = { reason, detail };
  return { status, json: body };
};
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Each typed value as `•••`. */
const hide = (text: string, values: Map<string, string>): string =>
  [...values.values()]
    .filter((v) => v !== "")
    .sort((a, b) => b.length - a.length)
    .reduce((t, v) => t.replaceAll(v, "•••"), text);

/** Every string in `answer` with the values hidden; a `detail` or `tail`
 *  also scrubbed of secret-shaped text (not every string: that would
 *  shred a commit sha or a run's URL). */
const hideIn = <T>(answer: T, values: Map<string, string>): T =>
  JSON.parse(JSON.stringify(answer), (key, v: unknown) =>
    typeof v !== "string"
      ? v
      : key === "detail" || key === "tail"
        ? scrubSecrets(hide(v, values))
        : hide(v, values),
  ) as T;

/** A relative path inside the repo: no `..`, not absolute. */
const insideRepo = (p: unknown): boolean =>
  typeof p === "string" &&
  p.trim() !== "" &&
  !isAbsolute(p) &&
  !/^[a-zA-Z]:|^[\\/]/.test(p) &&
  !p.split(/[\\/]/).includes("..");

/** The body as an object, or null. A parse error's message is not said:
 *  V8 quotes the body in it, and this body can hold a secret. */
async function objectOf(
  req: Parameters<Handler>[0],
): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse((await req.body()).toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createCiJobs(o: {
  /** Absent: every CI route answers `routeNotFound`. */
  ci?: StudioCi;
  events: { send(e: StudioEvent): void };
  log: (line: string) => void;
  /** Each `done` event as well, for `tellIfUnseen`. */
  tell?: (e: StudioEvent) => void;
}): CiJobs {
  const { ci, log } = o;
  /** The running job per repo root. */
  const jobs = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  /** The last job per root that ended: a reopened sheet reads it. */
  const last = new Map<
    string,
    { jobId: string; step: "plan" | "apply"; answer: CiAnswerWire }
  >();
  /** The typed values of each root's held plan, until it is applied or
   *  replaced: the apply's lines are hidden over them too. */
  const held = new Map<
    string,
    { planId: string; values: Map<string, string> }
  >();

  const badBody = (why: string) =>
    refuse(400, "ciBodyInvalid", `Nothing was done: ${why}.`);
  const isRoot = (root: unknown): root is string =>
    typeof root === "string" && isAbsolute(root);

  /** Runs one job; its lines and answer leave only with the values
   *  hidden. Answers the 202, or a refusal when the root is busy. */
  function start(
    root: string,
    step: "plan" | "apply",
    values: Map<string, string>,
    run: (progress: (line: string) => void) => Promise<CiAnswerWire>,
  ): { status: number; json: unknown } {
    if (jobs.has(root)) {
      return refuse(409, "ciBusy", `CI setup is already running for ${root}.`);
    }
    const jobId = randomUUID();
    jobs.set(root, jobId);
    const wall = (t: string) => scrubSecrets(hide(t, values));
    const progress = (line: string) => {
      const said = wall(line);
      log(`studio: ci ${jobId}: ${said}`);
      o.events.send({ type: "ci", jobId, phase: "progress", line: said });
    };
    const job = run(progress)
      .catch(
        (error: unknown): CiStopWire => ({
          reason: "internalError",
          detail: `CI setup stopped with an error: ${messageOf(error)}.`,
        }),
      )
      .then((raw) => {
        const answer = hideIn(raw, values);
        if (step === "plan" && "planId" in answer) {
          held.set(root, { planId: answer.planId, values });
        }
        last.set(root, { jobId, step, answer });
        jobs.delete(root);
        log(
          `studio: ci ${jobId}: ${step} ended${"reason" in answer ? `: ${answer.reason}: ${answer.detail}` : ""}`,
        );
        const done: StudioEvent = {
          type: "ci",
          jobId,
          phase: "done",
          step,
          answer,
        };
        o.events.send(done);
        o.tell?.(done);
      })
      .finally(() => pending.delete(job));
    pending.add(job);
    return { status: 202, json: { jobId } };
  }

  const absent: Handler = async () =>
    refuse(404, "routeNotFound", "This Studio was started without CI setup.");
  if (ci === undefined) {
    return {
      handlers: {
        repoCiState: absent,
        repoCiPlan: absent,
        repoCiApply: absent,
        repoPr: absent,
      },
      running: () => 0,
      drained: async () => {},
    };
  }

  return {
    running: () => jobs.size,
    async drained() {
      while (pending.size > 0) await Promise.all(pending);
    },
    handlers: {
      async repoCiState(req) {
        const root = req.query.get("root");
        if (!isRoot(root)) return badBody("root is not an absolute path");
        const jobId = jobs.get(root);
        if (jobId !== undefined) {
          const running: CiState = { kind: "running", jobId };
          return { status: 200, json: running };
        }
        let live: CiState;
        try {
          live = await ci.state(root);
        } catch (error) {
          live = { kind: "unreadable", detail: messageOf(error) };
        }
        const ended = last.get(root);
        const state: CiState =
          live.kind === "setUp" || ended === undefined
            ? live
            : { kind: "finished", ...ended };
        return { status: 200, json: state };
      },

      async repoCiPlan(req) {
        const body = await objectOf(req);
        if (body === null) return badBody("the body is not a JSON object");
        const { root, choices, secrets } = body;
        if (!isRoot(root)) return badBody("root is not an absolute path");
        if (
          typeof choices !== "object" ||
          choices === null ||
          Array.isArray(choices)
        ) {
          return badBody("choices is not an object");
        }
        if (
          typeof secrets !== "object" ||
          secrets === null ||
          Array.isArray(secrets) ||
          Object.values(secrets).some((v) => typeof v !== "string")
        ) {
          return badBody("secrets is not an object of strings");
        }
        const values = new Map(
          Object.entries(secrets as Record<string, string>),
        );
        const started = start(root, "plan", values, (progress) =>
          ci.plan(root, choices as CiChoicesWire, values, progress),
        );
        // A new plan replaces the one held, as the CLI's own hold does.
        if (started.status === 202) held.delete(root);
        return started;
      },

      async repoCiApply(req) {
        const body = await objectOf(req);
        if (body === null) return badBody("the body is not a JSON object");
        const { root, planId } = body;
        if (!isRoot(root)) return badBody("root is not an absolute path");
        if (typeof planId !== "string" || planId === "") {
          return badBody("planId is not a string");
        }
        const plan = held.get(root);
        const values =
          plan?.planId === planId ? plan.values : new Map<string, string>();
        const started = start(root, "apply", values, (progress) =>
          ci.apply(root, planId, progress),
        );
        // Applied once; its values go when the job does.
        if (started.status === 202 && plan?.planId === planId) {
          held.delete(root);
        }
        return started;
      },

      async repoPr(req) {
        const body = await objectOf(req);
        if (body === null) return badBody("the body is not a JSON object");
        const { root, branch, title, body: text, files } = body;
        if (!isRoot(root)) return badBody("root is not an absolute path");
        if (
          typeof branch !== "string" ||
          typeof title !== "string" ||
          typeof text !== "string"
        ) {
          return badBody("branch, title and body are not all strings");
        }
        if (
          !Array.isArray(files) ||
          files.length === 0 ||
          !files.every(insideRepo)
        ) {
          return badBody("files are not paths inside the repo");
        }
        const pr = await ci.openPr(root, {
          branch,
          title,
          body: text,
          files: files as string[],
        });
        return { status: 200, json: hideIn(pr, new Map()) };
      },
    },
  };
}
