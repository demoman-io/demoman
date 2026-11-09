import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  DEGRADATION_WORDS,
  type ExportAnswer,
  type FilmedCode,
  FLOWS_DIR,
  judgedOutput,
  type KeptDeliver,
  type KeptOutput,
  type KeptReceipt,
  type KeptScreens,
  type KeptVideo,
  keptFileName,
  messageOf,
  normaliseName,
  parseFilmedCode,
  prVerdict,
  RECEIPT_DIR,
  RECEIPT_VERSION,
  REFRESH_LIST_FILE,
  type RefreshListEntry,
  type RunReport,
  refreshListOf,
  screensDirOf,
  scriptDigest,
  serializeReceipt,
  serializeRefreshList,
  servedRunReport,
} from "@demoman/run-core";
import type { DemoScript } from "@demoman/scene-schema";
import { type StageTimes, stageTimes } from "../stage-times.js";
import { codeClause, prLine } from "./attach.js";
import type { BrowserSession } from "./browser.js";
import type { ScreensAnswer } from "./export.js";
import {
  filmedAtOf,
  filmedCodeIn,
  libraryAhead,
  place,
  placeFolder,
  readReceiptFile,
  repoPath,
} from "./keep.js";
import { readKeptFlows } from "./kept-flows.js";
import { createLibrary, type Library } from "./library.js";
import { samePicture, sameScreens } from "./same-picture.js";
import type { LocalExecutor } from "./types.js";
import type { VideoStore } from "./videos.js";

export interface RefreshVideo {
  name: string;
  /** The kept file, repo-relative. */
  file: string;
  /** The kept flow's id and route, or null when its file would not read. */
  flow: string | null;
  deliver: KeptDeliver | null;
  /** `changed`: the picture differs from the previous receipt's film.
   *  `added`: the same picture, with an output that did not exist written,
   *  or a version 1 receipt written again with its screen images.
   *  `uncompared`: no previous film to compare against; delivered as new. */
  outcome: "changed" | "added" | "uncompared" | "unchanged" | "failed";
  /** Why it failed (the run's verdict line, or what refused), or what the
   *  comparison found. */
  detail: string;
  /** The repo paths this refresh wrote for the video. */
  outputs: string[];
  /** A delivered video's line for a pull request (`attach`'s), else null. */
  line: string | null;
  /** What a reader must hear even though the video did not fail: no
   *  receipt to compare with, a report not written. */
  notes: string[];
  /** The new film's take id and the code it filmed, once there is a film. */
  video: string | null;
  filmedCode: FilmedCode | null;
  /** For `unchanged` and `added`: the previous receipt's video, which the
   *  picture matched. */
  sameAs: { video: string } | null;
  /** What this refresh wrote, with each output's type and aspect; the
   *  receipt and report are json. */
  files: RefreshListEntry["files"];
  /** The new film's judged-output screens, and its served run report. */
  screens: KeptScreens | null;
  report: unknown | null;
}

export interface RefreshResult {
  videos: RefreshVideo[];
  /** Why the list under --out-dir could not be written; the videos stand. */
  listError?: string;
}

export interface RefreshDeps {
  /** The user's library's reads, for the check that it is ahead of a kept
   *  file (`library: "local"` only). Never filmed into: every refresh films
   *  into a library thrown away after, so a refresh adds no version the
   *  kept file does not name. */
  library: Library;
  videos: VideoStore;
  /** A headless executor filming into `home` (a throwaway library), at the
   *  display `env` names,
   *  exporting into `outDir`, reading accounts from `projectDir`. */
  executor(options: {
    home: string;
    env: NodeJS.ProcessEnv;
    outDir: string;
    projectDir: string;
  }): LocalExecutor;
  /** The browser that decodes outputs to compare them. */
  session: Pick<BrowserSession, "openWorkPage">;
  /** Before each recording (a retry too): the app's reset from app.json,
   *  so one flow's changes never show in the next (DEM-57). */
  beforeFlow?: () => Promise<{ ok: true } | { ok: false; detail: string }>;
  /** The instant the started app was given as DEMOMAN_NOW (DEM-79): every
   *  run's page starts its clock there, and each receipt written says so.
   *  Absent when the repo pins none or no app was started here. */
  pinnedNow?: string;
  /** app.json pins now but this refresh could not use it (--base-url): the
   *  run already says so, so no video is told to set it (code review #6). */
  nowUnused?: boolean;
  /** The picture comparisons, of a decoded film (a version 1 receipt's)
   *  and of screen images; the real ones unless a test stands in. */
  samePicture?: typeof samePicture;
  sameScreens?: typeof sameScreens;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

/** Said beside a video replaced without a pin whose last screen showed
 *  dates (DEM-79): a likely cause, never the certain one. */
export const DATES_NOTE = (samples: string[]): string =>
  `this video shows dates such as ${samples.map((s) => `\`${s}\``).join(", ")}; if they follow today, set \`now\` in .demoman/app.json and read DEMOMAN_NOW in the app: https://demoman.io/docs/reference/app-json#pinned-dates`;

