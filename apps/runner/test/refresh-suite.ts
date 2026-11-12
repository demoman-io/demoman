import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
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
  CAMERA_DEFAULTS,
  motionTimings,
  WALLPAPER_LONG_SIDE,
} from "@demoman/compositor";
import { pngSize, STEP_QUIET_MS } from "@demoman/replay-engine";
import {
  fileDigest,
  LEGACY_FLOWS_DIR as KEPT_DIR,
  type KeptVideo,
  keptFileName,
  lookDigest,
  type PageScreens,
  RECEIPT_DIR,
  type RunReport,
  screensDirOf,
  serializeKept,
  verdictLine,
  webpSize,
} from "@demoman/run-core";
import { screenImageName } from "@demoman/run-core/render";
import { BRANDING_DEFAULTS } from "@demoman/scene-schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it as vitestIt,
} from "vitest";
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
  type RunVerdict,
  refreshKept,
  runVerdict,
} from "../src/executor/refresh.js";
import { sameScreens } from "../src/executor/same-picture.js";
import { createVideoStore } from "../src/executor/videos.js";
import { listenOnLoopback } from "../src/loopback.js";
import { LOGO_SVG, WALLPAPERS_DIR } from "./fixture.js";
import { readKeptV2 } from "./kept-v2.js";
import { sampleMp4 } from "./mp4-probe.js";

// Measured on CI (run 40820520425, 2026-10-29, ubuntu): a case that
// refreshes both videos, or one video twice, took 122-142 s, and the first
// film ran past 150 s; a single refresh 44-66 s, and the GIF swap (two)
// past 90 s. Locally (M-series Mac) the first film takes 22 s, as CI's x5
// (fff4505) would allow, but here the canvases draw on the GPU (`launch.ts`'s
// `HEADLESS_GPU_ARGS`) and CI's draw on the CPU: with the GPU left off the
// same case took 71 s, of it 10 s the wallpaper's per-frame draw (61 s on a
// gradient), and the file's cases 26-81 s, 1168 s in all; CI took 1.5-2.5x
// those. Each limit is at least 1.6x 2.5 times its slowest GPU-off case.
const SETUP_MS = 60_000;
const BOTH_MS = 300_000;
/** The grey-text case records three takes before its refresh: 53 s here,
 *  333 s on CI once (PR #67, 2026-11-11: 33 s past BOTH_MS, then passed). */
const GREY_TEXT_MS = 600_000;
const ONE_MS = 180_000;

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
/** A slower app: the click's answer waits on a request the test server
 *  holds `SLOW_ANSWER_MS` (a slow search, the settle's condition 2). A
 *  delay made by a timer alone is outside the settle by design
 *  (`STEP_QUIET_MS`). */
const SLOW_ANSWER_MS = 600;
const SLOW_PATH = "/slow-answer";
const SLOW = ORIGINAL.replace(
  CLICK_ANSWER,
  `fetch("${SLOW_PATH}").then(() => { ${CLICK_ANSWER} });`,
);
/** How long the server held each slow answer, in ms. */
const slowHeld: number[] = [];
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
/** DEM-138's case: a line of 12px grey text, in a box of fixed width so its
 *  glyph advances move nothing else, and the same line with 4 characters
 *  changed (14:11 to 05:00 is 4 digits). */
const LOCAL_TIME = (t: string) =>
  ORIGINAL.replace(
    HEADING,
    `${HEADING}<span class="local-time" style="display:block;width:140px;height:16px;font-size:12px;color:#9ca3af">${t} local time</span>`,
  );
const LOCAL_TIME_WAS = LOCAL_TIME("14:11");
const LOCAL_TIME_NOW = LOCAL_TIME("05:00");
/** A spinner that never stops, beside the button the camera zooms to, so it
 *  is in view on every screen: the page is never still (#10). */
const SPINNER = ORIGINAL.replace(
  "</style>",
  `#spin { position: fixed; right: 320px; bottom: 148px; width: 20px; height: 20px; border: 3px solid #c7d2fe; border-top-color: #3b5bdb; border-radius: 50%; animation: spin 800ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>`,
).replace("</main>", '<div id="spin"></div></main>');
/** A page of the fixture app with something added (the behaviours are
 *  `settle-app.html`'s, in replay-engine's fixtures): CSS, elements fixed at
 *  the foot of the page below the table so nothing else moves, a script. */
const withExtra = (css: string, body: string, js = "") =>
  `${ORIGINAL.replace("</style>", `${css}\n</style>`).replace("</main>", `${body}</main>`)}${js === "" ? "" : `<script>${js}</script>`}`;
/** The foot of the page: 32px high, 20px above the bottom of 1280x800. */
const FOOT = "position: fixed; bottom: 20px; height: 32px;";
/** DEM-139's field: `#search` focused, its caret drawn in one video and not
 *  in the other, as two captures a blink apart would show it. Headless
 *  Chromium draws the caret in the same phase in every recording (measured
 *  2026-11-10, replay-settled-screens.test.ts), so the phase is forced. */
const caretPage = (color: string) =>
  ORIGINAL.replace("</style>", `#search { caret-color: ${color}; }\n</style>`);
const CARET_ON = caretPage("#111827");
const CARET_OFF = caretPage("transparent");
/** A chip that fills on hover over `HOVER_MS`. Longer than the spec's
 *  150 ms on purpose: measured 2026-11-11, the pointer enters the chip
 *  ~530 ms before the hover returns (the glide's slow end), and the page
 *  screen is taken 734 ms after it entered; a 150 ms or 600 ms fill had
 *  arrived with or without the finite-animation condition, so only a fill
 *  longer than that lets this test fail. */
const HOVER_FILL = "#c7d2fe";
const HOVER_MS = 1000;
const HOVER = withExtra(
  `#tip { transition: background-color ${HOVER_MS}ms linear; background: #ffffff; }\n  #tip:hover { background: ${HOVER_FILL}; }`,
  `<span id="tip" style="${FOOT} left: 260px; width: 32px; border-radius: 6px"></span>`,
);
/** The spinner page with a line of small grey text beside the spinner. */
const PENDING = (n: number) =>
  SPINNER.replace(
    "</main>",
    `<span id="pending" style="position: fixed; right: 360px; bottom: 150px; width: 90px; font-size: 12px; color: #6b7280">${n} pending</span></main>`,
  );
/** The same page with its spinner half a turn on: what a capture at
 *  another moment shows. Two recordings here capture at the same phase
 *  (measured 2026-11-11: without the hold the angles differed by at most 38
 *  levels in a channel, which neither look sees), so the phase is forced. */
const SPIN_SHIFT_MS = 400;
const PENDING_SHIFTED = `${PENDING(3)}<script>{ const a = document.getElementById("spin").getAnimations()[0]; a.currentTime = (a.currentTime ?? 0) + ${SPIN_SHIFT_MS}; }</script>`;
/** An answer streamed over `STREAM_MS`: its first word after a pause
 *  longer than the beat, so only the request in flight says the step is
 *  not done. */
const STREAM_PATH = "/stream";
const STREAM_WORDS =
  "Your order ships on Tuesday from our Leeds warehouse and arrives by Friday next week.".split(
    " ",
  );
const STREAM_FIRST_MS = 500;
/** The answer's box at 1280x800, wider than the sentence by a margin no
 *  platform's glyph widths eat (`stream` asserts 20 px are left over). */
const ANSWER = { x: 340, y: 748, width: 880, height: 32 };
const STREAM_MS = 1500;
/** How long each stream the server sent took, in ms. */
const streamed: number[] = [];
const STREAM = withExtra(
  "",
  `<button type="button" id="ask" style="${FOOT} left: 260px; width: 60px">Ask</button><div id="answer" style="${FOOT} left: ${ANSWER.x}px; width: ${ANSWER.width}px; line-height: 32px; white-space: nowrap; overflow: hidden"></div>`,
  `document.getElementById("ask").onclick = async () => {
    const reader = (await fetch("${STREAM_PATH}")).body.getReader();
    const text = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      document.getElementById("answer").textContent += text.decode(value);
    }
  };`,
);
/** DEM-176: a click that loads the code for what it shows, as a route
 *  change in a dev server does, held `LAZY_MS` (longer than the beat). The
 *  module writes the line itself; until it arrives the page does not move,
 *  so only the script request in flight says the step is not done. */
const LAZY_PATH = "/lazy-panel.js";
const LAZY_MS = 800;
const LAZY_TEXT = "Ticket 1040 opened";
/** How long each lazy module the server sent was held, in ms. */
const lazyHeld: number[] = [];
const LAZY = withExtra(
  "",
  `<button type="button" id="open" style="${FOOT} left: 260px; width: 60px">Open</button><div id="opened" style="${FOOT} left: ${ANSWER.x}px; width: ${ANSWER.width}px; line-height: 32px; white-space: nowrap; overflow: hidden"></div>`,
  `document.getElementById("open").onclick = () => import("${LAZY_PATH}");`,
);
/** A toast that slides in over `TOAST_MS`, longer than the beat, so only
 *  the running animation says the step is not done. */
