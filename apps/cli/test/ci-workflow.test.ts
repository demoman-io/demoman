import { describe, expect, it } from "vitest";
import { ciSetup, ciWorkflow, expr } from "../src/ci-workflow.js";

// No YAML parser is in the repo's dependencies, so the structure is asserted
// by the lines that carry it; every key sits at a fixed indent.
const push = ciWorkflow({ version: "0.2.0", trigger: "push", route: "pr" });
const deploy = ciWorkflow({
  version: "0.2.0",
  trigger: { deployment: "Production" },
  route: "main",
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
    expect(deploy).toContain(
      `--base-url ${expr("github.event.deployment_status.environment_url")}`,
    );
    expect(deploy).toContain(`ref: ${expr("github.event.deployment.sha")}`);
    expect(push).not.toContain("--base-url");
  });

  it("passes the route to --deliver", () => {
    expect(push).toContain("refresh --deliver pr");
    expect(deploy).toContain("refresh --deliver main");
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

describe("ciSetup", () => {
  const io = (exists = false) => {
    const said: string[] = [];
    const wrote: Array<[string, string]> = [];
    return {
      said,
      wrote,
      io: {
        version: "0.2.0",
        ask: null,
        exists: () => exists,
        write: (p: string, t: string) => void wrote.push([p, t]),
        say: (l: string) => void said.push(l),
      },
    };
  };

  it("writes the file and says the two settings that make it work", async () => {
    const m = io();
    expect(
      await ciSetup(["--ci", "--trigger", "push", "--route", "pr"], m.io),
    ).toBe(0);
    expect(m.wrote[0]?.[0]).toBe(".github/workflows/demoman.yml");
    expect(m.wrote[0]?.[1]).toBe(push);
    const said = m.said.join("\n");
    expect(said).toContain(
      "Allow GitHub Actions to create and approve pull requests",
    );
    expect(said).toContain("Start your app");
  });

  it("stops, writing nothing, without a terminal or with a file already there", async () => {
    const a = io();
    expect(await ciSetup(["--ci"], a.io)).toBe(1);
    expect(a.said.join("")).toContain("--trigger");
    const b = io(true);
    expect(
      await ciSetup(["--ci", "--trigger", "push", "--route", "main"], b.io),
    ).toBe(1);
    expect(a.wrote.length + b.wrote.length).toBe(0);
  });
});
