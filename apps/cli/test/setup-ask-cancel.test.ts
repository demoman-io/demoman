import { beforeEach, describe, expect, it, vi } from "vitest";

// The real menus over a scripted clack: each prompt answers from `script`
// in order. clack's own cancel symbol is private, so the mock's isCancel
// knows this one.
const CANCEL = Symbol("cancel");
const script: unknown[] = [];
const prompted: string[] = [];
/** Each prompt's options, in order. */
const shown: unknown[] = [];
vi.mock("@clack/prompts", async (importActual) => {
  const actual = await importActual<typeof import("@clack/prompts")>();
  const next = (kind: string) => async (o: unknown) => {
    prompted.push(kind);
    shown.push(o);
    return script.shift();
  };
  return {
    ...actual,
    isCancel: (v: unknown) => v === CANCEL,
    multiselect: next("multiselect"),
    select: next("select"),
    password: next("password"),
    confirm: next("confirm"),
    text: next("text"),
    note: (...a: unknown[]) => {
      prompted.push("note");
      shown.push(a);
    },
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

describe("setup --ci's questions", () => {
  const facts = {
    slug: "o/r",
    defaultBranch: "trunk",
    canPush: true,
    isAdmin: true,
    deployments: [],
    hasReleases: true,
    workflowOnDefault: false,
    setupBranch: null,
    remote: "origin",
  };
  beforeEach(() => {
    script.length = 0;
    prompted.length = 0;
    shown.length = 0;
  });

  it("offers only the offered triggers, labelled with the real branch, the default first chosen", async () => {
    // Red with the old fixed menu: a deployment never on record, and "main".
    const { ciPrompts } = await import("../src/setup-deps.js");
    const { triggerOffers } = await import("../src/ci-setup.js");
    const offers = triggerOffers(facts);
    script.push(2); // the third option shown
    expect(await ciPrompts().trigger(offers)).toBe("push");
    const menu = shown[0] as {
      options: Array<{ value: number; label: string }>;
      initialValue: number;
    };
    expect(menu.options.map((o) => o.label)).toEqual([
      "when a release is published",
      "once a day",
      "on each merge to trunk",
    ]);
    expect(menu.options[menu.initialValue]?.label).toBe(
      "when a release is published",
    );
  });

  it("asks a secret unseen, and offers the route with the real branch", async () => {
    const { ciPrompts } = await import("../src/setup-deps.js");
    script.push("s3cret-value-long", "main");
    expect(await ciPrompts().secret("STRIPE_KEY", "app.json")).toBe(
      "s3cret-value-long",
    );
    expect(await ciPrompts().route("trunk")).toBe("main");
    expect(prompted).toEqual(["password", "select"]);
    const menu = shown[1] as { options: Array<{ label: string }> };
    expect(menu.options.map((o) => o.label)).toContain(
      "Committed straight to trunk",
    );
  });

  it("imports from an env file only after a yes, and a cancel at the plan is a no", async () => {
    const { ciPrompts } = await import("../src/setup-deps.js");
    script.push(false, true, ["A_KEY"], CANCEL);
    expect(await ciPrompts().envFile(".env", ["A_KEY", "B_KEY"])).toEqual([]);
    expect(await ciPrompts().envFile(".env", ["A_KEY", "B_KEY"])).toEqual([
      "A_KEY",
    ]);
    expect(
      await ciPrompts().confirm(["Records the repo flows once a day."]),
    ).toBe(false);
    expect(prompted).toEqual([
      "confirm",
      "confirm",
      "multiselect",
      "note",
      "confirm",
    ]);
  });
});
