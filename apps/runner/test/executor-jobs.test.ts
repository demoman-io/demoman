import { JOBS_KEPT } from "@demoman/agent-bridge";
import { describe, expect, it } from "vitest";
import { createJobTable, type Job } from "../src/executor/executor.js";

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

  it("lets go of the call that settled first, so a long one that settles late stays (DEM-141)", () => {
    // Red: order by start only — the long call is let go at the next set.
    const jobs = createJobTable();
    const long = inFlight();
    jobs.set("long", long);
    for (let i = 0; i < JOBS_KEPT; i++) jobs.set(`call-${i}`, settled());
    // Premise: full, with the long call first; call-0 went to make room.
    expect(jobs.get("long")).toBe(long);
    expect(jobs.get("call-0")).toBeUndefined();
    expect(jobs.get("call-1")).toBeDefined();
    long.final = { ok: true, value: { outcome: "complete" } };
    jobs.set("next", settled());
    expect(jobs.get("long")).toBe(long);
    expect(jobs.get("long")?.final).toEqual({
      ok: true,
      value: { outcome: "complete" },
    });
    expect(jobs.get("call-0")).toBeUndefined();
    expect(jobs.get("call-1")).toBeUndefined();
    expect(jobs.get("call-2")).toBeDefined();
    expect(jobs.get("next")).toBeDefined();
  });
});
