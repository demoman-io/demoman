import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DemoScriptSchema, type ScriptStep } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { INSTRUCTIONS_CLI } from "../src/instructions";
import { readRecipe } from "../src/recipe";

/**
 * The recipe is what an agent actually reads (spec §6, moved here from the
 * record-demo skill by plan 2), so it is held to the code: its examples to
 * the schema, its reasons to every reason the code can answer, and the
 * server's instructions to the length Claude Code delivers whole.
 *
 * One since 2026-10-20: `recipe-extension.md`, the extension executor's,
 * was archived with it, and its scans with it.
 */
const RECIPE = readRecipe();
const blocksOf = (recipe: string): string[] =>
  [...recipe.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] as string);

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "..", "..", "..");
const dir = (d: string) =>
  readdirSync(join(repo, d))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(d, f));
/** Every .ts file under `d`, at any depth. */
const tree = (d: string): string[] =>
  readdirSync(join(repo, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tree(join(d, e.name))
      : e.name.endsWith(".ts")
        ? [join(d, e.name)]
        : [],
  );
/** The files whose answers reach an agent: the CLI's executor, the shared
 *  run logic (the door's script refusals and the snapshot's own; auto-zoom.ts
 *  is left out, its `reason`s being notes a take keeps about zooms it
 *  skipped, which no tool answers), and the tools themselves. */
const CLI_SOURCES = [
  ...dir("apps/mcp/src"),
  ...dir("apps/runner/src/executor"),
  ...tree("packages/run-core/src").filter((f) => !f.endsWith("auto-zoom.ts")),
];
/** Answered by tools.ts itself rather than spelled through a helper the
 *  scan reads. */
const CLI_TOOL_REASONS = ["browserSilent", "unknownRun"];
/** Every way a reason is spelled where it is answered: a helper's first
 *  argument (`failure(`, `refused(`, `refusal(`, `refuse(` and the door's
 *  `refuseBeforeRun(`), a `LibraryError`'s, or a `reason`/`failed` field. */
const REASON =
  /(?:failure|refuseBeforeRun|refused|refusal|refuse|new LibraryError)\(\s*"(\w+)"|reason\s*[:=]\s*"(\w+)"|failed\s*:\s*"(\w+)"/g;
function reasonsInCode(sources: string[] = CLI_SOURCES): string[] {
  const found = new Set<string>();
  for (const file of sources) {
    for (const m of readFileSync(join(repo, file), "utf8").matchAll(REASON)) {
      found.add((m[1] ?? m[2] ?? m[3]) as string);
    }
  }
  return [...found].sort();
}

// The format and the reading of a snapshot.
describe("the recipe's examples and snapshot reading", () => {
  const recipe = RECIPE;
  const blocks = () => blocksOf(recipe);

  it("has examples to check — or 'every block parses' passes on none", () => {
    expect(blocks().length).toBeGreaterThanOrEqual(2);
  });

  // Red if a verb is renamed or a strict key is added and the recipe is not
  // updated: an agent would copy an example the door refuses.
  it("every json example is a DemoScript the door accepts", () => {
    for (const [i, block] of blocks().entries()) {
      const result = DemoScriptSchema.safeParse(JSON.parse(block));
      expect(
        result.success,
        `block ${i}: ${JSON.stringify(result.error?.issues)}`,
      ).toBe(true);
    }
  });

  it("shows every verb and every target shape at least once, and a scroll's landing", () => {
    const steps: ScriptStep[] = blocks().flatMap(
      (b) => DemoScriptSchema.parse(JSON.parse(b)).steps,
    );
    // A Record, not a list: a verb added to the schema and not here fails to
    // compile rather than going unshown.
    const verbs: Record<ScriptStep["do"], boolean> = {
      click: false,
      type: false,
      hover: false,
      scrollTo: false,
      waitFor: false,
      drag: false,
      waitForLoad: false,
      pause: false,
    };
    const shapes = new Set<string>();
    for (const step of steps) {
      verbs[step.do] = true;
      const target = "on" in step ? step.on : "into" in step ? step.into : null;
      if (target !== null) shapes.add(Object.keys(target).sort().join("+"));
    }
    expect(
      Object.entries(verbs)
        .filter(([, seen]) => !seen)
        .map(([v]) => v),
    ).toEqual([]);
    expect([...shapes].sort()).toEqual([
      "name+role",
      "stableId",
      "text",
      "treePath",
    ]);
    expect(
      steps.some((s) => s.do === "scrollTo" && s.landing !== undefined),
    ).toBe(true);
  });

  // Red if the recipe stops saying how to poll: plan 1's text said only
  // "until the outcome is not 'running'", and an export never says running.
  it("says to poll a run until it is not running and an export until it is not exporting", () => {
    expect(recipe).toMatch(/`running`/);
    expect(recipe).toMatch(/`exporting`/);
    expect(recipe).toMatch(/`stillRunning`/);
    expect(recipe).not.toMatch(/until the outcome is not `exporting`/);
  });

  // Plan 2, Review Focus 1. Red if the signed-out signal is not taught.
  it("tells the agent what landedElsewhere means and that it costs no run", () => {
    expect(recipe).toMatch(/`landedElsewhere[^`]*`[^\n]*sign/);
  });

  // Final review, finding 1. Red if the recipe reads every redirect as
  // signed out: a `/faq` → `/faq/` or http → https redirect is not a sign-in,
  // and the move there is to use `landedUrl`.
  it("tells the agent to read landedUrl, and to use it when it is not a sign-in page", () => {
    expect(recipe).toMatch(/not a sign-in[^.]*`landedUrl`/);
  });

  // Final review, finding 3. Red if the recipe asks for a snapshot of a page
  // state no snapshot can reach: `snapshot(url)` loads `url` fresh and takes
  // no steps, so content a click creates is never in it.
  it("says a snapshot sees only the page as loaded, and never asks for one after a step", () => {
    expect(recipe).toMatch(/only the page as it loads/);
    expect(recipe).not.toMatch(/[Ss]napshot again after a step/);
    expect(recipe).not.toMatch(/snapshot what the run's report shows/);
  });
});

describe("the sign-in rule", () => {
  // Red if any of the public places an agent reads drops the rule: only demo
  // accounts, and never the user's own password, never asked for. (Launch C2
  // replaced C's absolute "never sign in" with it.) The author's repo skill,
  // in internal/, is held to the same rule by internal/site/test/product-docs.test.mjs.
  const skill = (p: string) =>
    readFileSync(join(repo, p), "utf8").replace(/\s+/g, " ");
  const ONLY = /only demo accounts/i;
  const NEVER = /never ask for (the user's|their) (own )?password/i;
  const places = (): Array<[string, string]> => [
    ["the instructions", INSTRUCTIONS_CLI],
    ["the recipe", RECIPE.replace(/\s+/g, " ")],
    ["the plugin skill", skill("apps/cli/plugin/skills/record-demo/SKILL.md")],
  ];
  it("is in the instructions, the recipe and the plugin skill", () => {
    for (const [where, text] of places()) {
      expect(text, `${where}: only demo accounts`).toMatch(ONLY);
      expect(text, `${where}: never ask for the password`).toMatch(NEVER);
    }
  });
  it("no longer says C's absolute never-sign-in", () => {
    for (const [where, text] of places()) {
      expect(text, where).not.toMatch(/never sign in\b/i);
      expect(text, where).not.toContain("You never sign in yourself");
    }
  });
  // The carve-out that keeps the rule from refusing a demo of the sign-in
  // form itself, typed with values the user supplied.
  it("keeps the sign-in demo carve-out in the recipe", () => {
    expect(RECIPE.replace(/\s+/g, " ")).toContain(
      "A sign-in or sign-up demo is not signing in",
    );
  });
});

describe("the CLI's recipe on demo accounts (launch C2)", () => {
  const flat = RECIPE.replace(/\s+/g, " ");
  const NEW_REASONS = [
    "signInFailed",
    "secretMissing",
    "secretTooShort",
    "secretUnbound",
    "secretOffOrigin",
    "secretsFileNotIgnored",
    "secretsFileInvalid",
    "accountsInvalid",
    "unknownAccount",
    "invalidProject",
  ];
  // Red if a reason is missing from section 7's table: its own row, with
  // the move, not a mention elsewhere.
  it("gives every new reason a row in the refusals table", () => {
    const table = RECIPE.slice(RECIPE.indexOf("## 7. Every reason"));
    for (const r of NEW_REASONS) {
      expect(table, r).toMatch(new RegExp(`^\\| \`${r}\` \\|`, "m"));
    }
  });
  // Red if the recipe describes status shapes the executor does not return
  // (review fix: it said `refused` and an `ignored` boolean; the executor
  // answers `invalid`, `searchedFrom`, `absent` and `git`).
  it("describes status.accounts and status.secretsFile by the keys the executor returns", () => {
    const sec = flat.slice(
      flat.indexOf("`status.accounts`"),
      flat.indexOf("A page behind a login answers"),
    );
    expect(sec.length, "the section was found").toBeGreaterThan(200);
    for (const key of ["invalid", "searchedFrom", "git", "notGit", "absent"]) {
      expect(sec, key).toContain(key);
    }
    expect(sec).not.toContain("accounts.refused");
    expect(sec).not.toMatch(/\bignored`? (boolean|field)|`ignored`/);
    expect(sec).toContain('git: "ignored"');
    // The same keys come from the executor itself.
    const exec = readFileSync(
      join(repo, "apps/runner/src/executor/executor.ts"),
      "utf8",
    );
    for (const key of [
      "searchedFrom",
      "invalid:",
      "absent: true",
      "refused:",
    ]) {
      expect(exec, key).toContain(key);
    }
  });

  it("names the files, the prefix and the version", () => {
    for (const phrase of [
      ".demoman/accounts.json",
      "DEMOMAN_SECRET_",
      "DEMOMAN_SECRET_NAME_ORIGIN",
      ".demoman/secrets.env",
      "checkUrl",
      '"account"',
      "scriptVersion 5",
    ]) {
      expect(RECIPE, phrase).toContain(phrase);
    }
  });
  // Red if the recipe stops saying when to create an account and when not.
  it("creates accounts only against a local development database, else asks", () => {
    expect(flat).toMatch(/local development database/i);
    expect(flat).toMatch(/not clearly local[^.]*\./i);
    const notLocal = flat.slice(flat.search(/not clearly local/i));
    expect(notLocal).toContain("npx demoman signin");
  });
  it("teaches reuse by about, and the dev-only sign-in route", () => {
    expect(flat).toMatch(/`about`/);
    expect(flat).toMatch(/dev-only/i);
    expect(flat).toMatch(/Phoenix/);
    expect(flat).toMatch(/Rails/);
  });
  // The accounts example is not a script, so it sits in a ```jsonc block
  // the DemoScript checks above do not read; its shape is held here.
  it("shows an accounts file, and a script that names its account at version 5", () => {
    const jsonc = [...RECIPE.matchAll(/```jsonc\n([\s\S]*?)```/g)].map((m) =>
      JSON.parse(m[1] as string),
    );
    const file = jsonc.find((j) => j.accountsVersion === 1);
    expect(file, "an accounts example").toBeDefined();
    const site = Object.values(file.sites)[0] as {
      accounts: Record<
        string,
        {
          about: string;
          checkUrl: string;
          signIn: Array<Record<string, unknown>>;
        }
      >;
    };
    const account = Object.values(site.accounts)[0];
    expect(account?.about).toBeTruthy();
    expect(account?.checkUrl).toBeTruthy();
    expect(account?.signIn[0]?.do).toBe("goto");
    expect(account?.signIn.some((s) => s.do === "type" && "into" in s)).toBe(
      true,
    );
    const scripts = blocksOf(RECIPE)
      .map((b) => JSON.parse(b))
      .filter((j) => "account" in j);
    expect(scripts.length).toBeGreaterThan(0);
    for (const j of scripts) expect(j.scriptVersion).toBe(5);
  });
});

describe("the CLI's recipe", () => {
  // Red when a reason the CLI can answer is missing from its recipe: an
  // agent would meet an identifier nothing told it how to read.
  it("names every reason the CLI can answer", () => {
    const reasons = [...reasonsInCode(CLI_SOURCES), ...CLI_TOOL_REASONS];
    // Premise: tools.ts still spells the ones it gives under the CLI.
    expect(reasonsInCode(["apps/mcp/src/tools.ts"])).toEqual(
      expect.arrayContaining(CLI_TOOL_REASONS),
    );
    // Premise: the scan reaches the CLI's executor, run-core and the door.
    expect(reasons).toEqual(
      expect.arrayContaining([
        "browserMissing",
        "noFrames",
        "deviceFailed",
        "pageDidNotLoad",
        "notAnObject",
        "unfilledHoles",
        "libraryUnwritable",
        "kitsUnreadable",
        "unknownKit",
      ]),
    );
    expect(reasons.filter((r) => !RECIPE.includes(`\`${r}\``))).toEqual([]);
  });

  // Project A's done-means: no extension wording left. Red if a line about
  // the extension's switch, approval, sites or reload comes back.
  it("says nothing of the extension", () => {
    expect(RECIPE).not.toMatch(/extension/i);
    expect(RECIPE).not.toMatch(/chrome:\/\//);
    expect(RECIPE).not.toMatch(/Let an agent run scripts|Allow an agent/);
    expect(RECIPE).not.toMatch(/`queued`/);
  });

  // Red while the CLI's export loop could stop on a call still in progress.
  it("polls an export until it is none of exporting, stillRunning", () => {
    expect(RECIPE).toMatch(/none of\s+`exporting`,\s+`stillRunning`/);
  });

  it("no longer tells an agent that the CLI cannot export", () => {
    expect(RECIPE).not.toContain("exportNotBuilt");
    expect(INSTRUCTIONS_CLI).not.toContain("exportNotBuilt");
    expect(INSTRUCTIONS_CLI).toContain("file.path");
  });

  // Red if the preface says only a snapshot or a run opens the CLI's window:
  // an export renders in that browser and opens it too.
  it("tells the agent an export opens the CLI's window too", () => {
    expect(INSTRUCTIONS_CLI).toContain("first snapshot, run or export");
  });

  // Red if the CLI's preface still describes the CLI as opt-in, which it
  // stopped being when it became the default.
  it("does not tell the agent the CLI was asked for with a flag", () => {
    expect(INSTRUCTIONS_CLI).not.toContain("--browser cli");
    expect(RECIPE).not.toContain("--browser");
  });

  it("keeps the CLI recipe within Codex's 10,000-token cut", () => {
    expect(Buffer.byteLength(RECIPE, "utf8")).toBeLessThanOrEqual(40_000);
  });

  // Red if the hand-back loses the links line, or grows back the list of
  // findings the user cannot act on (author, 2026-10-20).
  it("ends on the summary and the links, and passes on no framing calls", () => {
    expect(RECIPE).toMatch(
      /Hand back, on `saved`, two lines and nothing else: the `summary` as it is,\s+then the `links`/,
    );
    expect(RECIPE).toContain(
      "`[Open in studio](links.studio) · [Reveal in Finder](links.reveal) · [Copy video](links.copy)`",
    );
    expect(RECIPE).not.toMatch(/every film finding left standing/);
    expect(RECIPE).toMatch(/not the user's to act on: do not pass them on/);
  });

  // Red if `No demo:` reaches past Attach again: Ask is the default since
  // d9949b38, so it would land in every PR of everyone who never chose it
  // (author, 2026-10-22).
  it("writes No demo: only under attach, and nothing in the PR under ask", () => {
    expect(RECIPE).toMatch(/`ask`: offer once;[^`]*the PR says nothing of it/);
    expect(RECIPE).toMatch(
      /`attach`: with no video, the PR description gets\s+one line, `No demo: <why>`/,
    );
    expect(RECIPE.match(/No demo:/g)).toHaveLength(1);
  });
});

// 2026-10-11: a run with no `viewport` films the size the user chose for
// agent videos (their screen's, by default). An agent copies the format's
// example, so an example carrying a viewport would pin every run to it and
// the user's choice would never apply. Red if a json example names one, or
// if the recipe stops saying what an absent one means and what `size` says.
describe("the recipe on a run's size", () => {
  const recipe = RECIPE;
  it("names no viewport in any example", () => {
    for (const block of blocksOf(recipe)) {
      expect(JSON.parse(block)).not.toHaveProperty("viewport");
    }
  });

  it("says an absent viewport is the user's choice, and to leave it out", () => {
    expect(recipe).toMatch(/`viewport` absent means the size the user chose/);
    expect(recipe).toMatch(/Leave `viewport`\s+out unless the user\s+asked/);
  });

  it("teaches size, and puts its error in the hand-back", () => {
    expect(recipe).toMatch(/`size` is `\{ width, height, from, error \}`/);
    // The hand-back names it on its one extra line.
    expect(recipe).toMatch(/Hand back[\s\S]*`size\.error`/);
  });
});
