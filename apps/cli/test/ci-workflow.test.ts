import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciSetup, ciWorkflow, expr } from "../src/ci-workflow.js";

// No YAML parser is in the repo's dependencies, so the structure is asserted
// by the lines that carry it; every key sits at a fixed indent.
const push = ciWorkflow({ version: "0.2.0", trigger: "push", route: "pr" });
const deploy = ciWorkflow({
  version: "0.2.0",
  trigger: { deployment: "Production" },
  route: "pr",
});
const lines = (y: string) => y.split("\n");
const npx = (y: string) => lines(y).filter((l) => l.includes("npx --prefix"));

describe("ciWorkflow", () => {
  it("pins the version in both npx lines", () => {
    expect(npx(push)).toHaveLength(2);
    for (const l of npx(push)) expect(l).toContain("demoman@0.2.0");
    expect(push).toContain("setup --browser-only");
    expect(push).not.toContain("setup --yes");
  });

  it("indents with spaces only and has the three top-level keys", () => {
    expect(push).not.toContain("\t");
    for (const key of ["name:", "on:", "permissions:", "jobs:"]) {
      expect(lines(push)).toContain(key === "name:" ? "name: Demoman" : key);
    }
    expect(push).toContain("  contents: write");
    expect(push).toContain("  pull-requests: write");
  });

  it("checks out the full history, for deliver's commit check", () => {
    expect(push).toContain("uses: actions/checkout@v4");
    expect(push).toContain("fetch-depth: 0");
  });

  it("checks out LFS files, so refresh compares videos and not pointers", () => {
    for (const y of [push, deploy]) {
      const checkout = y
        .split("uses: actions/checkout@v4\n")[1]
        ?.split("\n      - ")[0];
      expect(checkout).toContain("          lfs: true");
    }
  });

  it("guards the push job against its own commits", () => {
    expect(push).toContain("[skip demoman]");
    expect(push).toContain("github.actor != 'github-actions[bot]'");
    expect(lines(push).filter((l) => l.startsWith("    if:"))).toHaveLength(1);
  });

  it("starts the app for push, and not for a deployment", () => {
    expect(push).toContain("Start your app");
    expect(deploy).not.toContain("Start your app");
  });

  it("triggers on deployment_status and refreshes the deployed URL", () => {
    expect(lines(deploy)).toContain("  deployment_status:");
    expect(deploy).toContain(
      "github.event.deployment_status.state == 'success'",
    );
    expect(deploy).toContain(
      "github.event.deployment.environment == 'Production'",
    );
    // The URL reaches the shell through env, never interpolated into it.
    expect(deploy).toContain('--base-url "$DEMOMAN_BASE_URL"');
    expect(deploy).toContain(
      `DEMOMAN_BASE_URL: ${expr("github.event.deployment_status.environment_url")}`,
    );
    expect(deploy).toContain(`ref: ${expr("github.event.deployment.sha")}`);
    expect(push).not.toContain("--base-url");
  });

  it("interpolates no expression into any run line, in either shape", () => {
    for (const y of [push, deploy]) {
      const runs = lines(y).filter((l) => l.trim().startsWith("run:"));
      expect(
        runs.length,
        "premise: the workflow has run lines",
      ).toBeGreaterThan(3);
      for (const l of runs) expect(l, l).not.toContain("${{");
    }
  });

  it("passes the route to --deliver", () => {
    expect(push).toContain("refresh --deliver pr");
    expect(deploy).toContain("refresh --deliver pr");
    expect(
      ciWorkflow({ version: "0.2.0", trigger: "push", route: "main" }),
    ).toContain("refresh --deliver main");
    expect(push).toContain(`GH_TOKEN: ${expr("github.token")}`);
  });

  it("installs exactly the named fonts", () => {
    const apt = lines(push).find((l) => l.includes("apt-get install"));
    expect(apt).toContain("fonts-noto-core fonts-noto-color-emoji");
    expect(apt?.trim().endsWith("fonts-noto-color-emoji")).toBe(true);
  });

  it("caches Playwright's browsers keyed on the version", () => {
    expect(push).toContain("path: ~/.cache/ms-playwright");
    expect(push).toContain("key: playwright-0.2.0");
  });

  it("refuses an environment name that would break the quoting", () => {
    expect(() =>
      ciWorkflow({
        version: "0.2.0",
        trigger: { deployment: "a'b" },
        route: "pr",
      }),
    ).toThrow(/environment/);
  });
});

describe("the loop guard", () => {
  const skipIf = expr("steps.guard.outputs.skip != 'true'");
  /** The steps of the job, each as its own block of lines. */
  const steps = (y: string) =>
    y
      .slice(y.indexOf("    steps:\n") + 11)
      .split(/\n(?= {6}- )/)
      .filter((b) => b.startsWith("      - "));

  for (const [name, y, sha] of [
    ["push", push, "github.sha"],
    ["deployment", deploy, "github.event.deployment.sha"],
  ] as const) {
    it(`${name}: a guard step follows the checkout and every later step is conditioned on it`, () => {
      const all = steps(y);
      expect(all.length).toBeGreaterThan(4);
      expect(all[0]).toContain("actions/checkout@v4");
      expect(all[1]).toContain("id: guard");
      expect(all[1]).toContain(`SHA: ${expr(sha)}`);
      for (const later of all.slice(2)) {
        expect(later, later).toContain(`if: ${skipIf}`);
      }
      // The sha reaches the script through env, never interpolated into it.
      expect(all[1]?.split("run: |")[1]).not.toContain("${{");
    });
  }

  it("outputs skip for the refresh PR's merge commit and a marked commit, not an ordinary one", () => {
    const script = (push.split("run: |\n")[1] ?? "")
      .split("\n      - ")[0]
      ?.split("\n")
      .map((l) => l.slice(10))
      .join("\n");
    expect(script).toContain("GITHUB_OUTPUT");
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    git("init", "-q");
    const answer = (message: string): string => {
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        message,
      );
      const out = join(dir, "out.txt");
      writeFileSync(out, "");
      execFileSync("bash", ["-c", script ?? ""], {
        cwd: dir,
        env: { ...process.env, SHA: "HEAD", GITHUB_OUTPUT: out },
      });
      return readFileSync(out, "utf8");
    };
    expect(answer("Merge pull request #7 from acme/demoman/refresh")).toBe(
      "skip=true\n",
    );
    expect(answer("Refresh the demo\n\n[skip demoman]")).toBe("skip=true\n");
    expect(answer("Fix the invoice filter")).toBe("");
  });

  it("keeps the push job's own guard", () => {
    expect(push).toContain("github.actor != 'github-actions[bot]'");
  });
});

