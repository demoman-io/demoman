import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, serializeApp } from "@demoman/run-core";
import type { Verified } from "@demoman/runner/package";
import { describe, expect, it } from "vitest";
import type { GithubFacts } from "../src/ci-github.js";
import { envFileValues, type NeededSecret } from "../src/ci-secrets.js";
import type { CiDeps } from "../src/ci-setup.js";
import { CI_COMMAND, type CiToolArgs, createCiTool } from "../src/ci-tool.js";
import type { Watched } from "../src/ci-watch.js";

/** Fed through every fake below; no answer or progress line may carry it. */
const SECRET = "sk_live_mcp-door-secret-42";
const APP: AppSpec = {
  appVersion: 1,
  install: ["npm ci"],
  start: "npm start",
  url: "http://127.0.0.1:3999/",
  timeoutSeconds: 60,
  env: {},
  secrets: [],
  services: {},
};
const SELLER: NeededSecret = {
  name: "DEMOMAN_SECRET_SELLER",
  for: "account",
  why: "the seller account signs in with it",
};

/** A repo with one kept flow, and app.json unless `appJson` is false. */
function repoDir(o: { appJson?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "demoman-ci-tool-"));
  mkdirSync(join(root, ".demoman", "flows"), { recursive: true });
  writeFileSync(
    join(root, ".demoman", "flows", "checkout.json"),
    JSON.stringify({
      keptVersion: 2,
      flow: randomUUID(),
      deliver: "files",
      name: "Checkout",
      script: {
        scriptVersion: 1,
        name: "Checkout",
        target: "http://127.0.0.1:3999/",
        viewport: { width: 1280, height: 800 },
        steps: [{ do: "waitForLoad" }],
      },
      scale: 1,
      logo: null,
      wallpaper: null,
      outputs: [
        { path: "o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
      ],
      report: null,
    }),
  );
  if (o.appJson !== false)
    writeFileSync(join(root, ".demoman", "app.json"), serializeApp(APP));
  return root;
}

const passedCheck: Verified = {
  passed: true,
  flow: "Checkout",
  outcome: "unchanged",
  recordSeconds: 8,
  appSeconds: 3,
  lines: [],
};

function tool(
  o: {
    root?: string;
    needed?: NeededSecret[];
    /** What the environment holds: localValues reads it, as the real one. */
    env?: Record<string, string>;
    verify?: CiDeps["verifySetup"];
    watched?: Watched;
    openSetupPr?: CiDeps["openSetupPr"];
    lsRemote?: { code: number; stdout: string; stderr: string };
  } = {},
) {
  const root = o.root ?? repoDir();
  const calls: string[] = [];
  const said: string[] = [];
  const seen: {
    pr?: Parameters<CiDeps["openSetupPr"]>[0];
    watch?: Parameters<CiDeps["watchSetupRun"]>[0];
  } = {};
  const facts: GithubFacts = {
    slug: "o/r",
    defaultBranch: "trunk",
    canPush: true,
    isAdmin: true,
    deployments: [],
    hasReleases: false,
    workflowOnDefault: false,
    setupBranch: null,
  };
  const ci = createCiTool({
    root: async (project) => ({ root: project ?? root }),
    deps: (_root, progress) => ({
      version: "0.9.0",
      env: o.env ?? {},
      git: async (args) =>
        args[0] === "ls-tree"
          ? { code: 0, stdout: "", stderr: "" }
          : args[0] === "ls-remote"
            ? (o.lsRemote ?? {
                code: 0,
                stdout: "abc123\trefs/heads/demoman/setup\n",
                stderr: "",
              })
            : { code: 128, stdout: "", stderr: "fatal: no such path" },
      readGithub: async () => facts,
      detectApp: async () => ({ none: "nothing to propose from" }),
      neededSecrets: async () => ({ needed: o.needed ?? [] }),
      localValues: async (_r, needed, env) => {
        const values = new Map<string, string>();
        for (const n of needed) {
          const v = env[n.name];
          if (v !== undefined) values.set(n.name, v);
        }
        return {
          values,
          missing: needed.filter((n) => !values.has(n.name)).map((n) => n.name),
          tooShort: [],
        };
      },
      envFileValues,
      existingSecrets: async () => [],
      verifySetup: async (...a) => {
        calls.push("verifySetup");
        return o.verify ? o.verify(...a) : passedCheck;
      },
      setSecrets: async (_slug, values) => {
        calls.push("setSecrets");
        return { set: [...values.keys()], kept: [], failed: [] };
      },
      allowActionPullRequests: async () => {
        calls.push("allowActionPullRequests");
        return { kind: "turnedOn" };
      },
      openSetupPr: async (a) => {
        calls.push("openSetupPr");
        seen.pr = a;
        if (o.openSetupPr) return o.openSetupPr(a);
        return {
          opened: {
            number: 7,
            url: "https://github.com/o/r/pull/7",
            branch: "demoman/setup",
            sha: "s1",
          },
        };
      },
      watchSetupRun: async (a) => {
        calls.push("watchSetupRun");
        seen.watch = a;
        progress(`Waiting for the setup run (${SECRET})`);
        return (
          o.watched ?? {
            passed: {
              runUrl: "https://github.com/o/r/actions/runs/9",
              artifactUrl: "https://github.com/o/r/actions/runs/9#artifacts",
              lines: [],
            },
          }
        );
      },
    }),
  });
  const call = (a: CiToolArgs) => ci(a, (l) => void said.push(l));
  return { call, calls, said, seen, root };
}
const outward = [
  "setSecrets",
  "allowActionPullRequests",
  "openSetupPr",
  "watchSetupRun",
];