const TOAST_MS = 600;
const TOAST_FILL = "#065f46";
/** Where the toast comes to rest, at 1280x800. */
const TOAST_REST = { x: 600, y: 748, width: 180, height: 32 };
const TOAST = withExtra(
  `@keyframes slidein { from { transform: translateX(240px); } to { transform: none; } }
  .toast { ${FOOT} left: 600px; width: 180px; padding: 6px 12px; border-radius: 8px; background: ${TOAST_FILL}; color: #fff; animation: slidein ${TOAST_MS}ms ease-out forwards; }`,
  `<button type="button" id="save" style="${FOOT} left: 260px; width: 80px">Save</button><div id="toasts"></div>`,
  `document.getElementById("save").onclick = () => {
    const d = document.createElement("div");
    d.className = "toast";
    d.textContent = "Saved";
    document.getElementById("toasts").append(d);
  };`,
);
/** A search that filters the table once the typing has stopped for
 *  `DEBOUNCE_MS`, inside the beat. A debounce longer than the beat is a
 *  delay made by a timer alone, outside the settle by design
 *  (`STEP_QUIET_MS`): measured 2026-11-11 at 250 ms, both videos' screens
 *  were taken before the filter. */
const DEBOUNCE_MS = 150;
const DEBOUNCE = withExtra(
  "",
  "",
  `let deb;
  document.getElementById("search").addEventListener("input", (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      for (const tr of document.querySelectorAll("#rows tr"))
        tr.style.display = tr.textContent.includes(e.target.value) ? "" : "none";
    }, ${DEBOUNCE_MS});
  });`,
);
/** A count that ticks every `TICK_MS`, shorter than the beat: the DOM
 *  never goes quiet once it starts. */
const TICKS = `<span id="ticks" style="${FOOT} left: 260px; width: 80px; line-height: 32px"></span>`;
const TICK_MS = 50;
const TICK = `setInterval(() => { const t = document.getElementById("ticks"); t.textContent = String(Number(t.textContent) + 1); }, ${TICK_MS});`;
const NEVER_AFTER_CLICK = withExtra(
  "",
  TICKS,
  `document.getElementById("checkout-btn").addEventListener("click", () => { ${TICK} });`,
);
/** The page an app that shows dates relative to its "now" serves (DEM-79):
 *  a due date the server renders, and an age the page works out from a
 *  server timestamp against its own clock. `serverNow` is what the app
 *  takes as now: the real clock, or DEMOMAN_NOW when pinned. */
const DAY_MS = 86_400_000;
const datedPage = (serverNow: number, heading = HEADING) => {
  const due = new Date(serverNow + 28 * DAY_MS).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return ORIGINAL.replace(
    HEADING,
    `${heading}<p id="due">Due ${due}</p><p id="age" data-t="${serverNow - 5 * 60_000}"></p>
<script>{ const p = document.getElementById("age"); p.textContent = "Created " + Math.round((Date.now() - Number(p.dataset.t)) / 60000) + " minutes ago"; }</script>`,
  );
};
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
    // The nav is on every screen; which one reads most, and which look
    // counts it first, depends on the platform's fonts (Linux: the final
    // screen, 2026-10-28; macOS: sharply since the per-pixel look).
    where: /changed (sharply|faintly) (before step \d+|on the final screen)/,
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
/** A 640x480 WebP of one colour, made in a work page. */
async function webpOf(rgb: [number, number, number]): Promise<Buffer> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    const base64 = await work.page.evaluate(async ([r, g, b]) => {
      const canvas = new OffscreenCanvas(640, 480);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, 640, 480);
      const blob = await canvas.convertToBlob({ type: "image/webp" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const x of bytes) binary += String.fromCharCode(x);
      return btoa(binary);
    }, rgb);
    return Buffer.from(base64, "base64");
  } finally {
    await work.page.close();
  }
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
    await rm(join(repo, RECEIPT_DIR, keptFileName(video.name)), {
      force: true,
    });
    await rm(join(repo, RECEIPT_DIR, screensDirOf(keptFileName(video.name))), {
      recursive: true,
      force: true,
    });
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

/** Runs `fn`, then puts the repo's flows and outputs back as they were: a
 *  test that delivers must not change what the later tests in its lane
 *  read (CI, PR #36). */
const leavingRepo = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = await mkdtemp(join(tmpdir(), "demoman-refresh-saved-"));
  const dirs = ["docs", ".demoman"];
  for (const d of dirs)
    await cp(join(repo, d), join(saved, d), { recursive: true }).catch(
      () => undefined,
    );
  try {
    return await fn();
  } finally {
    for (const d of dirs) {
      await rm(join(repo, d), { recursive: true, force: true });
      await cp(join(saved, d), join(repo, d), { recursive: true }).catch(
        () => undefined,
      );
    }
    await rm(saved, { recursive: true, force: true });
  }
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
    keptVersion: 2,
    // One flow per kept file: two files naming one flow both fail.
    flow: randomUUID(),
    deliver: "commit",
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
    report: name === A ? "docs/order-report.json" : null,
  };
}

/** Each run: the display its executor was given, and its motion's scale. */
const filmed: { name: string; display: string; scale: number | null }[] = [];
/** Every run this file films: its name, and the gaps (source ms) between
 *  its consecutive step markers after the first. */
const gaps: {
  name: string;
  gaps: number[];
  settle: number;
  /** The page screen after the first click (`after` 2): how long its
   *  settle waited, and why it never settled if it did not. */
  clickScreen: { waitedMs: number; unsettled?: string } | null;
  /** Every page screen the run took, as the bundle records it. */
  screens: {
    after: number;
    waitedMs: number;
    heldAnimations: number;
    unsettled?: string;
  }[];
}[] = [];
/** Every saved export's screens and wallpaper warning, in order. */
const exported: {
  fileType: string;
  /** Page screens for "screens"; the video's own screens otherwise. */
  screens: unknown;
  wallpaper: "leftOut" | "soft" | null;
  /** A page screens export's images, copied before refresh removes them:
   *  each video's screens, the new one's included. Null for a video export. */
  dir: string | null;
}[] = [];
/** The copies in `exported`, removed when the file ends. */
const copies: string[] = [];
/** Every home and output folder refresh handed an executor, in order. Read
 *  from the handoff, not by listing the system's temp: other checkouts'
 *  suites refresh into the same temp at the same time (2026-10-30). */
const madeDirs: string[] = [];

