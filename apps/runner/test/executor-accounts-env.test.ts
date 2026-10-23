// apps/runner/test/executor-accounts-env.test.ts
//
// Launch C2's security review (2026-10-16): which environment secrets and
// project folders an account sign-in may use. Split from
// executor-accounts.test.ts on 2026-10-17; the shared setup is
// accounts-harness.ts.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionStore } from "../src/executor/sessions.js";
import {
  app,
  ENV,
  everythingUnder,
  executor,
  home,
  logs,
  NEXT,
  PASSWORD,
  type Report,
  repo,
  run,
  SELLER,
  script,
  seller,
  signedInSince,
  snap,
  takes,
  useExecutor,
  writeAccounts,
} from "./accounts-harness.js";
import { sessionFor } from "./login-app.js";

describe("environment secrets and project (security review, 2026-10-16)", () => {
  // Another checkout whose accounts.json names this app and the seller's
  // secret: a folder the caller chose, not the one Demoman started in.
  let other: string;
  beforeEach(async () => {
    other = await mkdtemp(join(tmpdir(), "demoman-exec-acct-other-"));
    execFileSync("git", ["init", "-q"], { cwd: other });
    await mkdir(join(other, ".demoman"));
    await writeFile(join(other, ".gitignore"), ".demoman/secrets.env\n");
    await writeFile(
      join(other, ".demoman", "accounts.json"),
      JSON.stringify(seller()),
    );
  });
  afterEach(() => rm(other, { recursive: true, force: true }));

  it("withholds them from an accounts.json reached through project, saying why", async () => {
    // Premise: the environment holds the secret this file asks for.
    expect(ENV.DEMOMAN_SECRET_KL_SELLER).toBe(PASSWORD);
    const gets = app.gets("/app");
    const out = await snap(`${app.url}/app`, { project: other });
    expect(out.ok, JSON.stringify(out)).toBe(false);
    expect(out.reason).toBe("secretMissing");
    expect(out.detail).toContain("DEMOMAN_SECRET_KL_SELLER is set");
    expect(out.detail).toContain("reached through `project`");
    expect(out.detail).toContain(join(other, ".demoman", "secrets.env"));
    expect(out.detail).not.toContain(PASSWORD);
    expect(signedInSince(SELLER)).toBe(0);
    expect(app.gets("/app")).toBe(gets);
  }, 60_000); // 0.0 s here; 5x is 0.2 s

  it("uses that checkout's own secrets.env", async () => {
    await writeFile(
      join(other, ".demoman", "secrets.env"),
      `DEMOMAN_SECRET_KL_SELLER=${PASSWORD}\n`,
    );
    const out = await snap(`${app.url}/app`, { project: other });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.value.signedIn?.account).toBe("seller");
  }, 60_000); // 2.5 s here; 5x is 12 s

  it("uses them when project names the repo Demoman started in", async () => {
    await writeAccounts(seller());
    const out = await snap(`${app.url}/app`, { project: repo });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.value.signedIn?.account).toBe("seller");
  }, 60_000); // 2.5 s here; 5x is 12 s
});

it("films with C's manual session on a site with no accounts entry", async () => {
  await writeAccounts(seller({ origin: "http://localhost:1" }));
  await createSessionStore(home).save(
    sessionFor(app, app.validCookieFor(SELLER)),
  );
  const report = await run(NEXT);
  expect(report.outcome, JSON.stringify(report)).toBe("complete");
  expect(report.account).toBeUndefined();
}, 120_000); // 3.9 s here; 5x is 19 s

it("never lets a secret value out, in replies, logs or files", async () => {
  // The app echoes a wrong password; the run then fails, and every surface
  // is searched for it.
  await executor.close();
  useExecutor({
    env: { DEMOMAN_SECRET_KL_SELLER: "wrong-password-here" },
  });
  await writeAccounts(seller());
  const out = await executor.request("run", {
    script: script(`${app.url}/app`, NEXT),
  });
  expect(app.lastPage()).toContain("wrong-password-here"); // premise
  expect(JSON.stringify(out)).not.toContain("wrong-password-here");
  expect(logs.join("\n")).not.toContain("wrong-password-here");
  expect(await everythingUnder(home)).not.toContain("wrong-password-here");
}, 120_000); // 1.9 s here; 5x is 9.4 s

it("scrubs a value the run itself repeats, from the reply and from report.json", async () => {
  // A step that names the password as text it cannot find: the run's report
  // quotes the target, so the value reaches the reply and the take's file
  // unless the sweep takes it out.
  await writeAccounts(seller());
  const out = (await executor.request("run", {
    script: script(`${app.url}/app`, [
      { do: "waitForLoad" },
      { do: "click", on: { text: PASSWORD } },
    ]),
  })) as { value: Report };
  // Premise: the sign-in happened this call (the sweep knows the value) and
  // the run reached the step that names it.
  expect(out.value.signedIn?.account, JSON.stringify(out)).toBe("seller");
  expect(out.value.outcome).not.toBe("refusedBeforeRun");
  expect(JSON.stringify(out)).toContain("{secret:KL_SELLER}");
  expect(JSON.stringify(out)).not.toContain(PASSWORD);
  const kept = await everythingUnder(join(home, "takes"));
  expect(kept).toContain("{secret:KL_SELLER}"); // premise: report.json exists
  expect(kept).not.toContain(PASSWORD);
}, 120_000); // 4.4 s here; 5x is 22 s