describe("the ci tool", () => {
  // Decision 4. Red if a call without confirmed applies: the revert proof
  // lets `ci` apply when confirmed is absent.
  it("answers the plan and does nothing outward without confirmed: true", async () => {
    const t = tool();
    const a = await t.call({ trigger: "daily" });
    expect(a).toMatchObject({ outcome: "plan", plan: { trigger: "daily" } });
    expect(a.lines).toEqual(
      expect.arrayContaining([expect.stringMatching(/once a day/)]),
    );
    expect(t.calls).toEqual(["verifySetup"]);
    // The checked bytes never leave the process.
    expect(JSON.stringify(a)).not.toContain("contents");
    const b = await t.call({ trigger: "daily", confirmed: false });
    expect(b.outcome).toBe("plan");
    expect(t.calls.filter((c) => outward.includes(c))).toEqual([]);
  });

  // Red if confirmed plans again (the check runs twice, and the agent could
  // be shown one plan and applied another) or applies without the checked
  // bytes.
  it("applies the very plan it showed, with its checked files, on confirmed: true", async () => {
    const t = tool();
    const shown = await t.call({ trigger: "daily" });
    const done = await t.call({ trigger: "daily", confirmed: true });
    expect(done).toMatchObject({
      outcome: "opened",
      pr: { url: "https://github.com/o/r/pull/7" },
      run: { passed: { runUrl: "https://github.com/o/r/actions/runs/9" } },
    });
    // One check: the plan shown, not a second one.
    expect(t.calls).toEqual(["verifySetup", "setSecrets", ...outward.slice(1)]);
    // The link as progress, before the watch; not repeated in the answer.
    const opened = t.said.indexOf(
      "Opened the setup pull request: https://github.com/o/r/pull/7",
    );
    expect(opened).toBeGreaterThan(-1);
    expect(opened).toBeLessThan(
      t.said.findIndex((l) => l.startsWith("Waiting for the setup run")),
    );
    expect(String(done.lines)).not.toContain("Opened the setup pull request");
    expect(t.seen.pr?.files.map((f) => f.path)).toEqual(
      (shown.plan as { files: string[] }).files,
    );
    // A second confirmed has no plan left to apply: it plans again.
    const again = await t.call({ trigger: "daily", confirmed: true });
    expect(again.outcome).toBe("plan");
    expect(t.calls.filter((c) => c === "openSetupPr")).toHaveLength(1);
  });

  // Red if confirmed applies a plan the agent never saw.
  it("answers a plan, and applies nothing, when confirmed comes with choices it never showed", async () => {
    const t = tool();
    const first = await t.call({ trigger: "daily", confirmed: true });
    expect(first.outcome).toBe("plan");
    expect(String(first.next)).toMatch(/no plan with these choices/i);
    const other = await t.call({ trigger: "push", confirmed: true });
    expect(other.outcome).toBe("plan");
    expect(t.calls.filter((c) => outward.includes(c))).toEqual([]);
  });

  // Review fix 1. Red if a plan that passed stays confirmable after a later
  // plan of the same choices stopped: confirmed would apply the old plan.
  it("forgets a shown plan when a later plan of the same choices stops", async () => {
    let fail = false;
    const t = tool({
      verify: async () =>
        fail
          ? {
              passed: false,
              step: "refresh",
              reason: "refreshFailed",
              detail: "the flow failed",
              tail: "",
            }
          : passedCheck,
    });
    expect((await t.call({ trigger: "daily" })).outcome).toBe("plan");
    fail = true;
    expect((await t.call({ trigger: "daily" })).reason).toBe("refreshFailed");
    fail = false;
    const c = await t.call({ trigger: "daily", confirmed: true });
    expect(c.outcome).toBe("plan");
    expect(t.calls.filter((x) => outward.includes(x))).toEqual([]);
  });

  // Review fix 3. Red if watch drops a choice given with it (an app never
  // written, a confirmed never acted on) without saying so.
  it("refuses watch with any other choice, naming them", async () => {
    const root = repoDir({ appJson: false });
    const t = tool({ root });
    const a = await t.call({ watch: true, app: { ...APP }, confirmed: true });
    expect(a).toMatchObject({ reason: "invalidArgs" });
    expect(String(a.detail)).toContain("app, confirmed");
    expect(existsSync(join(root, ".demoman", "app.json"))).toBe(false);
    expect(t.calls).toEqual([]);
  });

  // Review fix 4. Red if the plan stops saying edits after it are not in
  // the pull request.
  it("says an edit after the plan is not in the pull request", async () => {
    const a = await tool().call({ trigger: "daily" });
    expect(String(a.next)).toMatch(/edit made after this plan is not in it/);
  });

  // R7 (Decision 2). Red if the agent's app is not written, is written
  // when it does not parse, or the answer does not say so.
  it("writes a parsed app to the working tree's .demoman/app.json, uncommitted, and says so", async () => {
    const root = repoDir({ appJson: false });
    const t = tool({ root });
    const a = await t.call({
      trigger: "daily",
      app: { ...APP, start: "pnpm dev" },
    });
    expect(a.outcome).toBe("plan");
    expect(readFileSync(join(root, ".demoman", "app.json"), "utf8")).toBe(
      serializeApp({ ...APP, start: "pnpm dev" }),
    );
    expect(String(a.appFile)).toMatch(/\.demoman\/app\.json.*uncommitted/);
    expect(a.plan).toMatchObject({ app: { source: { kind: "agent" } } });

    const bad = repoDir({ appJson: false });
    const b = await tool({ root: bad }).call({ app: { start: 3 } });
    expect(b.reason).toBe("appInvalid");
    expect(existsSync(join(bad, ".demoman", "app.json"))).toBe(false);
  });

  // Red if a missing value is asked of the agent, or the answer drops the
  // names or the line the person runs.
  it("answers secretMissing with names and the person's command, never a value", async () => {
    const t = tool({ needed: [SELLER] });
    const a = await t.call({ trigger: "daily" });
    expect(a).toMatchObject({
      reason: "secretMissing",
      secrets: [{ name: "DEMOMAN_SECRET_SELLER" }],
      command: CI_COMMAND,
    });
    expect(CI_COMMAND).toBe("npx demoman setup --ci");
    expect(t.calls).toEqual([]);
  });

  // Red if any answer, stop or progress line carries a value: the door's
  // redaction over its values is what keeps each of these clean.
  it("never says a secret value, in a plan, a stop, a run's tail, a fault or a progress line", async () => {
    const env = { DEMOMAN_SECRET_SELLER: SECRET };
    const echoing: CiDeps["verifySetup"] = async (_a, d) => {
      d.log(`starting with ${SECRET}`);
      return passedCheck;
    };
    const answers: unknown[] = [];
    // A plan, then an apply whose run failed with the value in its tail.
    const t = tool({
      needed: [SELLER],
      env,
      verify: echoing,
      watched: {
        failed: {
          runUrl: "https://github.com/o/r/actions/runs/9",
          step: "Refresh",
          tail: `signed in with ${SECRET}`,
          failedRuns: null,
          gaveUp: false,
          note: "the count could not be read",
        },
      },
    });
    answers.push(await t.call({ trigger: "daily" }));
    answers.push(await t.call({ trigger: "daily", confirmed: true }));
    // A failed check whose output echoes the value.
    const f = tool({
      needed: [SELLER],
      env,
      verify: async (_a, d) => {
        d.log(SECRET);
        return {
          passed: false,
          step: "refresh",
          reason: "refreshFailed",
          detail: `bad ${SECRET}`,
          tail: SECRET,
        };
      },
    });
    answers.push(await f.call({ trigger: "daily" }));
    // A fault that names the value.
    const g = tool({
      needed: [SELLER],
      env,
      openSetupPr: async () => {
        throw new Error(`push failed for ${SECRET}`);
      },
    });
    await g.call({ trigger: "daily" });
    answers.push(await g.call({ trigger: "daily", confirmed: true }));

    // Premise: the value went through each path to be hidden.
    expect(
      answers.map(
        (a) =>
          (a as { outcome?: string }).outcome ??
          (a as { reason: string }).reason,
      ),
    ).toEqual(["plan", "opened", "refreshFailed", "threw"]);
    expect(t.said.length + f.said.length).toBeGreaterThan(0);
    for (const m of [...answers, ...t.said, ...f.said, ...g.said]) {
      expect(JSON.stringify(m)).not.toContain(SECRET);
    }
    expect(JSON.stringify(answers[1])).toContain("<redacted>");
    // A null count is said as unknown, and the note with it.
    expect((answers[1] as { lines: string[] }).lines).toEqual(
      expect.arrayContaining(["the count could not be read"]),
    );
  });

  // Red if watch reads another commit than the branch's head, or a third
  // failure is not said as gaveUp.
  it("watches the newest run on demoman/setup, and answers gaveUp at three failures", async () => {
    const t = tool({
      watched: {
        failed: {
          runUrl: "https://github.com/o/r/actions/runs/11",
          step: "Refresh",
          tail: "boom",
          failedRuns: 3,
          gaveUp: true,
        },
      },
    });
    const a = await t.call({ watch: true });
    expect(t.seen.watch).toEqual({
      slug: "o/r",
      branch: "demoman/setup",
      sha: "abc123",
    });
    expect(a).toMatchObject({ outcome: "gaveUp" });
    expect(t.calls).toEqual(["watchSetupRun"]);

    const none = tool({ lsRemote: { code: 0, stdout: "", stderr: "" } });
    expect(await none.call({ watch: true })).toMatchObject({
      reason: "noSetupBranch",
    });
    const unread = tool({
      lsRemote: { code: 128, stdout: "", stderr: "fatal: no origin" },
    });
    expect(await unread.call({ watch: true })).toMatchObject({
      reason: "githubUnreadable",
    });
    expect([...none.calls, ...unread.calls]).toEqual([]);
  });

  // Red if a replaceSecrets name the setup does not use is dropped silently.
  it("refuses a replaceSecrets name the setup does not use", async () => {
    const t = tool();
    const a = await t.call({ trigger: "daily", replaceSecrets: ["NOPE"] });
    expect(a).toMatchObject({ reason: "invalidArgs" });
    expect(String(a.detail)).toContain("NOPE");
  });
});
