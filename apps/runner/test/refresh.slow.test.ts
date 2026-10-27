import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEPT_DIR,
  type KeptVideo,
  keptFileName,
  type RunReport,
  serializeKept,
  verdictLine,
} from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import {
  type RefreshDeps,
  type RefreshResult,
  refreshKept,
  uncleanRun,
} from "../src/executor/refresh.js";
import { execGit } from "../src/executor/repo.js";
import { createVideoStore } from "../src/executor/videos.js";
import { listenOnLoopback } from "../src/loopback.js";

// Measured locally (2026-10-27, M-series Mac, headless): a refresh of both
// videos (two runs, three exports, three comparisons) 13-21 s; of one video
// 5-10 s. x5 for CI (fff4505) with margin.
const SETUP_MS = 60_000;
const BOTH_MS = 150_000;
const ONE_MS = 90_000;

const ORIGINAL = await readFile(
  new URL(
    "../../../packages/compositor/scripts/fixture-app.html",
    import.meta.url,
  ),
  "utf8",
);
const HEADING = "<h1>Invoices</h1>";
const REPORTS_LINK = '<a href="#reports" data-testid="nav-reports">Reports</a>';

let html = ORIGINAL;
let server: ReturnType<typeof createServer>;
let origin: string;
let repo: string;
let home: string;
let session: BrowserSession;
const lines: string[] = [];
/** Rewrites a run answer before refresh reads it; null leaves it alone. */
let inject:
  | ((answer: Record<string, unknown>) => Record<string, unknown>)
  | null = null;

const A = "Place an order";
const B = "Open the reports";
const out = {
  aMp4: "docs/order.mp4",
  aGif: "docs/order.gif",
  bMp4: "docs/reports.mp4",
};

function kept(
  name: string,
  clicks: string[],
  scale: number,
  outputs: KeptVideo["outputs"],
): KeptVideo {
  return {
    keptVersion: 1,
    name,
    script: {
      scriptVersion: 1,
      name,
      target: `${origin}/app`,
      viewport: { width: 1280, height: 800 },
      steps: [
        { do: "waitForLoad" },
        ...clicks.map((text) => ({ do: "click", on: { text } })),
      ],
    } as KeptVideo["script"],
    scale,
    logo: null,
    outputs,
    report: name === A ? "docs/order-report.json" : null,
    from: { videoId: "video-x", takeId: "scene-x", recordedRevision: "r" },
  };
}

/** Each run: the display its executor was given, and its motion's scale. */
const filmed: { name: string; display: string; scale: number | null }[] = [];
/** The temp folders refresh makes, as they are in the system's temp now. */
const refreshTemps = async () =>
  (await readdir(tmpdir())).filter((n) =>
    /^demoman-refresh-(home-)?[A-Za-z0-9]{6}$/.test(n),
  );

const deps = (): RefreshDeps => ({
  home,
  library: createLibrary(home),
  videos: createVideoStore(home, createLibrary(home)),
  executor: (o) => {
    const e = createLocalExecutor({
      home: o.home,
      headless: true,
      standInDisplay: true,
      env: o.env,
      outDir: o.outDir,
      projectDir: o.projectDir,
      log: (l) => void lines.push(l),
    });
    return {
      ...e,
      request: async (op, args, p) => {
        const answer = await e.request(op, args, p);
        if (op === "run" && answer.ok) {
          // The scale its motion was really filmed at: the screencast's
          // frames against the page's width (`capture.dpr` is the stills'
          // fixed REPLAY_DPR, not the display's).
          const takeId = (answer.value as RunReport).provenance?.takeId;
          const bundle =
            typeof takeId === "string"
              ? await createLibrary(o.home).frameStore(takeId).getBundle(takeId)
              : null;
          const span = bundle?.motionSpans[0];
          filmed.push({
            name: String((args.script as { name: string }).name),
            display: String(o.env.DEMOMAN_DISPLAY),
            scale: span === undefined ? null : span.width / 1280,
          });
        }
        if (op !== "run" || inject === null || !answer.ok) return answer;
        return {
          ok: true,
          value: inject(answer.value as Record<string, unknown>),
        };
      },
    };
  },
  session,
  env: process.env,
  git: execGit,
  log: (l) => void lines.push(l),
});

