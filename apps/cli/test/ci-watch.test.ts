import { describe, expect, it } from "vitest";
import { type Watched, watchSetupRun } from "../src/ci-watch.js";
import type { Gh } from "../src/gh-run.js";

const URL = "https://github.com/o/r/actions/runs/7";
const A = { slug: "o/r", branch: "demoman/setup", sha: "abc" };
type View = {
  status: string;
  conclusion: string | null;
  step?: string;
  failedStep?: string;
};
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const bad = { code: 1, stdout: "", stderr: "network down" };

// views: one entry per `run view`; the last repeats. A null entry is a gh error.
function rig(o: {
  views?: (View | null)[];
  listed?: unknown[] | null;
  failedRuns?: number;
  counted?: { conclusion: string }[] | "unreadable";
  log?: string;
}) {
  let clock = 0;
  let v = 0;
  const progress: string[] = [];
  const views = o.views ?? [];
  const gh: Gh = async (args) => {
    if (args[0] === "run" && args[1] === "list") {
      if (!args.join(" ").includes("headSha")) {
        if (o.counted === "unreadable") return bad;
        if (o.counted) return ok(JSON.stringify(o.counted));
        return ok(
          JSON.stringify(
            Array.from({ length: o.failedRuns ?? 0 }, () => ({
              conclusion: "failure",
            })),
          ),
        );
      }
      if (o.listed === null) return bad;
      return ok(
        JSON.stringify(
          o.listed ?? [{ databaseId: 7, headSha: "abc", url: URL }],
        ),
      );
    }
    if (args[1] === "view" && args.includes("--log-failed"))
      return ok(o.log ?? "");
    if (args[1] === "view") {
      const x = views[Math.min(v++, views.length - 1)];
      if (!x) return bad;
      const steps = [
        {
          name: x.failedStep ?? x.step ?? "Install",
          status: x.step ? "in_progress" : "completed",
          conclusion: x.failedStep ? "failure" : null,
        },
      ];
      return ok(
        JSON.stringify({
          status: x.status,
          conclusion: x.conclusion,
          jobs: [{ name: "check", steps }],
        }),
      );
    }
    throw new Error(args.join(" "));
  };
  const deps = {
    gh,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    progress: (l: string) => void progress.push(l),
  };
  return { deps, progress };
}
const run = (r: ReturnType<typeof rig>, extra = {}) =>
  watchSetupRun({ ...A, ...extra }, r.deps);