const deps = (): RefreshDeps => ({
  library: createLibrary(home),
  videos: createVideoStore(home, createLibrary(home)),
  executor: (o) => {
    madeDirs.push(o.home, o.outDir);
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
          const click = bundle?.pageScreens?.find((p) => p.after === 2);
          gaps.push({
            name: String((args.script as { name: string }).name),
            screens: (bundle?.pageScreens ?? []).map((p) => ({
              after: p.after,
              waitedMs: p.waitedMs,
              heldAnimations: p.heldAnimations,
              ...(p.unsettled === undefined ? {} : { unsettled: p.unsettled }),
            })),
            clickScreen:
              click === undefined
                ? null
                : {
                    waitedMs: click.waitedMs,
                    ...(click.unsettled === undefined
                      ? {}
                      : { unsettled: click.unsettled }),
                  },
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
            screens: unknown;
            folder?: { path: string };
            warnings: { wallpaperWarning?: { kind: "leftOut" | "soft" } };
          };
          let dir: string | null = null;
          if (v.fileType === "screens" && v.folder !== undefined) {
            dir = await mkdtemp(join(tmpdir(), "demoman-refresh-shots-"));
            copies.push(dir);
            await cp(v.folder.path, dir, { recursive: true });
          }
          exported.push({
            fileType: v.fileType,
            screens: v.screens,
            wallpaper: v.warnings.wallpaperWarning?.kind ?? null,
            dir,
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
  log: (l) => void lines.push(l),
});

const refresh = (only?: string[], pinnedNow?: string): Promise<RefreshResult> =>
  refreshKept(
    { repoRoot: repo, library: "throwaway", ...(only ? { only } : {}) },
    { ...deps(), ...(pinnedNow === undefined ? {} : { pinnedNow }) },
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
/** The recipe, with the screens its receipt says the committed files show. */
const keptOf = async (
  name: string,
): Promise<KeptVideo & { screens: PageScreens }> => {
  const { kept, receipt } = await readKeptV2(
    repo,
    `${KEPT_DIR}/${keptFileName(name)}`,
  );
  if (receipt.screens === null)
    throw new Error(`${name}'s receipt predates page screens`);
  return { ...kept, screens: receipt.screens };
};
/** The settled screens of a receipt's page screens. */
const settled = (sc: PageScreens) =>
  sc.screens.filter((s) => s.unsettled === undefined);
/** A copy of `name`'s page screens, to read after its receipt is replaced. */
async function screensCopy(
  name: string,
): Promise<{ dir: string; screens: PageScreens }> {
  const dir = await mkdtemp(join(tmpdir(), "demoman-screens-copy-"));
  await cp(join(repo, RECEIPT_DIR, screensDirOf(keptFileName(name))), dir, {
    recursive: true,
  });
  return { dir, screens: (await keptOf(name)).screens };
}
/** `sameScreens` on two sets of page screens with their looks left out:
 *  whether the pages alone read the same. */
async function pagesAlone(
  a: { dir: string; screens: PageScreens },
  b: { dir: string; screens: PageScreens },
) {
  const bare = ({ look: _look, ...sc }: PageScreens) => sc;
  return sameScreens(
    { dir: a.dir, screens: bare(a.screens) },
    { dir: b.dir, screens: bare(b.screens) },
    { session, log: (l) => void lines.push(l) },
  );
}
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

/** The test body that ran last, and whether it has ended. vitest does not
 *  stop a body that timed out: it runs on beside the next test and resets
 *  `html`, `exported` and the repo's files under it. On CI (2026-10-29) a
 *  timed-out slower-app refresh set `html` back to the original while "a
 *  one-digit change" filmed, which then read unchanged. */
let last = { done: Promise.resolve() as Promise<unknown>, ended: true };
const it = (name: string, body: () => unknown, ms?: number) =>
  vitestIt(
    name,
    () => {
      const run = { done: Promise.resolve() as Promise<unknown>, ended: false };
      run.done = Promise.resolve()
        .then(body)
        .finally(() => {
          run.ended = true;
        });
      last = run;
      return run.done;
    },
    ms,
  );

/** Registers the file's hooks and its parts, in the order given. Every file
 *  gets a repo, an app and a browser of its own (vitest isolates modules per
 *  file), so the parts a file names read only what that file filmed.
 *
 *  Split four ways on 2026-11-01 (six files now, each a job of CI's refresh
 *  matrix): as one file the lane ran 3012 s on CI, the whole of its shard's
 *  3014 s, and a file is the smallest unit vitest can hand to another
 *  machine. */
export function refreshSuite(...parts: (() => void)[]): void {
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === STREAM_PATH) {
        // The first word after a pause longer than the beat, the rest
        // evenly over what is left of `STREAM_MS` (both asserted in
        // `stream`): in the pause only the request says it is not done.
        const from = performance.now();
        res.writeHead(200, { "content-type": "text/plain" });
        STREAM_WORDS.forEach((word, i) => {
          setTimeout(
            () => {
              res.write(i === 0 ? word : ` ${word}`);
              if (i < STREAM_WORDS.length - 1) return;
              res.end();
              streamed.push(performance.now() - from);
            },
            STREAM_FIRST_MS +
              (i * (STREAM_MS - STREAM_FIRST_MS)) / (STREAM_WORDS.length - 1),
          );
        });
        return;
      }
      if (req.url === LAZY_PATH) {
        const from = performance.now();
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end(
            `document.getElementById("opened").textContent = ${JSON.stringify(LAZY_TEXT)};`,
          );
          lazyHeld.push(performance.now() - from);
        }, LAZY_MS);
        return;
      }
      if (req.url === SLOW_PATH) {
        const from = performance.now();
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
          slowHeld.push(performance.now() - from);
        }, SLOW_ANSWER_MS);
        return;
      }
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
            {
              path: out.aMp4,
              fileType: "mp4",
              aspect: "16:9",
              quality: "share",
            },
            {
              path: out.aGif,
              fileType: "gif",
              aspect: "16:9",
              quality: "share",
            },
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
          [
            {
              path: out.bMp4,
              fileType: "mp4",
              aspect: "16:9",
              quality: "share",
            },
          ],
          2000,
        ),
      ),
    );
    // Committed, as a checkout in CI has them: the first film is at HEAD.
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "-m",
        "keep",
      ],
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
    for (const dir of [repo, home, ...copies])
      if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Each test starts once the one before it has really ended, and says so
   *  when it had to wait. */
  beforeEach(async () => {
    const previous = last;
    if (previous.ended) return;
    const from = performance.now();
    const how = await previous.done.then(
      () => "passed",
      (error: unknown) =>
        `failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.warn(
      `refresh: the previous test ran ${((performance.now() - from) / 1000).toFixed(1)} s past its timeout and then ${how}; this test started after it`,
    );
  }, BOTH_MS);
  describe("refresh", () => {
    for (const part of parts) part();
  });
}

/** Films A and B for the first time: the committed videos every group but
 *  the self-contained ones compares against. */
export const firstFilm = () => {
  it(
    "films each kept video and writes its outputs and receipt, the first time as new",
    async () => {
      madeDirs.length = 0;
      const r = await refresh();
      expect(
        r.videos.map((v) => [v.name, v.outcome]),
        JSON.stringify(r),
      ).toEqual([
        [B, "uncompared"],
        [A, "uncompared"],
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
          `${RECEIPT_DIR}/${screensDirOf(keptFileName(A))}`,
          `${RECEIPT_DIR}/${keptFileName(A)}`,
        ].sort(),
      );
      expect(a.detail).toBe("nothing to compare against; delivered as new");
      expect(a.notes).toEqual([`${RECEIPT_DIR}/${keptFileName(A)} is missing`]);
      // The recipe is the committed one, byte for byte.
      expect(
        execFileSync("git", ["status", "--porcelain", KEPT_DIR], { cwd: repo })
          .toString()
          .trim(),
      ).toBe("");
      // The line attach would put above it, filmed at the checkout's HEAD.
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
        .toString()
        .slice(0, 7);
      expect(a.line).toBe(
        `Demo: \`${A}\` · matches all 2 steps · recorded at \`${headSha}\``,
      );
      expect((await bytes(out.aGif)).subarray(0, 6).toString("latin1")).toMatch(
        /^GIF8[79]a$/,
      );
      const report = JSON.parse(
        (await bytes("docs/order-report.json")).toString(),
      );
      expect(report.outcome).toBe("complete");
      // Written in the served words, as keep writes it.
      expect(typeof report.provenance.videoId).toBe("string");
      expect("takeId" in report.provenance).toBe(false);
      // A throwaway library: the user's was never touched, and every temp
      // folder refresh made was removed.
      expect(await readdir(home)).toEqual([]);
      expect(lines.some((l) => l.includes("was not removed"))).toBe(false);
      // The premise: refresh made a home and an output folder in the
      // system's temp for each of the two scales it filmed.
      expect(lines.some((l) => l.startsWith("refresh: running"))).toBe(true);
      expect(madeDirs, JSON.stringify(madeDirs)).toHaveLength(4);
      for (const dir of madeDirs)
        expect(dir).toMatch(
          new RegExp(`^${tmpdir()}/demoman-refresh-(home-)?[A-Za-z0-9]{6}$`),
        );
      expect(madeDirs.filter((dir) => existsSync(dir))).toEqual([]);
    },
    BOTH_MS,
  );
};

/** The unchanged reading, then the slower app's, which is measured against it. */
export const unchangedThenSlower = () => {
  it(
    "leaves an unchanged picture byte for byte as it was",
    async () => {
      const before = await Promise.all(Object.values(out).map(bytes));
      const r = await refresh();
      expect(
        r.videos.map((v) => v.outcome),
        JSON.stringify(r),
      ).toEqual(["unchanged", "unchanged"]);
      // The premise: sameScreens answered same for the judged output
      // alone, over k of n page screens recorded from a real run, each the
      // page at CSS 1x, with the look beside them.
      for (const name of [A, B]) {
        const { screens } = await keptOf(name);
        expect(screens.look, name).toMatch(/^[0-9a-f]+$/);
        const dir = join(repo, RECEIPT_DIR, screensDirOf(keptFileName(name)));
        for (const sc of settled(screens)) {
          const png = await readFile(join(dir, screenImageName(sc.step)));
          expect(pngSize(png), `${name} ${screenImageName(sc.step)}`).toEqual({
            width: 1280,
            height: 800,
          });
        }
        const m = byName(r, name).detail.match(
          /^docs\/\w+\.mp4: at most [\d.]+% sharply and [\d.]+% faintly of the picture changed, over (\d+) of (\d+) screens(; .+)?$/,
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
      // The premise: the app answers the click through a request, not a
      // timer.
      expect(SLOW).toContain(`fetch("${SLOW_PATH}")`);
      expect(SLOW).not.toContain("setTimeout");
      const fast = gaps.filter((g) => g.name === B).length;
      const held = slowHeld.length;
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
      // The premise: the server held the answer the full 600 ms, once for
      // each video's click.
      const heldNow = slowHeld.slice(held);
      expect(heldNow.length, JSON.stringify(heldNow)).toBeGreaterThanOrEqual(2);
      for (const ms of heldNow)
        expect(ms, JSON.stringify(heldNow)).toBeGreaterThanOrEqual(
          SLOW_ANSWER_MS - 5,
        );
      const bGaps = gaps.filter((g) => g.name === B);
      const [before, now] = [
        bGaps[fast - 1],
        bGaps[fast],
      ] as (typeof gaps)[0][];
      // The premise: the settle waited for that request. The screen after
      // the click settled in both videos, and its wait grew by most of the
      // 600 ms.
      const evidence = JSON.stringify([before?.clickScreen, now?.clickScreen]);
      expect(before?.clickScreen?.unsettled, evidence).toBeUndefined();
      expect(now?.clickScreen?.unsettled, evidence).toBeUndefined();
      expect(
        (now?.clickScreen?.waitedMs ?? 0) -
          (before?.clickScreen?.waitedMs ?? 0),
        evidence,
      ).toBeGreaterThan(400);
      // The premise: the page stopped moving after the first click later
      // than in the video before it, by most of the 600 ms, and neither
      // video's gap sits near the camera's line.
      expect(
        (now?.settle as number) - (before?.settle as number),
        JSON.stringify(gaps),
      ).toBeGreaterThan(300);
      for (const g of [before, now])
        expect(clearOfLine(g?.gaps[0] as number), JSON.stringify(g)).toBe(true);
    },
    BOTH_MS,
  );
};

/** One digit changed, then restored. */
export const oneDigit = () => {
  it(
    "a one-digit change reads changed",
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
        settled(screens).some((sc) => sc.step !== null),
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
      expect(a.outcome, JSON.stringify(r)).toBe("changed");
      expect(a.detail).toMatch(
        /% of the picture changed sharply before step \d+, over /,
      );
      // And back: the digit restored reads changed too, a second reading.
      const back = byName(await refresh([A]), A);
      noiseLine("one digit, back", back.detail);
      expect(back.outcome, back.detail).toBe("changed");
    },
    BOTH_MS,
  );
};

/** Where `.local-time` sits on the page at 1280x800, and the pixels at which
 *  two PNG screens differ (their bounding box and count), decoded in a work
 *  page. */
async function localTimeRect(page: string) {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    await work.page.setViewportSize({ width: 1280, height: 800 });
    await work.page.setContent(page);
    return await work.page.$eval(".local-time", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  } finally {
    await work.page.close();
  }
}
async function differing(a: Buffer, b: Buffer) {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    return await work.page.evaluate(
      async ([x, y]) => {
        const pixels = async (base64: string) => {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes]));
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
          ctx.drawImage(bmp, 0, 0);
          return ctx.getImageData(0, 0, bmp.width, bmp.height);
        };
        const [p, q] = [await pixels(x as string), await pixels(y as string)];
        if (p.width !== q.width || p.height !== q.height)
          return { sizes: [p.width, p.height, q.width, q.height] };
        let [x0, y0, x1, y1, n]: [number, number, number, number, number] = [
          p.width,
          p.height,
          -1,
          -1,
          0,
        ];
        for (let i = 0; i < p.data.length; i += 4) {
          if (
            p.data[i] === q.data[i] &&
            p.data[i + 1] === q.data[i + 1] &&
            p.data[i + 2] === q.data[i + 2]
          )
            continue;
          const [px, py] = [(i / 4) % p.width, Math.floor(i / 4 / p.width)];
          [x0, y0, x1, y1, n] = [
            Math.min(x0, px),
            Math.min(y0, py),
            Math.max(x1, px),
            Math.max(y1, py),
            n + 1,
          ];
        }
        return { n, x0, y0, x1, y1, width: p.width };
      },
      [a.toString("base64"), b.toString("base64")],
    );
  } finally {
    await work.page.close();
  }
}

