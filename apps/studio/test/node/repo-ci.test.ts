import type {
  CiAppliedWire,
  CiPlannedWire,
  CiStopWire,
  StudioEvent,
} from "@demoman/studio-protocol";
import { describe, expect, it } from "vitest";
import { createCiJobs, type StudioCi } from "../../src/repo-ci.js";
import type { StudioRequest } from "../../src/server.js";

const flush = () => new Promise<void>((r) => setImmediate(r));
const ROOT = "/work/app";
const SECRET = "s3cret-value";

const req = (o: { body?: string; root?: string } = {}): StudioRequest =>
  ({
    params: {},
    query: new URLSearchParams(o.root === undefined ? {} : { root: o.root }),
    body: async () => Buffer.from(o.body ?? ""),
  }) as unknown as StudioRequest;

/** A deferred answer the test settles. */
function held<T>() {
  let settle: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    settle = r;
  });
  return { promise, settle };
}

const planned = (o: Partial<CiPlannedWire> = {}): CiPlannedWire =>
  ({
    planId: "plan-1",
    plan: { files: [".github/workflows/demoman.yml"] },
    lines: ["Trigger: on each merge to main"],
    ...o,
  }) as unknown as CiPlannedWire;

const applied = (o: Partial<CiAppliedWire> = {}): CiAppliedWire => ({
  pr: {
    opened: {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      branch: "demoman/setup",
      sha: "a".repeat(40),
    },
  },
  secrets: { set: ["S"], kept: [], failed: [] },
  setting: null,
  watched: {
    passed: { runUrl: "https://run", artifactUrl: "https://art", lines: [] },
  },
  lines: ["The setup run passed: https://run"],
  ...o,
});

function setup(ci: Partial<StudioCi> = {}) {
  const sent: StudioEvent[] = [];
  const told: StudioEvent[] = [];
  const logs: string[] = [];
  const jobs = createCiJobs({
    ci: {
      state: async () => ({ kind: "notSetUp" }),
      plan: async () => planned(),
      apply: async () => applied(),
      openPr: async () => ({ failed: "pr", detail: "" }),
      ...ci,
    },
    events: { send: (e) => sent.push(e) },
    log: (l) => logs.push(l),
    tell: (e) => told.push(e),
  });
  const h = jobs.handlers;
  return { jobs, h, sent, told, logs };
}

const body = (r: unknown) => (r as { json: unknown }).json;

