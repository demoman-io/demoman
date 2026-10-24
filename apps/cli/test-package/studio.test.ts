// Launch D2 through the packed install: `demoman studio <takeId>` opens the
// studio on a take in a visible Chrome for Testing app window; an export is
// started through the same HTTP API the page's Export button uses; the GIF
// that lands decodes and outputs.json lists it; `studio --stop` says so.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { serveFixtureApp } from "../../runner/test/fixture.js";
import { sampleImage } from "../../runner/test/mp4-probe.js";
import { connect, installPacked, text } from "../test/packed-install.js";

let packed: Awaited<ReturnType<typeof installPacked>>;
let app: Awaited<ReturnType<typeof serveFixtureApp>>;
let home: string;
const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  DEMOMAN_HOME: home,
  DEMOMAN_NO_UPDATE_CHECK: "1",
});
beforeAll(async () => {
  packed = await installPacked();
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-package-studio-"));
});
afterAll(async () => {
  // Whatever the case did, no studio (and so no Chrome) outlives it.
  if (packed !== undefined && home !== undefined) {
    try {
      execFileSync(process.execPath, [packed.bin, "studio", "--stop"], {
        env: env(),
        stdio: "pipe",
      });
    } catch {
      // the case's own --stop already ran, or the studio never started
    }
  }
  app?.close();
  await packed?.cleanup();
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});

type Answer = {
  outcome: string;
  id?: string;
  provenance?: { takeId?: string };
};

async function takeId(): Promise<string> {
  const c = await connect(
    process.execPath,
    [packed.bin, "mcp", "--out-dir", join(home, "out")],
    { DEMOMAN_HOME: home, DEMOMAN_NO_UPDATE_CHECK: "1" },
  );
  try {
    let v = JSON.parse(
      text(
        await c.callTool({
          name: "run",
          arguments: {
            video: { new: "Place an order", confirmedNew: true },
            script: {
              scriptVersion: 1,
              name: "Place an order",
              target: app.url,
              viewport: { width: 1280, height: 800 },
              steps: [
                { do: "waitForLoad" },
                { do: "click", on: { text: "Place order" } },
                { do: "pause", ms: 1200 },
              ],
            },
          },
        }),
      ),
    ) as Answer;
    while (["running", "stillRunning"].includes(v.outcome)) {
      v = JSON.parse(
        text(await c.callTool({ name: "report", arguments: { id: v.id } })),
      ) as Answer;
    }
    expect(v.outcome, JSON.stringify(v)).toBe("complete");
    const id = v.provenance?.takeId;
    if (id === undefined)
      throw new Error(`the run names no take: ${JSON.stringify(v)}`);
    return id;
  } finally {
    await c.close();
  }
}

const demoman = (...args: string[]): string =>
  execFileSync(process.execPath, [packed.bin, ...args], {
    env: env(),
    encoding: "utf8",
    timeout: 60_000,
  });

it("opens the Studio on a take, exports a GIF through its API, and stops", async () => {
  const id = await takeId();
  const opened = demoman("studio", id);
  // No link: stdout and argv are readable, and a live ticket is a key.
  expect(opened).toBe("Opened the Studio.\n");

  const state = JSON.parse(
    await readFile(join(home, "studio.json"), "utf8"),
  ) as { port: number; token: string };

  // The window is a real browser on the studio's own profile, whose argv
  // (any local user's `ps`) carries no entry ticket and no token.
  const processes = execFileSync("ps", ["-axo", "command"], {
    encoding: "utf8",
  });
  const studioBrowser = processes
    .split("\n")
    .filter((l) => l.includes(join(home, "profiles", "studio")));
  expect(
    studioBrowser,
    "no browser is running on the Studio's profile",
  ).not.toEqual([]);
  for (const line of studioBrowser) {
    expect(line).not.toContain("?t=");
    expect(line).not.toContain(state.token);
  }

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      method,
      headers: {
        Cookie: `studio=${state.token}`,
        "X-Demoman-Studio": "1",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.text() };
  };

  const scene = await call("GET", `/api/takes/${id}/scene`);
  expect(scene.status, scene.body).toBe(200);
  const { revision } = JSON.parse(scene.body) as { revision: string };
  const started = await call("POST", `/api/takes/${id}/exports`, {
    fileType: "gif",
    revision,
  });
  expect(started.status, started.body).toBeLessThan(300);

  const outputs = join(home, "takes", id, "outputs.json");
  const deadline = Date.now() + 240_000;
  let rows: { path: string; fileType: string }[] = [];
  while (Date.now() < deadline) {
    if (existsSync(outputs)) {
      rows = JSON.parse(await readFile(outputs, "utf8"));
      if (rows.length > 0) break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(rows, "outputs.json lists no export").toHaveLength(1);
  const row = rows[0] as { path: string; fileType: string };
  expect(row.fileType).toBe("gif");
  const bytes = await readFile(row.path);
  const read = await sampleImage(bytes, "image/gif", { colors: [] });
  expect(read.frameCount, JSON.stringify(read)).toBeGreaterThan(1);
  expect(read.width).toBeGreaterThan(0);

  expect(demoman("studio", "--stop")).toBe("Stopped the Studio.\n");
}, 600_000);
