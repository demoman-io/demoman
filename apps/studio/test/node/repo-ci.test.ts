import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubSecrets } from "@demoman/run-core";
import type {
  CiAppliedWire,
  CiPlannedWire,
  CiStopWire,
  StudioEvent,
} from "@demoman/studio-protocol";
import { describe, expect, it } from "vitest";
import {
  createCiJobs,
  PLAN_KEPT_MS,
  type StudioCi,
} from "../../src/repo-ci.js";
import type { StudioRequest } from "../../src/server.js";

const flush = () => new Promise<void>((r) => setImmediate(r));
const ROOT = "/work/app";
const SECRET = "s3cret-value";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123";
const RUN_URL =
  "https://github.com/demoman-io/demoman/actions/runs/19234567890";

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

function setup(ci: Partial<StudioCi> = {}, now?: () => number) {
  const sent: StudioEvent[] = [];
  const told: StudioEvent[] = [];
  const logs: string[] = [];
  const jobs = createCiJobs({
    ci: {
      state: async () => ({ kind: "notSetUp" }),
      plan: async () => planned(),
      apply: async () => applied(),
      openPr: async () => ({ failed: "pr", detail: "" }),
      forget: () => {},
      ...ci,
    },
    events: { send: (e) => sent.push(e) },
    log: (l) => logs.push(l),
    tell: (e) => told.push(e),
    ...(now === undefined ? {} : { now }),
  });
  const h = jobs.handlers;
  return { jobs, h, sent, told, logs };
}

const body = (r: unknown) => (r as { json: unknown }).json;

