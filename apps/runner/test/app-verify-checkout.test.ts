// verifySetup for real: a temp git repo with the fixture app committed, a
// worktree, the app started there, one repo flow recorded and exported into
// a throwaway library, and the receipt's final page screen decoded.
//
// The real root's page.html is edited and left uncommitted (the heading's
// band turned white): an app started from the real root instead of the clean
// checkout serves that page, the flow still records, and the band's pixels
// are not in the export.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_FILE,
  type AppSpec,
  FLOWS_DIR,
  type KeptVideo,
  keptFileName,
  parseReceipt,
  RECEIPT_DIR,
  serializeApp,
  serializeKept,
} from "@demoman/run-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { verifySetup } from "../src/executor/app-verify.js";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import { type RefreshDeps, refreshKept } from "../src/executor/refresh.js";
import { execGit } from "../src/executor/repo.js";
import { STILL_LOOKS } from "../src/executor/same-picture.js";
import { createVideoStore } from "../src/executor/videos.js";
import { WALLPAPERS_DIR } from "./fixture.js";

// Measured locally (M-series Mac, 2026-11-04): 10.3-10.5 s, so not a
// `.slow.` file. A single refresh ran 44-66 s on CI (refresh-suite.ts), where
// canvases draw on the CPU: 180 s is 2.7x that.
const TIMEOUT_MS = 180_000;
/** `sharply`'s levels: the least grey change refresh calls a sharp one. */
const SHARP = (
  STILL_LOOKS.find((l) => l.name === "sharply") as { levels: number }
).levels;

const SERVER = fileURLToPath(
  new URL("./fixtures/app-start/server.mjs", import.meta.url),
);
const VIEW = { width: 1280, height: 800 };
/** Where the heading is, as a dark band, and a stretch of plain page. */
const HEADING = { x: 160, y: 200, width: 640, height: 160 };
const PLAIN = { x: 900, y: 480, width: 240, height: 200 };
const BAND = "background:#111827";
const PAGE = `<!doctype html><meta charset=utf-8><title>Check</title><style>html,body{margin:0;background:#fff}h1{position:absolute;left:${HEADING.x}px;top:${HEADING.y}px;width:${HEADING.width}px;height:${HEADING.height}px;margin:0;${BAND};color:#6b7280;font:48px sans-serif}</style><h1>Clean checkout</h1>`;
/** The real root's uncommitted edit: the same heading, no dark band. */
const DIRTY = PAGE.replace(BAND, "background:#fff");
const NAME = "Open the page";

const lines: string[] = [];
const log = (l: string) => void lines.push(l);
let repo: string;
let home: string;
let session: BrowserSession;
let port: number;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

beforeAll(async () => {
  port = await freePort();
  repo = await mkdtemp(join(tmpdir(), "app-verify-repo-"));
  home = await mkdtemp(join(tmpdir(), "app-verify-home-"));
  const g = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd: repo,
    }).toString();
  g("init", "-q");
  await copyFile(SERVER, join(repo, "server.mjs"));
  await writeFile(join(repo, "page.html"), PAGE);
  g("add", "-A");
  g("commit", "-q", "-m", "app");
  await writeFile(join(repo, "page.html"), DIRTY);
  session = createBrowserSession({ headless: true, log });
});

afterAll(async () => {
  await session?.close();
  for (const dir of [repo, home])
    if (dir) await rm(dir, { recursive: true, force: true });
});

/** Mean grey (Rec. 601) of each rect of a PNG, decoded in a work page. */
async function greysOf(
  png: Buffer,
  rects: { x: number; y: number; width: number; height: number }[],
): Promise<{ width: number; height: number; means: number[] }> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    return await work.page.evaluate(
      async ([base64, rects]) => {
        const data = Uint8Array.from(atob(base64 as string), (c) =>
          c.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([data], { type: "image/png" }),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(bitmap, 0, 0);
        const means = (
          rects as { x: number; y: number; width: number; height: number }[]
        ).map((r) => {
          const px = ctx.getImageData(
            Math.round(r.x),
            Math.round(r.y),
            Math.round(r.width),
            Math.round(r.height),
          ).data;
          let sum = 0;
          for (let i = 0; i < px.length; i += 4)
            sum +=
              0.299 * (px[i] as number) +
              0.587 * (px[i + 1] as number) +
              0.114 * (px[i + 2] as number);
          return sum / (px.length / 4);
        });
        return { width: bitmap.width, height: bitmap.height, means };
      },
      [png.toString("base64"), rects] as const,
    );
  } finally {
    await work.page.close();
  }
}

