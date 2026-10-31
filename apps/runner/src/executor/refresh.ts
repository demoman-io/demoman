import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  type ExportAnswer,
  type FilmedCode,
  judgedOutput,
  KEPT_DIR,
  type KeptDeliver,
  type KeptReceipt,
  type KeptScreens,
  type KeptVideo,
  keptFileName,
  messageOf,
  prVerdict,
  RECEIPT_DIR,
  type RunReport,
  serializeReceipt,
  servedRunReport,
} from "@demoman/run-core";
import type { DemoScript } from "@demoman/scene-schema";
import { codeClause, prLine } from "./attach.js";
import type { BrowserSession } from "./browser.js";
import {
  filmedAtOf,
  libraryAhead,
  place,
  readReceiptFile,
  repoPath,
} from "./keep.js";
import { readKeptFlows } from "./kept-flows.js";
import { createLibrary, type Library } from "./library.js";
import { samePicture } from "./same-picture.js";
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
   *  `added`: the same picture, with an output that did not exist written.
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
  /** For `unchanged`: the previous receipt's video, which the picture matched. */
  sameAs: { video: string } | null;
  /** The new film's judged-output screens, and its served run report. */
  screens: KeptScreens | null;
  report: unknown | null;
}

export interface RefreshResult {
  videos: RefreshVideo[];
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
  /** The picture comparison; the real one unless a test stands in. */
  samePicture?: typeof samePicture;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

/** The display a device script films on; its own size comes from the
 *  device, so only the scale here matters. */
const DEVICE_DISPLAY = { width: 1280, height: 800 };

type Job = {
  kept: KeptVideo;
  /** What the committed files show: the receipt, else a v1 file's own; null
   *  when there is neither, and the film is delivered uncompared. */
  previous: KeptReceipt | null;
  receiptFile: string;
  file: string;
  script: DemoScript;
  /** What a reader must hear before the film: the library ahead (local
   *  only), no receipt. */
  notes: string[];
};

/**
 * Why a run answer is not clean enough to replace a committed video, or
 * null when it is: complete, never stopped, every step matched, nothing
 * degraded, everything stored. Read from the answer, never recomputed; the
 * reason given is the answer's own summary (its verdict line).
 */
export function uncleanRun(answer: Record<string, unknown>): string | null {
  const r = answer as Omit<Partial<RunReport>, "outcome"> & {
    outcome?: unknown;
    summary?: unknown;
    reason?: unknown;
    detail?: unknown;
    error?: unknown;
  };
  if (r.outcome === "refusedBeforeRun") return `${r.reason}: ${r.detail}`;
  if (r.outcome === "threw") return `the run threw: ${r.error}`;
  const clean =
    r.outcome === "complete" &&
    r.stopped === undefined &&
    r.verdict?.kind === "matches" &&
    r.frames?.degradations.length === 0 &&
    (r.notStored ?? []).length === 0;
  if (clean) return null;
  return typeof r.summary === "string"
    ? r.summary
    : `the run answered ${JSON.stringify(r.outcome)} with no summary`;
}

/**
 * `demoman refresh`: re-films each kept video's script with no agent,
 * judges the run, exports each output, and compares the judged output's
 * picture with the one the previous receipt describes. A changed or
 * uncompared film replaces every output, the report and the receipt (each
 * by rename from a finished file beside it); the recipe is never written.
 * A video that fails leaves its committed files as they were and says why;
 * the others still refresh.
 */
export async function refreshKept(
  args: {
    repoRoot: string;
    only?: string[];
    baseUrl?: string;
    library: "local" | "throwaway";
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
      screens: null,
      report: null,
    });

