import { describe, expect, it } from "vitest";
import type { CiDeps, CiPlan } from "../src/ci-setup.js";
import { ciWorkflow } from "../src/ci-workflow.js";
import { createStudioCi, releaseOlder } from "../src/studio-ci.js";

const ROOT = "/work/app";
const TYPED = "s3cret-value";
const READ = "env-value-123";

/** Deps whose `readGithub` answers `facts`; nothing else is reached. */
const depsAnswering = (facts: unknown) => () =>
  ({ readGithub: async () => facts }) as unknown as Omit<
    CiDeps,
    "log" | "signal"
  >;

const facts = (workflowOnDefault: boolean) => ({
  slug: "o/r",
  defaultBranch: "main",
  canPush: true,
  isAdmin: true,
  deployments: [],
  hasReleases: false,
  workflowOnDefault,
  setupBranch: null,
  remote: "origin",
});

/** A plan as B makes it, with its checked bytes not enumerable. */
function livePlan(): CiPlan {
  const plan: CiPlan = {
    root: ROOT,
    repo: { slug: "o/r", defaultBranch: "main", remote: "origin" },
    trigger: "push",
    offers: [
      {
        trigger: "push",
        label: "on each merge to main",
        offered: true,
        why: "",
      },
    ],
    route: "pr",
    artifact: false,
    filesFlows: [],
    app: null,
    deployment: null,
    check: { skipped: "no app" },
    secrets: [{ name: "S", status: "set" }],
    actionsSetting: "notNeeded",
    files: [".github/workflows/demoman.yml"],
    scriptOnly: [],
    branch: "demoman/setup",
    title: "Set up Demoman",
    update: null,
    pushCost: null,
    offBase: null,
  };
  Object.defineProperty(plan, "contents", {
    value: [{ path: ".github/workflows/demoman.yml", text: "on: push" }],
    enumerable: false,
  });
  return plan;
}