it(
  "passes from a clean checkout, and the export shows the committed page",
  async () => {
    // The fixture's premise: the committed page, loaded directly, shows the
    // heading as a dark band at HEADING; HEAD has it, the real root does not.
    const work = await session.openWorkPage();
    if (!work.ok) throw new Error(work.detail);
    try {
      await work.page.setViewportSize(VIEW);
      await work.page.setContent(PAGE);
      const rect = await work.page.$eval("h1", (h) => {
        const r = h.getBoundingClientRect();
        return {
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          band: getComputedStyle(h).backgroundColor,
        };
      });
      expect(rect).toEqual({ rect: HEADING, band: "rgb(17, 24, 39)" });
    } finally {
      await work.page.close();
    }
    expect(
      execFileSync("git", ["show", "HEAD:page.html"], { cwd: repo }).toString(),
    ).toContain(BAND);
    expect(await readFile(join(repo, "page.html"), "utf8")).not.toContain(BAND);

    const app: AppSpec = {
      appVersion: 1,
      install: [],
      start: "node server.mjs",
      url: `http://127.0.0.1:${port}/`,
      timeoutSeconds: 30,
      // MODE too: vitest sets MODE=test in the env the app inherits.
      env: { PORT: String(port), PAGE: "page.html", MODE: "normal" },
      secrets: [],
      services: {},
    };
    const kept = {
      keptVersion: 2,
      flow: randomUUID(),
      deliver: "commit",
      name: NAME,
      script: {
        scriptVersion: 1,
        name: NAME,
        target: app.url,
        viewport: VIEW,
        steps: [
          { do: "waitForLoad" },
          { do: "click", on: { text: "Clean checkout" } },
        ],
      },
      scale: 1,
      logo: null,
      wallpaper: null,
      outputs: [
        {
          path: "docs/page.mp4",
          fileType: "mp4",
          aspect: "16:9",
          quality: "share",
        },
      ],
      report: null,
    } as unknown as KeptVideo;
    /** The final screen, read from the checkout before it is removed. */
    let shot = null as { png: Buffer } | null;
    const refreshDeps = (env: NodeJS.ProcessEnv): RefreshDeps => ({
      library: createLibrary(home),
      videos: createVideoStore(home, createLibrary(home)),
      executor: (o) =>
        createLocalExecutor({
          wallpapersDir: WALLPAPERS_DIR,
          home: o.home,
          headless: true,
          standInDisplay: true,
          env: o.env,
          outDir: o.outDir,
          projectDir: o.projectDir,
          log,
        }),
      session,
      env,
      log,
    });

    const from = performance.now();
    const r = await verifySetup(
      {
        root: repo,
        files: [
          { path: APP_FILE, text: serializeApp(app) },
          {
            path: `${FLOWS_DIR}/${keptFileName(NAME)}`,
            text: serializeKept(kept),
          },
        ],
        target: { app },
        secrets: {},
      },
      {
        git: execGit,
        refresh: async (args, env) => {
          const result = await refreshKept(args, refreshDeps(env));
          // A failed video wrote no receipt: verifySetup says why.
          if (result.videos.some((v) => v.outcome === "failed")) return result;
          const file = join(args.repoRoot, RECEIPT_DIR, keptFileName(NAME));
          const parsed = parseReceipt(await readFile(file, "utf8"), file);
          if (!parsed.ok) throw new Error(parsed.detail);
          const { receipt } = parsed;
          shot = {
            png: await readFile(
              join(
                args.repoRoot,
                RECEIPT_DIR,
                receipt.screensDir as string,
                "final.png",
              ),
            ),
          };
          return result;
        },
        docker: async () => ({ code: 0 }),
        log,
      },
    );
    console.info(
      `app-verify: verifySetup took ${((performance.now() - from) / 1000).toFixed(1)} s`,
    );
    expect(r, `${JSON.stringify(r)}\n${lines.join("\n")}`).toMatchObject({
      passed: true,
      flow: NAME,
      outcome: "uncompared",
    });
    // The checkout is gone, and the real root was never written.
    expect(
      execFileSync("git", ["worktree", "list"], { cwd: repo })
        .toString()
        .trim()
        .split("\n"),
    ).toHaveLength(1);
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: repo })
        .toString()
        .trim(),
    ).toBe("M page.html");

    if (shot === null) throw new Error("refresh never read the final screen");
    const { png } = shot;
    // Premise: the final screen is the page itself at CSS 1x, so page
    // pixels are its pixels.
    const decoded = await greysOf(png, []);
    expect([decoded.width, decoded.height]).toEqual([VIEW.width, VIEW.height]);
    /** A page rect on the PNG, 15% in from each edge. */
    const onPng = (p: typeof HEADING) => ({
      x: p.x + p.width * 0.15,
      y: p.y + p.height * 0.15,
      width: p.width * 0.7,
      height: p.height * 0.7,
    });
    const { means } = await greysOf(png, [onPng(HEADING), onPng(PLAIN)]);
    const [heading, plain] = means as [number, number];
    console.info(
      `app-verify: final screen grey ${heading.toFixed(1)} on the heading, ${plain.toFixed(1)} on plain page (sharp is ${SHARP})`,
    );
    expect(
      plain - heading,
      `heading ${heading.toFixed(1)}, plain page ${plain.toFixed(1)}`,
    ).toBeGreaterThan(SHARP);
  },
  TIMEOUT_MS,
);
