import {
  access,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  type ExportAnswer,
  judgedOutput,
  KEPT_DIR,
  type KeptScreens,
  type KeptVideo,
  keptFileName,
  messageOf,
  parseKept,
  prVerdict,
  type RunReport,
  serializeKept,
} from "@demoman/run-core";
import type { DemoScript } from "@demoman/scene-schema";
import { codeClause, prLine } from "./attach.js";
import type { BrowserSession } from "./browser.js";
import { libraryAhead, place, repoPath } from "./keep.js";
import { createLibrary, type Library } from "./library.js";
import type { GitRunner } from "./repo.js";
import { samePicture } from "./same-picture.js";
import type { LocalExecutor } from "./types.js";
import type { VideoStore } from "./videos.js";

export interface RefreshVideo {
  name: string;
  /** The kept file, repo-relative. */
  file: string;
  outcome: "replaced" | "unchanged" | "failed";
  /** Why it failed (the run's verdict line, or what refused), or what the
   *  comparison found. */
  detail: string;
  /** The repo paths this refresh wrote for the video. */
  outputs: string[];
  /** A replaced video's line for a pull request (`attach`'s), else null. */
  line: string | null;
  /** What a reader must hear even though the video did not fail: an output
   *  replaced without a comparison, a report not written. */
  notes: string[];
}

export interface RefreshResult {
  videos: RefreshVideo[];
}

export interface RefreshDeps {
  /** The user's library, which `library: "local"` films into. */
  home: string;
  /** The library's reads, for the check that it is ahead of a kept file
   *  (local refreshes only; a throwaway refresh never reads them). */
  library: Library;
  videos: VideoStore;
  /** A headless executor filming into `home`, at the display `env` names,
   *  exporting into `outDir`, reading accounts from `projectDir`. */
  executor(options: {
    home: string;
    env: NodeJS.ProcessEnv;
    outDir: string;
    projectDir: string;
  }): LocalExecutor;
  /** The browser that decodes outputs to compare them. */
  session: Pick<BrowserSession, "openWorkPage">;
  env: NodeJS.ProcessEnv;
  git: GitRunner;
  log: (line: string) => void;
}

/** The display a device script films on; its own size comes from the
 *  device, so only the scale here matters. */
const DEVICE_DISPLAY = { width: 1280, height: 800 };