/** Records A of `page` with nothing to compare against, so the committed
 *  screens are that page's; returns its opening page screen's image. */
async function firstScreenOf(page: string) {
  html = page;
  const file = keptFileName(A);
  await rm(join(repo, RECEIPT_DIR, file), { force: true });
  await rm(join(repo, RECEIPT_DIR, screensDirOf(file)), {
    recursive: true,
    force: true,
  });
  const r = await refresh([A]);
  expect(byName(r, A).outcome, JSON.stringify(r)).toBe("uncompared");
  const { receipt } = await readKeptV2(repo, `${KEPT_DIR}/${file}`);
  const dir = join(repo, RECEIPT_DIR, screensDirOf(file));
  const screen = receipt.screens?.screens[0];
  return {
    image: await readFile(join(dir, screenImageName(screen?.step ?? null))),
    names: await readdir(dir),
    screen,
  };
}

/** DEM-138: 4 characters of 12px grey text, in the app's own page. */
export const smallGreyText = () => {
  // DEM-138: read "unchanged" while refresh compared 1280-wide drawn
  // screens; the page at CSS 1x sees it (spec 2026-11-10).
  it(
    "a small grey text change reads changed (DEM-138)",
    async () => {
      await leavingRepo(async () => {
        // The premise: the two pages differ only in the digits of one span.
        expect(LOCAL_TIME_WAS).not.toBe(LOCAL_TIME_NOW);
        expect(LOCAL_TIME_WAS.replace("14:11", "05:00")).toBe(LOCAL_TIME_NOW);
        const was = await firstScreenOf(LOCAL_TIME_WAS);
        const now = await firstScreenOf(LOCAL_TIME_NOW);
        // Leave the committed screens as the first page's: what refresh reads.
        await firstScreenOf(LOCAL_TIME_WAS);
        // The premise: both opening screens settled, and are the page itself
        // at CSS 1x, so the span's page rect is its rect on the image.
        expect(was.screen, JSON.stringify(was.screen)).toEqual({ step: 0 });
        expect(now.screen, JSON.stringify(now.screen)).toEqual({ step: 0 });
        const rect = await localTimeRect(LOCAL_TIME_WAS);
        expect(
          rect.x >= 0 &&
            rect.y >= 0 &&
            rect.x + rect.width <= 1280 &&
            rect.y + rect.height <= 800,
          `the span is in view: ${JSON.stringify(rect)}`,
        ).toBe(true);
        const d = await differing(was.image, now.image);
        expect("n" in d, `images differ in size: ${JSON.stringify(d)}`).toBe(
          true,
        );
        // Narrows for the checker what the line above asserted: the reply
        // is the diff, not the two sizes.
        if (d.n === undefined || d.width === undefined) {
          throw new Error(`images differ in size: ${JSON.stringify(d)}`);
        }
        expect(d.width, "the page at 1x").toBe(1280);
        // The premise: the two kept screen images differ, and only inside
        // the span's rect (1 px for its glyphs' antialiasing).
        const box = {
          x0: rect.x,
          y0: rect.y,
          x1: rect.x + rect.width,
          y1: rect.y + rect.height,
        };
        const evidence = JSON.stringify({ d, box, names: was.names });
        expect(d.n, evidence).toBeGreaterThan(0);
        expect(d.x0, evidence).toBeGreaterThanOrEqual(box.x0 - 1);
        expect(d.y0, evidence).toBeGreaterThanOrEqual(box.y0 - 1);
        expect(d.x1, evidence).toBeLessThanOrEqual(box.x1 + 1);
        expect(d.y1, evidence).toBeLessThanOrEqual(box.y1 + 1);
        html = LOCAL_TIME_NOW;
        const r = await refresh([A]);
        const a = byName(r, A);
        noiseLine("small grey text", a.detail);
        expect(a.outcome, `${a.detail} | ${JSON.stringify(r)}`).toBe("changed");
        expect(a.detail).toMatch(
          /% of the picture changed \w+ (before step \d+|on the final screen), over the [\d.]+% allowed/,
        );
      }).finally(() => {
        html = ORIGINAL;
      });
    },
    GREY_TEXT_MS,
  );
};

/** Each colour restyle, then restored. */
export const restyles = () => {
  for (const restyle of RESTYLES) {
    it(
      `a colour restyle reads changed: ${restyle.name}`,
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
        expect(a.outcome, JSON.stringify(r)).toBe("changed");
        expect(a.detail).toMatch(restyle.where);
        // And back to the committed colours, a second reading.
        const back = byName(await refresh([A]), A);
        noiseLine(`${restyle.name}, back`, back.detail);
        expect(back.outcome, back.detail).toBe("changed");
      },
      BOTH_MS,
    );
  }
};

/** A video of its own with a short ending. */
export const shortEnding = () => {
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
        expect(first.outcome, first.detail).toBe("uncompared");
        // The premise: both recordings' final screens settled, so the final
        // screen is compared (the slower one's, from its page screens).
        const final = (sc: PageScreens) =>
          settled(sc).some((x) => x.step === null);
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
        // The page screens': an unchanged refresh exports no MP4.
        const slower = exported.find((e) => e.fileType === "screens")
          ?.screens as PageScreens | undefined;
        expect(slower && final(slower), JSON.stringify(exported)).toBe(true);
        expect(v.outcome, v.detail).toBe("unchanged");
      });
    },
    BOTH_MS,
  );
};

/** A video of its own kept as a GIF alone. */
export const gifAlone = () => {
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
        expect(first.outcome, first.detail).toBe("uncompared");
        // The premise: the GIF is the output judged, and it has screens.
        const { screens } = await keptOf(name);
        expect(
          settled(screens).length,
          JSON.stringify(screens),
        ).toBeGreaterThan(1);
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
};

/** Videos that cannot be compared, from the first film. */
export const compareFailures = () => {
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

  // Review Focus 5, recorded for real: a receipt from before page screens
  // is compared with nothing, never read as "unchanged", and says so.
  it(
    "replaces once a video whose receipt predates page screens, saying so",
    async () => {
      const receiptFile = `${RECEIPT_DIR}/${keptFileName(B)}`;
      const v3 = JSON.parse((await bytes(receiptFile)).toString());
      // The premise: the receipt was version 3, and is made version 2 as a
      // version 2 receipt was written: moments and a size, no page screens.
      expect(v3.receiptVersion).toBe(3);
      await writeFile(
        join(repo, receiptFile),
        JSON.stringify({
          ...v3,
          receiptVersion: 2,
          screensSize: { width: 1280, height: 927 },
          screens: {
            steps: v3.screens.steps,
            moments: [{ step: null, ms: 1 }],
          },
        }),
      );
      const r = await refresh([B]);
      const b = byName(r, B);
      expect(b.outcome, JSON.stringify(r)).toBe("added");
      expect(b.notes).toEqual([`${receiptFile} predates page screens`]);
      expect(b.detail).toBe("recorded again and not compared");
      expect(b.sameAs).toBeNull();
      expect(b.outputs).toContain(out.bMp4);
      expect(b.outputs).toContain(receiptFile);
      expect(JSON.parse((await bytes(receiptFile)).toString())).toMatchObject({
        receiptVersion: 3,
        video: b.video,
      });
    },
    ONE_MS,
  );
};

/** Replaces and failures in a chain: each reads the page and the committed
 *  files the one before it left. */
