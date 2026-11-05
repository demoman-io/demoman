import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, FLOWS_DIR } from "@demoman/run-core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every path the module opens, so "nothing reads .env" is checked, not assumed.
const opened: string[] = [];
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: ((p: unknown, ...a: unknown[]) => {
      opened.push(String(p));
      return (real.readFile as (...x: unknown[]) => unknown)(p, ...a);
    }) as typeof real.readFile,
  };
});

import {
  envFileNames,
  envFileValues,
  localValues,
  neededSecrets,
  setSecrets,
} from "../src/ci-secrets.js";
import type { Gh } from "../src/gh-run.js";

const ORIGIN = "http://127.0.0.1:3999";
const dirs: string[] = [];
afterEach(async () => {
  opened.length = 0;
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function repo(opts: { target?: string; accounts?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "demoman-ci-secrets-"));
  dirs.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await mkdir(join(root, FLOWS_DIR), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".demoman/secrets.env\n");
  if (opts.accounts !== false) {
    await writeFile(
      join(root, ".demoman", "accounts.json"),
      JSON.stringify({
        accountsVersion: 1,
        sites: {
          [ORIGIN]: {
            default: "seller",
            accounts: {
              seller: {
                about: "a seller",
                checkUrl: "/app",
                signIn: [
                  { do: "goto", url: "/login" },
                  {
                    do: "type",
                    into: { stableId: "pw" },
                    text: "{secret:SELLER}",
                  },
                ],
              },
            },
          },
        },
      }),
    );
  }
  await writeFile(
    join(root, FLOWS_DIR, "checkout.json"),
    JSON.stringify({
      keptVersion: 2,
      flow: randomUUID(),
      deliver: "commit",
      name: "Checkout",
      script: {
        scriptVersion: 1,
        name: "Checkout",
        target: opts.target ?? `${ORIGIN}/`,
        viewport: { width: 1280, height: 800 },
        steps: [{ do: "waitForLoad" }],
      },
      scale: 1,
      logo: null,
      wallpaper: null,
      outputs: [
        {
          path: "docs/o.mp4",
          fileType: "mp4",
          aspect: "16:9",
          quality: "share",
        },
      ],
      report: null,
    }),
  );
  return root;
}
const app = (secrets: string[]): AppSpec => ({
  appVersion: 1,
  install: [],
  start: "node s.mjs",
  url: `${ORIGIN}/`,
  timeoutSeconds: 10,
  env: {},
  secrets,
  services: {},
});

describe("neededSecrets", () => {
  it("names each account secret and its origin binding, then the app's", async () => {
    const root = await repo({});
    const r = await neededSecrets(root, app(["STRIPE_KEY"]));
    expect(r).toEqual({
      needed: [
        {
          name: "DEMOMAN_SECRET_SELLER",
          for: "account",
          why: `account seller on ${ORIGIN}`,
        },
        {
          name: "DEMOMAN_SECRET_SELLER_ORIGIN",
          for: "account",
          why: `account seller on ${ORIGIN}`,
        },
        { name: "STRIPE_KEY", for: "app", why: "app.json" },
      ],
    });
  });

  it("adds nothing for a flow on a site with no accounts", async () => {
    const root = await repo({ target: "https://other.example.com/" });
    expect(await neededSecrets(root, null)).toEqual({ needed: [] });
  });

  it("refuses with the choice's detail when the account is unknown", async () => {
    const root = await repo({ accounts: false });
    // a flow naming an account while no accounts.json exists
    const f = join(root, FLOWS_DIR, "checkout.json");
    const k = JSON.parse(
      await (await import("node:fs/promises")).readFile(f, "utf8"),
    );
    k.script.scriptVersion = 5;
    k.script.account = "ghost";
    await writeFile(f, JSON.stringify(k));
    const r = await neededSecrets(root, null);
    expect(r).toMatchObject({
      refused: expect.stringContaining('names account "ghost"'),
    });
  });

  it("reads no .env", async () => {
    const root = await repo({});
    await neededSecrets(root, null);
    await localValues(root, [], {});
    expect(opened.filter((p) => /(^|\/)\.env/.test(p))).toEqual([]);
  });
});

describe("localValues", () => {
  it("takes the environment, else the ignored secrets.env, and names what is missing", async () => {
    const root = await repo({});
    await writeFile(
      join(root, ".demoman", "secrets.env"),
      `DEMOMAN_SECRET_SELLER=file-password\nDEMOMAN_SECRET_SELLER_ORIGIN=${ORIGIN}\n`,
    );
    const needed = [
      { name: "DEMOMAN_SECRET_SELLER", for: "account" as const, why: "x" },
      {
        name: "DEMOMAN_SECRET_SELLER_ORIGIN",
        for: "account" as const,
        why: "x",
      },
      { name: "STRIPE_KEY", for: "app" as const, why: "app.json" },
      { name: "OTHER", for: "app" as const, why: "app.json" },
    ];
    const r = await localValues(root, needed, {
      STRIPE_KEY: "sk-env-long-enough",
      DEMOMAN_SECRET_SELLER: "env-password-1",
    });
    expect([...r.values]).toEqual([
      ["DEMOMAN_SECRET_SELLER", "env-password-1"],
      ["STRIPE_KEY", "sk-env-long-enough"],
      ["DEMOMAN_SECRET_SELLER_ORIGIN", ORIGIN],
    ]);
    expect(r.missing).toEqual(["OTHER"]);
  });

  it("refuses to read a secrets.env git does not ignore", async () => {
    const root = await repo({});
    await writeFile(join(root, ".gitignore"), "");
    await writeFile(
      join(root, ".demoman", "secrets.env"),
      "DEMOMAN_SECRET_A=abcdefgh\n",
    );
    await expect(
      localValues(
        root,
        [{ name: "DEMOMAN_SECRET_A", for: "account", why: "x" }],
        {},
      ),
    ).resolves.toMatchObject({
      unread: expect.stringContaining("does not ignore it"),
      missing: ["DEMOMAN_SECRET_A"],
    });
  });
});

describe("localValues length", () => {
  it("reports an account's value under the minimum by name, not by value", async () => {
    const root = await repo({});
    const r = await localValues(
      root,
      [{ name: "DEMOMAN_SECRET_A", for: "account", why: "x" }],
      { DEMOMAN_SECRET_A: "short" },
    );
    expect(r.tooShort).toEqual(["DEMOMAN_SECRET_A"]);
    expect(r.missing).toEqual([]);
    expect(r.values.size).toBe(0);
  });

  // Finding 8, red: apply the minimum to every secret again.
  it("takes an app secret of any length: the minimum is a run's, for accounts", async () => {
    const root = await repo({});
    const r = await localValues(
      root,
      [{ name: "PORT_KEY", for: "app", why: "app.json" }],
      { PORT_KEY: "abc" },
    );
    expect(r.tooShort).toEqual([]);
    expect(r.values.get("PORT_KEY")).toBe("abc");
  });
});

describe(".env files", () => {
  it("lists only the names asked for, and reads only the chosen values", async () => {
    const root = await repo({});
    const p = join(root, ".env");
    await writeFile(p, "STRIPE_KEY=sk-1\nUNRELATED=nope\n");
    const needed = [
      { name: "STRIPE_KEY", for: "app" as const, why: "app.json" },
    ];
    expect(await envFileNames(p, needed)).toEqual(["STRIPE_KEY"]);
    expect([...(await envFileValues(p, ["STRIPE_KEY"]))]).toEqual([
      ["STRIPE_KEY", "sk-1"],
    ]);
  });
});

type Call = { args: string[]; input?: string };
const fakeGh = (refuse: string[] = []) => {
  const calls: Call[] = [];
  const gh: Gh = async (args, o) => {
    calls.push({ args, input: o?.input });
    const name = args[2] ?? "";
    return refuse.includes(name)
      ? { code: 1, stdout: "", stderr: "HTTP 403: forbidden" }
      : { code: 0, stdout: "", stderr: "" };
  };
  return { gh, calls };
};

describe("setSecrets", () => {
  it("sends each value on stdin exactly, and never in argv", async () => {
    const { gh, calls } = fakeGh();
    const values = new Map([
      ["A", "value-one"],
      ["B", "value two\nwith a newline"],
    ]);
    const r = await setSecrets(gh, "o/r", values, [], []);
    expect(r).toEqual({ set: ["A", "B"], kept: [], failed: [] });
    expect(calls.map((c) => c.input)).toEqual([
      "value-one",
      "value two\nwith a newline",
    ]);
    for (const c of calls)
      for (const v of values.values())
        for (const a of c.args) expect(a).not.toContain(v);
  });

  it("keeps an existing secret unless it is to be replaced", async () => {
    const { gh, calls } = fakeGh();
    const values = new Map([
      ["X", "xxxxxxxx"],
      ["Y", "yyyyyyyy"],
    ]);
    const r = await setSecrets(gh, "o/r", values, ["Y"], ["X", "Y"]);
    expect(r).toEqual({ set: ["Y"], kept: ["X"], failed: [] });
    expect(calls.map((c) => c.args[2])).toEqual(["Y"]);
  });

  it("stops at the first refusal and lists the rest as not attempted", async () => {
    const { gh, calls } = fakeGh(["b"]);
    const values = new Map([
      ["a", "aaaaaaaa"],
      ["b", "bbbbbbbb"],
      ["c", "cccccccc"],
    ]);
    const r = await setSecrets(gh, "o/r", values, [], []);
    expect(r).toEqual({
      set: ["a"],
      kept: [],
      failed: [
        { name: "b", said: "HTTP 403: forbidden" },
        { name: "c", said: "not attempted: setup stopped at b" },
      ],
    });
    expect(calls.map((c) => c.args[2])).toEqual(["a", "b"]);
  });

  it("removes the value itself from what gh said", async () => {
    const gh: Gh = async (_a, o) => ({
      code: 1,
      stdout: "",
      stderr: `rejected ${o?.input}`,
    });
    const r = await setSecrets(
      gh,
      "o/r",
      new Map([["a", "plain-pass-1"]]),
      [],
      [],
    );
    expect(r.failed[0]?.said).toBe("rejected <redacted>");
  });

  it("keeps an existing secret even after setup stopped", async () => {
    const { gh } = fakeGh(["a"]);
    const values = new Map([
      ["a", "aaaaaaaa"],
      ["b", "bbbbbbbb"],
      ["c", "cccccccc"],
    ]);
    const r = await setSecrets(gh, "o/r", values, [], ["b"]);
    expect(r.kept).toEqual(["b"]);
    expect(r.failed.map((f) => f.name)).toEqual(["a", "c"]);
  });

  it("scrubs what gh said", async () => {
    const token = `ghp_${"a".repeat(30)}`;
    const gh: Gh = async () => ({
      code: 1,
      stdout: "",
      stderr: `bad ${token}`,
    });
    const r = await setSecrets(gh, "o/r", new Map([["a", "aaaaaaaa"]]), [], []);
    expect(r.failed[0]?.said).not.toContain(token);
  });
});