  const { entries, duplicates } = await readKeptFlows(root);
  const twice = new Map(
    duplicates.flatMap((d) => d.files.map((f) => [f, d] as const)),
  );
  const asked = args.only?.map(keptFileName);
  const found = new Set<string>();
  // One executor per display: a browser launches at one scale.
  const groups = new Map<string, Job[]>();
  for (const entry of entries) {
    const { file } = entry;
    const n = file.slice(KEPT_DIR.length + 1);
    // Whether it is one `only` names cannot be told, so it is said.
    if ("unreadable" in entry) {
      failed({ name: n.replace(/\.json$/, ""), file }, entry.unreadable);
      // Its file is the one `only` would name: not also "no kept video".
      found.add(n);
      continue;
    }
    const { kept, migrated } = entry;
    const slug = keptFileName(kept.name);
    if (asked !== undefined && !asked.includes(slug)) continue;
    found.add(slug);
    const who = { name: kept.name, file, kept };
    const dup = twice.get(file);
    if (dup !== undefined) {
      failed(
        who,
        `${dup.files.join(" and ")} both name the flow ${dup.flow} — delete one of them, then refresh again`,
      );
      continue;
    }
    if (kept.deliver === "files") {
      failed(who, "deliver files needs --out-dir");
      continue;
    }
    const receiptFile = `${RECEIPT_DIR}/${slug}`;
    const outside: string[] = [];
    for (const p of [
      ...kept.outputs.map((o) => o.path),
      ...(kept.report === null ? [] : [kept.report]),
      ...(kept.logo === null ? [] : [kept.logo]),
      ...(kept.wallpaper === null ? [] : [kept.wallpaper]),
      receiptFile,
    ]) {
      const at = await repoPath(root, rootReal, p, "refresh");
      if (typeof at !== "string") outside.push(at.outside);
    }
    if (outside.length > 0) {
      failed(who, outside.join("; "));
      continue;
    }
    const had = await readReceiptFile(join(root, receiptFile), receiptFile);
    if ("detail" in had) {
      failed(who, `${had.detail}, so what its outputs show is unknown`);
      continue;
    }
    if ("receipt" in had && had.receipt.flow !== kept.flow) {
      failed(
        who,
        `${receiptFile} is the receipt of flow ${had.receipt.flow}, but ${file} keeps flow ${kept.flow}, so what its outputs show is unknown`,
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
    if (previous === null) notes.push(`${receiptFile} is missing`);
    const script = scriptFor(kept, root, args.baseUrl);
    const { width, height } = script.viewport ?? DEVICE_DISPLAY;
    const display = `${width}x${height}@${kept.scale}`;
    groups.set(display, [
      ...(groups.get(display) ?? []),
      { kept, previous, receiptFile, file, script, notes },
    ]);
  }
  for (const a of args.only ?? []) {
    if (!found.has(keptFileName(a)))
      failed(
        { name: a, file: `${KEPT_DIR}/${keptFileName(a)}` },
        `no kept video is named "${a}"`,
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
          deps.log(`refresh: filming "${job.kept.name}" at ${display}`);
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
        videos.push(await deliverOne(one, root, deps));
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

/** A video filmed clean and exported: each output's new file, in order. */
type Filmed = {
  job: Job;
  report: RunReport;
  takeId: string;
  rendered: string[];
  renderedScreens: KeptScreens[];
  /** The take's report.json, served; or why it is not had. */
  stored: { value: unknown } | { not: string };
};

async function filmOne(
  job: Job,
  root: string,
  executor: LocalExecutor,
  home: string,
  deps: RefreshDeps,
): Promise<Filmed | { failed: string }> {
  const { kept, script } = job;
  const run = async () => {
    const out = await executor.request("run", {
      script,
      // The kept flow by its id: the throwaway library adopts it, so what
      // the film makes names a flow the repo keeps.
      video: { id: kept.flow },
      project: root,
      // The committed kept file is refresh's input, never its output.
      leaveKept: true,
    });
    return out.ok
      ? (out.value as Record<string, unknown>)
      : { outcome: "refusedBeforeRun", reason: out.reason, detail: out.detail };
  };
  const answer = await run();
  const unclean = uncleanRun(answer);
  if (unclean !== null) return { failed: unclean };
  const report = answer as unknown as RunReport;
  const takeId = report.provenance.takeId;
  if (takeId === null) return { failed: "the run is clean but made no video" };

  const rendered: string[] = [];
  const renderedScreens: KeptScreens[] = [];
  for (const o of kept.outputs) {
    const out = await executor.request("export", {
      takeId,
      fileType: o.fileType,
      aspect: o.aspect,
      // Its file is renamed into the repo; no row names the temp one.
      unlisted: true,
      // A GIF has no quality to choose; export refuses one.
      ...(o.fileType === "mp4" ? { quality: o.quality } : {}),
    });
    if (!out.ok) return { failed: `${o.path}: ${out.detail}` };
    const exported = out.value as ExportAnswer & { summary?: string };
    if (exported.outcome !== "saved" || exported.fileType === "stills")
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
    rendered.push(exported.file.path);
    renderedScreens.push(exported.screens);
  }
  const read = await createLibrary(home).getJson(takeId, "report.json");
  const stored: Filmed["stored"] =
    "value" in read
      ? { value: servedRunReport(read.value as RunReport) }
      : {
          not: `video ${takeId}'s run report ${"missing" in read ? "is missing" : `could not be read (${read.unreadable})`}`,
        };
  if ("not" in stored) deps.log(`refresh: "${kept.name}": ${stored.not}`);
  return { job, report, takeId, rendered, renderedScreens, stored };
}

/**
 * Judges the video's one output (`judgedOutput`) against the previous
 * receipt's film. A changed or uncompared film replaces every output, the
 * report and then the receipt, each by rename from a finished file beside
 * it. The same picture writes only an output with no committed file
 * (`added`), and the receipt, which describes the judged output, stays.
 * The recipe is never written.
 */
async function deliverOne(
  { job, report, takeId, rendered, renderedScreens, stored }: Filmed,
  root: string,
  deps: RefreshDeps,
): Promise<RefreshVideo> {
  const { kept, previous, receiptFile, file } = job;
  const said: string[] = [];
  const notes: string[] = [...job.notes];
  const j = judgedOutput(kept.outputs);
  const judged = kept.outputs[j] as (typeof kept.outputs)[number];
  const screens = renderedScreens[j] as KeptScreens;
  const filmedCode = report.filmedCode ?? null;
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
      outcome === "unchanged" && previous !== null
        ? { video: previous.video }
        : null,
    screens,
    report: "value" in stored ? stored.value : null,
  });
  // Nothing is written until the comparison is made: one that cannot be
  // made fails the video with its files as they were.
  const fail = (why: string) => {
    said.splice(0, said.length, why);
    return answer("failed", [], null);
  };
  const exists = (p: string) =>
    access(join(root, p)).then(
      () => true,
      () => false,
    );
  // null: nothing to compare against, so the film is delivered as new.
  let same: boolean | null = null;
  if (previous === null) {
    // Its note (the receipt is missing) is already in `notes`.
  } else if (!(await exists(judged.path))) {
    notes.push(`${judged.path} is missing`);
  } else {
    let cmp: Awaited<ReturnType<typeof samePicture>>;
    try {
      cmp = await (deps.samePicture ?? samePicture)(
        join(root, judged.path),
        rendered[j] as string,
        judged.fileType,
        previous.screens,
        screens,
        { session: deps.session, steps: kept.script.steps, log: deps.log },
      );
    } catch (error) {
      return fail(
        `${judged.path} could not be compared with its new export, so nothing was replaced: ${messageOf(error)}`,
      );
    }
    if ("uncomparable" in cmp) {
      return fail(
        `${judged.path} could not be compared with its new export, so nothing was replaced: ${cmp.uncomparable}`,
      );
    }
    if ("undecodable" in cmp) {
      if (cmp.undecodable === "new") {
        return fail(
          `${judged.path}'s new export could not be decoded as ${judged.fileType.toUpperCase()} (${cmp.detail}), so nothing was replaced`,
        );
      }
      // The one forgiven: a committed file that is no picture is replaced.
      notes.push(
        `${judged.path} was replaced without a comparison: the committed file could not be decoded (${cmp.detail})`,
      );
    } else {
      same = cmp.same;
      said.push(`${judged.path}: ${cmp.detail}`);
    }
  }
  if (same === null) said.push("nothing to compare against; delivered as new");
  // The outputs to write: all of them on a new film; else those not there.
  const toWrite: number[] = [];
  for (const [i, o] of kept.outputs.entries()) {
    if (same !== true) toWrite.push(i);
    else if (i !== j && !(await exists(o.path))) {
      toWrite.push(i);
      said.push(`${o.path} is new`);
    }
  }
  if (toWrite.length === 0) return answer("unchanged", [], null);
  // A receipt with no screen is one every later refresh refuses: fail now,
  // with nothing written, as keep does.
  if (same !== true && screens.moments.length === 0) {
    return fail(
      `${judged.path}, the output a refresh judges, has no still screen to compare against — a refresh would have nothing to check; nothing was written`,
    );
  }

  const written: string[] = [];
  const put = async (path: string, bytes: Uint8Array | string) => {
    const from = await place(join(root, path), bytes);
    deps.log(`refresh: renamed ${relative(root, from)} over ${path}`);
    written.push(path);
  };
  try {
    for (const i of toWrite) {
      const o = kept.outputs[i] as (typeof kept.outputs)[number];
      await put(o.path, await readFile(rendered[i] as string));
    }
    if (same !== true) {
      if (kept.report !== null) {
        if ("value" in stored)
          await put(kept.report, `${JSON.stringify(stored.value, null, 2)}\n`);
        else notes.push(`${kept.report} was not written: ${stored.not}`);
      }
      // Last: the receipt says what the committed video now shows.
      await put(
        receiptFile,
        serializeReceipt({
          receiptVersion: 1,
          flow: kept.flow,
          video: takeId,
          filmedAt: filmedAtOf({ value: report }),
          filmedCode: filmedCode ?? {
            none: "the run report records no filmed code",
          },
          screens,
          // The take is in a library thrown away after: no library holds
          // a revision of it to be ahead of.
          recordedRevision: null,
        }),
      );
    }
  } catch (error) {
    said.push(
      `${written.length > 0 ? `wrote ${written.join(", ")}, then ` : ""}could not write into ${root} (${messageOf(error)})`,
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
  return answer(
    same === null ? "uncompared" : same ? "added" : "changed",
    written,
    line,
  );
}
