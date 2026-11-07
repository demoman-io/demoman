import type { CiState } from "@demoman/studio-protocol";
import { describe, expect, it } from "vitest";
import type { CiEvent } from "../../../pages/src/platform/types";
import { ciSteps, type RepoCiDoor } from "../../../pages/src/shell/ci-steps";

/** A CI door that answers `state`, and lets the test send events and see bodies. */
function ciDoor(state: CiState | Error) {
  let send: (e: CiEvent) => void = () => {};
  const offs = { ci: 0 };
  const planBodies: Array<{ root: string; choices: object; secrets: object }> =
    [];
  const applyBodies: unknown[] = [];
  const door: RepoCiDoor = {
    state: async () => {
      if (state instanceof Error) throw state;
      return state;
    },
    plan: async (b) => {
      planBodies.push(b);
      return { jobId: "ci-1" };
    },
    apply: async (b) => {
      applyBodies.push(b);
      return { jobId: "ci-2" };
    },
    openPr: async () => ({ failed: "pr", detail: "" }),
    onCi: (_job, fn) => {
      send = fn;
      return () => {
        offs.ci += 1;
      };
    },
  };
  const tellCi = (e: Record<string, unknown>) =>
    send({ type: "ci", jobId: "ci-1", ...e } as CiEvent);
  return { door, offs, planBodies, applyBodies, tellCi };
}

const stopOf = (extra: object) => ({ reason: "x", detail: "d", ...extra });

async function read(state: CiState | Error) {
  const d = ciDoor(state);
  let changes = 0;
  const s = ciSteps(d.door, "/r", () => {
    changes += 1;
  });
  await s.read();
  return { d, s, changes: () => changes };
}