describe("the Studio's CI door", () => {
  it("says each GitHub answer as a CiState", async () => {
    const stateOf = (f: unknown) =>
      createStudioCi({ deps: depsAnswering(f) }).state(ROOT);
    // Red if GhUnusable loses its detail, or workflowOnDefault is not read.
    expect(
      await stateOf({ reason: "ghSignedOut", detail: "run gh auth login" }),
    ).toEqual({ kind: "noGh", detail: "run gh auth login" });
    expect(
      await stateOf({ reason: "githubUnreadable", detail: "gh timed out" }),
    ).toEqual({ kind: "unreadable", detail: "gh timed out" });
    // No workflow text to place: set up, and the reason is kept (DEM-269).
    expect(await stateOf(facts(true))).toEqual({
      kind: "setUp",
      unread: "GitHub sent no content for it",
    });
    expect(await stateOf(facts(false))).toEqual({ kind: "notSetUp" });
  });

  // DEM-269. Red if a set-up repo whose workflow an older release wrote is
  // not offered the update, or one that cannot be read, names no release or
  // is this release's is.
  it("offers an update only for a workflow an older release wrote", async () => {
    const workflow = (version: string, route: "pr" | "main") =>
      ciWorkflow({
        version,
        trigger: "daily",
        route,
        branch: "main",
        app: null,
        secrets: { accounts: [], app: [] },
      });
    const stateOf = (workflowText?: string) =>
      createStudioCi({
        deps: () =>
          ({
            version: "0.9.9",
            readGithub: async () => ({
              ...facts(true),
              ...(workflowText === undefined ? {} : { workflowText }),
            }),
          }) as unknown as Omit<CiDeps, "log" | "signal">,
      }).state(ROOT);
    expect(await stateOf(workflow("0.9.8", "main"))).toEqual({
      kind: "setUp",
      update: { from: "0.9.8", to: "0.9.9", trigger: "daily", route: "main" },
    });
    expect(await stateOf(workflow("0.9.9", "pr"))).toEqual({ kind: "setUp" });
    // Review of DEM-269: red if a newer workflow is offered a downgrade, or
    // a tag that is no release is compared as text.
    expect(await stateOf(workflow("0.9.10", "pr"))).toEqual({ kind: "setUp" });
    expect(await stateOf(workflow("latest", "pr"))).toMatchObject({
      kind: "setUp",
      unread: "its release latest cannot be compared with 0.9.9",
    });
    expect(await stateOf("name: Mine\non:\n  push:\n")).toMatchObject({
      kind: "setUp",
      unread: expect.stringContaining("refresh"),
    });
    expect(await stateOf(undefined)).toEqual({
      kind: "setUp",
      unread: "GitHub sent no content for it",
    });
    // A workflow run from a packed build names no release.
    expect(
      await stateOf(
        workflow("0.9.8", "pr").replace(/-y demoman@\S+/g, "-y demoman"),
      ),
    ).toMatchObject({
      kind: "setUp",
      unread: expect.stringContaining("names no"),
    });
    // Review of DEM-269: never offered while its pull request is open.
    const openPr = await createStudioCi({
      deps: () =>
        ({
          version: "0.9.9",
          readGithub: async () => ({
            ...facts(true),
            workflowText: workflow("0.9.8", "pr"),
            setupBranch: { pr: { number: 9, url: "https://x/9" } },
          }),
        }) as unknown as Omit<CiDeps, "log" | "signal">,
    }).state(ROOT);
    // Held back, and said (review of DEM-269).
    expect(openPr).toEqual({
      kind: "setUp",
      unread:
        "its update to 0.9.9 waits on the open setup pull request https://x/9",
    });
  });

  it("orders releases as releases, not as text", () => {
    expect(releaseOlder("0.9.8", "0.9.9")).toBe(true);
    expect(releaseOlder("0.9.10", "0.9.9")).toBe(false);
    expect(releaseOlder("0.9.9", "0.9.9")).toBe(false);
    expect(releaseOlder("0.10.0-rc.1", "0.10.0")).toBe(true);
    // Review of DEM-269: numbered pre-releases by number, not text.
    expect(releaseOlder("0.10.0-rc.9", "0.10.0-rc.10")).toBe(true);
    expect(releaseOlder("0.10.0-rc.10", "0.10.0-rc.9")).toBe(false);
    expect(releaseOlder("latest", "0.9.9")).toBeNull();
  });

  it("plans with the values untouched, applies the same live plan, and redacts every line", async () => {
    const plan = livePlan();
    const planned: { values: Map<string, string> }[] = [];
    const appliedWith: { plan: CiPlan; values: Map<string, string> }[] = [];
    const lines: string[] = [];
    const ci = createStudioCi({
      deps: (_root, progress) =>
        ({
          // The watch's lines come through `progress`, not `log`.
          watchSetupRun: async () => {
            progress(`the run printed ${READ}`);
          },
        }) as unknown as Omit<CiDeps, "log" | "signal">,
      planCiSetup: async (_root, _choices, deps, values) => {
        planned.push({ values: new Map(values) });
        // B adds every value it reads from this machine.
        values.set("FROM_ENV", READ);
        deps.log(`starting with ${TYPED} and ${READ}`);
        return plan;
      },
      applyCiSetup: async (p, deps, values) => {
        appliedWith.push({ plan: p, values });
        deps.log(`setting ${TYPED}`);
        await deps.watchSetupRun({ slug: "o/r", branch: "b", sha: "s" });
        return {
          pr: {
            opened: { number: 1, url: "https://pr", branch: "b", sha: "s" },
          },
          secrets: { set: ["S"], kept: [], failed: [] },
          setting: null,
          watched: {
            failed: {
              runUrl: "https://run",
              step: "record",
              tail: `echo ${READ}`,
              failedRuns: 1,
              gaveUp: false,
            },
          },
        };
      },
    });
    const answer = await ci.plan(
      ROOT,
      {},
      new Map([["S", TYPED]]),
      (l) => lines.push(l),
      new AbortController().signal,
    );
    // Red if the adapter changes or drops a typed value before B sees it.
    expect(planned[0]?.values).toEqual(new Map([["S", TYPED]]));
    if (!("planId" in answer)) throw new Error(JSON.stringify(answer));
    expect(JSON.stringify(answer)).not.toContain("contents");

    const done = await ci.apply(ROOT, answer.planId, (l) => lines.push(l));
    // Red if the plan is copied (B's apply then stops planWithoutFiles), or
    // apply is given a fresh map without the values the plan read.
    expect(appliedWith[0]?.plan).toBe(plan);
    expect(appliedWith[0]?.values.get("FROM_ENV")).toBe(READ);
    // Red if a line or the watch's tail is forwarded unredacted (R9).
    expect(lines).toEqual([
      "starting with <redacted> and <redacted>",
      "setting <redacted>",
      "the run printed <redacted>",
    ]);
    expect(done).toMatchObject({
      watched: { failed: { tail: "echo <redacted>" } },
    });
    expect(JSON.stringify(done)).not.toContain(READ);
    // Applied once.
    expect(await ci.apply(ROOT, answer.planId, () => {})).toMatchObject({
      reason: "planNotFound",
    });
  });

  it("hands the plan's stop signal to B's check, and none to apply", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const ci = createStudioCi({
      deps: depsAnswering(facts(false)),
      planCiSetup: async (_root, _choices, deps) => {
        signals.push(deps.signal);
        return livePlan();
      },
      applyCiSetup: async (_p, deps) => {
        signals.push(deps.signal);
        return { reason: "prFailed", detail: "" };
      },
    });
    const stopper = new AbortController();
    const answer = await ci.plan(ROOT, {}, new Map(), () => {}, stopper.signal);
    if (!("planId" in answer)) throw new Error(JSON.stringify(answer));
    await ci.apply(ROOT, answer.planId, () => {});
    // Red if depsOf drops the plan's signal, or passes one to apply (R11).
    expect(signals).toEqual([stopper.signal, undefined]);
  });

  it("forgets the plan held for a repo, and only that repo's", async () => {
    let applies = 0;
    const ci = createStudioCi({
      deps: depsAnswering(facts(false)),
      planCiSetup: async () => livePlan(),
      applyCiSetup: async () => {
        applies += 1;
        return { reason: "prFailed", detail: "" };
      },
    });
    const planOf = async (root: string) => {
      const p = await ci.plan(
        root,
        {},
        new Map(),
        () => {},
        new AbortController().signal,
      );
      if (!("planId" in p)) throw new Error(JSON.stringify(p));
      return p.planId;
    };
    const here = await planOf(ROOT);
    const there = await planOf("/work/other");
    ci.forget(ROOT);
    // Red if forget leaves the repo's plan held, or drops another repo's.
    expect(await ci.apply(ROOT, here, () => {})).toMatchObject({
      reason: "planNotFound",
    });
    expect(applies).toBe(0);
    await ci.apply("/work/other", there, () => {});
    expect(applies).toBe(1);
  });
});
