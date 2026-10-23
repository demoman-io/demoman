// apps/runner/test/executor-credential.test.ts
//
// Launch C done-means 2, second half: a demo password a script types into a
// password field is in no file of the take and not in the run's reply.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { type LoginApp, serveLoginApp } from "./login-app.js";

const SECRET = "Zq-demo-passw0rd-7781";
let app: LoginApp;
let home: string;
let executor: LocalExecutor;
beforeAll(async () => {
  app = await serveLoginApp();
  home = await mkdtemp(join(tmpdir(), "demoman-credential-"));
  executor = createLocalExecutor({
    home,
    headless: true,
    log: () => undefined,
  });
}, 30_000);
afterAll(async () => {
  await executor.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
});

async function everyFile(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await everyFile(path)));
    else out.push(path);
  }
  return out;
}

async function typeInto(
  testId: "pw" | "nick",
): Promise<{ reply: string; files: string[]; takeId: string }> {
  const out = await executor.request("run", {
    script: {
      scriptVersion: 1,
      name: `type into ${testId}`,
      target: `${app.url}/typing`,
      viewport: { width: 1024, height: 640 },
      steps: [
        { do: "waitForLoad" },
        { do: "type", into: { stableId: testId }, text: SECRET },
      ],
    },
  });
  expect(out.ok, JSON.stringify(out)).toBe(true);
  const report = (
    out as {
      value: { outcome: string; provenance?: { takeId: string | null } };
    }
  ).value;
  expect(report.outcome, JSON.stringify(report)).toBe("complete");
  const takeId = report.provenance?.takeId;
  expect(takeId).toBeTruthy();
  return {
    reply: JSON.stringify(report),
    takeId: takeId as string,
    files: await everyFile(join(home, "takes", takeId as string)),
  };
}

const holding = async (files: string[]) => {
  const hits: string[] = [];
  for (const f of files) {
    if ((await readFile(f)).includes(Buffer.from(SECRET))) hits.push(f);
  }
  return hits;
};

it("keeps a demo password typed into a password field in no file and not in the reply", async () => {
  const { reply, files, takeId } = await typeInto("pw");
  // Premise: the take wrote its files, report.json among them.
  expect(files.some((f) => f.endsWith("scene.json"))).toBe(true);
  expect(files.some((f) => f.endsWith("report.json"))).toBe(true);
  expect(await holding(files)).toEqual([]);
  expect(reply).not.toContain(SECRET);
  expect(reply).toContain('"textHidden":"credentialField"');

  // Launch C spec 3.5: the hidden step comes back as a hole, and a re-film
  // refuses to run until the author fills it.
  const derived = await executor.request("derive", { takeId });
  const derivedJson = JSON.stringify(derived);
  expect(derivedJson).not.toContain(SECRET);
  expect(derivedJson, derivedJson).toMatch(/"reason":"redacted"/);
  const refilm = await executor.request("run", { takeId });
  expect(JSON.stringify(refilm), JSON.stringify(refilm)).toMatch(
    /refusedBeforeRun[\s\S]*unfilledHoles/,
  );
}, 120_000);

it("hides text typed into a field the page could not be asked about", async () => {
  const NICK = "harmless-nickname";
  const out = await executor.request("run", {
    script: {
      scriptVersion: 1,
      name: "type into a missing field",
      target: `${app.url}/typing`,
      viewport: { width: 1024, height: 640 },
      steps: [
        { do: "waitForLoad" },
        { do: "type", into: { stableId: "nick" }, text: NICK },
        { do: "type", into: { stableId: "no-such-field" }, text: SECRET },
      ],
    },
  });
  expect(out.ok, JSON.stringify(out)).toBe(true);
  const report = (
    out as {
      value: { outcome: string; provenance?: { takeId: string | null } };
    }
  ).value;
  const reply = JSON.stringify(report);
  // Premise: the run stopped at the missing field, after the nickname step
  // made a take.
  expect(report.outcome, reply).toBe("stopped");
  const takeId = report.provenance?.takeId;
  expect(takeId, reply).toBeTruthy();
  const files = await everyFile(join(home, "takes", takeId as string));
  expect(files.some((f) => f.endsWith("report.json"))).toBe(true);
  expect(await holding(files)).toEqual([]);
  expect(reply).not.toContain(SECRET);
  // Positive control: the visible step's text is in the take.
  expect(
    reply +
      (await readFile(
        join(home, "takes", takeId as string, "report.json"),
        "utf8",
      )),
  ).toContain(NICK);
  expect(reply).toContain('"textHidden":"credentialUnchecked"');
}, 120_000);

// Final review 1: a snapshot lists no target for a bare password input (no
// role, no text), so an agent following the recipe types into its label.
// The walk clicks the label, the browser focuses the input, and the value
// must be hidden as if the input had been named.
it("hides a demo password typed through the label a snapshot lists for it", async () => {
  type Target = {
    target: Record<string, unknown>;
    kind: string;
    text: string | null;
  };
  const snap = (await executor.request("snapshot", {
    url: `${app.url}/typing`,
  })) as { ok: boolean; value: { targets: Target[] } };
  expect(snap.ok, JSON.stringify(snap)).toBe(true);
  const targets = snap.value.targets;
  const label = targets.find(
    (t) => t.kind === "text" && t.target.text === "Account password",
  );
  // Premise: the snapshot lists the label, and no target names the input
  // itself — the only field it lists is the nickname — so the label is how
  // a script reaches it.
  expect(label, JSON.stringify(targets)).toBeDefined();
  expect(JSON.stringify(targets)).not.toContain("acct-pw");
  expect(
    targets.filter((t) => t.kind === "textbox").map((t) => t.target),
    JSON.stringify(targets),
  ).toEqual([{ stableId: "nick" }]);
  const out = await executor.request("run", {
    script: {
      scriptVersion: 1,
      name: "type through the label",
      target: `${app.url}/typing`,
      viewport: { width: 1024, height: 640 },
      steps: [
        { do: "waitForLoad" },
        { do: "type", into: label?.target, text: SECRET },
      ],
    },
  });
  expect(out.ok, JSON.stringify(out)).toBe(true);
  const report = (
    out as {
      value: { outcome: string; provenance?: { takeId: string | null } };
    }
  ).value;
  const reply = JSON.stringify(report);
  expect(report.outcome, reply).toBe("complete");
  const takeId = report.provenance?.takeId;
  expect(takeId, reply).toBeTruthy();
  const files = await everyFile(join(home, "takes", takeId as string));
  // Premise: the take wrote the files the value would land in.
  expect(files.some((f) => f.endsWith("scene.json"))).toBe(true);
  expect(files.some((f) => f.endsWith("report.json"))).toBe(true);
  expect(await holding(files)).toEqual([]);
  expect(reply).not.toContain(SECRET);
  expect(reply).toContain('"textHidden":"credentialField"');
}, 120_000);

// Positive control: the search would find the value if it were there.
it("keeps the same value typed into an ordinary text field", async () => {
  const { files, reply } = await typeInto("nick");
  expect((await holding(files)).length).toBeGreaterThan(0);
  expect(reply).not.toContain('"textHidden"');
}, 120_000);