/** The display a device script films on; its own size comes from the
 *  device, so only the scale here matters. */
const DEVICE_DISPLAY = { width: 1280, height: 800 };

type Job = {
  kept: KeptVideo;
  /** What the committed files show: the receipt, else a v1 file's own; null
   *  when there is neither, and the film is delivered uncompared. */
  previous: KeptReceipt | null;
  /** What a note calls `previous`: its receipt, or the v1 file it came from. */
  previousAt: string;
  receiptFile: string;
  file: string;
  script: DemoScript;
  /** What a reader must hear before the film: the library ahead (local
   *  only), no receipt. */
  notes: string[];
  /** Where the committed files are read (the checkout, or `previous` for a
   *  files flow; null when none was given) and where new ones are written. */
  from: string | null;
  to: string;
};

export type RunVerdict =
  | { kind: "clean" }
  | { kind: "degraded"; problems: string[] }
  | { kind: "failed"; detail: string };

/** The degradations that leave a video correct, only less smooth or less
 *  sharp: a soft still, a scroll still moving, motion frames dropped or kept
 *  as stills under load. Any other (a drag or click that may have done
 *  nothing, missing motion) can make the video wrong, so it fails (review
 *  of the DEM-55 branch). */
const FORGIVEN = new Set<string>([
  "stillFailed",
  "scrollUnsettled",
  "budgetBreach",
  "keyframeOnly",
]);
const STILLS_ONLY = "no motion was recorded: the video is its stills only";

/**
 * Whether a run answer can replace a committed video. Clean: complete, never
 * stopped, every step matched, everything stored, nothing degraded.
 * Degraded: all of that, but every degradation is one that leaves the video
 * correct (FORGIVEN), or acting steps recorded no motion; refresh records it
 * once more (DEM-55). Failed: anything else, its detail the answer's own
 * summary plus the degradations in the report's words, so CI says why.
 * Read from the answer, never recomputed.
 */
export function runVerdict(answer: Record<string, unknown>): RunVerdict {
  const r = answer as Omit<
    Partial<RunReport>,
    "outcome" | "frames" | "steps"
  > & {
    outcome?: unknown;
    summary?: unknown;
    reason?: unknown;
    detail?: unknown;
    error?: unknown;
    steps?: Array<{ intent?: { do?: string } }>;
    frames?: { spans?: number; degradations?: string[] };
  };
  if (r.outcome === "refusedBeforeRun")
    return { kind: "failed", detail: `${r.reason}: ${r.detail}` };
  if (r.outcome === "threw")
    return { kind: "failed", detail: `the run threw: ${r.error}` };
  const kinds = [...new Set(r.frames?.degradations ?? [])];
  const problems = kinds.map((k) => {
    const words = (DEGRADATION_WORDS as Record<string, string>)[k];
    return words === undefined ? k : `${words} (${k})`;
  });
  // As compare/numbers.ts: no spans matters only when a step acts.
  const acting = (r.steps ?? []).filter((s) => s.intent?.do !== "pause");
  const starved = r.frames?.spans === 0 && acting.length > 0;
  if (starved) problems.push(STILLS_ONLY);
  const whole =
    r.outcome === "complete" &&
    r.stopped === undefined &&
    r.verdict?.kind === "matches" &&
    r.frames !== undefined &&
    (r.notStored ?? []).length === 0;
  if (whole && kinds.every((k) => FORGIVEN.has(k)))
    return problems.length === 0
      ? { kind: "clean" }
      : { kind: "degraded", problems };
  const line =
    typeof r.summary === "string"
      ? r.summary
      : `the run answered ${JSON.stringify(r.outcome)} with no summary`;
  return {
    kind: "failed",
    detail: problems.length === 0 ? line : `${line} — ${problems.join("; ")}`,
  };
}

/** Records a flow, and once more when the first recording is degraded: on a
 *  busy runner a soft still or a starved screencast is usually a one-off
 *  (DEM-55). Answers the run that stands and its verdict; a second degraded
 *  run stands too, and the caller delivers it with a note. */