describe("ciSteps", () => {
  // Red if a CiState stops leading to its own step (notSetUp form, setUp, note for noGh and unreadable, working for running).
  it.each([
    [{ kind: "notSetUp" }, "form"],
    [{ kind: "setUp" }, "setUp"],
    [{ kind: "noGh", detail: "gh is not signed in." }, "note"],
    [{ kind: "unreadable", detail: "Cannot read." }, "note"],
    [{ kind: "running", jobId: "ci-1" }, "working"],
  ] as Array<[CiState, string]>)("%j leads to %s", async (state, k) => {
    const { s } = await read(state);
    expect(s.step.k).toBe(k);
  });

  // Red if a state read that fails is not said (it would look like "set up").
  it("a state read that throws is a note with its words", async () => {
    const { s } = await read(new Error("gh died"));
    expect(s.step).toEqual({ k: "note", text: "gh died" });
  });

  // Red if the plan's listener stays after its final event.
  it("stops listening once the plan ends", async () => {
    const { d, s } = await read({ kind: "notSetUp" });
    await s.check({});
    expect(d.offs.ci).toBe(0);
    d.tellCi({ phase: "done", step: "plan", answer: stopOf({}) });
    expect(d.offs.ci).toBe(1);
  });

  // Red if the filled holes stop being merged over the draft: a good start blanked, a url hole lost, or an env.X hole dropped.
  it("keeps the draft's start and merges the url and env holes on the next Check", async () => {
    const { d, s } = await read({ kind: "notSetUp" });
    await s.check({});
    d.tellCi({
      phase: "done",
      step: "plan",
      answer: stopOf({
        reason: "appHoles",
        proposal: {
          draft: {
            appVersion: 1,
            install: [],
            start: "pnpm dev",
            url: null,
            timeoutSeconds: 60,
            env: { KEEP: "1" },
          },
          source: { kind: "agent" },
          holes: [
            { field: "url", why: "no origin" },
            { field: "env.API_HOST", why: "no value" },
          ],
        },
      }),
    });
    // Premise: the draft already has a good start, and it is not a hole.
    expect(s.proposal?.draft.start).toBe("pnpm dev");
    expect(s.proposal?.holes.map((h) => h.field)).not.toContain("start");
    expect(s.step).toMatchObject({ k: "form", stop: { reason: "appHoles" } });
    s.holes.url = "http://localhost:3000";
    s.holes["env.API_HOST"] = "localhost";
    await s.check({});
    expect(d.planBodies).toHaveLength(2);
    expect(d.planBodies[1]).toMatchObject({
      root: "/r",
      choices: {
        app: {
          start: "pnpm dev",
          url: "http://localhost:3000",
          env: { KEEP: "1", API_HOST: "localhost" },
        },
        appBy: "person",
      },
    });
  });

  // Red if changing the trigger or route stops marking the plan stale, or a stale plan can still be applied (R16).
  it("cannot apply a plan after its trigger or route changed", async () => {
    const { d, s } = await read({ kind: "notSetUp" });
    await s.check({});
    d.tellCi({
      phase: "done",
      step: "plan",
      answer: { planId: "p1", plan: {}, lines: [] },
    });
    expect(s.step).toMatchObject({ k: "planned", stale: false });
    s.markStale();
    expect(s.step).toMatchObject({ k: "planned", stale: true });
    await s.apply();
    expect(d.applyBodies).toEqual([]);
  });

  // Red if a stop other than appHoles/secretMissing stops ending on the stopped step.
  it("ends on the stop for any other reason", async () => {
    const { d, s } = await read({ kind: "notSetUp" });
    await s.check({});
    d.tellCi({
      phase: "done",
      step: "plan",
      answer: stopOf({ reason: "alreadySetUp" }),
    });
    expect(s.step.k).toBe("stopped");
  });

  // Red if a finished job's answer stops showing on reopening instead of offering setup again.
  it("shows a finished job's result", async () => {
    const { s } = await read({
      kind: "finished",
      jobId: "ci-9",
      step: "plan",
      answer: stopOf({ reason: "alreadySetUp" }),
    });
    expect(s.step.k).toBe("stopped");
  });

  // Red if a plan answered by a job that was not this one's (replayed by state) can be applied without a fresh Check.
  it.each([
    [{ kind: "running", jobId: "ci-1" }],
    [
      {
        kind: "finished",
        jobId: "ci-1",
        step: "plan",
        answer: { planId: "p0", plan: {}, lines: [] },
      },
    ],
  ] as Array<[CiState]>)("a replayed plan from %j is stale", async (state) => {
    const { d, s } = await read(state);
    if (state.kind === "running")
      d.tellCi({
        phase: "done",
        step: "plan",
        answer: { planId: "p0", plan: {}, lines: [] },
      });
    expect(s.step).toMatchObject({ k: "planned", stale: true });
    await s.apply();
    expect(d.applyBodies).toEqual([]);
    await s.check({});
    expect(d.planBodies).toHaveLength(1);
  });

  // Red if a stopped step (live or replayed) cannot lead back to Check.
  it("Check after an actionsRefused stop sends a new plan", async () => {
    const live = await read({ kind: "notSetUp" });
    await live.s.check({});
    live.d.tellCi({
      phase: "done",
      step: "plan",
      answer: stopOf({ reason: "actionsRefused" }),
    });
    expect(live.s.step.k).toBe("stopped");
    await live.s.check({});
    expect(live.d.planBodies).toHaveLength(2);
  });

  // Red if the panels show the timings.
  it("leaves timing lines out of its panel", async () => {
    const { d, s } = await read({ kind: "notSetUp" });
    await s.check({});
    for (const line of ["timing export 4s", "Checking", "timing refresh 9s"])
      d.tellCi({ phase: "progress", line });
    expect(s.step).toEqual({ k: "working", lines: ["Checking"] });
  });

  // Red if an apply's pull request is not kept for the caller's result.
  it("an apply's pull request is its prUrl", async () => {
    const { d, s } = await read({ kind: "notSetUp" });
    await s.check({});
    d.tellCi({
      phase: "done",
      step: "plan",
      answer: { planId: "p1", plan: {}, lines: [] },
    });
    await s.apply();
    d.tellCi({
      phase: "done",
      step: "apply",
      answer: {
        pr: { opened: { number: 3, url: "https://gh/pr/3" } },
        secrets: { set: [], kept: [], failed: [] },
        setting: null,
        watched: { unknown: { why: "w", runUrl: null } },
        lines: [],
      },
    });
    expect(s.step.k).toBe("applied");
    expect(s.prUrl).toBe("https://gh/pr/3");
  });

  // Red if a stopped instance keeps redrawing (a closed sheet's job ending later).
  it("says nothing after stop", async () => {
    const { d, s, changes } = await read({ kind: "notSetUp" });
    await s.check({});
    const before = changes();
    s.stop();
    d.tellCi({ phase: "progress", line: "late" });
    expect(changes()).toBe(before);
  });
});
