import { describe, expect, it } from "vitest";
import {
  createJobTable,
  JOBS_KEPT,
  type Job,
} from "../src/executor/executor.js";

const settled = (): Job => ({
  op: "run",
  latest: null,
  final: { ok: true, value: { outcome: "complete" } },
});
const inFlight = (): Job => ({ op: "export", latest: {}, final: null });

// Review 2026-10-13, #7: every run and export stayed in the table, with its
// whole report, for the life of the process. Red if `set` never lets go.
describe("the job table report(id) answers from", () => {
  it("keeps the latest JOBS_KEPT, letting the oldest settled one go", () => {
    const jobs = createJobTable();
    for (let i = 0; i <= JOBS_KEPT; i++) jobs.set(`call-${i}`, settled());
    // The premise: one more than it keeps went in.
    expect(jobs.get(`call-${JOBS_KEPT}`)).toBeDefined();
    expect(jobs.get("call-0")).toBeUndefined();
    expect(jobs.get("call-1")).toBeDefined();
  });

  it("never lets go of a call still in flight, however old", () => {
    const jobs = createJobTable(2);
    jobs.set("old-but-running", inFlight());
    jobs.set("a", settled());
    jobs.set("b", settled());
    expect(jobs.get("old-but-running")).toBeDefined();
    expect(jobs.get("a")).toBeUndefined();
    expect(jobs.get("b")).toBeDefined();
  });
});