export const replaceChain = () => {
  it(
    "reads a change seen only on the final screen as changed",
    async () => {
      // The premise: the change is in a panel that is off-screen until the
      // last step opens it, and the page really changed.
      expect(ORIGINAL).toContain(PANEL_CSS);
      expect(ORIGINAL.split(PANEL_BG).length).toBe(2);
      expect(PANEL_CHANGED).not.toContain(PANEL_BG);
      html = PANEL_CHANGED;
      const r = await refresh([A]);
      expect(byName(r, A).outcome, JSON.stringify(r)).toBe("changed");
      expect(byName(r, A).detail).toMatch(
        /% of the picture changed \w+ on the final screen, over /,
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
      expect(a.outcome, JSON.stringify(r)).toBe("changed");
      // Judged by its MP4 alone, and the GIF went with it.
      expect(a.detail).toContain(out.aMp4);
      expect(a.detail).not.toContain(out.aGif);
      expect(a.outputs).toContain(out.aGif);
      for (const [i, b] of (await both()).entries())
        expect(b.equals(before[i] as Buffer)).toBe(false);
    },
    // Two refreshes, as a two-video case is.
    BOTH_MS,
  );

  it(
    "writes the receipt's screens when it changes, and lists it, never the recipe",
    async () => {
      const file = `${KEPT_DIR}/${keptFileName(A)}`;
      const receiptFile = `${RECEIPT_DIR}/${keptFileName(A)}`;
      const recipe = await bytes(file);
      const before = await screensCopy(A);
      html = PANEL_CHANGED.replace(HEADING, "<h1>Overdue invoices</h1>");
      expect(html).not.toContain(HEADING);
      exported.length = 0;
      const r = await refresh([A]);
      expect(byName(r, A).outcome, JSON.stringify(r)).toBe("changed");
      expect(byName(r, A).outputs).toContain(receiptFile);
      expect(byName(r, A).outputs).not.toContain(file);
      expect((await bytes(file)).equals(recipe)).toBe(true);
      // The receipt records the take's page screens, which decided.
      const judged = exported.find((e) => e.fileType === "screens");
      expect(judged, JSON.stringify(exported)).toBeDefined();
      const after = (await keptOf(A)).screens;
      expect(after).toEqual(judged?.screens);
      // The premise: the receipt's images are the new page's, not the old
      // ones: the opening screen shows the new heading.
      const name = screenImageName(0);
      const dir = join(repo, RECEIPT_DIR, screensDirOf(keptFileName(A)));
      const [was, now] = await Promise.all([
        readFile(join(before.dir, name)),
        readFile(join(dir, name)),
      ]);
      await rm(before.dir, { recursive: true, force: true });
      expect(was.equals(now), name).toBe(false);
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
      ).toEqual(["changed", "changed"]);
      expect(byName(r, A).detail).toMatch(
        /% of the picture changed \w+ (before step \d+|on the final screen), over /,
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
      // The script's own step, as its label says (DEM-61).
      expect(b.detail).toMatch(/^Stopped at script step \d+ of \d+: /);
      expect(b.outputs).toEqual([]);
      expect(b.line).toBeNull();
      expect((await bytes(out.bMp4)).equals(before)).toBe(true);
      // The nav lost a link, so the other video's picture changed too.
      expect(byName(r, A).outcome).toBe("changed");
    },
    BOTH_MS,
  );

  it(
    "fails a replace whose new video has no settled screen, writing nothing",
    async () => {
      // The committed MP4 is gone, so the video is delivered without a
      // comparison, and its new video settled no screen.
      const file = `${KEPT_DIR}/${keptFileName(A)}`;
      const receiptFile = `${RECEIPT_DIR}/${keptFileName(A)}`;
      const mp4 = await bytes(out.aMp4);
      const before = await Promise.all(
        [out.aGif, file, receiptFile].map(bytes),
      );
      await rm(join(repo, out.aMp4));
      injectExport = (v) => {
        if (v.fileType !== "screens") return v;
        const sc = v.screens as PageScreens;
        return {
          ...v,
          screens: {
            ...sc,
            screens: sc.screens.map((x) => ({ ...x, unsettled: "injected" })),
          },
        };
      };
      let r: RefreshResult;
      try {
        r = await refresh([A]);
      } finally {
        injectExport = null;
        await writeFile(join(repo, out.aMp4), mp4);
      }
      const a = byName(r, A);
      expect(a.outcome, JSON.stringify(r)).toBe("failed");
      expect(a.detail).toMatch(
        /^docs\/order\.mp4, the output a refresh judges, has no settled screen to compare against \(0 of \d+ screens settled; before step 1: injected; .*on the final screen: injected\) — a refresh would have nothing to check; nothing was written$/,
      );
      expect(a.outputs).toEqual([]);
      // The premise: the page screens really answered.
      expect(
        exported.some((e) => e.fileType === "screens"),
        JSON.stringify(exported),
      ).toBe(true);
      const after = await Promise.all([out.aGif, file, receiptFile].map(bytes));
      for (const [i, b] of after.entries())
        expect(b.equals(before[i] as Buffer)).toBe(true);
    },
    ONE_MS,
  );

  it(
    "records a degraded run once more, then delivers it with a note (DEM-55)",
    async () => {
      html = ORIGINAL;
      let clean: RunVerdict | undefined;
      let runs = 0;
      inject = (v) => {
        runs += 1;
        clean = runVerdict(v);
        const report = v as unknown as RunReport;
        const degraded = {
          ...report,
          frames: { ...report.frames, degradations: ["budgetBreach" as const] },
        };
        return { ...degraded, summary: verdictLine(degraded) };
      };
      let r: RefreshResult;
      try {
        r = await leavingRepo(() => refresh([A]));
      } finally {
        inject = null;
      }
      // The premise: the run itself was clean.
      expect(clean).toEqual({ kind: "clean" });
      // Red when a forgiven degradation fails the flow, or is not retried.
      expect(runs).toBe(2);
      expect(byName(r, A).outcome).not.toBe("failed");
      expect(byName(r, A).notes.join(" ")).toContain(
        "recorded with problems Demoman could not avoid on this machine: motion frames were skipped to stay inside the frame budget (budgetBreach)",
      );
    },
    ONE_MS,
  );

  it(
    "runs the app's reset before each flow, and a failed reset fails only its flow (DEM-57)",
    async () => {
      html = ORIGINAL;
      const events: string[] = [];
      let resets = 0;
      inject = (v) => {
        events.push("run");
        return v;
      };
      let r: RefreshResult;
      try {
        r = await leavingRepo(() =>
          refreshKept(
            { repoRoot: repo, library: "throwaway", only: [A, B] },
            {
              ...deps(),
              beforeFlow: async () => {
                events.push("reset");
                resets += 1;
                return resets === 1
                  ? { ok: false, detail: "`pnpm reset` exited with code 1" }
                  : { ok: true };
              },
            },
          ),
        );
      } finally {
        inject = null;
      }
      // Red when no reset runs, or a failed one stops the other flows.
      expect(events).toEqual(["reset", "reset", "run"]);
      const failed = r.videos.filter((v) => v.outcome === "failed");
      expect(failed.map((v) => v.detail)).toEqual([
        "reset failed: `pnpm reset` exited with code 1",
      ]);
      expect(r.videos.filter((v) => v.outcome !== "failed")).toHaveLength(1);
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
        expect(lines.filter((l) => l.startsWith("refresh: running"))).toEqual(
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
        [`${KEPT_DIR}/${keptFileName(A)}`, "changed"],
      ]);
      expect(r.videos[0]?.detail).toMatch(
        /^\.demoman\/videos\/broken\.json: script\./,
      );
    },
    ONE_MS,
  );
};

