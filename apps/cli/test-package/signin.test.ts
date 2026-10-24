// Launch C through the packed install: `demoman signin` saves a session in a
// visible window, and the MCP from the same install films behind it; an
// expired session then stops as signedOut.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { serveLoginApp } from "../../runner/test/login-app.js";
import { connect, installPacked, text } from "../test/packed-install.js";

let packed: Awaited<ReturnType<typeof installPacked>>;
let app: Awaited<ReturnType<typeof serveLoginApp>>;
let home: string;
beforeAll(async () => {
  packed = await installPacked();
  app = await serveLoginApp();
  home = await mkdtemp(join(tmpdir(), "demoman-package-signin-"));
});
afterAll(async () => {
  await app?.close();
  await packed?.cleanup();
  await rm(home, { recursive: true, force: true });
});

it("signs in through the packed bin, films behind it, then stops when it expires", async () => {
  const before = app.signIns();
  const child = spawn(
    process.execPath,
    [packed.bin, "signin", `${app.url}/app?auto=1`],
    {
      env: { ...process.env, DEMOMAN_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let said = "";
  child.stdout.on("data", (b) => {
    said += String(b);
  });
  child.stderr.on("data", (b) => {
    said += String(b);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  const exitedBounded = (): Promise<number | null> =>
    Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`signin did not exit within 60 s; it printed: ${said}`),
            ),
          60_000,
        ),
      ),
    ]);
  try {
    // Enter once the fixture's sign-in page has submitted itself — wait for
    // the condition, bounded, never for a duration. The form submits once
    // released, and it is released when signin asks for the sign-in, so it
    // never goes before signin has read the page.
    const deadline = Date.now() + 60_000;
    let releasedSignIn = false;
    while (app.signIns() <= before) {
      if (!releasedSignIn && said.includes("press Enter here")) {
        app.releaseSignIn();
        releasedSignIn = true;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `signin exited (code ${child.exitCode}, signal ${child.signalCode}) before the sign-in page submitted; it printed: ${said}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `the sign-in page never submitted within 60 s; the bin printed: ${said}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(app.signIns(), "the fixture counted no new sign-in").toBeGreaterThan(
      before,
    );
    child.stdin.write("\n");
    const code = await exitedBounded();
    expect(code, said).toBe(0);
    expect(said).toContain("Signed in to localhost");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }

  const c = await connect(process.execPath, [packed.bin, "mcp"], {
    DEMOMAN_HOME: home,
    DEMOMAN_NO_UPDATE_CHECK: "1",
  });
  try {
    const script = {
      scriptVersion: 1,
      name: "behind the login",
      target: `${app.url}/app`,
      viewport: { width: 1024, height: 640 },
      steps: [{ do: "waitForLoad" }, { do: "click", on: { text: "Next" } }],
    };
    const finish = async (args: Record<string, unknown>) => {
      let v = JSON.parse(
        text(await c.callTool({ name: "run", arguments: args })),
      ) as {
        outcome: string;
        id?: string;
        stopped?: { reason: string };
        provenance?: { takeId: string | null };
      };
      const pollDeadline = Date.now() + 120_000;
      while (["running", "stillRunning"].includes(v.outcome)) {
        if (Date.now() > pollDeadline) {
          throw new Error(
            `the run was still going after 120 s; last answer: ${JSON.stringify(v)}`,
          );
        }
        v = JSON.parse(
          text(await c.callTool({ name: "report", arguments: { id: v.id } })),
        );
      }
      return v;
    };
    const filmed = await finish({
      script,
      video: { new: "Signed in", confirmedNew: true },
    });
    expect(filmed.outcome, JSON.stringify(filmed)).toBe("complete");
    expect(filmed.provenance?.takeId).toBeTruthy();

    app.expireAll();
    const expired = await finish({
      script,
      video: { new: "Expired session", confirmedNew: true },
    });
    expect(expired.stopped?.reason, JSON.stringify(expired)).toBe("signedOut");
    expect(expired.outcome, JSON.stringify(expired)).toBe("stopped");
    expect(
      expired.provenance?.takeId ?? null,
      `an expired run kept a take: ${JSON.stringify(expired)}`,
    ).toBeNull();
    expect(JSON.stringify(expired)).toContain("signin");
  } finally {
    await c.close();
  }
}, 300_000);