describe("the CI routes", () => {
  it("answer routeNotFound without repoCi", async () => {
    // Red if createCiJobs serves the routes with no StudioCi to reach.
    const { handlers } = createCiJobs({
      events: { send: () => {} },
      log: () => {},
    });
    const answers = await Promise.all([
      handlers.repoCiState(req({ root: ROOT })),
      handlers.repoCiPlan(req({ body: "{}" })),
      handlers.repoCiApply(req({ body: "{}" })),
      handlers.repoPr(req({ body: "{}" })),
    ]);
    for (const a of answers) {
      expect(a).toMatchObject({
        status: 404,
        json: { reason: "routeNotFound" },
      });
    }
  });

  it("a plan answers 202, then its progress lines and done, in order", async () => {
    const gate = held<void>();
    const { h, sent } = setup({
      plan: async (_root, _choices, _values, progress) => {
        progress("Checking from a clean checkout");
        await gate.promise;
        progress("The check passed");
        return planned();
      },
    });
    const started = await h.repoCiPlan(
      req({ body: JSON.stringify({ root: ROOT, choices: {}, secrets: {} }) }),
    );
    expect(started).toMatchObject({ status: 202 });
    const { jobId } = body(started) as { jobId: string };
    gate.settle();
    await flush();
    // Red if the done event is sent before the job's lines, or not at all.
    expect(sent).toEqual([
      {
        type: "ci",
        jobId,
        phase: "progress",
        line: "Checking from a clean checkout",
      },
      { type: "ci", jobId, phase: "progress", line: "The check passed" },
      { type: "ci", jobId, phase: "done", step: "plan", answer: planned() },
    ]);
  });

  it("a typed value reaches no event, log line or answer body", async () => {
    const seen: Map<string, string>[] = [];
    const { h, sent, logs } = setup({
      plan: async (_root, _choices, values, progress) => {
        seen.push(new Map(values));
        progress(`starting the app with S=${SECRET}`);
        progress("token ghp_abcdefghijklmnopqrstuvwxyz0123");
        return planned({ lines: [`S is ${SECRET}`] });
      },
      apply: async (_root, planId, progress) => {
        progress(`watching, and the run printed ${SECRET}`);
        expect(planId).toBe("plan-1");
        return applied({
          watched: {
            failed: {
              runUrl: "https://run",
              step: "record",
              tail: `echo ${SECRET}`,
              failedRuns: 1,
              gaveUp: false,
            },
          },
        });
      },
    });
    const bodies: unknown[] = [];
    const post = async (route: "repoCiPlan" | "repoCiApply", b: string) => {
      const r = await h[route](req({ body: b }));
      bodies.push(body(r));
      await flush();
    };
    // A body that is not JSON: V8's parse error would quote it.
    await post("repoCiPlan", `{"root":"${ROOT}","secrets":{"S":"${SECRET}"`);
    await post(
      "repoCiPlan",
      JSON.stringify({ root: ROOT, choices: {}, secrets: { S: SECRET } }),
    );
    await post("repoCiApply", JSON.stringify({ root: ROOT, planId: "plan-1" }));
    bodies.push(body(await h.repoCiState(req({ root: ROOT }))));

    // Premise: the value reached the StudioCi.
    expect(seen[0]?.get("S")).toBe(SECRET);
    // Red if the server stops hiding each typed value as •••.
    const progress = sent.flatMap((e) =>
      e.type === "ci" && e.phase === "progress" ? [e.line] : [],
    );
    expect(progress).toEqual([
      "starting the app with S=•••",
      "token <redacted>",
      "watching, and the run printed •••",
    ]);
    expect(JSON.stringify(bodies[3])).toContain("echo •••");
    const everything = JSON.stringify({ sent, logs, bodies });
    expect(everything).not.toContain(SECRET);
  });

  it("state is running while a job runs, and the finished answer after", async () => {
    const gate = held<CiStopWire>();
    let live: "notSetUp" | "setUp" = "notSetUp";
    const { h } = setup({
      state: async () => ({ kind: live }),
      plan: () => gate.promise,
    });
    const started = await h.repoCiPlan(
      req({ body: JSON.stringify({ root: ROOT, choices: {}, secrets: {} }) }),
    );
    const { jobId } = body(started) as { jobId: string };
    // Red if state asks the StudioCi while this server's job runs.
    expect(body(await h.repoCiState(req({ root: ROOT })))).toEqual({
      kind: "running",
      jobId,
    });
    // A second job for the same repo waits for the first to end.
    expect(
      await h.repoCiPlan(
        req({ body: JSON.stringify({ root: ROOT, choices: {}, secrets: {} }) }),
      ),
    ).toMatchObject({ status: 409, json: { reason: "ciBusy" } });
    const stop = { reason: "secretMissing", detail: "S is not set" };
    gate.settle(stop);
    await flush();
    // Red if the server forgets the last answer once its job ends.
    expect(body(await h.repoCiState(req({ root: ROOT })))).toEqual({
      kind: "finished",
      jobId,
      step: "plan",
      answer: stop,
    });
    live = "setUp";
    expect(body(await h.repoCiState(req({ root: ROOT })))).toEqual({
      kind: "setUp",
    });
  });

  it("an apply's done event goes to tellIfUnseen, and the jobs drain", async () => {
    const gate = held<CiAppliedWire>();
    const { h, told, jobs } = setup({ apply: () => gate.promise });
    await h.repoCiApply(
      req({ body: JSON.stringify({ root: ROOT, planId: "plan-1" }) }),
    );
    expect(jobs.running()).toBe(1);
    let drained = false;
    void jobs.drained().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    gate.settle(applied());
    await flush();
    // Red if a finished job is not told, or drained() does not wait for it.
    expect(told).toMatchObject([{ type: "ci", phase: "done", step: "apply" }]);
    expect(drained).toBe(true);
  });

  it("refuses a pull request whose files leave the repo", async () => {
    let opened = 0;
    const { h } = setup({
      openPr: async () => {
        opened += 1;
        return { failed: "pr", detail: "" };
      },
    });
    const pr = (files: string[]) =>
      h.repoPr(
        req({
          body: JSON.stringify({
            root: ROOT,
            branch: "b",
            title: "t",
            body: "x",
            files,
          }),
        }),
      );
    // Premise: a path inside the repo goes through.
    expect(await pr(["docs/demos/a.mp4"])).toMatchObject({ status: 200 });
    // Red if a path with `..` or an absolute one reaches openPr.
    for (const bad of [["../secrets.env"], ["/etc/passwd"], ["a/../../b"]]) {
      expect(await pr(bad)).toMatchObject({
        status: 400,
        json: { reason: "ciBodyInvalid" },
      });
    }
    expect(opened).toBe(1);
  });
});