it("scrubs scene.json and status.json too (final review M4)", async () => {
  await writeAccounts(seller());
  // The script's name lands in the take's scene; here it carries the value,
  // as an anchor's displayed text could.
  const out = (await executor.request("run", {
    script: {
      ...script(`${app.url}/app`, NEXT, { account: "seller" }),
      name: `Demo ${PASSWORD}`,
    },
  })) as { ok: boolean; value: Report & { takeId?: string } };
  // Premise: the run signed in this call (the sweep knows the value) and
  // stored a take.
  expect(out.value.signedIn?.account, JSON.stringify(out)).toBe("seller");
  const [take] = await takes();
  expect(take, JSON.stringify(out)).toBeDefined();
  const scene = await readFile(
    join(home, "takes", take ?? "", "scene.json"),
    "utf8",
  );
  const status = await readFile(
    join(home, "takes", take ?? "", "status.json"),
    "utf8",
  );
  // Premise: the name is in the scene, swept to the placeholder.
  expect(scene).toContain("{secret:KL_SELLER}");
  expect(scene).not.toContain(PASSWORD);
  expect(status).not.toContain(PASSWORD);
  expect(await everythingUnder(join(home, "takes"))).not.toContain(PASSWORD);
}, 120_000); // 5.6 s here; 5x is 28 s

it("scrubs progress notes that quote the script's target", async () => {
  await writeAccounts(seller());
  await run(NEXT); // saves the account's session
  app.expireAll();
  const progress: string[] = [];
  await executor.request(
    "run",
    { script: script(`${app.url}/app?q=${PASSWORD}`, NEXT) },
    (v) => progress.push(JSON.stringify(v)),
  );
  // Premise: the run stopped at the start on the sign-in page and its
  // progress note quoted the target (the secret in its place).
  expect(progress.join("\n")).toContain("{secret:KL_SELLER}");
  expect(progress.join("\n")).not.toContain(PASSWORD);
}, 180_000); // 12 s here; 5x is 59 s

it("scrubs a value it never signed in with: a saved session, a fresh executor", async () => {
  await writeAccounts(seller());
  await run(NEXT); // saves the account's session
  await executor.close();
  logs.length = 0;
  useExecutor();
  const out = (await executor.request("run", {
    script: script(`${app.url}/app`, [
      { do: "waitForLoad" },
      { do: "click", on: { text: PASSWORD } },
    ]),
  })) as { value: Report };
  // Premise: no sign-in this call, so the sweep learned nothing from one.
  expect(out.value.signedIn, JSON.stringify(out)).toBeUndefined();
  expect(out.value.outcome).not.toBe("refusedBeforeRun");
  expect(JSON.stringify(out)).toContain("{secret:KL_SELLER}");
  expect(JSON.stringify(out)).not.toContain(PASSWORD);
  expect(logs.join("\n")).not.toContain(PASSWORD);
  const kept = await everythingUnder(join(home, "takes"));
  expect(kept).toContain("{secret:KL_SELLER}");
  expect(kept).not.toContain(PASSWORD);
}, 180_000); // 8.3 s here; 5x is 42 s

it("lists the accounts in status, never a value", async () => {
  await writeAccounts(seller());
  await writeFile(
    join(repo, ".demoman", "secrets.env"),
    `DEMOMAN_SECRET_KL_SELLER=${PASSWORD}\n`,
  );
  const out = (await executor.request("status", {})) as {
    value: { accounts: unknown; secretsFile: unknown };
  };
  expect(out.value.accounts).toEqual({
    file: join(repo, ".demoman", "accounts.json"),
    sites: [
      {
        origin: app.url,
        default: "seller",
        accounts: [{ name: "seller", about: "a demo seller", session: "none" }],
      },
    ],
  });
  expect(out.value.secretsFile).toEqual({
    path: join(repo, ".demoman", "secrets.env"),
    git: "ignored",
  });
  expect(JSON.stringify(out)).not.toContain(PASSWORD);
});

it("lists an account's saved session in status.sessions with its account (final review M3)", async () => {
  await writeAccounts(seller());
  const before = (await executor.request("status", {})) as {
    value: { sessions: unknown };
  };
  expect(before.value.sessions).toEqual([]); // premise: nothing saved yet
  const report = await run(NEXT, { account: "seller" });
  expect(report.signedIn?.account, JSON.stringify(report)).toBe("seller");
  const out = (await executor.request("status", {})) as {
    value: {
      sessions: Array<{ site: string; account?: string; origin?: string }>;
    };
  };
  expect(out.value.sessions).toHaveLength(1);
  expect(out.value.sessions[0]).toMatchObject({
    account: "seller",
    origin: app.url,
  });
}, 120_000); // 5.6 s here; 5x is 28 s
