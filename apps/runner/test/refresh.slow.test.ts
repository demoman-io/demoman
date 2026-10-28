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
import { CAMERA_DEFAULTS, motionTimings } from "@demoman/compositor";
import {
  KEPT_DIR,
  type KeptScreens,
  type KeptVideo,
  keptFileName,
  parseKept,
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
  type RefreshVideo,
  refreshKept,
  uncleanRun,
} from "../src/executor/refresh.js";
import { execGit } from "../src/executor/repo.js";
import { createVideoStore } from "../src/executor/videos.js";
import { listenOnLoopback } from "../src/loopback.js";
import { WALLPAPERS_DIR } from "./fixture.js";
import { sampleMp4 } from "./mp4-probe.js";

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
// Hidden off-screen until the first click opens it: a change here is seen
// only on what the last step reveals.
const PANEL_CSS = "transform: translateX(100%)";
const PANEL_BG = "background: #111827; color: #e5e7eb;";
const PANEL_CHANGED = ORIGINAL.replace(
  PANEL_BG,
  "background: #f9fafb; color: #e5e7eb;",
);
const CLICK_ANSWER = 'document.getElementById("panel").classList.add("open");';
const SLOW = ORIGINAL.replace(
  CLICK_ANSWER,
  `setTimeout(() => { ${CLICK_ANSWER} }, 600);`,
);
/** `returnsBetween`'s line, as the gap from one beat's hold to the next
 *  arrival at the default smoothness (2725 ms); a gap between two markers is
 *  the same length, as both sit `leadInMs` before theirs. */
const LINE_MS = (() => {
  const t = motionTimings(0.5);
  return t.zoomInMs + t.zoomOutMs + 2 * CAMERA_DEFAULTS.neutral.minPlateauMs;
})();
const REPORTS_LINK = '<a href="#reports" data-testid="nav-reports">Reports</a>';
/** The amounts' generator: the first row reads $1,200.00. */
const AMOUNT = "(1200 + i * 317)";
/** One digit of one cell: the first row's $1,200.00 reads $1,207.00. */
const ONE_DIGIT = ORIGINAL.replace(
  AMOUNT,
  "(1200 + i * 317 + (i === 0 ? 7 : 0))",
);
/** A spinner that never stops, beside the button the camera zooms to, so it
 *  is in view on every screen: the page is never still (#10). */
const SPINNER = ORIGINAL.replace(
  "</style>",
  `#spin { position: fixed; right: 320px; bottom: 148px; width: 20px; height: 20px; border: 3px solid #c7d2fe; border-top-color: #3b5bdb; border-radius: 50%; animation: spin 800ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>`,
).replace("</main>", '<div id="spin"></div></main>');
/** A colour's grey level (Rec. 601), 0-255. */
const luma = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) =>
    Number.parseInt(hex.slice(i, i + 2), 16),
  );
  return 0.299 * (r as number) + 0.587 * (g as number) + 0.114 * (b as number);
};
/** Restyles that change a colour and nothing else: where the fixture says
 *  it, what it becomes, and where in the film it shows. */
const RESTYLES = [
  {
    name: "nav text gray-700 to gray-500",
    rule: "nav a { display: block; padding: 8px 12px; border-radius: 6px; color: ",
    from: "#374151",
    to: "#6b7280",
    // The nav is on every screen; which one reads most depends on the
    // platform's fonts (Linux: the final screen, 2026-10-28).
    where: /changed faintly (before step \d+|on the final screen)/,
  },
  {
    name: "the button blue to a green as light",
    rule: "border-radius: 8px; background: ",
    from: "#3b5bdb",
    to: "#2b8a3e",
    /** Grey alone cannot tell these apart: the test that colour is read. */
    greyUnder: 10,
    where: /before step \d+/,
  },
  {
    name: "the dark panel #111827 to #7f1d1d",
    rule: "width: 360px; background: ",
    from: "#111827",
    to: "#7f1d1d",
    where: /on the final screen/,
  },
] as const;
/** Each `td`'s text, as the page renders it from `page`. */
async function cellsOf(page: string): Promise<string[]> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    await work.page.setContent(page);
    return await work.page.$$eval("td", (tds) =>
      tds.map((td) => td.textContent ?? ""),
    );
  } finally {
    await work.page.close();
  }
}
/** The `screens noise` line CI's log carries: the largest share changed at
 *  a screen, out of how many were compared, on this platform. */