/** A video of its own on an uploaded image. */
export const upload = () => {
  // Ruling R13: keep copies an uploaded image into the repo and names it
  // there (`kept.wallpaper`); a refresh in CI films it from that copy. A
  // soft one (smaller than the zoom needs) is the picture the author kept.
  // Red if refresh stops pointing the script at the repo's copy: the run
  // would read the repo-relative ref from its own empty home, and the
  // export would leave the image out.
  // Ruling R27: the copy is the take's own file, an already-fitted WebP,
  // and the run door owns it byte for byte, so the export reads the bytes
  // keep recorded and an unchanged video stays unchanged. Red if the door
  // re-encodes it: the look is then the re-encode's, never keep's.
  it(
    "films an uploaded image from its copy in the repo, soft or not, and leaves it unchanged after",
    async () => {
      html = ORIGINAL;
      const C = "On an upload";
      const copy = `${KEPT_DIR}/wallpapers/green.webp`;
      const green: [number, number, number] = [0, 160, 80];
      const webp = await webpOf(green);
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
        // The premise: the repo copy is what keep copies, the take's own
        // file — a WebP already within the long side a fit makes.
        const size = webpSize(webp);
        expect(size).toEqual({ width: 640, height: 480 });
        expect(Math.max(640, 480)).toBeLessThanOrEqual(WALLPAPER_LONG_SIDE);
        // The output is read before `withKept` removes it.
        const { r, film, look, again } = await withKept(video, async () => {
          const r = await refresh([C]);
          const film = await bytes("docs/upload.mp4").catch(() => null);
          const look = (await keptOf(C)).screens.look;
          return { r, film, look, again: await refresh([C]) };
        });
        const c = byName(r, C);
        expect(c.outcome, JSON.stringify(r)).toBe("uncompared");
        // The look the export recorded is the one keep records for the
        // take: its branding with the repo copy's own bytes.
        expect(look).toBe(
          lookDigest(
            {
              background: { kind: "image", ref: copy },
              logo: null,
              padding: 0.15,
            },
            { logo: null, wallpaper: fileDigest(webp) },
          ),
        );
        expect((await bytes(copy)).equals(webp)).toBe(true);
        // Nothing changed since: unchanged.
        const second = byName(again, C);
        expect(second.outcome, JSON.stringify(again)).toBe("unchanged");
        // The premise: the render warned soft, and nothing else: the first
        // refresh's page screens and MP4, the unchanged one's page screens.
        // Page screens render nothing, so they say nothing soft.
        expect(
          exported.slice(before).map((e) => [e.fileType, e.wallpaper]),
        ).toEqual([
          ["screens", null],
          ["mp4", "soft"],
          ["screens", null],
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
    ONE_MS * 2,
  );
};

/** An export that left the wallpaper out. */
export const wallpaperLeftOut = () => {
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
      // The page screens are the first export asked for: they say it.
      expect(a.detail).toBe(
        `${out.aMp4}'s page screens would be judged by a look that leaves out its wallpaper: ${said}`,
      );
      const after = await Promise.all([out.aMp4, out.aGif].map(bytes));
      for (const [i, b] of after.entries())
        expect(b.equals(before[i] as Buffer)).toBe(true);
    },
    ONE_MS,
  );
};

/** A look changed outside the window. */
export const lookOutside = () => {
  // The background is judged by its look, not its pixels: a blur that
  // changes only outside the window is a change. Red if the look is not
  // compared, as the window's pixels are the same.
  it(
    "replaces a video whose look changed outside the window",
    async () => {
      html = ORIGINAL;
      const before = await keptOf(B);
      expect(before.screens.look, "premise: a look to compare").toBeDefined();
      const pagesBefore = await screensCopy(B);
      const file = join(repo, KEPT_DIR, keptFileName(B));
      const blurred = {
        ...before,
        script: {
          ...before.script,
          look: {
            branding: {
              ...BRANDING_DEFAULTS,
              background: { ...BRANDING_DEFAULTS.background, blur: 0.5 },
            },
          },
        },
      } as KeptVideo;
      await writeFile(file, serializeKept(blurred));
      const r = await refresh([B]);
      const b = byName(r, B);
      expect(b.outcome, JSON.stringify(r)).toBe("changed");
      expect(b.detail).toBe(
        `${out.bMp4}: the look changed: the background, padding or logo round the window is not the one the committed video was recorded with`,
      );
      // The premise: only the look moved; the pages alone read the same.
      const after = await keptOf(B);
      expect(after.screens.look).not.toBe(before.screens.look);
      const pages = await pagesAlone(pagesBefore, {
        dir: join(repo, RECEIPT_DIR, screensDirOf(keptFileName(B))),
        screens: after.screens,
      });
      await rm(pagesBefore.dir, { recursive: true, force: true });
      expect(pages, JSON.stringify(pages)).toMatchObject({ same: true });
    },
    ONE_MS,
  );
};

/** A video of its own whose logo or upload changes. */
export const logoOrUpload = () => {
  // Ruling R25: an image is in the look by its bytes. A logo or upload
  // replaced in the repo under its own name is a new look, though the
  // window's pixels are the same. Red if the bytes are not digested.
  it(
    "replaces a video whose logo or uploaded image changed under the same name",
    async () => {
      html = ORIGINAL;
      const D = "On a branded upload";
      const logo = `${KEPT_DIR}/logos/acme.svg`;
      const upload = `${KEPT_DIR}/wallpapers/blue.webp`;
      await mkdir(join(repo, KEPT_DIR, "logos"), { recursive: true });
      await mkdir(join(repo, KEPT_DIR, "wallpapers"), { recursive: true });
      await writeFile(join(repo, logo), LOGO_SVG);
      await writeFile(join(repo, upload), await webpOf([30, 60, 200]));
      const base = kept(
        D,
        ["Place order"],
        1,
        [
          {
            path: "docs/branded.mp4",
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
        logo,
        wallpaper: upload,
        script: {
          ...base.script,
          look: {
            branding: {
              background: { kind: "image", ref: upload, blur: 1 },
              logo: { ref: logo, corner: "top-right", size: 0.06, opacity: 1 },
              padding: 0.12,
            },
          },
        },
      };
      try {
        await withKept(video, async () => {
          const first = byName(await refresh([D]), D);
          expect(first.outcome, first.detail).toBe("uncompared");
          for (const [what, path, bytes] of [
            ["logo", logo, LOGO_SVG.replace("#ff00ff", "#00ffff")],
            ["upload", upload, await webpOf([200, 60, 30])],
          ] as const) {
            const before = await keptOf(D);
            const pagesBefore = await screensCopy(D);
            await writeFile(join(repo, path), bytes);
            const r = byName(await refresh([D]), D);
            expect(r.outcome, `${what}: ${r.detail}`).toBe("changed");
            expect(r.detail, what).toBe(
              "docs/branded.mp4: the look changed: the background, padding or logo round the window is not the one the committed video was recorded with",
            );
            // The premise: the same files by name, the pages alone the same,
            // and only the look moved.
            const after = await keptOf(D);
            expect([after.logo, after.wallpaper], what).toEqual([logo, upload]);
            expect(after.screens.look, what).not.toBe(before.screens.look);
            const pages = await pagesAlone(pagesBefore, {
              dir: join(repo, RECEIPT_DIR, screensDirOf(keptFileName(D))),
              screens: after.screens,
            });
            await rm(pagesBefore.dir, { recursive: true, force: true });
            expect(pages, `${what}: ${JSON.stringify(pages)}`).toMatchObject({
              same: true,
            });
          }
        });
      } finally {
        for (const dir of ["logos", "wallpapers"])
          await rm(join(repo, KEPT_DIR, dir), { recursive: true, force: true });
      }
    },
    BOTH_MS,
  );
};

/** The fixture's guard, last: every two-click gap this file filmed. */
export const clickGuard = () => {
  it("keeps every click clear of the pan-or-pull-back line", () => {
    // Tests no production code: it fails when a fixture edit moves a gap
    // between clicks onto `returnsBetween`'s line (spec decision 5).
    // The premise: the file filmed a video with two clicks (its first film
    // does, and the files that run this guard all start with it).
    const withGap = gaps.filter((g) => g.gaps.length > 0);
    expect(withGap.length, JSON.stringify(gaps)).toBeGreaterThan(0);
    for (const g of withGap)
      for (const gap of g.gaps)
        expect(
          clearOfLine(gap),
          `${g.name}: a ${gap} ms gap is within 500 ms of ${LINE_MS}`,
        ).toBe(true);
  });
};

/** An app that shows dates relative to now, recorded a day apart (DEM-79):
 *  unpinned it reads changed and says why; pinned it reads unchanged, and a
 *  real change beside the dates still reads changed. */
export const pinnedDates = () => {
  const PINNED = "2026-11-06T09:00:00Z";
  const video = (name: string) =>
    kept(
      name,
      ["Place order"],
      1,
      [
        {
          path: `docs/${name.toLowerCase().replaceAll(" ", "-")}.mp4`,
          fileType: "mp4",
          aspect: "16:9",
          quality: "share",
        },
      ],
      0,
      3500,
    );
  const said = (v: unknown) => JSON.stringify(v);

  it(
    "unpinned, a day apart, reads changed and says the dates may be why",
    async () => {
      const name = "Dated unpinned";
      // Premise: the two days really render different pages.
      const today = Date.now();
      expect(datedPage(today - DAY_MS)).not.toBe(datedPage(today));
      expect(datedPage(today)).toContain('<p id="due">Due ');
      try {
        await withKept(video(name), async () => {
          html = datedPage(today - DAY_MS);
          const first = byName(await refresh([name]), name);
          expect(first.outcome, said(first)).not.toBe("failed");
          html = datedPage(today);
          const second = byName(await refresh([name]), name);
          expect(second.outcome, said(second)).toBe("changed");
          expect(
            second.notes.some((n) => n.includes("DEMOMAN_NOW")),
            said(second),
          ).toBe(true);
        });
      } finally {
        html = ORIGINAL;
      }
    },
    BOTH_MS,
  );

  it(
    "pinned, recorded twice, reads unchanged and its receipt records the pin the run confirmed",
    async () => {
      const name = "Dated pinned";
      try {
        await withKept(video(name), async () => {
          html = datedPage(Date.parse(PINNED));
          const first = byName(await refresh([name], PINNED), name);
          expect(first.outcome, said(first)).not.toBe("failed");
          // The receipt says which instant the committed video shows.
          const { receipt } = await readKeptV2(
            repo,
            `${KEPT_DIR}/${keptFileName(name)}`,
          );
          expect(receipt.pinnedNow, said(receipt)).toBe(PINNED);
          const second = byName(await refresh([name], PINNED), name);
          expect(second.outcome, said(second)).toBe("unchanged");
        });
      } finally {
        html = ORIGINAL;
      }
    },
    BOTH_MS,
  );

  it(
    "pinned, a real change beside the dates reads changed",
    async () => {
      const name = "Dated pinned change";
      try {
        await withKept(video(name), async () => {
          html = datedPage(Date.parse(PINNED));
          const first = byName(await refresh([name], PINNED), name);
          expect(first.outcome, said(first)).not.toBe("failed");
          html = datedPage(Date.parse(PINNED), "<h1>Bills</h1>");
          // Premise: only the heading differs.
          expect(html).not.toBe(datedPage(Date.parse(PINNED)));
          const second = byName(await refresh([name], PINNED), name);
          expect(second.outcome, said(second)).toBe("changed");
          expect(second.notes.join(" "), said(second)).not.toContain(
            "DEMOMAN_NOW",
          );
        });
      } finally {
        html = ORIGINAL;
      }
    },
    BOTH_MS,
  );
};

type Rect = { x: number; y: number; width: number; height: number };
/** `fn`'s answer on `page`, laid out at 1280x800 in a work page. */
async function inPage<T>(page: string, fn: () => T): Promise<T> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    await work.page.setViewportSize({ width: 1280, height: 800 });
    await work.page.setContent(page);
    return await work.page.evaluate(fn);
  } finally {
    await work.page.close();
  }
}
/** The RGB of every pixel of `png` inside `rect`, row by row, decoded in a
 *  work page. */
async function pixelsIn(png: Buffer, rect: Rect): Promise<number[][]> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    const flat = await work.page.evaluate(
      async ([b64, r]) => {
        const bytes = Uint8Array.from(atob(b64 as string), (c) =>
          c.charCodeAt(0),
        );
        const bmp = await createImageBitmap(new Blob([bytes]));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(bmp, 0, 0);
        const { x, y, width, height } = r as Rect;
        return Array.from(
          ctx.getImageData(
            Math.round(x),
            Math.round(y),
            Math.round(width),
            Math.round(height),
          ).data,
        );
      },
      [png.toString("base64"), rect] as const,
    );
    const out: number[][] = [];
    for (let i = 0; i < flat.length; i += 4)
      out.push([flat[i], flat[i + 1], flat[i + 2]] as number[]);
    return out;
  } finally {
    await work.page.close();
  }
}
/** How far into `rect` (from its left) the last pixel darker than mid grey
 *  is; -1 when none is. */
