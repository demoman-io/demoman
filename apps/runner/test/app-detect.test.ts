import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectApp } from "../src/executor/app-detect.js";

const FIX = fileURLToPath(new URL("./fixtures/app-detect/", import.meta.url));
const fix = (name: string) => join(FIX, name);
const text = (name: string, file: string) =>
  readFile(join(fix(name), file), "utf8");
const ORIGIN = "http://localhost:3000";

const temps: string[] = [];
afterEach(async () => {
  for (const d of temps.splice(0))
    await rm(d, { recursive: true, force: true });
});
/** A scratch copy, so a test can add a file the fixture must not carry. */
async function copyOf(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "app-detect-"));
  temps.push(dir);
  await cp(fix(name), dir, { recursive: true });
  return dir;
}

describe("detectApp", () => {
  it("playwright: takes command, url and timeout from webServer", async () => {
    expect(await text("playwright", "playwright.config.ts")).toContain(
      "webServer",
    );
    const got = await detectApp(fix("playwright"), null);
    expect(got).toEqual({
      source: { kind: "playwright", file: "playwright.config.ts" },
      draft: {
        appVersion: 1,
        install: ["npm ci"],
        start: "npm run dev -- --host",
        url: "http://localhost:5173",
        timeoutSeconds: 90,
        env: {},
        secrets: [],
        services: {},
      },
      holes: [],
    });
  });

  it("playwright: a template or an array is a hole naming the file", async () => {
    expect(await text("playwright-template", "playwright.config.ts")).toContain(
      "`npm run dev",
    );
    const got = await detectApp(fix("playwright-template"), null);
    if ("none" in got) throw new Error(got.none);
    expect(got.source).toEqual({
      kind: "playwright",
      file: "playwright.config.ts",
    });
    expect(got.draft.start).toBeNull();
    expect(got.holes.map((h) => h.field)).toContain("start");
    expect(got.holes.find((h) => h.field === "start")?.why).toBe(
      "`webServer.command` is not a plain string in playwright.config.ts",
    );
  });

  it("workflow: a wait-on job splits install lines from the backgrounded start", async () => {
    expect(await text("wait-on", ".github/workflows/ci.yml")).toContain(
      "wait-on",
    );
    const got = await detectApp(fix("wait-on"), null);
    expect(got).toEqual({
      source: {
        kind: "workflow",
        file: ".github/workflows/ci.yml",
        job: "e2e",
      },
      draft: {
        appVersion: 1,
        install: ["pnpm install --frozen-lockfile", "pnpm run build"],
        start: "pnpm run serve",
        url: "http://localhost:8080",
        timeoutSeconds: 120,
        env: {},
        secrets: [],
        services: {},
      },
      holes: [],
    });
  });

  it("workflow: the Cypress action's build, start and wait-on", async () => {
    expect(await text("cypress-action", ".github/workflows/cy.yml")).toContain(
      "cypress-io/github-action",
    );
    const got = await detectApp(fix("cypress-action"), null);
    expect(got).toMatchObject({
      source: {
        kind: "workflow",
        file: ".github/workflows/cy.yml",
        job: "cypress",
      },
      draft: {
        install: ["npm ci", "npm run build"],
        start: "npm start",
        url: "http://localhost:3000",
      },
      holes: [],
    });
  });

  it("copilot: run steps are install, services are services, start and url are holes", async () => {
    expect(
      await text("copilot", ".github/workflows/copilot-setup-steps.yml"),
    ).toContain("services:");
    const got = await detectApp(fix("copilot"), null);
    expect(got).toEqual({
      source: {
        kind: "copilot",
        file: ".github/workflows/copilot-setup-steps.yml",
      },
      draft: {
        appVersion: 1,
        install: ["npm ci", "npm run build"],
        start: null,
        url: null,
        timeoutSeconds: 120,
        env: {},
        secrets: [],
        services: {
          postgres: {
            image: "postgres:16",
            ports: ["5432:5432"],
            env: { POSTGRES_DB: "app" },
            options: "--health-cmd pg_isready",
          },
        },
      },
      holes: [
        { field: "start", why: expect.any(String) },
        { field: "url", why: expect.any(String) },
      ],
    });
  });

  it("package.json: the lockfile picks the manager; dev script; url is the recorded origin", async () => {
    expect(await text("package-json", "package.json")).toContain('"dev"');
    const got = await detectApp(fix("package-json"), ORIGIN);
    if ("none" in got) throw new Error(got.none);
    expect(got.source).toEqual({ kind: "packageJson", file: "package.json" });
    expect(got.draft).toMatchObject({
      install: ["pnpm install --frozen-lockfile", "pnpm run build"],
      start: "pnpm run dev",
      url: ORIGIN,
    });
  });

  it("package.json: with no recorded origin the url is a hole", async () => {
    const got = await detectApp(fix("package-json"), null);
    if ("none" in got) throw new Error(got.none);
    expect(got.draft.url).toBeNull();
    expect(got.holes.map((h) => h.field)).toContain("url");
  });

  it(".env.example: a name with no value is a hole, never in draft.env", async () => {
    expect(await text("package-json", ".env.example")).toContain("API_KEY=");
    const got = await detectApp(fix("package-json"), ORIGIN);
    if ("none" in got) throw new Error(got.none);
    expect(got.holes.map((h) => h.field)).toContain("env.API_KEY");
    expect(got.holes.map((h) => h.field)).not.toContain("env.PUBLIC_NAME");
    expect(got.draft.env).not.toHaveProperty("API_KEY");
  });

  it(".env is never read", async () => {
    const dir = await copyOf("package-json");
    await writeFile(join(dir, ".env"), "SECRET_TOKEN=\n");
    const got = await detectApp(dir, ORIGIN);
    if ("none" in got) throw new Error(got.none);
    expect(got.holes.map((h) => h.field)).not.toContain("env.SECRET_TOKEN");
  });

  it("monorepo: the one package whose script names the recorded port", async () => {
    const got = await detectApp(fix("monorepo-one"), ORIGIN);
    if ("none" in got) throw new Error(got.none);
    expect(got.source).toEqual({
      kind: "packageJson",
      file: "apps/web/package.json",
    });
    expect(got.draft).toMatchObject({
      install: [
        "pnpm install --frozen-lockfile",
        "pnpm --filter web run build",
      ],
      start: "pnpm --filter web run dev",
      url: ORIGIN,
    });
  });

  it("monorepo: two packages naming the port is none, naming both", async () => {
    const two = await text("monorepo-two", "apps/docs/package.json");
    expect(two).toContain("PORT=3000");
    expect(await text("monorepo-two", "apps/web/package.json")).toContain(
      "--port 3000",
    );
    const got = await detectApp(fix("monorepo-two"), ORIGIN);
    expect(got).toEqual({
      none: `cannot tell which package serves ${ORIGIN}: docs, web`,
    });
  });

  it("nothing: none, naming the four places it looked", async () => {
    const got = await detectApp(fix("nothing"), ORIGIN);
    expect(got).toEqual({
      none: expect.stringContaining("playwright.config"),
    });
    const none = (got as { none: string }).none;
    for (const place of [
      "playwright.config",
      ".github/workflows",
      "copilot-setup-steps.yml",
      "package.json",
    ]) {
      expect(none).toContain(place);
    }
  });

  it("order: a Playwright config wins over package.json", async () => {
    const dir = await copyOf("package-json");
    await writeFile(
      join(dir, "playwright.config.ts"),
      'export default { webServer: { command: "node s.js", url: "http://localhost:9000" } };\n',
    );
    const got = await detectApp(dir, ORIGIN);
    if ("none" in got) throw new Error(got.none);
    expect(got.source.kind).toBe("playwright");
    expect(got.draft.start).toBe("node s.js");
  });

  it("a workflow that does not parse is named in the answer, not skipped", async () => {
    const dir = await copyOf("nothing");
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    await writeFile(
      join(dir, ".github/workflows/bad.yml"),
      "jobs: [unclosed\n",
    );
    const none = await detectApp(dir, ORIGIN);
    expect(none).toEqual({
      none: expect.stringContaining(
        ".github/workflows/bad.yml could not be parsed",
      ),
    });
    // and a later source that answers still carries it as a hole
    await writeFile(
      join(dir, "package.json"),
      '{ "scripts": { "dev": "vite" } }',
    );
    const got = await detectApp(dir, ORIGIN);
    if ("none" in got) throw new Error(got.none);
    expect(got.source.kind).toBe("packageJson");
    expect(got.holes).toContainEqual({
      field: ".github/workflows/bad.yml",
      why: expect.stringContaining("could not be parsed"),
    });
  });

  it("a malformed pnpm-workspace.yaml is none, not a thrown error", async () => {
    const dir = await copyOf("monorepo-one");
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages: [unclosed\n");
    const got = await detectApp(dir, ORIGIN);
    expect(got).toEqual({
      none: expect.stringContaining("pnpm-workspace.yaml could not be parsed"),
    });
  });

  describe("wait-on targets", () => {
    async function urlFor(waitOn: string) {
      const dir = await copyOf("wait-on");
      const file = join(dir, ".github/workflows/ci.yml");
      const yml = (await readFile(file, "utf8")).replace(
        "npx wait-on http://localhost:8080",
        waitOn,
      );
      await writeFile(file, yml);
      const got = await detectApp(dir, null);
      if ("none" in got) throw new Error(got.none);
      expect(got.source.kind).toBe("workflow");
      return got;
    }
    it("skips option flags and their values", async () => {
      const got = await urlFor("npx wait-on -t 60000 http://localhost:3000");
      expect(got.draft.url).toBe("http://localhost:3000");
    });
    it("takes host:port and http-get:// as http", async () => {
      expect((await urlFor("npx wait-on localhost:3000")).draft.url).toBe(
        "http://localhost:3000",
      );
      expect(
        (await urlFor("npx wait-on http-get://localhost:3000/health")).draft
          .url,
      ).toBe("http://localhost:3000/health");
    });
    it("tcp:3000 is not a URL: a hole, never a guess", async () => {
      for (const target of ["tcp:3000", "tcp:localhost:3000"]) {
        const got = await urlFor(`npx wait-on ${target}`);
        expect(got.draft.url).toBeNull();
        expect(got.holes.map((h) => h.field)).toContain("url");
      }
    });
  });
});