function noiseLine(name: string, detail: string): string {
  const same = detail.match(/at most ([\d.]+)% sharply and ([\d.]+)% faintly/);
  const changed = detail.match(/([\d.]+)% of the picture changed (\w+)/);
  const [k] = screensOf(detail);
  const shares =
    same !== null
      ? `${same[1]}% sharply, ${same[2]}% faintly`
      : `${changed?.[1]}% ${changed?.[2]}`;
  const line = `screens noise: max ${shares} over ${k} screens on ${process.platform} (${name})`;
  console.info(line);
  return line;
}
/** Writes a kept file of its own into the repo, and removes it with every
 *  output it names when `body` is done. */
async function withKept<T>(
  video: KeptVideo,
  body: () => Promise<T>,
): Promise<T> {
  const file = join(repo, KEPT_DIR, keptFileName(video.name));
  await writeFile(file, serializeKept(video));
  try {
    return await body();
  } finally {
    await rm(file, { force: true });
    for (const o of video.outputs)
      await rm(join(repo, o.path), { force: true });
  }
}

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
/** Rewrites a saved export's answer before refresh reads it. */
let injectExport:
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
  /** A pause before the last click, to move the gap between clicks off the
   *  camera's line (the guard test at the end). */
  pauseMs = 0,
  /** A pause after the last click, so the film ends on a still screen
   *  (1500 ms is the short ending a slower app is measured on, below). */
  endMs = 0,
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
        ...clicks.flatMap((text, i) => [
          ...(pauseMs > 0 && i === clicks.length - 1 && i > 0
            ? [{ do: "pause", ms: pauseMs }]
            : []),
          { do: "click", on: { text } },
        ]),
        ...(endMs > 0 ? [{ do: "pause", ms: endMs }] : []),
      ],
    } as KeptVideo["script"],
    scale,
    logo: null,
    wallpaper: null,
    outputs,
    screens: { steps: 1, moments: [{ step: null, ms: 500 }] },
    report: name === A ? "docs/order-report.json" : null,
    from: { videoId: "video-x", takeId: "scene-x", recordedRevision: "r" },
  };
}

/** Each run: the display its executor was given, and its motion's scale. */
const filmed: { name: string; display: string; scale: number | null }[] = [];
/** Every run this file films: its name, and the gaps (source ms) between
 *  its consecutive step markers after the first. */
const gaps: { name: string; gaps: number[]; settle: number }[] = [];
/** Every saved export's screens and wallpaper warning, in order. */
const exported: {
  fileType: string;
  screens: KeptScreens;
  wallpaper: "leftOut" | "soft" | null;
}[] = [];
/** The temp folders refresh makes, as they are in the system's temp now. */
const refreshTemps = async () =>
  (await readdir(tmpdir())).filter((n) =>
    /^demoman-refresh-(home-)?[A-Za-z0-9]{6}$/.test(n),
  );