async function inkRight(png: Buffer, rect: Rect): Promise<number> {
  const px = await pixelsIn(png, rect);
  const width = Math.round(rect.width);
  let right = -1;
  for (const [i, [r, g, b]] of px.entries())
    if (
      0.299 * (r as number) + 0.587 * (g as number) + 0.114 * (b as number) <
      128
    )
      right = Math.max(right, i % width);
  return right;
}
/** Whether `rgb` is within `by` of `hex` in every channel. */
const near = (rgb: number[] | undefined, hex: string, by = 12) =>
  [1, 3, 5].every(
    (at, i) =>
      Math.abs(
        (rgb?.[i] ?? -99) - Number.parseInt(hex.slice(at, at + 2), 16),
      ) <= by,
  );

/** A video of its own: `steps` after the load, one MP4 at scale 1. */
function own(name: string, steps: Record<string, unknown>[]): KeptVideo {
  const base = kept(name, [], 1, [
    {
      path: `docs/${name.toLowerCase().replaceAll(" ", "-")}.mp4`,
      fileType: "mp4",
      aspect: "16:9",
      quality: "share",
    },
  ]);
  return {
    ...base,
    script: {
      ...base.script,
      steps: [{ do: "waitForLoad" }, ...steps],
    } as KeptVideo["script"],
  };
}
type Video = {
  /** The refresh's answer for the video. */
  v: RefreshVideo;
  /** The folder its page screens were copied to. */
  dir: string;
  /** Its page screens, as the bundle recorded them. */
  screens: (typeof gaps)[0]["screens"];
};
/** Records `video` on each page in turn, one refresh each, with nothing
 *  committed before the first: each refresh's answer, page screens and
 *  their images. */
async function recordOn(video: KeptVideo, pages: string[]): Promise<Video[]> {
  const out: Video[] = [];
  try {
    await withKept(video, async () => {
      for (const page of pages) {
        html = page;
        const [runs, shots] = [gaps.length, exported.length];
        const r = await refresh([video.name]);
        const set = exported
          .slice(shots)
          .filter((e) => e.fileType === "screens")
          .at(-1);
        const run = gaps.slice(runs).at(-1);
        if (set?.dir == null || run === undefined)
          throw new Error(
            `no page screens from the refresh: ${JSON.stringify(r)}`,
          );
        out.push({
          v: byName(r, video.name),
          dir: set.dir,
          screens: run.screens,
        });
      }
    });
  } finally {
    html = ORIGINAL;
  }
  return out;
}
const finalScreen = (v: Video) => readFile(join(v.dir, screenImageName(null)));

/** DEM-139: a focused field's blinking caret. Red without the caret style
 *  (PAGE_CAPTURE_HOLD): the final screen differs at the caret. */
export const caret = () => {
  it(
    "a focused field with a blinking caret reads unchanged (DEM-139)",
    async () => {
      // The premise: a capture without the caret style differs between the
      // two pages, and only inside the field (the caret). A work page's
      // capture, not the video's: it shows the forcing works, not that a
      // video's capture would catch the caret in its drawn phase.
      const shot = (page: string) =>
        inPage(page, () => {
          (document.getElementById("search") as HTMLInputElement).focus();
          const r = (
            document.getElementById("search") as HTMLElement
          ).getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }).then(async (field) => {
          const work = await session.openWorkPage();
          if (!work.ok) throw new Error(work.detail);
          try {
            await work.page.setViewportSize({ width: 1280, height: 800 });
            await work.page.setContent(page);
            await work.page.focus("#search");
            return {
              field,
              png: await work.page.screenshot({ caret: "initial" }),
            };
          } finally {
            await work.page.close();
          }
        });
      const [on, off] = [await shot(CARET_ON), await shot(CARET_OFF)];
      const d = await differing(on.png, off.png);
      const f = on.field;
      const evidence = JSON.stringify({ d, field: f });
      expect("n" in d && (d.n ?? 0) > 0, evidence).toBe(true);
      if (!("n" in d)) return;
      expect(d.x0, evidence).toBeGreaterThanOrEqual(f.x);
      expect(d.x1, evidence).toBeLessThanOrEqual(f.x + f.width);
      expect(d.y0, evidence).toBeGreaterThanOrEqual(f.y);
      expect(d.y1, evidence).toBeLessThanOrEqual(f.y + f.height);
      const [, again] = await recordOn(
        own("Caret", [{ do: "click", on: { stableId: "search" } }]),
        [CARET_ON, CARET_OFF],
      );
      noiseLine("caret", again?.v.detail ?? "");
      expect(again?.v.outcome, again?.v.detail).toBe("unchanged");
      // The premise: the final screen, the field focused, was compared.
      expect(again?.v.detail).toMatch(/over 3 of 3 screens$/);
    },
    BOTH_MS,
  );
};

/** A chip the resting pointer hovers, its fill arriving over `HOVER_MS`.
 *  Red without the finite-animation condition: the screen is taken with
 *  the fill on its way. */
export const hover = () => {
  it(
    "an element hovered by the resting pointer reads unchanged",
    async () => {
      expect(HOVER).toContain(`transition: background-color ${HOVER_MS}ms`);
      const [one, two] = (await recordOn(
        own("Hover", [{ do: "hover", on: { stableId: "tip" } }]),
        [HOVER, HOVER],
      )) as [Video, Video];
      noiseLine("hover", two.v.detail);
      expect(two.v.outcome, two.v.detail).toBe("unchanged");
      expect(two.v.detail).toMatch(/over 3 of 3 screens$/);
      // The premise: both final screens show the chip's fill all the way
      // arrived, at its centre (260 + 16, 748 + 16).
      for (const v of [one, two]) {
        const [px] = await pixelsIn(await finalScreen(v), {
          x: 276,
          y: 764,
          width: 1,
          height: 1,
        });
        expect(near(px, HOVER_FILL, 1), JSON.stringify(px)).toBe(true);
      }
    },
    BOTH_MS,
  );
};

/** DEM-73's fixture: a spinner that never stops, on every screen, half a
 *  turn apart in the two videos. Red without the hold at the start: the
 *  spinner's angle differs. */