describe("the workflow's shape", () => {
  it("serialises runs", () => {
    expect(push).toContain(
      "concurrency:\n  group: demoman-refresh\n  cancel-in-progress: false",
    );
  });
  it("watches the branch it is given, main by default", () => {
    expect(push).toContain("branches: [main]");
    const m = ciWorkflow({
      version: "0.2.0",
      trigger: "push",
      route: "pr",
      branch: "master",
    });
    expect(m).toContain("branches: [master]");
  });
  it("names _ORIGIN beside each secret", () => {
    expect(push).toContain("# DEMOMAN_SECRET_SELLER: ");
    expect(push).toContain("# DEMOMAN_SECRET_SELLER_ORIGIN: ");
    expect(push).toContain("{ secret: NAME }");
  });
  it("refuses the main route on a deployment", () => {
    expect(() =>
      ciWorkflow({
        version: "0.2.0",
        trigger: { deployment: "P" },
        route: "main",
      }),
    ).toThrow(/not a branch/);
  });
});

describe("ciSetup", () => {
  const io = (
    over: {
      exists?: boolean;
      root?: { root: string } | { none: string };
      branch?: string | null;
      ask?: unknown;
    } = {},
  ) => {
    const said: string[] = [];
    const wrote: Array<[string, string]> = [];
    const asked = { n: 0 };
    return {
      said,
      wrote,
      asked,
      io: {
        version: "0.2.0",
        ask: (over.ask ?? null) as never,
        root: async () => over.root ?? { root: "/repo" },
        defaultBranch: async () =>
          over.branch === undefined ? "main" : over.branch,
        exists: () => over.exists ?? false,
        write: (p: string, t: string) => void wrote.push([p, t]),
        say: (l: string) => void said.push(l),
      },
    };
  };
  const flags = ["--ci", "--trigger", "push", "--route", "pr"];

  it("writes the file and says the settings that make it work", async () => {
    const m = io();
    expect(await ciSetup(flags, m.io)).toBe(0);
    expect(m.wrote[0]?.[0]).toBe(".github/workflows/demoman.yml");
    expect(m.wrote[0]?.[1]).toBe(push);
    const said = m.said.join("\n");
    expect(said).toContain(
      "Allow GitHub Actions to create and approve pull requests",
    );
    expect(said).toContain("Start your app");
    expect(said).toContain("_ORIGIN");
  });

  it("stops, writing nothing, without a terminal or with a file already there", async () => {
    const a = io();
    expect(await ciSetup(["--ci"], a.io)).toBe(1);
    expect(a.said.join("")).toContain("--trigger");
    const b = io({ exists: true });
    expect(await ciSetup(flags, b.io)).toBe(1);
    expect(a.wrote.length + b.wrote.length).toBe(0);
  });

  it("stops outside a git repo", async () => {
    const m = io({ root: { none: "not a git repository" } });
    expect(await ciSetup(flags, m.io)).toBe(1);
    expect(m.said.join("")).toContain("not a git repository");
    expect(m.wrote).toEqual([]);
  });

  it("looks for an existing file before asking anything", async () => {
    const m = io({
      exists: true,
      ask: {
        trigger: async () => {
          throw new Error("asked");
        },
        route: async () => "pr",
      },
    });
    expect(await ciSetup(["--ci"], m.io)).toBe(1);
    expect(m.said.join("")).toContain("already exists");
  });

  it("refuses --route main with a deployment trigger, by flags and by prompt", async () => {
    const a = io();
    expect(
      await ciSetup(
        ["--ci", "--trigger", "Production", "--route", "main"],
        a.io,
      ),
    ).toBe(1);
    const b = io({
      ask: { trigger: async () => "Production", route: async () => "main" },
    });
    expect(await ciSetup(["--ci"], b.io)).toBe(1);
    for (const m of [a, b]) {
      expect(m.said.join("")).toContain("not a branch");
      expect(m.said.join("")).toContain("--route pr");
      expect(m.wrote).toEqual([]);
    }
  });

  it("writes the default branch it read, and says it assumed main when it cannot read one", async () => {
    const a = io({ branch: "master" });
    expect(await ciSetup(flags, a.io)).toBe(0);
    expect(a.wrote[0]?.[1]).toContain("branches: [master]");
    expect(a.said.join("")).not.toContain("assum");
    const b = io({ branch: null });
    expect(await ciSetup(flags, b.io)).toBe(0);
    expect(b.wrote[0]?.[1]).toContain("branches: [main]");
    expect(b.said.join("\n")).toContain(
      "Could not read origin's default branch",
    );
  });
});
