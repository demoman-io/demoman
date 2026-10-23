// apps/runner/test/accounts-harness.ts
//
// What executor-accounts.test.ts and executor-accounts-env.test.ts share:
// one login app per file, a fresh home, repo and executor per case, and the
// script and accounts helpers. Split from one file on 2026-10-17 so the two
// halves run in parallel (together they were 132 s, the fast tier's longest
// runner file). The hooks register on whichever file imports this.
import { execFileSync } from "node:child_process";
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
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { boundTo, type LoginApp, serveLoginApp } from "./login-app.js";

export const PASSWORD = "correct-horse-battery";
export const CUSTOMER_PASSWORD = `${PASSWORD}-c`;
export const SELLER = "seller@demo.test";
export const CUSTOMER = "customer@demo.test";
export const ENV = {
  DEMOMAN_SECRET_KL_SELLER: PASSWORD,
  DEMOMAN_SECRET_KL_CUSTOMER: CUSTOMER_PASSWORD,
};
export let app: LoginApp;
export let repo: string;
export let home: string;
export let executor: LocalExecutor;
export let logs: string[];

beforeAll(async () => {
  app = await serveLoginApp({
    accounts: { [SELLER]: PASSWORD, [CUSTOMER]: CUSTOMER_PASSWORD },
  });
}, 30_000); // starts one local HTTP server: well under 1 s here

export const makeExecutor = (over: { env?: NodeJS.ProcessEnv } = {}) =>
  createLocalExecutor({
    home,
    headless: true,
    log: (line) => logs.push(line),
    projectDir: repo,
    env: boundTo(over.env ?? ENV, app.url),
  });

beforeEach(async () => {
  await executor?.close();
  if (home !== undefined) await rm(home, { recursive: true, force: true });
  if (repo !== undefined) await rm(repo, { recursive: true, force: true });
  logs = [];
  servedAtStart = app.dashboardsServedTo().length;
  signInsAtStart = app.signInsAs(SELLER);
  home = await mkdtemp(join(tmpdir(), "demoman-exec-acct-home-"));
  repo = await mkdtemp(join(tmpdir(), "demoman-exec-acct-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await mkdir(join(repo, ".demoman"));
  await writeFile(join(repo, ".gitignore"), ".demoman/secrets.env\n");
  executor = makeExecutor();
});
afterAll(async () => {
  await executor.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

export const signIn = (email: string, secret: string) => [
  { do: "goto", url: "/login" },
  { do: "type", into: { stableId: "user_email" }, text: email },
  {
    do: "type",
    into: { stableId: "user_password" },
    text: `{secret:${secret}}`,
  },
  { do: "click", on: { role: "button", name: "Sign in" } },
];
export const sellerEntry = {
  about: "a demo seller",
  checkUrl: "/app",
  signIn: signIn(SELLER, "KL_SELLER"),
};
export const customerEntry = {
  about: "a demo customer",
  checkUrl: "/app",
  signIn: signIn(CUSTOMER, "KL_CUSTOMER"),
};
export const seller = (over: { origin?: string } = {}) => ({
  accountsVersion: 1,
  sites: {
    [over.origin ?? app.url]: {
      default: "seller",
      accounts: { seller: sellerEntry },
    },
  },
});
export const sellerAndCustomer = (over: { default?: string } = {}) => ({
  accountsVersion: 1,
  sites: {
    [app.url]: {
      default: over.default ?? "seller",
      accounts: { seller: sellerEntry, customer: customerEntry },
    },
  },
});
export const writeAccounts = (json: unknown) =>
  writeFile(
    join(repo, ".demoman", "accounts.json"),
    JSON.stringify(json, null, 2),
  );

export type Report = {
  outcome: string;
  reason?: string;
  detail?: string;
  account?: string;
  signedIn?: { account: string; steps: number; ms: number };
  stopped?: { reason: string; detail?: string };
};
export const script = (
  target: string,
  steps: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  scriptVersion: extra.account === undefined ? 1 : 5,
  name: "behind the login",
  target,
  viewport: { width: 1024, height: 640 },
  steps,
  ...extra,
});
export const run = async (
  steps: unknown[],
  extra: Record<string, unknown> = {},
) => {
  const out = (await executor.request("run", {
    script: script(`${app.url}/app`, steps, extra),
  })) as { ok: boolean; value: Report };
  expect(out.ok, JSON.stringify(out)).toBe(true);
  return out.value;
};
export const snap = (url: string, extra: Record<string, unknown> = {}) =>
  executor.request("snapshot", { url, ...extra }) as Promise<{
    ok: boolean;
    reason?: string;
    detail?: string;
    value: {
      session: string;
      account: string | null;
      signedIn?: { account: string };
    };
  }>;
export const takes = () =>
  readdir(join(home, "takes")).catch(() => [] as string[]);
export const NEXT = [
  { do: "waitForLoad" },
  { do: "click", on: { text: "Next" } },
];
export const lastServed = () => app.dashboardsServedTo().at(-1);
// One app serves every test, so its counters only ever grow: a test reads
// them as the change since it began.
export let servedAtStart = 0;
export let signInsAtStart = 0;
export const servedSince = () => app.dashboardsServedTo().slice(servedAtStart);
export const signedInSince = (email: string) =>
  app.signInsAs(email) - signInsAtStart;
export const everythingUnder = async (dir: string): Promise<string> => {
  const files = await readdir(dir, { recursive: true });
  const texts = await Promise.all(
    files.map((f) => readFile(join(dir, f), "utf8").catch(() => "")),
  );
  return texts.join("\n");
};

/** A case that needs an executor built differently replaces the one
 *  `beforeEach` made; the next `beforeEach` closes whichever is current. */
export function useExecutor(
  over: { env?: NodeJS.ProcessEnv } = {},
): LocalExecutor {
  executor = makeExecutor(over);
  return executor;
}