export async function recordWithRetry(
  run: () => Promise<Record<string, unknown>>,
  name: string,
  log: (line: string) => void,
): Promise<{ answer: Record<string, unknown>; verdict: RunVerdict }> {
  const first = await run();
  const verdict = runVerdict(first);
  if (verdict.kind !== "degraded") return { answer: first, verdict };
  log(
    `refresh: "${name}" recorded with ${verdict.problems.join("; ")}; trying it once more`,
  );
  const answer = await run();
  const second = runVerdict(answer);
  // A retry that fails keeps the first run, which can still be delivered.
  return second.kind === "failed"
    ? { answer: first, verdict }
    : { answer, verdict: second };
}

/**
 * `demoman refresh`: re-films each kept video's script with no agent,
 * judges the run, renders the judged output's still screens alone and
 * compares them with the previous receipt's images, then exports only what
 * it must write (`filmOne`). A changed or uncompared film replaces every
 * output, the report, the images and the receipt (each by rename from a
 * finished file or folder beside it); the recipe is never written.
 * A video that fails leaves its committed files as they were and says why;
 * the others still refresh.
 */
export async function refreshKept(
  args: {
    repoRoot: string;
    only?: string[];
    baseUrl?: string;
    library: "local" | "throwaway";
    /** Where `files` flows are written, with the list of what was made. */
    outDir?: string;
    /** A folder an earlier `outDir` was kept in: what `files` flows are
     *  compared against. */
    previous?: string;
  },
  deps: RefreshDeps,
): Promise<RefreshResult> {
  const root = resolve(args.repoRoot);
  const rootReal = await realpath(root);
  const videos: RefreshVideo[] = [];
  const failed = (
    who: { name: string; file: string; kept?: KeptVideo },
    detail: string,
    notes: string[] = [],
  ) =>
    videos.push({
      name: who.name,
      file: who.file,
      flow: who.kept?.flow ?? null,
      deliver: who.kept?.deliver ?? null,
      outcome: "failed",
      detail,
      outputs: [],
      line: null,
      notes,
      video: null,
      filmedCode: null,
      sameAs: null,
      files: [],
      screens: null,
      report: null,
    });

  const { entries, duplicates } = await readKeptFlows(root);
  const twice = new Map(
    duplicates.flatMap((d) => d.files.map((f) => [f, d] as const)),
  );
  // Matched as the library matches names, not by file: "add the tasks"
  // asks for "Add a task".
  const asked = args.only?.map(normaliseName);
  const found = new Set<string>();
  // One executor per display: a browser launches at one scale.
  const groups = new Map<string, Job[]>();
  for (const entry of entries) {
    const { file } = entry;
    const n = basename(file);
    // Whether it is one `only` names cannot be told, so it is said.
    if ("unreadable" in entry) {
      failed({ name: n.replace(/\.json$/, ""), file }, entry.unreadable);
      // Its file is the one `only` would name: not also "no kept video".
      found.add(normaliseName(n.replace(/\.json$/, "")));
      continue;
    }
    const { kept, migrated } = entry;
    const slug = normaliseName(kept.name);
    if (asked !== undefined && !asked.includes(slug)) continue;
    found.add(slug);
    const who = { name: kept.name, file, kept };
    const dup = twice.get(file);
    if (dup !== undefined) {
      failed(
        who,
        dup.sameName === true
          ? `${dup.files.join(" and ")} are two different flows with one file name — rename one of the two flows, then refresh again`
          : `${dup.files.join(" and ")} both name the flow ${dup.flow} — delete one of them, then refresh again`,
      );
      continue;
    }
    const toFolder = kept.deliver === "files";
    if (toFolder && args.outDir === undefined) {
      failed(
        who,
        // DEM-99: setup turns the artifact on for the files flows it sees; one
        // added later lands here, so this names the way out.
        "deliver files needs --out-dir <folder>; Demoman's CI workflow passes one only with its artifact, so delete .github/workflows/demoman.yml on the default branch and run `npx demoman setup --ci` again, which turns the artifact on for a files flow",
      );
      continue;
    }
    const to = toFolder ? resolve(args.outDir as string) : root;
    let from: string | null = toFolder
      ? args.previous === undefined
        ? null
        : resolve(args.previous)
      : root;
    // A --previous folder that is not there is "no previous" (the first run
    // of a bucket), said in a note; one that is there and unreadable fails.
    let noPrevious = "no --previous folder was given";
    if (toFolder && from !== null) {
      const gone = from;
      const dir = await stat(gone).then(
        (st) => (st.isDirectory() ? null : "is not a folder"),
        (error: unknown) =>
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : `cannot be read (${messageOf(error)})`,
      );
      if (dir === "missing") {
        noPrevious = `${gone} does not exist, so there was nothing to compare against`;
        from = null;
      } else if (dir !== null) {
        failed(
          who,
          `--previous ${gone} ${dir}, so what was delivered is unknown`,
        );
        continue;
      }
    }
    // A files flow's receipt sits beside its outputs, not under the repo.
    // Named after the recipe's own file, never the flow's current name.
    const receiptFile = toFolder
      ? `${n.replace(/\.json$/, "")}.receipt.json`
      : `${RECEIPT_DIR}/${n}`;
    const outside: string[] = [];
    // A files flow's outputs, report and receipt are bare names (the parser
    // holds them to it); its logo and wallpaper are repo paths, read here.
    for (const p of [
      ...(toFolder
        ? []
        : [
            ...kept.outputs.map((o) => o.path),
            ...(kept.report === null ? [] : [kept.report]),
            receiptFile,
          ]),
      ...(kept.logo === null ? [] : [kept.logo]),
      ...(kept.wallpaper === null ? [] : [kept.wallpaper]),
    ]) {
      const at = await repoPath(root, rootReal, p, "refresh");
      if (typeof at !== "string") outside.push(at.outside);
    }
    if (outside.length > 0) {
      failed(who, outside.join("; "));
      continue;
    }
    const receiptAt = from === null ? null : join(from, receiptFile);
    const had =
      receiptAt === null
        ? ({ missing: true } as const)
        : await readReceiptFile(receiptAt, toFolder ? receiptAt : receiptFile);
    if ("detail" in had) {
      failed(who, `${had.detail}, so what its outputs show is unknown`);
      continue;
    }
    if ("receipt" in had && had.receipt.flow !== kept.flow) {
      failed(
        who,
        `${receiptAt} is the receipt of flow ${had.receipt.flow}, but ${file} keeps flow ${kept.flow}, so what its outputs show is unknown`,
      );
      continue;
    }
    // A v1 file is its own receipt until a refresh writes one beside it.
    const previous = "receipt" in had ? had.receipt : migrated;
    const notes: string[] = [];
    if (args.library === "local") {
      const ahead = await libraryAhead(kept, previous, file, deps);
      if (ahead !== null) notes.push(ahead);
    }
    if (previous === null)
      notes.push(
        receiptAt === null
          ? noPrevious
          : `${toFolder ? receiptAt : receiptFile} is missing`,
      );
    const script = scriptFor(kept, root, args.baseUrl);
    const { width, height } = script.viewport ?? DEVICE_DISPLAY;
    const display = `${width}x${height}@${kept.scale}`;
    groups.set(display, [
      ...(groups.get(display) ?? []),
      {
        kept,
        previous,
        previousAt:
          "receipt" in had
            ? toFolder
              ? (receiptAt as string)
              : receiptFile
            : file,
        receiptFile,
        file,
        script,
        notes,
        from,
        to,
      },
    ]);
  }
  for (const a of args.only ?? []) {
    if (!found.has(normaliseName(a)))
      failed(
        { name: a, file: `${FLOWS_DIR}/${keptFileName(a)}` },
        `the repo has no flow named "${a}"`,
      );
  }

  // Every video is filmed before any file is written, so each one films
  // the checkout as it was.
  const filmed: Filmed[] = [];
  const outDirs: string[] = [];
  try {
    for (const [display, jobs] of groups) {
      const home = await mkdtemp(join(tmpdir(), "demoman-refresh-home-"));
      const outDir = await mkdtemp(join(tmpdir(), "demoman-refresh-"));
      outDirs.push(outDir);
      const executor = deps.executor({
        home,
        env: { ...deps.env, DEMOMAN_DISPLAY: display },
        outDir,
        projectDir: root,
      });
      try {
        for (const job of jobs) {
          const who = { name: job.kept.name, file: job.file, kept: job.kept };
          deps.log(`refresh: running "${job.kept.name}" at ${display}`);
          try {
            const one = await filmOne(job, root, executor, home, deps);
            if ("failed" in one) failed(who, one.failed, job.notes);
            else filmed.push(one);
          } catch (error) {
            failed(who, `refresh threw: ${messageOf(error)}`, job.notes);
          }
        }
      } finally {
        await executor
          .close()
          .catch((error: unknown) =>
            deps.log(
              `refresh: the browser would not close (${messageOf(error)})`,
            ),
          );
        await remove(home, deps);
      }
    }
    for (const one of filmed) {
      try {
        const video = await deliverOne(one, deps);
        one.times.mark("write");
        one.times.note(video.outcome);
        deps.log(one.times.line(`refresh "${one.job.kept.name}"`));
        videos.push(video);
      } catch (error) {
        failed(
          { name: one.job.kept.name, file: one.job.file, kept: one.job.kept },
          `refresh threw: ${messageOf(error)}`,
        );
      }
    }
  } finally {
    for (const dir of outDirs) await remove(dir, deps);
  }
  videos.sort((a, b) => a.file.localeCompare(b.file));
  if (args.outDir !== undefined) {
    const list = join(resolve(args.outDir), REFRESH_LIST_FILE);
    try {
      await place(list, serializeRefreshList(refreshListOf({ videos })));
    } catch (error) {
      return {
        videos,
        listError: `the refresh list ${list} could not be written (${messageOf(error)})`,
      };
    }
  }
  return { videos };
}

