import { describe, expect, it } from "vitest";
import type { CiDeps, CiPlan } from "../src/ci-setup.js";
import { createStudioCi } from "../src/studio-ci.js";

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
    app: null,
    deployment: null,
    check: { skipped: "no app" },
    secrets: [{ name: "S", status: "set" }],
    actionsSetting: "notNeeded",
    files: [".github/workflows/demoman.yml"],
    scriptOnly: [],
    branch: "demoman/setup",
    title: "Set up Demoman",
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
    expect(await stateOf(facts(true))).toEqual({ kind: "setUp" });
    expect(await stateOf(facts(false))).toEqual({ kind: "notSetUp" });
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
    const answer = await ci.plan(ROOT, {}, new Map([["S", TYPED]]), (l) =>
      lines.push(l),
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
});