export const spinner = () => {
  it(
    "a spinner beside static content reads unchanged, and a change beside it changed",
    async () => {
      // The premise: the spinner is on the page, in view.
      expect(SPINNER).toContain('<div id="spin"></div></main>');
      const spin = await inPage(PENDING(3), () => {
        const r = (
          document.getElementById("spin") as HTMLElement
        ).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      expect(
        spin.x >= 0 &&
          spin.y >= 0 &&
          spin.x + spin.width <= 1280 &&
          spin.y + spin.height <= 800,
        JSON.stringify(spin),
      ).toBe(true);
      // The premise: at the same moment, the second page's spinner is
      // about half its 800 ms turn ahead of the first's.
      const phase = (page: string) =>
        inPage(page, () =>
          Number(
            (document.getElementById("spin") as HTMLElement).getAnimations()[0]
              ?.currentTime,
          ),
        );
      const ahead = (await phase(PENDING_SHIFTED)) - (await phase(PENDING(3)));
      expect(ahead, `${ahead} ms`).toBeGreaterThan(SPIN_SHIFT_MS - 150);
      expect(ahead, `${ahead} ms`).toBeLessThan(SPIN_SHIFT_MS + 150);
      const videos = await recordOn(
        own("Spinner", [{ do: "click", on: { text: "Place order" } }]),
        [PENDING(3), PENDING_SHIFTED, PENDING(4)],
      );
      const [first, same, changed] = videos as [Video, Video, Video];
      // The premise: the spinner was running at every capture, so every
      // screen held it.
      for (const v of videos)
        expect(
          v.screens.map((s) => s.heldAnimations),
          JSON.stringify(v.screens),
        ).toEqual([1, 1, 1]);
      expect(first.v.outcome).toBe("uncompared");
      noiseLine("spinner", same.v.detail);
      expect(same.v.outcome, same.v.detail).toBe("unchanged");
      expect(same.v.detail).toMatch(/over 3 of 3 screens$/);
      noiseLine("spinner, a digit beside it", changed.v.detail);
      expect(changed.v.outcome, changed.v.detail).toBe("changed");
    },
    BOTH_MS,
  );
};

/** An answer streamed over 1.5 s. Red without the in-flight condition: the
 *  screen is taken in the pause before the first word. */
export const stream = () => {
  it(
    "the screen after a streamed answer is the finished answer, unchanged",
    async () => {
      // The premise: a pause longer than the beat before the first word,
      // and the words after it inside the beat.
      expect(STREAM_FIRST_MS).toBeGreaterThan(STEP_QUIET_MS);
      expect(
        (STREAM_MS - STREAM_FIRST_MS) / (STREAM_WORDS.length - 1),
      ).toBeLessThan(STEP_QUIET_MS);
      const full = STREAM_WORDS.join(" ");
      const text = await inPage(
        STREAM.replace(
          'overflow: hidden"></div>',
          `overflow: hidden">${full}</div>`,
        ),
        () => {
          const range = document.createRange();
          range.selectNodeContents(document.getElementById("answer") as Node);
          const r = range.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        },
      );
      // The premise: the whole answer fits its box on this platform's
      // fonts, so where the ink ends is where the answer ends.
      expect(
        text.x + text.width,
        `the answer spans ${JSON.stringify(text)} in a box ending at ${ANSWER.x + ANSWER.width}`,
      ).toBeLessThan(ANSWER.x + ANSWER.width - 20);
      const from = streamed.length;
      const videos = await recordOn(
        own("Stream", [{ do: "click", on: { text: "Ask" } }]),
        [STREAM, STREAM],
      );
      const two = videos[1] as Video;
      noiseLine("stream", two.v.detail);
      expect(two.v.outcome, two.v.detail).toBe("unchanged");
      expect(two.v.detail).toMatch(/over 3 of 3 screens$/);
      // The premise: each video's stream took its 1.5 s, and was still open
      // when the click returned: the settle after it waited most of it.
      const took = streamed.slice(from);
      expect(took.length, JSON.stringify(took)).toBe(2);
      for (const ms of took) expect(ms).toBeGreaterThanOrEqual(STREAM_MS - 5);
      for (const v of videos) {
        const after = v.screens.find((s) => s.after === 2);
        // The picture: the ink ends where the whole answer ends.
        const right = await inkRight(await finalScreen(v), ANSWER);
        expect(
          Math.abs(ANSWER.x + right + 1 - (text.x + text.width)),
          `ink ends at ${ANSWER.x + right + 1}; the whole answer at ${text.x + text.width}; ${JSON.stringify(v.screens)}`,
        ).toBeLessThanOrEqual(3);
        expect(after?.unsettled, JSON.stringify(v.screens)).toBeUndefined();
        expect(after?.waitedMs, JSON.stringify(v.screens)).toBeGreaterThan(
          STREAM_FIRST_MS,
        );
      }
    },
    BOTH_MS,
  );
};

/** DEM-176: a click whose result waits on a lazily loaded module. Red while
 *  only fetch and XHR count as in flight: the screen is taken before the
 *  module arrives, with the panel still empty. */
export const lazyModule = () => {
  it(
    "the screen after a click that loads code is the page the code drew, unchanged (DEM-176)",
    async () => {
      // The premise: the module is held longer than the beat.
      expect(LAZY_MS).toBeGreaterThan(STEP_QUIET_MS);
      // The premise: the element the module writes to is the one in the
      // box the screens are read in (the base page has a `#panel` of its
      // own, off screen), and its line leaves more than 40 px of ink there.
      const drawn = await inPage(
        LAZY.replace(
          'overflow: hidden"></div>',
          `overflow: hidden">${LAZY_TEXT}</div>`,
        ),
        () => {
          const range = document.createRange();
          range.selectNodeContents(document.getElementById("opened") as Node);
          const r = range.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width };
        },
      );
      expect(drawn.x, JSON.stringify(drawn)).toBe(ANSWER.x);
      expect(drawn.y, JSON.stringify(drawn)).toBeGreaterThanOrEqual(ANSWER.y);
      expect(drawn.width, JSON.stringify(drawn)).toBeGreaterThan(40);
      const from = lazyHeld.length;
      const videos = await recordOn(
        own("Lazy module", [{ do: "click", on: { stableId: "open" } }]),
        [LAZY, LAZY],
      );
      const two = videos[1] as Video;
      noiseLine("lazy module", two.v.detail);
      expect(two.v.outcome, two.v.detail).toBe("unchanged");
      expect(two.v.detail).toMatch(/over 3 of 3 screens$/);
      // The premise: each video's click loaded the module, held its time.
      const took = lazyHeld.slice(from);
      expect(took.length, JSON.stringify(took)).toBeGreaterThanOrEqual(2);
      for (const ms of took) expect(ms).toBeGreaterThanOrEqual(LAZY_MS - 5);
      for (const v of videos) {
        // The picture: the panel is empty on the opening screen and holds
        // the module's line on the final one.
        const opening = await readFile(join(v.dir, screenImageName(0)));
        expect(await inkRight(opening, ANSWER)).toBe(-1);
        expect(
          await inkRight(await finalScreen(v), ANSWER),
          JSON.stringify(v.screens),
        ).toBeGreaterThan(40);
        const after = v.screens.find((s) => s.after === 2);
        expect(after?.unsettled, JSON.stringify(v.screens)).toBeUndefined();
        expect(after?.waitedMs, JSON.stringify(v.screens)).toBeGreaterThan(
          LAZY_MS - STEP_QUIET_MS,
        );
      }
    },
    BOTH_MS,
  );
};

/** A toast that slides in over 600 ms. Red without the finite-animation
 *  condition: the screen is taken mid-slide. */
export const toast = () => {
  it(
    "a toast that slides in is on the final screen in both videos",
    async () => {
      expect(TOAST_MS).toBeGreaterThan(STEP_QUIET_MS);
      const rest = await inPage(
        TOAST.replace(
          '<div id="toasts"></div>',
          '<div id="toasts"><div class="toast" style="animation: none">Saved</div></div>',
        ),
        () => {
          const r = (
            document.querySelector(".toast") as HTMLElement
          ).getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        },
      );
      expect(rest).toEqual(TOAST_REST);
      const videos = await recordOn(
        own("Toast", [{ do: "click", on: { text: "Save" } }]),
        [TOAST, TOAST],
      );
      const two = videos[1] as Video;
      noiseLine("toast", two.v.detail);
      expect(two.v.outcome, two.v.detail).toBe("unchanged");
      expect(two.v.detail).toMatch(/over 3 of 3 screens$/);
      for (const v of videos) {
        // Both ends of the toast at rest, in its padding.
        const y = TOAST_REST.y + TOAST_REST.height / 2;
        const png = await finalScreen(v);
        const left = await pixelsIn(png, {
          x: TOAST_REST.x + 4,
          y,
          width: 1,
          height: 1,
        });
        const right = await pixelsIn(png, {
          x: TOAST_REST.x + TOAST_REST.width - 6,
          y,
          width: 1,
          height: 1,
        });
        expect(
          near(left[0], TOAST_FILL) && near(right[0], TOAST_FILL),
          `left ${JSON.stringify(left)} right ${JSON.stringify(right)}; ${JSON.stringify(v.screens)}`,
        ).toBe(true);
      }
    },
    BOTH_MS,
  );
};

/** A search that filters once typing stops for 150 ms. Red if the beat is
 *  below the debounce: the screen is taken before the filter. */
export const debounce = () => {
  it(
    "a debounced search's screen is the filtered list, unchanged",
    async () => {
      const rows = await inPage(
        DEBOUNCE,
        () =>
          [...document.querySelectorAll("#rows tr")].filter((tr) =>
            (tr.textContent ?? "").includes("Acme"),
          ).length,
      );
      // The premise: the search leaves one row of ten, and its delay is
      // inside the beat.
      expect(rows).toBe(1);
      expect(DEBOUNCE_MS).toBeLessThan(STEP_QUIET_MS);
      const videos = await recordOn(
        own("Debounce", [
          { do: "type", into: { stableId: "search" }, text: "Acme" },
        ]),
        [DEBOUNCE, DEBOUNCE],
      );
      const two = videos[1] as Video;
      noiseLine("debounce", two.v.detail);
      expect(two.v.outcome, two.v.detail).toBe("unchanged");
      expect(two.v.detail).toMatch(/over 3 of 3 screens$/);
      // The picture: in each video the final screen has lost nine rows
      // against the opening. The typed word alone changed 3,106 when the
      // screen was taken before the filter (measured 2026-11-11, the beat at
      // 100 ms).
      for (const v of videos) {
        const d = await differing(
          await readFile(join(v.dir, screenImageName(0))),
          await finalScreen(v),
        );
        expect(
          "n" in d ? d.n : 0,
          `${JSON.stringify(d)}; ${JSON.stringify(v.screens)}`,
        ).toBeGreaterThan(100_000);
      }
    },
    BOTH_MS,
  );
};

/** A page whose DOM never goes quiet once the click starts a count. Red if
 *  an unsettled screen is compared (its image is never written) or
 *  forgiven (it goes unnamed). A page that never settles from its load is not a case here:
 *  the run itself fails on it (`pageNeverSettled`). */
export const neverSettles = () => {
  it(
    "a page that never settles names the step, and never reads unchanged on it",
    async () => {
      const videos = await recordOn(
        own("Never settles", [{ do: "click", on: { text: "Place order" } }]),
        [NEVER_AFTER_CLICK, NEVER_AFTER_CLICK],
      );
      const [first, again] = videos as [Video, Video];
      // The premise: before the click the page settled, after it never did.
      for (const v of videos)
        expect(
          v.screens.map((s) => s.unsettled === undefined),
          JSON.stringify(v.screens),
        ).toEqual([true, true, false]);
      // The premise: the count ticks inside the beat, and an unsettled
      // screen's image is never written, so nothing of it can be read.
      expect(TICK_MS).toBeLessThan(STEP_QUIET_MS);
      for (const v of videos)
        expect((await readdir(v.dir)).sort()).toEqual(
          [screenImageName(0), screenImageName(1)].sort(),
        );
      expect(first.v.outcome, first.v.detail).toBe("uncompared");
      // The two settled screens are compared, and the final one is named.
      expect(again.v.outcome, again.v.detail).toBe("unchanged");
      noiseLine("never settles", again.v.detail);
      expect(again.v.detail).toMatch(
        /over 2 of 3 screens; on the final screen: the DOM never went quiet$/,
      );
    },
    BOTH_MS,
  );
};
