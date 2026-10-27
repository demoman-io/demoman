import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleMp4 } from "../../runner/test/mp4-probe.js";
import { connect, installPacked, text } from "../test/packed-install.js";

const ORIGINAL = await readFile(
  new URL(
    "../../../packages/compositor/scripts/fixture-app.html",
    import.meta.url,
  ),
  "utf8",
);
const HEADING = "<h1>Invoices</h1>";
// A heading the fixture never paints: loud magenta, large, other words.
const NEW_HEADING =
  '<h1 style="color:#ff00ff;font-size:64px">Quarterly receipts</h1>';
const MAGENTA: [number, number, number] = [255, 0, 255];
const NAME = "Place an order";
const MP4 = "docs/order.mp4";

// Measured locally (2026-10-27, M-series Mac, headless): the run ~10 s, keep
// ~10 s, each refresh 8-15 s. x5 for the runner (fff4505), with margin.
const STEP_MS = 120_000;

let packed: Awaited<ReturnType<typeof installPacked>>;
let server: Server;
let origin: string;
let html = ORIGINAL;
let repo: string;
let home: string;
beforeAll(async () => {
  packed = await installPacked();
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = await mkdtemp(join(tmpdir(), "demoman-package-"));
  repo = await mkdtemp(join(tmpdir(), "demoman-refresh-repo-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "init");
});
afterAll(async () => {
  server?.close();
  await packed?.cleanup();
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

type Cli = { code: number; stdout: string; stderr: string };
/** The packed CLI inside the temp repo; CI=true makes refresh's library throwaway. */
const cli = (...args: string[]): Promise<Cli> =>
  new Promise((done) =>
    execFile(
      process.execPath,
      [packed.bin, ...args],
      {
        cwd: repo,
        env: {
          ...process.env,
          DEMOMAN_HOME: home,
          DEMOMAN_NO_UPDATE_CHECK: "1",
          CI: "true",
        },
        maxBuffer: 16 << 20,
      },
      (err, stdout, stderr) =>
        done({
          code: err ? (typeof err.code === "number" ? err.code : 127) : 0,
          stdout,
          stderr,
        }),
    ),
  );
const said = (r: Cli) =>
  `exit ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
const kept = () => readFile(join(repo, MP4));
const magentaMost = async (bytes: Buffer) => {
  const read = await sampleMp4(bytes, { colors: [MAGENTA] });
  return Math.max(...read.readings.map((r) => r.colorCounts[0] ?? 0));
};

it(
  "keeps a video and refreshes it from the packed install: unchanged, replaced, failed",
  async () => {
    // The video: a fixture run through the packed MCP server, in the temp repo.
    const c = await connect(
      process.execPath,
      [packed.bin, "mcp", "--out-dir", join(home, "out")],
      { DEMOMAN_HOME: home, DEMOMAN_NO_UPDATE_CHECK: "1" },
    );
    try {
      const args = {
        video: { new: NAME, confirmedNew: true },
        project: repo,
        script: {
          scriptVersion: 1,
          name: NAME,
          target: origin,
          viewport: { width: 1280, height: 800 },
          steps: [
            { do: "waitForLoad" },
            { do: "click", on: { text: "Place order" } },
            { do: "pause", ms: 1200 },
          ],
        },
      };
      let v = JSON.parse(
        text(await c.callTool({ name: "run", arguments: args })),
      ) as {
        outcome: string;
        id?: string;
      };
      while (["running", "stillRunning"].includes(v.outcome)) {
        v = JSON.parse(
          text(await c.callTool({ name: "report", arguments: { id: v.id } })),
        );
      }
      expect(v.outcome, JSON.stringify(v)).toBe("complete");
    } finally {
      await c.close();
    }

    const k = await cli("keep", NAME, "--to", MP4);
    expect(k.code, said(k)).toBe(0);
    const original = await kept();

    // Unchanged: same app, same picture, the file is not touched.
    const same = await cli("refresh");
    console.info(`[refresh] unchanged: ${same.stdout.trim()}`);
    expect(same.code, said(same)).toBe(0);
    expect(same.stdout, said(same)).toContain(`${NAME}: unchanged`);
    expect((await kept()).equals(original), said(same)).toBe(true);

    // Replaced: the heading differs (premise), and the new file shows it.
    html = ORIGINAL.replace(HEADING, NEW_HEADING);
    expect(ORIGINAL.split(HEADING).length, "the fixture has one heading").toBe(
      2,
    );
    expect(html).not.toContain(HEADING);
    expect(html).toContain("Quarterly receipts");
    const before = await magentaMost(original);
    expect(before, "the old film has no magenta heading").toBeLessThan(20);
    const changed = await cli("refresh");
    console.info(`[refresh] replaced: ${changed.stdout.trim()}`);
    expect(changed.code, said(changed)).toBe(0);
    expect(changed.stdout, said(changed)).toContain(`${NAME}: replaced`);
    const replaced = await kept();
    expect(replaced.equals(original), said(changed)).toBe(false);
    expect(
      await magentaMost(replaced),
      "the replaced film does not show the new heading",
    ).toBeGreaterThan(100);

    // Failed: a target the script clicks is gone; the file stays byte for byte.
    const BUTTON = /<button[^>]*id="checkout-btn"[^>]*>Place order<\/button>/;
    expect(html, "the button is there to remove").toMatch(BUTTON);
    html = html.replace(BUTTON, "");
    expect(html).not.toContain("Place order");
    const broken = await cli("refresh");
    console.info(`[refresh] failed: ${broken.stdout.trim()}`);
    expect(broken.code, said(broken)).toBe(1);
    expect(broken.stdout, said(broken)).toContain(`${NAME}: failed`);
    expect((await kept()).equals(replaced), said(broken)).toBe(true);
  },
  STEP_MS * 5,
);