describe("watchSetupRun", () => {
  it("passes after queued then in progress, with the run's artifacts link", async () => {
    const r = rig({
      views: [
        { status: "queued", conclusion: null },
        { status: "in_progress", conclusion: null, step: "Record" },
        { status: "completed", conclusion: "success" },
      ],
    });
    const w = (await run(r)) as {
      passed: { runUrl: string; artifactUrl: string };
    };
    expect(w.passed.runUrl).toBe(URL);
    expect(w.passed.artifactUrl).toBe(`${URL}#artifacts`);
    expect(r.progress.some((l) => l.includes("Record"))).toBe(true);
  });

  it("fails with the failing step and a scrubbed 40-line tail, and counts failed runs", async () => {
    const log = Array.from({ length: 60 }, (_, i) => `line ${i}`)
      .join("\n")
      .concat("\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    const r = rig({
      views: [
        {
          status: "completed",
          conclusion: "failure",
          failedStep: "Record flows",
        },
      ],
      failedRuns: 2,
      log,
    });
    const w = (await run(r)) as {
      failed: {
        step: string;
        tail: string;
        failedRuns: number;
        gaveUp: boolean;
        runUrl: string;
      };
    };
    expect(w.failed.step).toBe("Record flows");
    expect(w.failed.tail.split("\n")).toHaveLength(40);
    expect(w.failed.tail).not.toContain("line 5\n");
    expect(w.failed.tail).not.toContain("ghp_");
    expect(w.failed.failedRuns).toBe(2);
    expect(w.failed.gaveUp).toBe(false);
  });

  it("gives up at the third failed run", async () => {
    const r = rig({
      views: [{ status: "completed", conclusion: "failure", failedStep: "x" }],
      failedRuns: 3,
    });
    expect(
      ((await run(r)) as { failed: { gaveUp: boolean } }).failed.gaveUp,
    ).toBe(true);
  });

  it("reports a cancelled run as cancelled", async () => {
    const r = rig({
      views: [{ status: "completed", conclusion: "cancelled" }],
    });
    expect(await run(r)).toEqual({ cancelled: { runUrl: URL } });
  });

  it("five gh errors in a row are unknown, naming the run and never failed", async () => {
    const r = rig({
      views: [{ status: "in_progress", conclusion: null }, null],
    });
    const w = (await run(r)) as { unknown: { runUrl: string; why: string } };
    expect(w.unknown.runUrl).toBe(URL);
    expect(w.unknown.why).toContain("its outcome is unknown, not failed");
    expect(w.unknown.why).toContain(URL);
    expect("failed" in w).toBe(false);
  });

  it("two errors then success is passed", async () => {
    const r = rig({
      views: [null, null, { status: "completed", conclusion: "success" }],
    });
    expect("passed" in (await run(r))).toBe(true);
  });

  it("no run by appearMs is unknown, naming the paths and the Actions settings", async () => {
    const r = rig({ listed: [] });
    const w = (await run(r, { appearMs: 60_000 })) as {
      unknown: { runUrl: string | null; why: string };
    };
    expect(w.unknown.runUrl).toBeNull();
    expect(w.unknown.why).toContain("pull_request");
    expect(w.unknown.why).toContain("https://github.com/o/r/settings/actions");
  });

  it("a run for another sha is not ours", async () => {
    const r = rig({ listed: [{ databaseId: 9, headSha: "old", url: "u" }] });
    expect("unknown" in (await run(r, { appearMs: 30_000 }))).toBe(true);
  });

  it("a run that never finishes is unknown at the timeout, with its URL", async () => {
    const r = rig({ views: [{ status: "in_progress", conclusion: null }] });
    const w = (await run(r, { timeoutMs: 60_000 })) as Watched & {
      unknown: { runUrl: string; why: string };
    };
    expect(w.unknown.runUrl).toBe(URL);
    expect(w.unknown.why).toContain("still running");
  });

  it("an unreadable failed-run count is null with a note, never a guessed 1", async () => {
    const r = rig({
      views: [{ status: "completed", conclusion: "failure", failedStep: "x" }],
      counted: "unreadable",
    });
    const w = (await run(r)) as {
      failed: { failedRuns: number | null; gaveUp: boolean; note: string };
    };
    expect(w.failed.failedRuns).toBeNull();
    expect(w.failed.gaveUp).toBe(false);
    expect(w.failed.note).toContain("unknown");
    expect(w.failed.note).toContain(URL);
  });

  it("a timed_out run counts as failed, at least once", async () => {
    const r = rig({
      views: [
        { status: "completed", conclusion: "timed_out", failedStep: "x" },
      ],
      counted: [
        { conclusion: "timed_out" },
        { conclusion: "timed_out" },
        { conclusion: "failure" },
      ],
    });
    const w = (await run(r)) as {
      failed: { failedRuns: number; gaveUp: boolean };
    };
    expect(w.failed.failedRuns).toBe(3);
    expect(w.failed.gaveUp).toBe(true);
  });

  it("a list lagging behind the current run still counts it once", async () => {
    const r = rig({
      views: [{ status: "completed", conclusion: "failure", failedStep: "x" }],
      counted: [],
    });
    expect(
      ((await run(r)) as { failed: { failedRuns: number } }).failed.failedRuns,
    ).toBe(1);
  });

  it("action_required is unknown with the run URL, not failed", async () => {
    const r = rig({
      views: [{ status: "completed", conclusion: "action_required" }],
    });
    const w = (await run(r)) as { unknown: { runUrl: string; why: string } };
    expect(w.unknown.runUrl).toBe(URL);
    expect("failed" in w).toBe(false);
  });
});
