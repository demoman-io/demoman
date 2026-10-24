import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findAccounts } from "../src/executor/accounts.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { signin, signinAccount } from "../src/signin.js";
import { boundTo, type LoginApp, serveLoginApp } from "./login-app.js";

const PASSWORD = "correct-horse-battery";
let app: LoginApp;
let repo: string;
let home: string;
beforeAll(async () => {
  app = await serveLoginApp({ accounts: { "seller@demo.test": PASSWORD } });
}, 30_000);
afterAll(async () => {
  await app.close();
});

const signIn = [
  { do: "goto", url: "/login" },
  { do: "type", into: { stableId: "user_email" }, text: "seller@demo.test" },
  {
    do: "type",
    into: { stableId: "user_password" },
    text: "{secret:KL_SELLER}",
  },
  { do: "click", on: { role: "button", name: "Sign in" } },
];
const accountsJson = (origins: string[]) =>
  JSON.stringify({
    accountsVersion: 1,
    sites: Object.fromEntries(
      origins.map((o) => [
        o,
        {
          default: "seller",
          accounts: {
            seller: { about: "a demo seller", checkUrl: "/app", signIn },
          },
        },
      ]),
    ),
  });
const makeRepo = async (origins: string[]): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "demoman-acct-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await mkdir(join(dir, ".demoman"));
  await writeFile(join(dir, ".gitignore"), ".demoman/secrets.env\n");
  await writeFile(
    join(dir, ".demoman", "accounts.json"),
    accountsJson(origins),
  );
  return dir;
};
beforeEach(async () => {
  repo = await makeRepo([app.url]);
  home = await mkdtemp(join(tmpdir(), "demoman-acct-home-"));
});

describe("signinAccount", () => {
  it("signs in from the repo's steps and says where it saved", async () => {
    const lines: string[] = [];
    const code = await signinAccount("seller", {
      home,
      projectDir: repo,
      env: boundTo({ DEMOMAN_SECRET_KL_SELLER: PASSWORD }, app.url),
      out: (l) => lines.push(l),
    });
    expect(code, lines.join("\n")).toBe(0);
    expect(lines.at(-1)).toBe(
      `Signed in to ${app.url} as seller; saved ${createSessionStore(home).pathOfAccount(app.url, "seller")}`,
    );
    expect(lines.join("\n")).not.toContain(PASSWORD);
  }, 60_000);

  it("signs in fresh even with a saved session (it is a check)", async () => {
    const env = boundTo({ DEMOMAN_SECRET_KL_SELLER: PASSWORD }, app.url);
    const first = await signinAccount("seller", {
      home,
      projectDir: repo,
      env,
      out: () => undefined,
    });
    expect(first).toBe(0);
    const before = app.signInsAs("seller@demo.test");
    const second = await signinAccount("seller", {
      home,
      projectDir: repo,
      env,
      out: () => undefined,
    });
    expect(second).toBe(0);
    expect(app.signInsAs("seller@demo.test")).toBe(before + 1);
  }, 90_000);

  it("exits 1 naming a missing secret", async () => {
    const lines: string[] = [];
    expect(
      await signinAccount("seller", {
        home,
        projectDir: repo,
        env: {},
        out: (l) => lines.push(l),
      }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("DEMOMAN_SECRET_KL_SELLER");
  }, 60_000);

  it("exits 2 for an account no site has, listing the ones there are", async () => {
    const lines: string[] = [];
    expect(
      await signinAccount("admin", {
        home,
        projectDir: repo,
        env: {},
        out: (l) => lines.push(l),
      }),
    ).toBe(2);
    expect(lines.join("\n")).toContain("seller");
  });

  it("exits 2 saying so when there is no accounts file", async () => {
    const empty = await mkdtemp(join(tmpdir(), "demoman-acct-none-"));
    const lines: string[] = [];
    expect(
      await signinAccount("seller", {
        home,
        projectDir: empty,
        env: {},
        out: (l) => lines.push(l),
      }),
    ).toBe(2);
    expect(lines.join("\n")).toContain("no .demoman/accounts.json found");
  });

  it("asks for --site when two sites have the account, and --site picks one", async () => {
    const two = await makeRepo([app.url, "http://localhost:1"]);
    // Premise: the file really holds the account under two origins.
    const lines: string[] = [];
    expect(
      await signinAccount("seller", {
        home,
        projectDir: two,
        env: {},
        out: (l) => lines.push(l),
      }),
    ).toBe(2);
    expect(lines.join("\n")).toContain("--site");
    expect(lines.join("\n")).toContain("http://localhost:1");
    expect(lines.join("\n")).toContain(app.url);

    const picked: string[] = [];
    const code = await signinAccount("seller", {
      home,
      projectDir: two,
      site: app.url,
      env: boundTo({ DEMOMAN_SECRET_KL_SELLER: PASSWORD }, app.url),
      out: (l) => picked.push(l),
    });
    expect(code, picked.join("\n")).toBe(0);
  }, 60_000);

  it("exits 2 for a --project that is not a folder, naming --project (final review M7)", async () => {
    const inside = await makeRepo([app.url]);
    // Premise: walking up from the missing folder would find the file.
    const missing = join(inside, "no-such-folder");
    expect((await findAccounts(missing)).kind).toBe("found");
    const lines: string[] = [];
    const code = await signinAccount("seller", {
      home,
      projectDir: missing,
      env: boundTo({ DEMOMAN_SECRET_KL_SELLER: PASSWORD }, app.url),
      out: (l) => lines.push(l),
    });
    expect(code, lines.join("\n")).toBe(2);
    expect(lines.join("\n")).toContain("--project");
    expect(lines.join("\n")).toContain(missing);
    expect(await readdir(home)).toEqual([]);
  });

  it("exits 2 for a --site the file does not hold", async () => {
    const lines: string[] = [];
    expect(
      await signinAccount("seller", {
        home,
        projectDir: repo,
        site: "http://localhost:2",
        env: {},
        out: (l) => lines.push(l),
      }),
    ).toBe(2);
    expect(lines.join("\n")).toContain("seller");
    expect(lines.join("\n")).toContain("http://localhost:2");
  });
});

// Audit run 1: a repo file or a page could write escape sequences to the
// user's terminal through signin's lines — erase a line, forge a success,
// plant a link. Red if `printable` is dropped from either sink.
describe("signin's lines carry no control characters", () => {
  const ESC = "\u001b[1A\u001b[2K\u001b]8;;https://x.test\u0007";
  const control = /[\p{Cc}\p{Cf}]/u;

  it("from an accounts.json key", async () => {
    const file = JSON.parse(accountsJson([app.url]));
    file.sites[app.url].accounts.seller[`k${ESC}`] = 1;
    await writeFile(
      join(repo, ".demoman", "accounts.json"),
      JSON.stringify(file),
    );
    const lines: string[] = [];
    const code = await signinAccount("seller", {
      home,
      projectDir: repo,
      env: {},
      out: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    // Premise: the line quotes the key it refused.
    expect(lines.join("\n")).toContain("unknown key");
    expect(lines.join("\n")).not.toMatch(control);
  });

  it("from the URL it was given", async () => {
    const lines: string[] = [];
    const code = await signin(`javascript:${ESC}`, {
      home,
      out: (l) => lines.push(l),
      enter: () => ({ done: new Promise(() => undefined), cancel: () => {} }),
    });
    expect(code).not.toBe(0);
    // Premise: the line quotes the URL it refused.
    expect(lines.join("\n")).toContain("not an http(s) URL");
    expect(lines.join("\n")).not.toMatch(control);
  });
});