const deps = (): RefreshDeps => ({
  library: createLibrary(home),
  videos: createVideoStore(home, createLibrary(home)),
  executor: (o) => {
    const e = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
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
          const at = (bundle?.markers ?? [])
            .map((m) => m.sourceTimeMs)
            .sort((x, y) => x - y)
            .slice(1);
          const marks = (bundle?.markers ?? [])
            .slice()
            .sort((x, y) => x.sourceTimeMs - y.sourceTimeMs)
            .slice(1);
          gaps.push({
            name: String((args.script as { name: string }).name),
            gaps: at.slice(1).map((t, i) => t - (at[i] as number)),
            // When the page stopped moving after the first click, from its
            // marker: the end of the last screencast span before the next.
            settle: (() => {
              const from = marks[0]?.sourceTimeMs ?? Number.NaN;
              const to = marks[1]?.sourceTimeMs ?? Number.POSITIVE_INFINITY;
              const ends = (bundle?.motionSpans ?? [])
                .filter((m) => m.startMs >= from && m.startMs < to)
                .map((m) => m.endMs);
              return ends.length === 0 ? Number.NaN : Math.max(...ends) - from;
            })(),
          });
          filmed.push({
            name: String((args.script as { name: string }).name),
            display: String(o.env.DEMOMAN_DISPLAY),
            scale: span === undefined ? null : span.width / 1280,
          });
        }
        if (op === "export" && answer.ok) {
          const v = answer.value as {
            fileType: string;
            screens: KeptScreens;
            warnings: { wallpaperWarning?: { kind: "leftOut" | "soft" } };
          };
          exported.push({
            fileType: v.fileType,
            screens: v.screens,
            wallpaper: v.warnings.wallpaperWarning?.kind ?? null,
          });
          if (injectExport !== null)
            return {
              ok: true,
              value: injectExport(answer.value as Record<string, unknown>),
            };
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
/** The `k of n screens` of a detail line. */
const screensOf = (detail: string): [number, number] => {
  const m = detail.match(/(\d+) of (\d+) screens/);
  if (m === null) throw new Error(`no "k of n screens" in: ${detail}`);
  return [Number(m[1]), Number(m[2])];
};
/** A's detail from the unchanged run, for the slower app's to match. */
let unchangedDetailA = "";
const bytes = (p: string) => readFile(join(repo, p));
const keptOf = async (name: string): Promise<KeptVideo> => {
  const file = `${KEPT_DIR}/${keptFileName(name)}`;
  const parsed = parseKept(await readFile(join(repo, file), "utf8"), file);
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.kept;
};
/** How far a gap between two clicks is from the pan-or-pull-back line: the
 *  room `returnsBetween` finds between the camera's hold after the first
 *  click and its arrival at the second (both `leadInMs` before their markers).
 *  Positive returns, negative pans; near 0 is the line. */
const clearOfLine = (g: number) => Math.abs(g - LINE_MS) > 500;
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
      kept(
        A,
        ["Place order"],
        1,
        [
          { path: out.aMp4, fileType: "mp4", aspect: "16:9", quality: "share" },
          { path: out.aGif, fileType: "gif", aspect: "16:9", quality: "share" },
        ],
        0,
        3500,
      ),
    ),
  );
  await writeFile(
    join(repo, KEPT_DIR, keptFileName(B)),
    serializeKept(
      kept(
        B,
        ["Place order", "Reports"],
        2,
        [{ path: out.bMp4, fileType: "mp4", aspect: "16:9", quality: "share" }],
        2000,
      ),
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
        [
          out.aGif,
          out.aMp4,
          "docs/order-report.json",
          `${KEPT_DIR}/${keptFileName(A)}`,
        ].sort(),
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
      // The premise: samePicture answered same for the judged output
      // alone, over k of n screens recorded from a real film.
      for (const name of [A, B]) {
        const { screens } = await keptOf(name);
        const m = byName(r, name).detail.match(
          /^docs\/\w+\.mp4: at most [\d.]+% sharply and [\d.]+% faintly of the picture changed, over (\d+) of (\d+) screens$/,
        );
        expect(m, byName(r, name).detail).not.toBeNull();
        expect(Number(m?.[1])).toBeGreaterThanOrEqual(2);
        expect(Number(m?.[2])).toBe(screens.steps + 1);
      }
      for (const name of [A, B]) noiseLine(name, byName(r, name).detail);
      expect(byName(r, A).detail).not.toContain(out.aGif);
      unchangedDetailA = byName(r, A).detail;
      expect(byName(r, A).line).toBeNull();
      const after = await Promise.all(Object.values(out).map(bytes));
      for (const [i, b] of after.entries())
        expect(b.equals(before[i] as Buffer)).toBe(true);
    },
    BOTH_MS,
  );

  it(
    "reads a slower app as unchanged",
    async () => {
      // The premise: the app really answers the click 600 ms later.
      expect(SLOW).not.toBe(ORIGINAL);
      const fast = gaps.filter((g) => g.name === B).length;
      html = SLOW;
      let r: RefreshResult;
      try {
        r = await refresh();
      } finally {
        html = ORIGINAL;
      }
      expect(
        r.videos.map((v) => [v.name, v.outcome]),
        JSON.stringify(r),
      ).toEqual([
        [B, "unchanged"],
        [A, "unchanged"],
      ]);
      for (const name of [A, B])
        noiseLine(`${name}, slower`, byName(r, name).detail);
      // The premise: as many screens were compared as in the unchanged run,
      // so the final screen did not drop out of either film.
      const slowA = byName(r, A).detail;
      expect(
        screensOf(slowA),
        `unchanged: ${unchangedDetailA} | slower: ${slowA}`,
      ).toEqual(screensOf(unchangedDetailA));
      // The premise: the page settled after the first click later than in the
      // film before it, by most of the 600 ms (the click's act is capped near
      // 1.1 s, and on CI it reached the cap in both films, so it cannot say),
      // and neither film's gap sits near the camera's line.
      const bGaps = gaps.filter((g) => g.name === B);
      const [before, now] = [
        bGaps[fast - 1],
        bGaps[fast],
      ] as (typeof gaps)[0][];
      expect(
        (now?.settle as number) - (before?.settle as number),
        JSON.stringify(gaps),
      ).toBeGreaterThan(300);
      for (const g of [before, now])
        expect(clearOfLine(g?.gaps[0] as number), JSON.stringify(g)).toBe(true);
    },
    BOTH_MS,
  );

  it(
    "a one-digit change reads replaced",
    async () => {
      // The premise: exactly one cell's text differs, by one character.
      const [was, now] = await Promise.all([ORIGINAL, ONE_DIGIT].map(cellsOf));
      const differ = (was as string[]).flatMap((c, i) =>
        c === (now as string[])[i]
          ? []
          : [[c.trim(), (now as string[])[i]?.trim()]],
      );
      expect(differ).toEqual([["$1,200.00", "$1,207.00"]]);
      // The premise: the film stops on a screen before a step, where the
      // table is in view (the panel the click opens covers the amounts).
      const { screens } = await keptOf(A);
      expect(
        screens.moments.some((m) => m.step !== null),
        JSON.stringify(screens),
      ).toBe(true);
      html = ONE_DIGIT;
      let r: RefreshResult;
      try {
        r = await refresh([A]);
      } finally {
        html = ORIGINAL;
      }
      const a = byName(r, A);
      noiseLine("one digit", a.detail);
      expect(a.outcome, JSON.stringify(r)).toBe("replaced");
      expect(a.detail).toMatch(
        /% of the picture changed sharply before step \d+ at /,
      );
      // And back: the digit restored reads replaced too, a second reading.
      const back = byName(await refresh([A]), A);
      noiseLine("one digit, back", back.detail);
      expect(back.outcome, back.detail).toBe("replaced");
    },
    BOTH_MS,
  );

  for (const restyle of RESTYLES) {
    it(
      `a colour restyle reads replaced: ${restyle.name}`,
      async () => {
        // The premise: the rule names that colour once, and only the colour
        // changes; the button keeps its lightness (grey alone cannot tell).
        const at = `${restyle.rule}${restyle.from}`;
        expect(ORIGINAL.split(at).length, at).toBe(2);
        const page = ORIGINAL.replace(at, `${restyle.rule}${restyle.to}`);
        expect(page).not.toContain(at);
        expect(page.length).toBe(ORIGINAL.length);
        const shift = Math.abs(luma(restyle.from) - luma(restyle.to));
        console.info(`restyle ${restyle.name}: grey moves ${shift.toFixed(1)}`);
        if ("greyUnder" in restyle)
          expect(
            shift,
            `grey ${luma(restyle.from)} to ${luma(restyle.to)}`,
          ).toBeLessThan(restyle.greyUnder);
        html = page;
        let r: RefreshResult;
        try {
          r = await refresh([A]);
        } finally {
          html = ORIGINAL;
        }
        const a = byName(r, A);
        noiseLine(restyle.name, a.detail);
        expect(a.outcome, JSON.stringify(r)).toBe("replaced");
        expect(a.detail).toMatch(restyle.where);
        // And back to the committed colours, a second reading.
        const back = byName(await refresh([A]), A);
        noiseLine(`${restyle.name}, back`, back.detail);
        expect(back.outcome, back.detail).toBe("replaced");
      },
      BOTH_MS,
    );
  }

  it(
    "reads a slower app as unchanged with a short ending",
    async () => {
      const name = "Short ending";
      const mp4 = "docs/short.mp4";
      const video = kept(
        name,
        ["Place order"],
        1,
        [{ path: mp4, fileType: "mp4", aspect: "16:9", quality: "share" }],
        0,
        1500,
      );
      await withKept(video, async () => {
        const first = byName(await refresh([name]), name);
        expect(first.outcome, first.detail).toBe("replaced");
        // The premise: both films end on a still screen, so the final screen
        // is compared (the slower film's screens, from its export).
        const final = (sc: KeptScreens) =>
          sc.moments.some((m) => m.step === null);
        const { screens } = await keptOf(name);
        expect(final(screens), JSON.stringify(screens)).toBe(true);
        exported.length = 0;
        html = SLOW;
        let r: RefreshResult;
        try {
          r = await refresh([name]);
        } finally {
          html = ORIGINAL;
        }
        const v = byName(r, name);
        noiseLine("short ending, slower", v.detail);
        const slower = exported.find((e) => e.fileType === "mp4")?.screens;
        expect(slower && final(slower), JSON.stringify(exported)).toBe(true);
        expect(v.outcome, v.detail).toBe("unchanged");
      });
    },
    BOTH_MS,
  );

  it(
    "reads a video kept as a GIF alone unchanged, and slower",
    async () => {
      const name = "Order as a GIF";
      const gif = "docs/order-only.gif";
      const video = kept(
        name,
        ["Place order"],
        1,
        [{ path: gif, fileType: "gif", aspect: "16:9", quality: "share" }],
        0,
        3500,
      );
      await withKept(video, async () => {
        const first = byName(await refresh([name]), name);
        expect(first.outcome, first.detail).toBe("replaced");
        // The premise: the GIF is the output judged, and it has screens.
        const { screens } = await keptOf(name);
        expect(screens.moments.length, JSON.stringify(screens)).toBeGreaterThan(
          1,
        );
        const same = byName(await refresh([name]), name);
        html = SLOW;
        let slower: RefreshVideo;
        try {
          slower = byName(await refresh([name]), name);
        } finally {
          html = ORIGINAL;
        }
        // Measured 2026-10-28 on a Mac: 0.0000% on both looks, both films.
        for (const [label, v] of [
          ["GIF alone", same],
          ["GIF alone, slower", slower],
        ] as const) {
          expect(v.detail, v.detail).toContain(gif);
          console.info(`gif only: ${label}: ${v.outcome}: ${v.detail}`);
          if (/\d+ of \d+ screens/.test(v.detail)) noiseLine(label, v.detail);
          expect(v.outcome, v.detail).toBe("unchanged");
        }
      });
    },
    BOTH_MS,
  );

  it(
    "measures a spinner that never stops, filmed twice (#10)",
    async () => {
      const name = "Spinner";
      const video = kept(
        name,
        ["Place order"],
        1,
        [
          {
            path: "docs/spinner.mp4",
            fileType: "mp4",
            aspect: "16:9",
            quality: "share",
          },
        ],
        0,
        3500,
      );
      // The premise: the spinner is on the page.
      expect(SPINNER).toContain('<div id="spin"></div></main>');
      expect(SPINNER).toContain("animation: spin");
      html = SPINNER;
      try {
        await withKept(video, async () => {
          const first = byName(await refresh([name]), name);
          const { screens } = await keptOf(name).catch((error: unknown) => ({
            screens: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
          }));
          const second = byName(await refresh([name]), name);
          // Measured, not asserted: it goes on #10.
          console.info(
            `spinner: first ${first.outcome}: ${first.detail} | screens ${JSON.stringify(screens)} | again ${second.outcome}: ${second.detail} | on ${process.platform}`,
          );
        });
      } finally {
        html = ORIGINAL;
      }
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
    "fails a kept file with no screens, saying keep it again",
    async () => {
      const kf = join(repo, KEPT_DIR, "no-screens.json");
      const { screens: _gone, ...bare } = await keptOf(A);
      await writeFile(kf, JSON.stringify({ ...bare, name: "No screens" }));
      try {
        const r = await refresh([A]);
        const v = r.videos.find((x) => x.file.endsWith("no-screens.json"));
        expect(v?.outcome, JSON.stringify(r)).toBe("failed");
        expect(v?.detail).toContain("demoman keep No screens");
        expect(v?.outputs).toEqual([]);
      } finally {
        await rm(kf, { force: true });
      }
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
    "replaces a change seen only on the final screen",
    async () => {
      // The premise: the change is in a panel that is off-screen until the
      // last step opens it, and the page really changed.
      expect(ORIGINAL).toContain(PANEL_CSS);
      expect(ORIGINAL.split(PANEL_BG).length).toBe(2);
      expect(PANEL_CHANGED).not.toContain(PANEL_BG);
      html = PANEL_CHANGED;
      const r = await refresh([A]);
      expect(byName(r, A).outcome, JSON.stringify(r)).toBe("replaced");
      expect(byName(r, A).detail).toMatch(
        /% of the picture changed \w+ on the final screen at [\d.]+s/,
      );
    },
    ONE_MS,
  );

  it(
    "replaces the GIF with its MP4, and leaves it with it",
    async () => {
      const both = () => Promise.all([out.aMp4, out.aGif].map(bytes));
      const before = await both();
      html = PANEL_CHANGED;
      const same = await refresh([A]);
      expect(byName(same, A).outcome, JSON.stringify(same)).toBe("unchanged");
      for (const [i, b] of (await both()).entries())
        expect(b.equals(before[i] as Buffer)).toBe(true);
      html = PANEL_CHANGED.replace(HEADING, "<h1>Open invoices</h1>");
      expect(html).not.toContain(HEADING);
      const r = await refresh([A]);
      const a = byName(r, A);
      expect(a.outcome, JSON.stringify(r)).toBe("replaced");
      // Judged by its MP4 alone, and the GIF went with it.
      expect(a.detail).toContain(out.aMp4);
      expect(a.detail).not.toContain(out.aGif);
      expect(a.outputs).toContain(out.aGif);
      for (const [i, b] of (await both()).entries())
        expect(b.equals(before[i] as Buffer)).toBe(false);
    },
    ONE_MS,
  );

  it(
    "rewrites the kept file's screens when it replaces, and lists it",
    async () => {
      const file = `${KEPT_DIR}/${keptFileName(A)}`;
      const before = (await keptOf(A)).screens;
      html = PANEL_CHANGED.replace(HEADING, "<h1>Overdue invoices</h1>");
      expect(html).not.toContain(HEADING);
      exported.length = 0;
      const r = await refresh([A]);
      expect(byName(r, A).outcome, JSON.stringify(r)).toBe("replaced");
      expect(byName(r, A).outputs).toContain(file);
      const judged = exported.find((e) => e.fileType === "mp4");
      expect(judged, JSON.stringify(exported)).toBeDefined();
      const after = (await keptOf(A)).screens;
      expect(after).toEqual(judged?.screens);
      // The premise: the new film's screens are not the file's old ones.
      expect(after).not.toEqual(before);
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
        /% of the picture changed \w+ (before step \d+|on the final screen) at [\d.]+s/,
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
    "fails a replace whose new film has no still screen, writing nothing",
    async () => {
      // The committed MP4 is gone, so the video is replaced without a
      // comparison, and its new film recorded no still screen.
      const file = `${KEPT_DIR}/${keptFileName(A)}`;
      const mp4 = await bytes(out.aMp4);
      const before = await Promise.all([out.aGif, file].map(bytes));
      await rm(join(repo, out.aMp4));
      injectExport = (v) =>
        v.fileType === "mp4"
          ? { ...v, screens: { ...(v.screens as KeptScreens), moments: [] } }
          : v;
      let r: RefreshResult;
      try {
        r = await refresh([A]);
      } finally {
        injectExport = null;
        await writeFile(join(repo, out.aMp4), mp4);
      }
      const a = byName(r, A);
      expect(a.outcome, JSON.stringify(r)).toBe("failed");
      expect(a.detail).toBe(
        `${out.aMp4}, the output a refresh judges, has no still screen to compare against — a refresh would have nothing to check; nothing was written`,
      );
      expect(a.outputs).toEqual([]);
      // The premise: the export really answered with no screen.
      expect(
        exported.some((e) => e.fileType === "mp4"),
        JSON.stringify(exported),
      ).toBe(true);
      const after = await Promise.all([out.aGif, file].map(bytes));
      for (const [i, b] of after.entries())
        expect(b.equals(before[i] as Buffer)).toBe(true);
    },
    ONE_MS,
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

  // Ruling R13: keep copies an uploaded image into the repo and names it
  // there (`kept.wallpaper`); a refresh in CI films it from that copy. A
  // soft one (smaller than the zoom needs) is the picture the author kept.
  // Red if refresh stops pointing the script at the repo's copy: the run
  // would read the repo-relative ref from its own empty home, and the
  // export would leave the image out.
  it(
    "films an uploaded image from its copy in the repo, soft or not",
    async () => {
      html = ORIGINAL;
      const C = "On an upload";
      const copy = `${KEPT_DIR}/wallpapers/green.webp`;
      const green: [number, number, number] = [0, 160, 80];
      const work = await session.openWorkPage();
      if (!work.ok) throw new Error(work.detail);
      let webp: Buffer;
      try {
        const base64 = await work.page.evaluate(async ([r, g, b]) => {
          const canvas = new OffscreenCanvas(640, 480);
          const ctx = canvas.getContext(
            "2d",
          ) as OffscreenCanvasRenderingContext2D;
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(0, 0, 640, 480);
          const blob = await canvas.convertToBlob({ type: "image/webp" });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (const x of bytes) binary += String.fromCharCode(x);
          return btoa(binary);
        }, green);
        webp = Buffer.from(base64, "base64");
      } finally {
        await work.page.close();
      }
      await mkdir(join(repo, KEPT_DIR, "wallpapers"), { recursive: true });
      await writeFile(join(repo, copy), webp);
      const base = kept(
        C,
        ["Place order"],
        1,
        [
          {
            path: "docs/upload.mp4",
            fileType: "mp4",
            aspect: "16:9",
            quality: "share",
          },
        ],
        0,
        3500,
      );
      const video: KeptVideo = {
        ...base,
        wallpaper: copy,
        script: {
          ...base.script,
          look: {
            branding: {
              background: { kind: "image", ref: copy },
              logo: null,
              padding: 0.15,
            },
          },
        },
      };
      const before = exported.length;
      try {
        // The output is read before `withKept` removes it.
        const { r, film } = await withKept(video, async () => {
          const r = await refresh([C]);
          return { r, film: await bytes("docs/upload.mp4").catch(() => null) };
        });
        const c = byName(r, C);
        expect(c.outcome, JSON.stringify(r)).toBe("replaced");
        // The premise: its export warned soft, and nothing else.
        expect(exported.slice(before).map((e) => e.wallpaper)).toEqual([
          "soft",
        ]);
        // The picture: the margin is the upload's green.
        const [reading] = (
          await sampleMp4(film ?? Buffer.alloc(0), {
            colors: [],
            blockPoints: [[0.03, 0.5]],
          })
        ).readings;
        const block = reading?.blocks[0] ?? [0, 0, 0];
        for (let i = 0; i < 3; i++)
          expect(
            Math.abs((block[i] as number) - (green[i] as number)),
            JSON.stringify(block),
          ).toBeLessThanOrEqual(12);
      } finally {
        await rm(join(repo, KEPT_DIR, "wallpapers"), {
          recursive: true,
          force: true,
        });
      }
    },
    ONE_MS,
  );

  // Ruling R13, as the logo: a video an export left on the gradient fails,
  // and its committed files stay. Red if refresh reads only the logo.
  it(
    "fails a video an export left without its wallpaper, leaving its files",
    async () => {
      html = ORIGINAL;
      const said =
        "The wallpaper was left out: x could not be read; the video uses the plain gradient.";
      const before = await Promise.all([out.aMp4, out.aGif].map(bytes));
      injectExport = (v) => ({
        ...v,
        warnings: {
          ...(v.warnings as object),
          wallpaperWarning: { kind: "leftOut", sentence: said },
        },
      });
      let r: RefreshResult;
      try {
        r = await refresh([A]);
      } finally {
        injectExport = null;
      }
      const a = byName(r, A);
      expect(a.outcome, JSON.stringify(r)).toBe("failed");
      expect(a.detail).toBe(
        `${out.aMp4} was rendered without its wallpaper: ${said}`,
      );
      const after = await Promise.all([out.aMp4, out.aGif].map(bytes));
      for (const [i, b] of after.entries())
        expect(b.equals(before[i] as Buffer)).toBe(true);
    },
    ONE_MS,
  );

  it("keeps every click clear of the pan-or-pull-back line", () => {
    // Tests no production code: it fails when a fixture edit moves a gap
    // between clicks onto `returnsBetween`'s line (spec decision 5).
    // The premise: the file filmed a video with two clicks, several times.
    const withGap = gaps.filter((g) => g.gaps.length > 0);
    expect(withGap.length, JSON.stringify(gaps)).toBeGreaterThan(3);
    for (const g of withGap)
      for (const gap of g.gaps)
        expect(
          clearOfLine(gap),
          `${g.name}: a ${gap} ms gap is within 500 ms of ${LINE_MS}`,
        ).toBe(true);
  });
});