const refresh = (only?: string[]): Promise<RefreshResult> =>
  refreshKept(
    { repoRoot: repo, library: "throwaway", ...(only ? { only } : {}) },
    deps(),
  );
const bytes = (p: string) => readFile(join(repo, p));
const byName = (r: RefreshResult, name: string) => {
  const v = r.videos.find((x) => x.name === name);
  if (v === undefined) throw new Error(`no ${name} in ${JSON.stringify(r)}`);
  return v;
};

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  origin = await listenOnLoopback(server);
  repo = await mkdtemp(join(tmpdir(), "demoman-refresh-repo-"));
  home = await mkdtemp(join(tmpdir(), "demoman-refresh-local-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    ],
    { cwd: repo },
  );
  await mkdir(join(repo, KEPT_DIR), { recursive: true });
  await writeFile(
    join(repo, KEPT_DIR, keptFileName(A)),
    serializeKept(
      kept(A, ["Place order"], 1, [
        { path: out.aMp4, fileType: "mp4", aspect: "16:9", quality: "share" },
        { path: out.aGif, fileType: "gif", aspect: "16:9", quality: "share" },
      ]),
    ),
  );
  await writeFile(
    join(repo, KEPT_DIR, keptFileName(B)),
    serializeKept(
      kept(B, ["Place order", "Reports"], 2, [
        { path: out.bMp4, fileType: "mp4", aspect: "16:9", quality: "share" },
      ]),
    ),
  );
  // Committed, as a checkout in CI has them: the first film is at HEAD.
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "keep"],
    { cwd: repo },
  );
  session = createBrowserSession({
    headless: true,
    log: (l) => void lines.push(l),
  });
}, SETUP_MS);

afterAll(async () => {
  await session?.close();
  server?.close();
  for (const dir of [repo, home])
    if (dir) await rm(dir, { recursive: true, force: true });
});

