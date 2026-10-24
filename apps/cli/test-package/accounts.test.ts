// Launch C2 through the packed install, unattended: the account is provisioned
// by files in the project plus one environment secret, `demoman signin
// --account` signs in with no window to type into, and the MCP started in that
// project films behind the login. The password reaches nothing on disk.
import { execFileSync, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { serveLoginApp } from "../../runner/test/login-app.js";
import { connect, installPacked, text } from "../test/packed-install.js";

const PASSWORD = "correct-horse-battery";
const EMAIL = "seller@demo.test";
let packed: Awaited<ReturnType<typeof installPacked>>;
let app: Awaited<ReturnType<typeof serveLoginApp>>;
let home: string;
let repo: string;
beforeAll(async () => {
  packed = await installPacked();
  app = await serveLoginApp({ accounts: { [EMAIL]: PASSWORD } });
  home = await mkdtemp(join(tmpdir(), "demoman-package-acct-home-"));
  repo = await mkdtemp(join(tmpdir(), "demoman-package-acct-repo-"));
});
afterAll(async () => {
  await app?.close();
  await packed?.cleanup();
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

/** Every file's text under `dir`. A file that cannot be read is named and
 *  fails the sweep: an unread file is not a clean file. */
const everythingUnder = async (dir: string): Promise<string> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const texts: string[] = [];
  const unreadable: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) continue;
    const path = join(e.parentPath, e.name);
    try {
      texts.push(await readFile(path, "utf8"));
    } catch (error) {
      unreadable.push(`${path} (${String(error)})`);
    }
  }
  if (unreadable.length > 0) {
    throw new Error(`the sweep could not read: ${unreadable.join("; ")}`);
  }
  return texts.join("\n");
};

it("signs in as an account with no window, then films behind it, leaving no password on disk", async () => {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await mkdir(join(repo, ".demoman"));
  await writeFile(join(repo, ".gitignore"), ".demoman/secrets.env\n");
  const accountsFile = join(repo, ".demoman", "accounts.json");
  await writeFile(
    accountsFile,
    JSON.stringify({
      accountsVersion: 1,
      sites: {
        [app.url]: {
          default: "seller",
          accounts: {
            seller: {
              about: "a demo seller",
              checkUrl: "/app",
              signIn: [
                { do: "goto", url: "/login" },
                {
                  do: "type",
                  into: { stableId: "user_email" },
                  text: EMAIL,
                },
                {
                  do: "type",
                  into: { stableId: "user_password" },
                  text: "{secret:KL_SELLER}",
                },
                { do: "click", on: { role: "button", name: "Sign in" } },
              ],
            },
          },
        },
      },
    }),
  );
  // The premise, asserted: the secret arrives by the environment only.
  const dotFiles = await readdir(join(repo, ".demoman"));
  expect(dotFiles, "a secrets file stands in for the environment").toEqual([
    "accounts.json",
  ]);

  const env = {
    ...process.env,
    DEMOMAN_HOME: home,
    DEMOMAN_NO_UPDATE_CHECK: "1",
    DEMOMAN_SECRET_KL_SELLER: PASSWORD,
    DEMOMAN_SECRET_KL_SELLER_ORIGIN: app.url,
  };
  const before = app.signInsAs(EMAIL);
  // Async, never spawnSync: the fixture app lives in this process, and a
  // blocked event loop could not answer the page the bin opens.
  const signin = await new Promise<{ status: number | null; said: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [packed.bin, "signin", "--account", "seller", "--project", repo],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let said = "";
      child.stdout.on("data", (b) => {
        said += String(b);
      });
      child.stderr.on("data", (b) => {
        said += String(b);
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`signin --account did not exit in 90 s: ${said}`));
      }, 90_000);
      child.on("exit", (status) => {
        clearTimeout(timer);
        resolve({ status, said });
      });
    },
  );
  const said = signin.said;
  expect(signin.status, said).toBe(0);
  expect(said).toMatch(/Signed in to .* as seller/);
  expect(app.signInsAs(EMAIL), "the fixture saw no sign-in").toBe(before + 1);

  // Remove the saved session: the MCP must sign in by itself.
  await rm(join(home, "sessions"), { recursive: true, force: true });
  const beforeMcp = app.signInsAs(EMAIL);

  const c = await connect(
    process.execPath,
    [packed.bin, "mcp"],
    {
      DEMOMAN_HOME: home,
      DEMOMAN_NO_UPDATE_CHECK: "1",
      DEMOMAN_SECRET_KL_SELLER: PASSWORD,
      DEMOMAN_SECRET_KL_SELLER_ORIGIN: app.url,
    },
    repo,
  );
  try {
    const script = {
      scriptVersion: 5,
      name: "behind the account login",
      target: `${app.url}/app`,
      account: "seller",
      viewport: { width: 1024, height: 640 },
      steps: [{ do: "waitForLoad" }, { do: "click", on: { text: "Next" } }],
    };
    type Rep = {
      outcome: string;
      id?: string;
      signedIn?: { account: string };
      provenance?: { takeId: string | null };
    };
    let v = JSON.parse(
      text(
        await c.callTool({
          name: "run",
          arguments: {
            script,
            video: { new: "Signed in as a demo account", confirmedNew: true },
          },
        }),
      ),
    ) as Rep;
    const deadline = Date.now() + 120_000;
    while (["running", "stillRunning"].includes(v.outcome)) {
      if (Date.now() > deadline) {
        throw new Error(`still going after 120 s: ${JSON.stringify(v)}`);
      }
      v = JSON.parse(
        text(await c.callTool({ name: "report", arguments: { id: v.id } })),
      ) as Rep;
    }
    expect(v.outcome, JSON.stringify(v)).toBe("complete");
    expect(v.signedIn?.account, JSON.stringify(v)).toBe("seller");
    expect(v.provenance?.takeId, JSON.stringify(v)).toBeTruthy();
    expect(
      app.signInsAs(EMAIL),
      "the MCP run did not sign in by itself after the session was removed",
    ).toBe(beforeMcp + 1);
    const takes = await readdir(join(home, "takes"));
    expect(takes.length, "no take on disk").toBeGreaterThan(0);
  } finally {
    await c.close();
  }

  const files = await readdir(home, { recursive: true });
  expect(
    files.length,
    "DEMOMAN_HOME is empty; the sweep proves nothing",
  ).toBeGreaterThan(2);
  // Positive control: the sweep finds a password planted under the home.
  const planted = join(home, "planted-control.txt");
  await writeFile(planted, `x ${PASSWORD} y`);
  expect(
    (await everythingUnder(home)).includes(PASSWORD),
    "the sweep cannot see a planted password",
  ).toBe(true);
  await rm(planted);
  const all = await everythingUnder(home);
  expect(
    all.includes(PASSWORD),
    "the password is on disk under DEMOMAN_HOME",
  ).toBe(false);
}, 300_000);