type Job = {
  kept: KeptVideo;
  file: string;
  script: DemoScript;
  /** Read before the film, which adds a version to the library. */
  ahead: string | null;
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
 * judges the run, exports each output, and replaces the video's files (each
 * by rename from a finished file beside it) only when the picture of its
 * judged output changed. A video that fails
 * leaves its committed files as they were and says why; the others still
 * refresh.
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
    name: string,
    file: string,
    detail: string,
    notes: string[] = [],
  ) =>
    videos.push({
      name,
      file,
      outcome: "failed",
      detail,
      outputs: [],
      line: null,
      notes,
    });

  let names: string[] = [];
  try {
    names = (await readdir(join(root, KEPT_DIR)))
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const asked = args.only?.map(keptFileName);
  const found = new Set<string>();
  // One executor per display: a browser launches at one scale.
  const groups = new Map<string, Job[]>();
  for (const n of names) {
    const file = `${KEPT_DIR}/${n}`;
    let text: string;
    try {
      text = await readFile(join(root, file), "utf8");
    } catch (error) {
      failed(n, file, `${file} could not be read (${messageOf(error)})`);
      continue;
    }
    const parsed = parseKept(text, file);
    // Whether it is one `only` names cannot be told, so it is said.
    if (!parsed.ok) {
      failed(n.replace(/\.json$/, ""), file, parsed.detail);
      // Its file is the one `only` would name: not also "no kept video".
      found.add(n);
      continue;
    }
    const { kept } = parsed;
    const slug = keptFileName(kept.name);
    if (asked !== undefined && !asked.includes(slug)) continue;
    found.add(slug);
    const outside: string[] = [];
    for (const p of [
      ...kept.outputs.map((o) => o.path),
      ...(kept.report === null ? [] : [kept.report]),
      ...(kept.logo === null ? [] : [kept.logo]),
    ]) {
      const at = await repoPath(root, rootReal, p, "refresh");
      if (typeof at !== "string") outside.push(at.outside);
    }
    if (outside.length > 0) {
      failed(kept.name, file, outside.join("; "));
      continue;
    }
    const script = scriptFor(kept, root, args.baseUrl);
    const { width, height } = script.viewport ?? DEVICE_DISPLAY;
    const display = `${width}x${height}@${kept.scale}`;
    groups.set(display, [
      ...(groups.get(display) ?? []),
      {
        kept,
        file,
        script,
        ahead:
          args.library === "local"
            ? await libraryAhead(kept, file, deps)
            : null,
      },
    ]);
  }
  for (const a of args.only ?? []) {
    if (!found.has(keptFileName(a)))
      failed(
        a,
        `${KEPT_DIR}/${keptFileName(a)}`,
        `no kept video is named "${a}"`,
      );
  }

  // Every video is filmed before any file is written, so each one films
  // the checkout as it was, and each line names the same code.
  const head =
    groups.size > 0 ? await headOf(root, deps) : { commit: null, tree: null };
  const filmed: Filmed[] = [];
  const outDirs: string[] = [];
  try {
    for (const [display, jobs] of groups) {
      const home =
        args.library === "throwaway"
          ? await mkdtemp(join(tmpdir(), "demoman-refresh-home-"))
          : deps.home;
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
          deps.log(`refresh: filming "${job.kept.name}" at ${display}`);
          try {
            const one = await filmOne(job, root, executor, home, args.library);
            if ("failed" in one)
              failed(job.kept.name, job.file, one.failed, notesOf(job));
            else filmed.push(one);
          } catch (error) {
            failed(
              job.kept.name,
              job.file,
              `refresh threw: ${messageOf(error)}`,
              notesOf(job),
            );
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
        if (args.library === "throwaway") await remove(home, deps);
      }
    }
    for (const one of filmed) {
      try {
        videos.push(await replaceOne(one, root, head, deps));
      } catch (error) {
        failed(
          one.job.kept.name,
          one.job.file,
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

const notesOf = (job: Job): string[] => (job.ahead === null ? [] : [job.ahead]);

/** The kept script as this refresh films it: the logo by its repo path
 *  (the runner reads a relative ref from DEMOMAN_HOME), and the target at
 *  `baseUrl`'s origin when one is given. */
function scriptFor(
  kept: KeptVideo,
  root: string,
  baseUrl?: string,
): DemoScript {
  const script = structuredClone(kept.script);
  const logo = script.look?.branding?.logo;
  if (kept.logo !== null && logo !== undefined && logo !== null)
    logo.ref = join(root, kept.logo);
  if (baseUrl !== undefined) {
    const t = new URL(script.target);
    script.target = new URL(`${t.pathname}${t.search}${t.hash}`, baseUrl).href;
  }
  return script;
}

/** The checkout's commit and tree, for the line's code clause. */
async function headOf(
  root: string,
  deps: RefreshDeps,
): Promise<{ commit: string | null; tree: string | null }> {
  const read = async (rev: string) => {
    try {
      const r = await deps.git(["rev-parse", rev], root);
      if (r.code === 0) return r.stdout.trim();
      deps.log(
        `refresh: git rev-parse ${rev} exited ${r.code}; lines say the code was not checked`,
      );
    } catch (error) {
      deps.log(
        `refresh: git could not read ${rev} (${messageOf(error)}); lines say the code was not checked`,
      );
    }
    return null;
  };
  return { commit: await read("HEAD"), tree: await read("HEAD^{tree}") };
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
  rendered: string[];
  renderedScreens: KeptScreens[];
  /** The take's report.json, for `kept.report`; or why it is not had. */
  stored: { value: unknown } | { not: string } | null;
};

async function filmOne(
  { kept, file, script, ahead }: Job,
  root: string,
  executor: LocalExecutor,
  home: string,
  library: "local" | "throwaway",
): Promise<Filmed | { failed: string }> {
  const fresh = { new: kept.name, confirmedNew: true };
  const run = async (video: unknown) => {
    const out = await executor.request("run", {
      script,
      video,
      project: root,
      // The committed kept file is refresh's input, never its output.
      leaveKept: true,
    });
    return out.ok
      ? (out.value as Record<string, unknown>)
      : { outcome: "refusedBeforeRun", reason: out.reason, detail: out.detail };
  };
  let answer = await run(
    library === "local" ? { id: kept.from.videoId } : fresh,
  );
  // A checkout whose videos were kept on another machine.
  if (
    answer.outcome === "refusedBeforeRun" &&
    answer.reason === "videoNotFound"
  )
    answer = await run(fresh);
  const unclean = uncleanRun(answer);
  if (unclean !== null) return { failed: unclean };
  const report = answer as unknown as RunReport;
  const takeId = report.provenance.takeId;
  if (takeId === null) return { failed: "the run is clean but made no take" };

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
    rendered.push(exported.file.path);
    renderedScreens.push(exported.screens);
  }
  let stored: Filmed["stored"] = null;
  if (kept.report !== null) {
    const read = await createLibrary(home).getJson(takeId, "report.json");
    stored =
      "value" in read
        ? { value: read.value }
        : {
            not: `take ${takeId}'s run report ${"missing" in read ? "is missing" : `could not be read (${read.unreadable})`}`,
          };
  }
  return {
    job: { kept, file, script, ahead },
    report,
    rendered,
    renderedScreens,
    stored,
  };
}

/** Judges the video's one output (`judgedOutput`) against its committed
 *  file. When the picture changed, every output, the report and the kept
 *  file (with the new film's screens) are replaced, each by rename from a
 *  finished file beside it. When it did not, only an output with no
 *  committed file is written. */
async function replaceOne(
  { job, report, rendered, renderedScreens, stored }: Filmed,
  root: string,
  head: { commit: string | null; tree: string | null },
  deps: RefreshDeps,
): Promise<RefreshVideo> {
  const { kept, file } = job;
  const said: string[] = [];
  const notes: string[] = notesOf(job);
  const answer = (
    outcome: RefreshVideo["outcome"],
    outputs: string[],
    line: string | null,
  ): RefreshVideo => ({
    name: kept.name,
    file,
    outcome,
    detail: said.join("; "),
    outputs,
    line,
    notes,
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
  const j = judgedOutput(kept.outputs);
  const judged = kept.outputs[j] as (typeof kept.outputs)[number];
  let changed = false;
  if (!(await exists(judged.path))) {
    changed = true;
    said.push(`${judged.path} is new`);
  } else {
    let cmp: Awaited<ReturnType<typeof samePicture>>;
    try {
      cmp = await samePicture(
        join(root, judged.path),
        rendered[j] as string,
        judged.fileType,
        kept.screens,
        renderedScreens[j] as KeptScreens,
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
      changed = true;
      notes.push(
        `${judged.path} was replaced without a comparison: the committed file could not be decoded (${cmp.detail})`,
      );
    } else {
      changed = !cmp.same;
      said.push(`${judged.path}: ${cmp.detail}`);
    }
  }
  // The outputs to write: all of them on a change; else those not yet there.
  const toWrite: number[] = [];
  for (const [i, o] of kept.outputs.entries()) {
    if (changed) toWrite.push(i);
    else if (i !== j && !(await exists(o.path))) {
      toWrite.push(i);
      said.push(`${o.path} is new`);
    }
  }
  if (toWrite.length === 0) return answer("unchanged", [], null);
  // A kept file with no screen is one every later refresh refuses: fail now,
  // with nothing written, as keep does.
  if (changed && (renderedScreens[j] as KeptScreens).moments.length === 0) {
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
    if (changed) {
      if (kept.report !== null && stored !== null) {
        if ("value" in stored)
          await put(kept.report, `${JSON.stringify(stored.value, null, 2)}\n`);
        else notes.push(`${kept.report} was not written: ${stored.not}`);
      }
      // Last: the kept file says what the committed video now shows.
      await put(
        file,
        serializeKept({ ...kept, screens: renderedScreens[j] as KeptScreens }),
      );
    }
  } catch (error) {
    said.push(
      `${written.length > 0 ? `wrote ${written.join(", ")}, then ` : ""}could not write into ${root} (${messageOf(error)})`,
    );
    return answer("failed", written, null);
  }
  const { line } = prLine(
    kept.name,
    prVerdict(report),
    codeClause(report.filmedCode, head.commit, head.tree),
  );
  return answer("replaced", written, line);
}