/** The kept script as this refresh films it: the logo and an uploaded
 *  wallpaper by their repo paths (the runner reads a relative ref from
 *  DEMOMAN_HOME), and the target at `baseUrl`'s origin when one is given. */
function scriptFor(
  kept: KeptVideo,
  root: string,
  baseUrl?: string,
): DemoScript {
  const script = structuredClone(kept.script);
  const logo = script.look?.branding?.logo;
  if (kept.logo !== null && logo !== undefined && logo !== null)
    logo.ref = join(root, kept.logo);
  const background = script.look?.branding?.background;
  if (kept.wallpaper !== null && background?.kind === "image")
    background.ref = join(root, kept.wallpaper);
  if (baseUrl !== undefined) {
    const t = new URL(script.target);
    script.target = new URL(`${t.pathname}${t.search}${t.hash}`, baseUrl).href;
  }
  return script;
}

async function remove(dir: string, deps: RefreshDeps): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch((error: unknown) =>
    deps.log(`refresh: ${dir} was not removed (${messageOf(error)})`),
  );
}

/** A video filmed clean, judged from its screens, and exported where it
 *  must be written. */
type Filmed = {
  job: Job;
  report: RunReport;
  takeId: string;
  /** Each exported output's new file, by its index in `kept.outputs`. */
  rendered: Map<number, string>;
  /** The judged output's screens render: its screens, the folder of their
   *  images, and the size their windows are measured in. */
  shots: {
    screens: KeptScreens;
    dir: string;
    size: { width: number; height: number };
  };
  /** The comparison's answer: null when there was nothing to compare
   *  against; `failure` when it could not be made. */
  same: boolean | null;
  failure: string | null;
  /** The outputs to write, by index: every one of a new picture, else those
   *  with no committed file. */
  toWrite: number[];
  /** What the comparison found, and what is new. */
  said: string[];
  /** The take's report.json, served; or why it is not had. */
  stored: { value: unknown } | { not: string };
  /** The stored report's dates on its last screen (not served); [] when
   *  none or the report is not had. */
  datesOnScreen: string[];
  /** Wall-clock per stage, said once the video is delivered. */
  times: StageTimes;
};