/** A plan for ROOT, ended: the server then holds `plan-1`. */
async function planOnce(h: ReturnType<typeof setup>["h"]): Promise<void> {
  await h.repoCiPlan(
    req({ body: JSON.stringify({ root: ROOT, choices: {}, secrets: {} }) }),
  );
  await flush();
}

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
        progress(`token ${TOKEN}`);
        return planned({
          plan: {
            check: { passed: true, lines: [`login with ${TOKEN}`] },
          } as unknown as CiPlannedWire["plan"],
          lines: [`S is ${SECRET}`],
        });
      },
      apply: async (_root, planId, progress) => {
        progress(`watching, and the run printed ${SECRET}`);
        expect(planId).toBe("plan-1");
        return applied({
          watched: {
            failed: {
              runUrl: "https://run",
              step: "record",
              tail: `echo ${SECRET} ${TOKEN}`,
              failedRuns: 1,
              gaveUp: false,
            },
          },
          // As watchedLines does: the tail, copied.
          lines: [
            `The setup run failed on its "record" step: ${RUN_URL}`,
            `  echo ${SECRET} ${TOKEN}`,
          ],
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
    // Red if `lines` (which copy a tail) skip the secret-shaped scrub.
    const done = sent.flatMap((e) =>
      e.type === "ci" && e.phase === "done" ? [e.answer] : [],
    );
    expect(done[0]).toMatchObject({
      plan: { check: { lines: ["login with <redacted>"] } },
    });
    expect(done[1]).toMatchObject({
      // Red if the scrub shreds GitHub's own run link.
      lines: [
        `The setup run failed on its "record" step: ${RUN_URL}`,
        "  echo ••• <redacted>",
      ],
    });
    const everything = JSON.stringify({ sent, logs, bodies });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(TOKEN);
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
    await planOnce(h);
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
    expect(told).toMatchObject([
      { type: "ci", phase: "done", step: "plan" },
      { type: "ci", phase: "done", step: "apply" },
    ]);
    expect(drained).toBe(true);
  });

  it("a GitHub link stays whole only when each of its parts is clean", async () => {
    const whole = [
      "https://github.com/demoman-io/demoman/actions/runs/41977952746",
      "https://github.com/demoman-io/demoman/pull/32",
    ];
    const shredded = [
      `https://github.com/acme/${"ab12".repeat(16)}/pull/1`,
      `https://github.com/${"Ab12".repeat(8)}/web/pull/1`,
      `https://github.com/acme/web/actions/runs/${"7".repeat(35)}`,
    ];
    const { h, sent } = setup({
      plan: async () => ({
        reason: "x",
        detail: [...whole, ...shredded].join(" "),
      }),
    });
    await h.repoCiPlan(
      req({ body: JSON.stringify({ root: ROOT, choices: {}, secrets: {} }) }),
    );
    await flush();
    const done = sent.find((e) => e.type === "ci" && e.phase === "done");
    const detail =
      done?.type === "ci" && done.phase === "done" && "detail" in done.answer
        ? done.answer.detail
        : "";
    // Premise: plain scrubSecrets shreds each of the three.
    for (const link of shredded) expect(scrubSecrets(link)).not.toBe(link);
    for (const link of whole) expect(detail).toContain(link);
    // Red if a link is let through on its shape, or on looksLikeSecret alone.
    for (const link of shredded) expect(detail).not.toContain(link);
    expect(detail.match(/<redacted>/g)).toHaveLength(3);
  });

  it("a plan that throws before its first await stops as a job, not a busy repo", async () => {
    const { h, sent } = setup({
      plan: () => {
        throw new Error("boom");
      },
    });
    const go = () =>
      h.repoCiPlan(
        req({ body: JSON.stringify({ root: ROOT, choices: {}, secrets: {} }) }),
      );
    // Red if a synchronous throw escapes start() with the root still held.
    expect(await go()).toMatchObject({ status: 202 });
    await flush();
    expect(sent.at(-1)).toMatchObject({
      phase: "done",
      answer: { reason: "internalError" },
    });
    expect(await go()).toMatchObject({ status: 202 });
  });

  it("a throw after the job ends leaves the repo free", async () => {
    const logs: string[] = [];
    const jobs = createCiJobs({
      ci: {
        state: async () => ({ kind: "notSetUp" }),
        plan: async () => planned(),
        apply: async () => applied(),
        openPr: async () => ({ failed: "pr", detail: "" }),
        forget: () => {},
      },
      events: { send: () => {} },
      log: (l) => logs.push(l),
      tell: () => {
        throw new Error("the notifier broke");
      },
    });
    const go = async () => {
      await planOnce(jobs.handlers);
      return jobs.handlers.repoCiApply(
        req({ body: JSON.stringify({ root: ROOT, planId: "plan-1" }) }),
      );
    };
    expect(await go()).toMatchObject({ status: 202 });
    await jobs.drained();
    // Red if the root's job is let go only after `tell` returns.
    expect(await go()).toMatchObject({ status: 202 });
    expect(logs.join("\n")).toContain("its end threw: the notifier broke");
  });

  it("opens a pull request only of files an add wrote inside the repo", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "studio-ci-pr-")));
    const outside = await mkdtemp(join(tmpdir(), "studio-ci-out-"));
    try {
      await mkdir(join(repo, "docs"));
      await writeFile(join(repo, "docs", "a.mp4"), "mp4");
      await writeFile(join(repo, ".env"), "S=1");
      await writeFile(join(outside, "b.mp4"), "elsewhere");
      await symlink(join(outside, "b.mp4"), join(repo, "docs", "b.mp4"));
      const asked: string[][] = [];
      const read: string[][] = [];
      const { h, jobs } = setup({
        openPr: async (_root, a) => {
          asked.push(a.files.map((f) => f.path));
          read.push(a.files.map((f) => f.real));
          return { failed: "pr", detail: "" };
        },
      });
      jobs.added(repo, ["docs/a.mp4", "docs/b.mp4"]);
      const pr = (files: string[]) =>
        h.repoPr(
          req({
            body: JSON.stringify({
              root: repo,
              branch: "demoman/add-a",
              title: "t",
              body: "x",
              files,
            }),
          }),
        );
      // Premise: a file the add wrote goes through.
      expect(await pr(["docs/a.mp4"])).toMatchObject({ status: 200 });
      // Red if repoPr takes a file no add wrote, or one whose link leads out.
      for (const bad of [".env", "docs/b.mp4", "../x", "/etc/passwd"]) {
        expect(await pr(["docs/a.mp4", bad])).toMatchObject({
          status: 409,
          json: {
            reason: "prFileRefused",
            detail: expect.stringContaining(bad),
          },
        });
      }
      expect(asked).toEqual([["docs/a.mp4"]]);
      // Red if openPr is not handed the resolved path to read.
      expect(read.at(-1)).toEqual([join(repo, "docs", "a.mp4")]);

      // A folder the add wrote (a receipt's screens) is the files in it.
      await mkdir(join(repo, "docs", "screens", "step-1"), { recursive: true });
      await writeFile(join(repo, "docs", "screens", "one.png"), "png");
      await writeFile(
        join(repo, "docs", "screens", "step-1", "two.png"),
        "png",
      );
      jobs.added(repo, ["docs/screens"]);
      // Red if a written folder reaches openPr as a path to read.
      expect(await pr(["docs/screens"])).toMatchObject({ status: 200 });
      expect(asked.at(-1)?.sort()).toEqual([
        "docs/screens/one.png",
        "docs/screens/step-1/two.png",
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("an add forgets the plan held for its repo", async () => {
    const { h, jobs } = setup();
    await h.repoCiPlan(
      req({ body: JSON.stringify({ root: ROOT, choices: {}, secrets: {} }) }),
    );
    await flush();
    // Premise: a reopened sheet would read the plan.
    expect(body(await h.repoCiState(req({ root: ROOT })))).toMatchObject({
      kind: "finished",
      answer: { planId: "plan-1" },
    });
    jobs.added(ROOT, ["docs/a.mp4"]);
    // Red if added() leaves the last plan answer for a reopened sheet.
    expect(body(await h.repoCiState(req({ root: ROOT })))).toEqual({
      kind: "notSetUp",
    });
  });

  it("a plan's own lines keep a long path; its check lines are still swept", async () => {
    const path = `.github/${"a".repeat(40)}/demoman.yml`;
    const { h, sent } = setup({
      plan: async () =>
        planned({
          plan: {
            check: { passed: true, lines: [`at ${"b".repeat(40)}`] },
          } as unknown as CiPlannedWire["plan"],
          lines: [`Writes ${path}`],
        }),
    });
    await h.repoCiPlan(
      req({ body: JSON.stringify({ root: ROOT, choices: {}, secrets: {} }) }),
    );
    await flush();
    // Premise: the sweep alone would redact the 40-character segment.
    expect(scrubSecrets(path)).not.toBe(path);
    // Red if hideIn sweeps a plan's own `lines`, or stops sweeping check.lines.
    expect(sent.at(-1)).toMatchObject({
      answer: {
        lines: [`Writes ${path}`],
        plan: { check: { lines: ["at <redacted>"] } },
      },
    });
  });

  it("refuses a pull request on a branch that is not demoman/add-<file>", async () => {
    const asked: string[] = [];
    const { h, jobs } = setup({
      openPr: async (_root, a) => {
        asked.push(a.branch);
        return { failed: "pr", detail: "" };
      },
    });
    // Red if repoPr hands openPr any branch the page names.
    for (const branch of ["main", "demoman/setup", "demoman/add-x;rm", ""]) {
      expect(
        await h.repoPr(
          req({
            body: JSON.stringify({
              root: ROOT,
              branch,
              title: "t",
              body: "x",
              files: ["docs/a.mp4"],
            }),
          }),
        ),
      ).toMatchObject({ status: 409, json: { reason: "prBranchRefused" } });
    }
    // Red if the branch pattern drops \p{L}
    const repo = await realpath(await mkdtemp(join(tmpdir(), "studio-ci-br-")));
    try {
      await mkdir(join(repo, "docs"));
      await writeFile(join(repo, "docs", "café-checkout.mp4"), "mp4");
      jobs.added(repo, ["docs/café-checkout.mp4"]);
      const accepted = await h.repoPr(
        req({
          body: JSON.stringify({
            root: repo,
            branch: "demoman/add-café-checkout",
            title: "t",
            body: "x",
            files: ["docs/café-checkout.mp4"],
          }),
        }),
      );
      expect(body(accepted)).not.toMatchObject({ reason: "prBranchRefused" });
      expect(asked).toEqual(["demoman/add-café-checkout"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses an apply of a plan it does not hold, and never asks the CLI", async () => {
    const asked: string[] = [];
    const { h } = setup({
      apply: async (_root, planId) => {
        asked.push(planId);
        return applied();
      },
    });
    const apply = (planId: string) =>
      h.repoCiApply(req({ body: JSON.stringify({ root: ROOT, planId }) }));
    // Red if repoCiApply hands the CLI a planId the server holds no plan for.
    expect(await apply("plan-1")).toMatchObject({
      status: 409,
      json: { reason: "planNotFound" },
    });
    await planOnce(h);
    expect(await apply("plan-2")).toMatchObject({
      status: 409,
      json: { reason: "planNotFound" },
    });
    expect(asked).toEqual([]);
    // Premise: the plan it holds is applied.
    expect(await apply("plan-1")).toMatchObject({ status: 202 });
    await flush();
    expect(asked).toEqual(["plan-1"]);
  });

  it("an add makes the CLI forget the repo's plan, and refuses its apply", async () => {
    const forgot: string[] = [];
    const { h, jobs } = setup({ forget: (root) => forgot.push(root) });
    await planOnce(h);
    jobs.added(ROOT, ["docs/a.mp4"]);
    // Red if added() leaves the CLI's hold, or the server's, in place.
    expect(forgot).toEqual([ROOT]);
    expect(
      await h.repoCiApply(
        req({ body: JSON.stringify({ root: ROOT, planId: "plan-1" }) }),
      ),
    ).toMatchObject({ status: 409, json: { reason: "planNotFound" } });
  });

  it("a plan that ends after an add is not held, and says to check again", async () => {
    const gate = held<void>();
    const forgot: string[] = [];
    const { h, jobs, sent } = setup({
      plan: async () => {
        await gate.promise;
        return planned();
      },
      forget: (root) => forgot.push(root),
    });
    await h.repoCiPlan(
      req({ body: JSON.stringify({ root: ROOT, choices: {}, secrets: {} }) }),
    );
    jobs.added(ROOT, ["docs/b.mp4"]);
    gate.settle();
    await flush();
    // Red if a plan checked before the add is held: its apply would leave the new flow out.
    const done = sent.find((e) => e.type === "ci" && e.phase === "done");
    expect(done).toMatchObject({ answer: { reason: "planNotFound" } });
    expect(forgot).toEqual([ROOT, ROOT]);
    expect(
      await h.repoCiApply(
        req({ body: JSON.stringify({ root: ROOT, planId: "plan-1" }) }),
      ),
    ).toMatchObject({ status: 409, json: { reason: "planNotFound" } });
  });

  it("refuses a plan older than the ci tool's limit, and drops it", async () => {
    let t = 0;
    const asked: string[] = [];
    const forgot: string[] = [];
    const { h } = setup(
      {
        apply: async (_root, planId) => {
          asked.push(planId);
          return applied();
        },
        forget: (root) => forgot.push(root),
      },
      () => t,
    );
    await planOnce(h);
    t = PLAN_KEPT_MS + 1;
    // Red if repoCiApply applies a plan whose check is past PLAN_KEPT_MS.
    expect(
      await h.repoCiApply(
        req({ body: JSON.stringify({ root: ROOT, planId: "plan-1" }) }),
      ),
    ).toMatchObject({ status: 409, json: { reason: "planNotFound" } });
    expect(asked).toEqual([]);
    expect(forgot).toEqual([ROOT]);
  });
});
