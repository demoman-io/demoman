import { beforeEach, describe, expect, it, vi } from "vitest";

// The real menus over a scripted clack: each prompt answers from `script`
// in order. clack's own cancel symbol is private, so the mock's isCancel
// knows this one.
const CANCEL = Symbol("cancel");
const script: unknown[] = [];
const prompted: string[] = [];
vi.mock("@clack/prompts", async (importActual) => {
  const actual = await importActual<typeof import("@clack/prompts")>();
  const next = (kind: string) => async () => {
    prompted.push(kind);
    return script.shift();
  };
  return {
    ...actual,
    isCancel: (v: unknown) => v === CANCEL,
    multiselect: next("multiselect"),
    select: next("select"),
  };
});

describe("setup's menus, cancelled part way", () => {
  beforeEach(() => {
    script.length = 0;
    prompted.length = 0;
  });

  // Esc or Ctrl+C at a later menu must cancel the whole run, not skip that
  // one question and go on to wire agents.
  it.each([
    ["the quality menu", 1],
    ["the pull-request menu", 2],
  ])("answers cancelled at %s and asks nothing after it", async (_, at) => {
    const { realSetupDeps } = await import("../src/setup-deps.js");
    const answers: unknown[] = [["Claude Code"], "high", "ask"];
    answers[at] = CANCEL;
    script.push(...answers);
    const ask = realSetupDeps("0.0.0", "/nowhere", {
      stdinTTY: true,
      stdoutTTY: true,
      env: {},
    }).ask;
    const got = await ask?.({
      agents: ["Claude Code"],
      quality: "high",
      pullRequests: "ask",
    });
    expect(got).toBe("cancelled");
    // The premise: the menus ran through the mock, up to the cancel.
    expect(prompted).toEqual(
      ["multiselect", "select", "select"].slice(0, at + 1),
    );
  });
});