/**
 * Films the video, renders the judged output's screens alone, and compares
 * them with the previous receipt's images; then exports only what must be
 * written: every output when the picture changed or there was nothing to
 * compare against, else each output with no committed file. A version 1
 * receipt has no images: its comparison is today's, on the judged output's
 * full export, and says so. The comparison is decided here, once; nothing
 * is written until every video is filmed (`deliverOne`).
 */
async function filmOne(
  job: Job,
  root: string,
  executor: LocalExecutor,
  home: string,
  deps: RefreshDeps,
): Promise<Filmed | { failed: string }> {
  const { kept, script, previous, from, receiptFile } = job;
  const times = stageTimes();
  const run = async (): Promise<Record<string, unknown>> => {
    const reset = (await deps.beforeFlow?.()) ?? { ok: true };
    if (!reset.ok)
      return {
        outcome: "refusedBeforeRun",
        reason: "reset failed",
        detail: reset.detail,
      };
    const out = await executor.request("run", {
      script,
      // The kept flow by its id: the throwaway library adopts it, so what
      // the film makes names a flow the repo keeps.
      video: { id: kept.flow },
      project: root,
      // The committed kept file is refresh's input, never its output.
      leaveKept: true,
      ...(deps.pinnedNow === undefined ? {} : { pinnedNow: deps.pinnedNow }),
      // Refresh is the one reader of the last screen's dates.
      readDates: true,
    });
    return out.ok
      ? (out.value as Record<string, unknown>)
      : { outcome: "refusedBeforeRun", reason: out.reason, detail: out.detail };
  };
  const { answer, verdict } = await recordWithRetry(run, kept.name, deps.log);
  // The group's first run includes the browser launch.
  times.mark("record");
  if (verdict.kind === "failed") return { failed: verdict.detail };
  if (verdict.kind === "degraded")
    job.notes.push(
      `recorded with problems Demoman could not avoid on this machine: ${verdict.problems.join("; ")}`,
    );
  const report = answer as unknown as RunReport;
  const takeId = report.provenance.takeId;
  if (takeId === null) return { failed: "the run is clean but made no video" };
  const read = await createLibrary(home).getJson(takeId, "report.json");
  const stored: Filmed["stored"] =
    "value" in read
      ? { value: servedRunReport(read.value as RunReport) }
      : {
          not: `video ${takeId}'s run report ${"missing" in read ? "is missing" : `could not be read (${read.unreadable})`}`,
        };
  if ("not" in stored) deps.log(`refresh: "${kept.name}": ${stored.not}`);
  // Not served, so from the stored report; lost with it, and said above.
  const datesOnScreen =
    "value" in read ? ((read.value as RunReport).datesOnScreen ?? []) : [];
  // The pin reached the run: its own answer records it. A receipt written
  // without that would put a real-date video under a pinned receipt.
  if (deps.pinnedNow !== undefined && report.pinnedNow !== deps.pinnedNow)
    return {
      failed: `the run did not confirm its page's clock was pinned to ${deps.pinnedNow}; nothing was replaced`,
    };

  /** One output's export, or with `screensOnly` its screens alone. */
  const exportOf = async <S extends boolean>(o: KeptOutput, screensOnly: S) => {
    const out = await executor.request("export", {
      takeId,
      fileType: o.fileType,
      aspect: o.aspect,
      // Its file is renamed into the repo; no row names the temp one.
      unlisted: true,
      // A GIF has no quality to choose; export refuses one. The screens
      // render at the target the output's own export renders at.
      ...(o.fileType === "mp4" ? { quality: o.quality } : {}),
      ...(screensOnly ? { screensOnly: true } : {}),
    });
    if (!out.ok) return { failed: `${o.path}: ${out.detail}` };
    const exported = out.value as (ExportAnswer | ScreensAnswer) & {
      summary?: string;
    };
    if (
      exported.outcome !== "saved" ||
      exported.fileType === "stills" ||
      (exported.fileType === "screens") !== screensOnly
    )
      return { failed: `${o.path}: ${exported.summary ?? exported.outcome}` };
    if (exported.warnings.logo !== null)
      return {
        failed: `${o.path} was rendered without its logo: ${exported.warnings.logo}`,
      };
    // A soft wallpaper is the picture the author kept; a missing one is not.
    if (exported.warnings.wallpaperWarning?.kind === "leftOut")
      return {
        failed: `${o.path} was rendered without its wallpaper: ${exported.warnings.wallpaperWarning.sentence}`,
      };
    return exported as Extract<
      typeof exported,
      { fileType: S extends true ? "screens" : "mp4" | "gif" }
    >;
  };

  const j = judgedOutput(kept.outputs);
  const judged = kept.outputs[j] as KeptOutput;
  const shot = await exportOf(judged, true);
  if ("failed" in shot) return shot;
  times.mark("screens");
  const shots: Filmed["shots"] = {
    screens: shot.screens as KeptScreens,
    dir: shot.folder.path,
    size: shot.size,
  };
  const said: string[] = [];
  const rendered = new Map<number, string>();
  const fullScreens = new Map<number, KeptScreens>();
  const filmed = (
    same: boolean | null,
    toWrite: number[] = [],
    failure: string | null = null,
  ): Filmed => ({
    job,
    report,
    takeId,
    rendered,
    shots,
    same,
    failure,
    toWrite,
    said,
    stored,
    datesOnScreen,
    times,
  });
  // A receipt with no screen is one every later refresh refuses, and a
  // comparison of none compared nothing: fail now, with nothing written.
  if (shots.screens.moments.length === 0)
    return filmed(
      null,
      [],
      `${judged.path}, the output a refresh judges, has no still screen to compare against — a refresh would have nothing to check; nothing was written`,
    );
  const exportAll = async (which: number[]) => {
    for (const i of which) {
      if (rendered.has(i)) continue;
      const o = kept.outputs[i] as KeptOutput;
      const exported = await exportOf(o, false);
      if ("failed" in exported) return exported;
      rendered.set(i, exported.file.path);
      fullScreens.set(i, exported.screens as KeptScreens);
      times.mark(`export ${o.fileType}`);
    }
    return null;
  };
  const exists = (p: string) =>
    from === null
      ? Promise.resolve(false)
      : access(join(from, p)).then(
          () => true,
          () => false,
        );
  const uncompared = (against: string, why: string) =>
    `${judged.path} could not be compared with its new ${against}, so nothing was replaced: ${why}`;
  const compareDeps = {
    session: deps.session,
    steps: kept.script.steps,
    log: deps.log,
  };
  // null: nothing to compare against, so the film is delivered as new.
  let same: boolean | null = null;
  if (previous === null) {
    // Its note (the receipt is missing) is already in `notes`.
  } else if (!(await exists(judged.path))) {
    job.notes.push(`${judged.path} is missing`);
  } else if (previous.screensDir === null || previous.screensSize === null) {
    job.notes.push(
      `${job.previousAt} had no screen images, so this refresh exported to compare; the next one compares its screens`,
    );
    const failed = await exportAll(kept.outputs.map((_, i) => i));
    if (failed !== null) return failed;
    let cmp: Awaited<ReturnType<typeof samePicture>>;
    try {
      cmp = await (deps.samePicture ?? samePicture)(
        join(from as string, judged.path),
        rendered.get(j) as string,
        judged.fileType,
        previous.screens,
        fullScreens.get(j) as KeptScreens,
        compareDeps,
      );
    } catch (error) {
      return filmed(null, [], uncompared("export", messageOf(error)));
    }
    times.mark("compare");
    if ("uncomparable" in cmp)
      return filmed(null, [], uncompared("export", cmp.uncomparable));
    if ("undecodable" in cmp) {
      if (cmp.undecodable === "new")
        return filmed(
          null,
          [],
          `${judged.path}'s new export could not be decoded as ${judged.fileType.toUpperCase()} (${cmp.detail}), so nothing was replaced`,
        );
      // The one forgiven: a committed file that is no picture is replaced.
      job.notes.push(
        `${judged.path} was replaced without a comparison: the committed file could not be decoded (${cmp.detail})`,
      );
    } else {
      same = cmp.same;
      said.push(`${judged.path}: ${cmp.detail}`);
    }
  } else {
    let cmp: Awaited<ReturnType<typeof sameScreens>>;
    try {
      cmp = await (deps.sameScreens ?? sameScreens)(
        {
          // The folder is named relative to the receipt's own.
          dir: join(from as string, dirname(receiptFile), previous.screensDir),
          screens: previous.screens,
          size: previous.screensSize,
        },
        shots,
        compareDeps,
      );
    } catch (error) {
      return filmed(null, [], uncompared("screens", messageOf(error)));
    }
    times.mark("compare");
    if ("uncomparable" in cmp)
      return filmed(null, [], uncompared("screens", cmp.uncomparable));
    same = cmp.same;
    said.push(`${judged.path}: ${cmp.detail}`);
  }
  if (same === null) said.push("nothing to compare against; delivered as new");
  const toWrite: number[] = [];
  for (const [i, o] of kept.outputs.entries()) {
    if (same !== true) toWrite.push(i);
    else if (i !== j && !(await exists(o.path))) {
      toWrite.push(i);
      said.push(`${o.path} is new`);
    }
  }
  const failed = await exportAll(toWrite);
  if (failed !== null) return failed;
  return filmed(same, toWrite);
}

