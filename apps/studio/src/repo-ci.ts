// CI setup in the Studio (Part C, Task 5). `StudioCi` is declared here and
// implemented by the CLI bin from Part B's orchestrator: the Studio never
// imports apps/cli. Plan and apply run as jobs of this server's own, so an
// apply's watch (up to about half an hour) outlives the window that asked.
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { looksLikeSecret, scrubSecrets } from "@demoman/run-core";
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
  /** Applies running now: only they hold the process (a plan whose window
   *  closed has no one to show it to). */
  running(): number;
  /** Resolves once no apply runs. */
  drained(): Promise<void>;
  /** An add's `written` files: the only ones `repoPr` takes for `root`. */
  added(root: string, files: string[]): void;
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

/** GitHub's own run, artifact and pull request links: the base64 sweep
 *  would shred them (`/demoman/actions/runs/1923…` is 32 such characters). */
const GITHUB_LINK =
  /(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:actions\/runs\/\d+(?:\/artifacts\/\d+)?|pull\/\d+)(?![\w/?#]))/;
/** A line scrubbed of secret-shaped text, its GitHub links left whole. */
const scrubLine = (l: string): string =>
  l
    .split(GITHUB_LINK)
    .map((part, i) =>
      i % 2 === 1 && !looksLikeSecret(part) ? part : scrubSecrets(part),
    )
    .join("");

/** Every string in `answer` with the values hidden; a `detail`, a `tail`
 *  and each of `lines` (which can copy a tail) also scrubbed of
 *  secret-shaped text. Not every string: that would shred a commit sha. */
const hideIn = <T>(answer: T, values: Map<string, string>): T =>
  JSON.parse(JSON.stringify(answer), (key, v: unknown) =>
    typeof v === "string"
      ? key === "detail" || key === "tail"
        ? scrubLine(hide(v, values))
        : hide(v, values)
      : key === "lines" && Array.isArray(v)
        ? v.map((l) => (typeof l === "string" ? scrubLine(l) : l))
        : v,
  ) as T;

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
  const jobs = new Map<string, { jobId: string; step: "plan" | "apply" }>();
  /** Applies still running, for `drained`. */
  const applying = new Set<Promise<void>>();
  /** Each root's files written by an add in this server's life. */
  const written = new Map<string, Set<string>>();
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
    jobs.set(root, { jobId, step });
    const wall = (t: string) => scrubLine(hide(t, values));
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
        // First: a throw below must not leave the repo busy.
        jobs.delete(root);
        const answer = hideIn(raw, values);
        if (step === "plan" && "planId" in answer) {
          held.set(root, { planId: answer.planId, values });
        }
        last.set(root, { jobId, step, answer });
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
      .catch((error: unknown) => {
        log(`studio: ci ${jobId}: its end threw: ${wall(messageOf(error))}`);
      })
      .finally(() => applying.delete(job));
    if (step === "apply") applying.add(job);
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
      added: () => {},
    };
  }

  return {
    running: () => applying.size,
    async drained() {
      while (applying.size > 0) await Promise.all(applying);
    },
    added(root, files) {
      const set = written.get(root) ?? new Set<string>();
      for (const f of files) set.add(f);
      written.set(root, set);
    },
    handlers: {
      async repoCiState(req) {
        const root = req.query.get("root");
        if (!isRoot(root)) return badBody("root is not an absolute path");
        const job = jobs.get(root);
        if (job !== undefined) {
          const running: CiState = { kind: "running", jobId: job.jobId };
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
          !files.every((f) => typeof f === "string")
        ) {
          return badBody("files is not a list of paths");
        }
        // R13: only what an add wrote here, and only where it resolves
        // inside the repo (a symlink cannot lead out), before any is read.
        const mine = written.get(root);
        const top = await realpath(root).catch(() => null);
        for (const f of files as string[]) {
          const at =
            mine?.has(f) === true && top !== null
              ? await realpath(join(root, f)).catch(() => null)
              : null;
          if (at === null || top === null || !at.startsWith(top + sep)) {
            return refuse(
              409,
              "prFileRefused",
              `Nothing was opened: ${f} is not a file an add wrote in ${root}.`,
            );
          }
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