describe("refresh", () => {
  it(
    "films each kept video and writes its outputs, the first time as new",
    async () => {
      const temps = await refreshTemps();
      const r = await refresh();
      expect(
        r.videos.map((v) => [v.name, v.outcome]),
        JSON.stringify(r),
      ).toEqual([
        [B, "replaced"],
        [A, "replaced"],
      ]);
      // Each scale films in a browser of its own, at that scale.
      expect(filmed).toEqual([
        { name: B, display: "1280x800@2", scale: 2 },
        { name: A, display: "1280x800@1", scale: 1 },
      ]);
      const a = byName(r, A);
      expect(a.outputs.sort()).toEqual(
        [out.aGif, out.aMp4, "docs/order-report.json"].sort(),
      );
      expect(a.detail).toContain(`${out.aMp4} is new`);
      // The line attach would put above it, filmed at the checkout's HEAD.
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
        .toString()
        .slice(0, 7);
      expect(a.line).toBe(
        `Demo: \`${A}\` · matches all 2 steps · filmed at \`${headSha}\``,
      );
      expect((await bytes(out.aGif)).subarray(0, 6).toString("latin1")).toMatch(
        /^GIF8[79]a$/,
      );
      const report = JSON.parse(
        (await bytes("docs/order-report.json")).toString(),
      );
      expect(report.outcome).toBe("complete");
      // A throwaway library: the user's was never touched, and every temp
      // folder refresh made was removed.
      expect(await readdir(home)).toEqual([]);
      expect(lines.some((l) => l.includes("was not removed"))).toBe(false);
      // The premise: refresh made its folders where this looks.
      expect(lines.some((l) => l.startsWith("refresh: filming"))).toBe(true);
      expect(await refreshTemps()).toEqual(temps);
    },
    BOTH_MS,
  );

  it(
    "leaves an unchanged picture byte for byte as it was",
    async () => {
      const before = await Promise.all(Object.values(out).map(bytes));
      const r = await refresh();
      expect(
        r.videos.map((v) => v.outcome),
        JSON.stringify(r),
      ).toEqual(["unchanged", "unchanged"]);
      // The premise: samePicture answered same for each output.
      expect(byName(r, A).detail).toMatch(
        new RegExp(
          `^${out.aMp4}: at most [\\d.]+% of the picture changed, over \\d+ moments at rest; ${out.aGif}: at most`,
        ),
      );
      expect(byName(r, B).detail).toMatch(
        /at most [\d.]+% of the picture changed/,
      );
      expect(byName(r, A).line).toBeNull();
      const after = await Promise.all(Object.values(out).map(bytes));
      for (const [i, b] of after.entries())
        expect(b.equals(before[i] as Buffer)).toBe(true);
    },
    BOTH_MS,
  );

  it(
    "fails a video whose pictures cannot be compared, leaving its file",
    async () => {
      const before = await bytes(out.bMp4);
      const r = await refreshKept(
        { repoRoot: repo, library: "throwaway", only: [B] },
        {
          ...deps(),
          session: {
            openWorkPage: async () => ({
              ok: false,
              reason: "windowDidNotOpen",
              detail: "injected: no page to decode on",
            }),
          },
        },
      );
      expect(r.videos.map((v) => [v.name, v.outcome])).toEqual([[B, "failed"]]);
      expect(r.videos[0]?.detail).toContain("injected: no page to decode on");
      expect((await bytes(out.bMp4)).equals(before)).toBe(true);
    },
    ONE_MS,
  );

  it(
    "replaces a committed file that is not a decodable video, saying so",
    async () => {
      await writeFile(join(repo, out.bMp4), "not a video");
      const r = await refresh([B]);
      const b = byName(r, B);
      expect(b.outcome, JSON.stringify(r)).toBe("replaced");
      expect(b.notes).toEqual([
        expect.stringMatching(
          /^docs\/reports\.mp4 was replaced without a comparison: the committed file could not be decoded \(.+\)$/,
        ),
      ]);
      expect((await bytes(out.bMp4)).toString("latin1")).not.toBe(
        "not a video",
      );
    },
    ONE_MS,
  );

  it(
    "replaces a changed picture by rename from a file beside it",
    async () => {
      html = ORIGINAL.replace(
        HEADING,
        "<h1>Quarterly receipts and refunds</h1>",
      );
      // The premise: the page the app serves really changed.
      expect(ORIGINAL.split(HEADING).length).toBe(2);
      expect(html).not.toContain(HEADING);
      const before = await Promise.all(Object.values(out).map(bytes));
      const inode = (await stat(join(repo, out.aMp4))).ino;
      lines.length = 0;
      const r = await refresh();
      expect(
        r.videos.map((v) => v.outcome),
        JSON.stringify(r),
      ).toEqual(["replaced", "replaced"]);
      expect(byName(r, A).detail).toMatch(
        /% of the picture changed at [\d.]+s, over the 0\.015% allowed, of \d+ moments at rest/,
      );
      const after = await Promise.all(Object.values(out).map(bytes));
      for (const [i, b] of after.entries())
        expect(b.equals(before[i] as Buffer)).toBe(false);
      // A rename gives the path a new file; a write in place keeps its inode.
      expect((await stat(join(repo, out.aMp4))).ino).not.toBe(inode);
      // The finished file it was renamed from sat beside it, and nothing is
      // left there.
      const renamed = lines.filter((l) => l.includes(`over ${out.aMp4}`));
      expect(renamed, lines.join("\n")).toEqual([
        expect.stringMatching(
          /^refresh: renamed docs\/order\.mp4\.[0-9a-f-]{36}\.tmp over docs\/order\.mp4$/,
        ),
      ]);
      expect(
        (await readdir(join(repo, "docs"))).filter((n) => n.endsWith(".tmp")),
      ).toEqual([]);
    },
    BOTH_MS,
  );

  it(
    "fails a video whose target is gone, leaving its file, and refreshes the other",
    async () => {
      // The premise: the link was there, and now is not.
      expect(html).toContain(REPORTS_LINK);
      html = html.replace(REPORTS_LINK, "");
      expect(html).not.toContain(">Reports<");
      const before = await bytes(out.bMp4);
      const r = await refresh();
      const b = byName(r, B);
      expect(b.outcome, JSON.stringify(r)).toBe("failed");
      expect(b.detail).toContain("Stopped after step");
      expect(b.outputs).toEqual([]);
      expect(b.line).toBeNull();
      expect((await bytes(out.bMp4)).equals(before)).toBe(true);
      // The nav lost a link, so the other video's picture changed too.
      expect(byName(r, A).outcome).toBe("replaced");
    },
    BOTH_MS,
  );

  it(
    "fails a run that carries a degradation, leaving its files",
    async () => {
      html = ORIGINAL;
      const before = await Promise.all([out.aMp4, out.aGif].map(bytes));
      let clean: string | null | undefined;
      inject = (v) => {
        clean = uncleanRun(v);
        const report = v as unknown as RunReport;
        const degraded = {
          ...report,
          frames: { ...report.frames, degradations: ["budgetBreach" as const] },
        };
        return { ...degraded, summary: verdictLine(degraded) };
      };
      let r: RefreshResult;
      try {
        r = await refresh([A]);
      } finally {
        inject = null;
      }
      // The premise: the run itself was clean.
      expect(clean).toBeNull();
      expect(r.videos.map((v) => [v.name, v.outcome])).toEqual([[A, "failed"]]);
      expect(byName(r, A).detail).toContain("motion frames were skipped");
      const after = await Promise.all([out.aMp4, out.aGif].map(bytes));
      for (const [i, b] of after.entries())
        expect(b.equals(before[i] as Buffer)).toBe(true);
    },
    ONE_MS,
  );

  it(
    "fails a video whose output links out of the repo, writing nothing there",
    async () => {
      const outside = await mkdtemp(join(tmpdir(), "demoman-refresh-out-"));
      try {
        await symlink(outside, join(repo, "linked"));
        await writeFile(
          join(repo, KEPT_DIR, keptFileName("Linked out")),
          serializeKept(
            kept("Linked out", ["Place order"], 1, [
              {
                path: "linked/c.mp4",
                fileType: "mp4",
                aspect: "16:9",
                quality: "share",
              },
            ]),
          ),
        );
        lines.length = 0;
        const r = await refresh(["Linked out"]);
        expect(r.videos.map((v) => [v.name, v.outcome])).toEqual([
          ["Linked out", "failed"],
        ]);
        expect(r.videos[0]?.detail).toContain(
          "linked/c.mp4 is not inside the repo",
        );
        expect(await readdir(outside)).toEqual([]);
        // Refused before filming: no browser was asked for.
        expect(lines.filter((l) => l.startsWith("refresh: filming"))).toEqual(
          [],
        );
      } finally {
        await rm(join(repo, KEPT_DIR, keptFileName("Linked out")), {
          force: true,
        });
        await rm(join(repo, "linked"), { force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
    ONE_MS,
  );

  it(
    "fails an invalid kept file naming its field, and refreshes the rest",
    async () => {
      await writeFile(
        join(repo, KEPT_DIR, "broken.json"),
        JSON.stringify({ keptVersion: 1, name: "Broken", scale: -1 }),
      );
      const r = await refresh([A]);
      expect(
        r.videos.map((v) => [v.file, v.outcome]),
        JSON.stringify(r),
      ).toEqual([
        [`${KEPT_DIR}/broken.json`, "failed"],
        [`${KEPT_DIR}/${keptFileName(A)}`, "replaced"],
      ]);
      expect(r.videos[0]?.detail).toMatch(
        /^\.demoman\/videos\/broken\.json: script\./,
      );
    },
    ONE_MS,
  );
});