/**
 * Writes what `filmOne` decided. A changed or uncompared film replaces every
 * output, the report, the receipt's screen images and then the receipt,
 * each by rename from a finished file or folder beside it. The same picture
 * writes only an output with no committed file (`added`), and the receipt,
 * which describes the judged output, stays; a version 1 receipt is written
 * again as version 2 with the images, still naming the committed video, and
 * is `added` too, so a delivery commits it. The recipe is never written.
 */
async function deliverOne(
  {
    job,
    report,
    takeId,
    rendered,
    shots,
    same,
    failure,
    toWrite,
    said,
    stored,
    datesOnScreen,
    times,
  }: Filmed,
  deps: RefreshDeps,
): Promise<RefreshVideo> {
  const { kept, previous, receiptFile, file, to } = job;
  // Every video is filmed before any is delivered: this one waited for them.
  times.mark("queued");
  const notes: string[] = [...job.notes];
  const { screens } = shots;
  // Beside the receipt, named after it; a repo path, or a files flow's name.
  const screensDir = screensDirOf(receiptFile);
  const screensAt = join(dirname(receiptFile), screensDir);
  // Null when unknown; the receipt gets the reason, a malformed one said.
  const filmedCode = parseFilmedCode(report.filmedCode);
  const receiptCode = filmedCodeIn(report);
  if (
    report.filmedCode !== undefined &&
    filmedCode === null &&
    "none" in receiptCode
  )
    notes.push(receiptCode.none);
  const answer = (
    outcome: RefreshVideo["outcome"],
    outputs: string[],
    line: string | null,
  ): RefreshVideo => ({
    name: kept.name,
    file,
    flow: kept.flow,
    deliver: kept.deliver,
    outcome,
    detail: said.join("; "),
    outputs,
    line,
    notes,
    video: takeId,
    filmedCode,
    sameAs:
      (outcome === "unchanged" || outcome === "added") && previous !== null
        ? { video: previous.video }
        : null,
    // The list names files; the images' folder goes with its receipt.
    files: outputs
      .filter((path) => path !== screensAt)
      .map((path) => {
        const o = kept.outputs.find((k) => k.path === path);
        return o === undefined
          ? { path, fileType: "json" as const, aspect: null }
          : { path, fileType: o.fileType, aspect: o.aspect };
      }),
    screens,
    report: "value" in stored ? stored.value : null,
  });
  // A comparison that could not be made fails the video with its files as
  // they were.
  if (failure !== null) {
    said.splice(0, said.length, failure);
    return answer("failed", [], null);
  }
  // A version 1 receipt gets its images now, so the next refresh compares
  // screens.
  const writeReceipt =
    same !== true || (previous !== null && previous.screensDir === null);
  if (toWrite.length === 0 && !writeReceipt)
    return answer("unchanged", [], null);

  const written: string[] = [];
  const put = async (path: string, bytes: Uint8Array | string) => {
    const temp = await place(join(to, path), bytes);
    deps.log(`refresh: renamed ${relative(to, temp)} over ${path}`);
    written.push(path);
  };
  try {
    // A files delivery cut short must not leave new outputs beside the old
    // receipt: with it gone first, the next refresh reads "missing".
    if (writeReceipt && kept.deliver === "files")
      await rm(join(to, receiptFile), { force: true });
    for (const i of toWrite) {
      const o = kept.outputs[i] as KeptOutput;
      await put(o.path, await readFile(rendered.get(i) as string));
    }
    if (same !== true && kept.report !== null) {
      if ("value" in stored)
        await put(kept.report, `${JSON.stringify(stored.value, null, 2)}\n`);
      else notes.push(`${kept.report} was not written: ${stored.not}`);
    }
    if (writeReceipt) {
      const temp = await placeFolder(join(to, screensAt), shots.dir, deps.log);
      deps.log(`refresh: renamed ${relative(to, temp)} over ${screensAt}`);
      written.push(screensAt);
      // Last: the receipt says what the committed video now shows. The same
      // picture is still the committed video, with the images judged so.
      await put(
        receiptFile,
        serializeReceipt({
          ...(same === true && previous !== null
            ? previous
            : {
                flow: kept.flow,
                video: takeId,
                filmedAt: filmedAtOf({ value: report }),
                filmedCode: receiptCode,
                // The take is in a library thrown away after: no library
                // holds a revision of it to be ahead of.
                recordedRevision: null,
                ...(report.pinnedNow === undefined
                  ? {}
                  : { pinnedNow: report.pinnedNow }),
              }),
          receiptVersion: RECEIPT_VERSION,
          screens,
          screensDir,
          screensSize: shots.size,
          // The committed files now show this script, whichever take made them.
          scriptDigest: scriptDigest(kept.script),
        }),
      );
    }
  } catch (error) {
    said.push(
      `${written.length > 0 ? `wrote ${written.join(", ")}, then ` : ""}could not write into ${to} (${messageOf(error)})`,
    );
    return answer("failed", written, null);
  }
  // The commit the line names is the one the run filmed, never HEAD read
  // again; a dirty film is not its commit's tree, so it is not called so.
  const code =
    filmedCode === null || "none" in filmedCode
      ? codeClause(filmedCode ?? undefined, null, null)
      : codeClause(
          filmedCode,
          filmedCode.commit,
          filmedCode.dirty ? null : filmedCode.tree,
        );
  const { line } = prLine(kept.name, prVerdict(report), code);
  if (
    same === false &&
    deps.pinnedNow === undefined &&
    deps.nowUnused !== true &&
    datesOnScreen.length > 0
  ) {
    const note = DATES_NOTE(datesOnScreen);
    notes.push(note);
    deps.log(`refresh: "${kept.name}": ${note}`);
  }
  return answer(
    same === null ? "uncompared" : same ? "added" : "changed",
    written,
    line,
  );
}
