import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { FrameBundle } from "@demoman/compositor";
import {
  KEPT_DIR,
  KEPT_VERSION,
  type KeptOutput,
  type KeptVideo,
  keptFileName,
  notCarriedOf,
  parseKept,
  type RefilmInfo,
  serializeKept,
} from "@demoman/run-core";
import { DemoScriptSchema } from "@demoman/scene-schema";
import { messageOf } from "../report.js";
import { chooseAccount, findAccounts } from "./accounts.js";
import { type ExportDeps, exportTake } from "./export.js";
import type { Library } from "./library.js";
import { readLogo } from "./logo-ref.js";
import { refilmFromVideo } from "./refilm.js";
import { type GitRunner, readRepo } from "./repo.js";
import { createSessionStore, siteOf } from "./sessions.js";
import {
  sharesRepo,
  type VideoRecord,
  type VideoRepo,
  type VideoStore,
} from "./videos.js";

export type KeepRefusal =
  | "unknownVideo"
  | "notCarried"
  | "unfilledHoles"
  | "handSignIn"
  | "outsideRepo"
  | "outputTaken"
  | "exportFailed"
  | "logoUnreadable"
  /** Any other reason a re-film of the video's version refuses (its own
   *  reason and sentence in the detail), or an accounts.json that will not
   *  choose an account: a refresh would refuse the same way. */
  | "cannotRefilm";

export interface KeepDeps {
  home: string;
  library: Library;
  videos: VideoStore;
  export: ExportDeps;
  git: GitRunner;
  log: (line: string) => void;
}

export type KeepAnswer =
  | {
      ok: true;
      file: string;
      kept: KeptVideo;
      written: string[];
      /** Said when `kept.scale` is a guess: the take records none. */
      scaleGuess?: string;
    }
  | { ok: false; reason: KeepRefusal; detail: string };

/** An output as asked: with no aspect, the take's own. */
export type KeepOutput = Omit<KeptOutput, "aspect"> & {
  aspect?: KeptOutput["aspect"];
};

/**
 * `demoman keep`: the video's current version as a kept file under
 * `.demoman/videos/` (everything a re-film needs, built the way a re-film
 * builds its script) and its outputs exported into the repo. Every output is
 * rendered to a temp folder first, and nothing lands in the repo until all
 * of them have: a refusal leaves the repo's files as they were. The kept
 * file is written last, so it never names outputs that are not there.
 */
export async function keepVideo(
  args: {
    video: string;
    to: KeepOutput[];
    report?: string;
    repoRoot: string;
  },
  deps: KeepDeps,
): Promise<KeepAnswer> {
  const refuse = (reason: KeepRefusal, detail: string): KeepAnswer => ({
    ok: false,
    reason,
    detail,
  });
  const root = resolve(args.repoRoot);
  const rootReal = await realpath(root);

  // The video: by id or exact name, among this repo's.
  const repo = await readRepo(root, deps.git);
  const here: VideoRepo = repo.ok
    ? { key: repo.repo.key }
    : { none: repo.none };
  const records = await deps.videos.list();
  const mine = records.filter(
    (v): v is VideoRecord => !("unreadable" in v) && sharesRepo(v.repo, here),
  );
  const video =
    mine.find((v) => v.id === args.video) ??
    mine.find((v) => v.name === args.video);
  if (video === undefined) {
    const unread = records.flatMap((v) =>
      "unreadable" in v ? [`${v.id}: ${v.unreadable}`] : [],
    );
    return refuse(
      "unknownVideo",
      `this repo has no video "${args.video}" (an id or an exact name)${mine.length > 0 ? `; its videos are ${mine.map((v) => `"${v.name}"`).join(", ")}` : ""}${unread.length > 0 ? `; ${unread.length} video record(s) could not be read (${unread.join("; ")})` : ""}`,
    );
  }

  // Every path keep writes, inside the repo once links are followed.
  const fileRel = `${KEPT_DIR}/${keptFileName(video.name)}`;
  const inRepo = (path: string) => repoPath(root, rootReal, path, "keep");
  // The kept file itself: `.demoman` or its `videos` can be a link too.
  const own = await inRepo(fileRel);
  if (typeof own !== "string") return refuse("outsideRepo", own.outside);
  const paths: string[] = [];
  for (const asked of [...args.to.map((o) => o.path), args.report]) {
    if (asked === undefined) continue;
    const p = await inRepo(asked);
    if (typeof p !== "string") return refuse("outsideRepo", p.outside);
    if (paths.includes(p) || p === fileRel) {
      return refuse(
        "outputTaken",
        `${p} is named twice by this keep — give each output its own path`,
      );
    }
    paths.push(p);
  }
  const outputPaths = paths.slice(0, args.to.length);
  const report = args.report === undefined ? null : (paths.at(-1) ?? null);

  // The paths other kept videos already write.
  const keptDir = join(root, KEPT_DIR);
  let names: string[] = [];
  try {
    names = (await readdir(keptDir)).filter((n) => n.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const rel = `${KEPT_DIR}/${name}`;
    const other = parseKept(await readFile(join(keptDir, name), "utf8"), rel);
    if (!other.ok) {
      deps.log(
        `${other.detail} — so its outputs were not checked against this keep's`,
      );
      continue;
    }
    const { kept } = other;
    if (rel === fileRel) {
      if (kept.from.videoId === video.id) continue;
      return refuse(
        "outputTaken",
        `${rel} already keeps the video "${kept.name}" (${kept.from.videoId}), whose name makes the same file — rename one of the two videos`,
      );
    }
    const theirs = [...kept.outputs.map((o) => o.path), kept.report];
    const clash = paths.find((p) => theirs.includes(p));
    if (clash !== undefined) {
      return refuse(
        "outputTaken",
        `${clash} is already kept by the video "${kept.name}" in ${rel} — choose another path, or remove it from ${rel}`,
      );
    }
  }

  const made = await buildKept(
    {
      root,
      rootReal,
      video,
      outputs: args.to.map((o, i) => ({
        ...o,
        path: outputPaths[i] as string,
      })),
      report,
    },
    deps,
  );
  if (!made.ok) return refuse(made.reason, made.detail);
  const { kept, built, logoBytes } = made;
  const { logo } = kept;

  const temp = await mkdtemp(join(tmpdir(), "demoman-keep-"));
  try {
    const rendered: Uint8Array[] = [];
    for (const o of kept.outputs) {
      deps.log(`keep: exporting ${o.path}`);
      const answer = await exportTake(
        {
          takeId: built.takeId,
          fileType: o.fileType,
          aspect: o.aspect,
          // Its file is renamed into the repo; no row names the temp one.
          unlisted: true,
          // A GIF has no quality to choose; export refuses one.
          ...(o.fileType === "mp4" ? { quality: o.quality } : {}),
        },
        { ...deps.export, outDir: temp },
        () => undefined,
      );
      if (answer.outcome !== "saved" || answer.fileType === "stills") {
        return refuse("exportFailed", `${o.path}: ${answer.summary}`);
      }
      if (answer.warnings.logo !== null) {
        return refuse(
          "logoUnreadable",
          `${o.path} was rendered without its logo: ${answer.warnings.logo}`,
        );
      }
      rendered.push(await readFile(answer.file.path));
    }
    const runReport =
      report === null
        ? null
        : await deps.library.getJson(built.takeId, "report.json");

    const written: string[] = [];
    try {
      for (const [i, o] of kept.outputs.entries()) {
        await place(join(root, o.path), rendered[i] as Uint8Array);
        written.push(o.path);
      }
      if (logo !== null && logoBytes !== null) {
        await place(join(root, logo), logoBytes);
        written.push(logo);
      }
      if (report !== null && runReport !== null) {
        if ("value" in runReport) {
          await place(
            join(root, report),
            `${JSON.stringify(runReport.value, null, 2)}\n`,
          );
          written.push(report);
        } else {
          deps.log(
            `keep: ${report} is written by the next refresh — take ${built.takeId}'s run report ${"missing" in runReport ? "is missing" : `could not be read (${runReport.unreadable})`}`,
          );
        }
      }
      await place(join(root, fileRel), serializeKept(kept));
      written.push(fileRel);
    } catch (error) {
      return refuse(
        "exportFailed",
        `${written.length > 0 ? `wrote ${written.join(", ")}, then ` : ""}could not write into ${root} (${messageOf(error)}), so ${fileRel} was not written`,
      );
    }
    return {
      ok: true,
      file: fileRel,
      kept,
      written,
      ...(made.scaleGuess === null ? {} : { scaleGuess: made.scaleGuess }),
    };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch((error: unknown) =>
      deps.log(`keep: ${temp} was not removed (${messageOf(error)})`),
    );
  }
}

type Built =
  | {
      ok: true;
      kept: KeptVideo;
      built: { takeId: string };
      read: { revision: string };
      /** The logo's bytes when they are to be copied into the repo. */
      logoBytes: Uint8Array | null;
      /** Why `kept.scale` is a guess, or null when the take said it. */
      scaleGuess: string | null;
    }
  | { ok: false; reason: KeepRefusal; detail: string };

/**
 * The kept file for `a.video`'s current version, built the way a re-film
 * builds its script: shared by `keep` and by `rewriteKept`, so a rewrite
 * can never differ from a keep. Writes nothing.
 */
async function buildKept(
  a: {
    root: string;
    rootReal: string;
    video: VideoRecord;
    outputs: (Omit<KeptOutput, "aspect"> & { aspect?: KeptOutput["aspect"] })[];
    report: string | null;
  },
  deps: KeepDeps,
): Promise<Built> {
  const { root, rootReal, video } = a;
  const inRepo = (path: string) => repoPath(root, rootReal, path, "keep");
  const refuse = (reason: KeepRefusal, detail: string): Built => ({
    ok: false,
    reason,
    detail,
  });
  // The script a re-film would run, and everything it leaves behind.
  const built = await refilmFromVideo(deps.videos, deps.library, a.video);
  if (!built.ok) {
    const { reason, detail } = built.refusal;
    return refuse(
      reason === "unfilledHoles" ? "unfilledHoles" : "cannotRefilm",
      reason === "unfilledHoles" ? detail : `${detail} (${reason})`,
    );
  }
  const left = leftBehind(built.refilm);
  if (left.length > 0) {
    return refuse(
      "notCarried",
      `take ${built.takeId} of "${video.name}" has edits a re-film does not carry, so a refresh would drop them: ${left.join(", ")} — remove them in the Studio, or record the video again, then keep it`,
    );
  }
  const read = await deps.library.getSceneRead(built.takeId);
  if (read === null) {
    return refuse(
      "cannotRefilm",
      `take ${built.takeId} of "${video.name}" has no scene.json any more`,
    );
  }
  const { scene } = read;
  // The run's own record first; takes filmed before it, their motion frames.
  const scale =
    scene.meta.capture.displayScale ??
    filmedScale(
      await deps.library.frameStore(built.takeId).getBundle(built.takeId),
      scene.meta.capture.viewport.width,
    );
  const scaleGuess =
    scale === null
      ? `1x is a guess: take ${built.takeId} records no filmed scale and has no motion frames to read one from, so refresh films it at 1x — if it was filmed at another scale, set "scale" in the kept file to it, or the first refresh replaces a video that did not change`
      : null;

  // A site signed in to by hand cannot be signed in to by a refresh in CI.
  const target = String(built.script.target);
  const named =
    typeof built.script.account === "string" ? built.script.account : undefined;
  const choice = chooseAccount(await findAccounts(root), target, named);
  if (choice.kind === "refused") return refuse("cannotRefilm", choice.detail);
  if (choice.kind === "manual") {
    const site = siteOf(target);
    const store = createSessionStore(deps.home);
    let saved: Awaited<ReturnType<typeof store.read>>["files"];
    try {
      saved = (await store.read()).files;
    } catch (error) {
      return refuse(
        "cannotRefilm",
        `whether ${target} is signed in to by hand cannot be told: ${messageOf(error)}`,
      );
    }
    if (saved.some((f) => f.account === undefined && f.site === site)) {
      return refuse(
        "handSignIn",
        `"${video.name}" films ${target}, which this machine signs in to with a session saved by hand (demoman signin, ${store.pathOf(site ?? "")}); a refresh in CI cannot sign in that way — add a demo account for ${new URL(target).origin} to .demoman/accounts.json, record the video again as it, then keep it`,
      );
    }
  }

  // The logo: by its repo path, copied in when it lives outside the repo.
  let logo: string | null = null;
  let logoBytes: Uint8Array | null = null;
  if (scene.branding.logo !== null) {
    const { ref } = scene.branding.logo;
    const had = await readLogo(deps.home, ref);
    if (!had.ok)
      return refuse("logoUnreadable", `the take's logo: ${had.error}`);
    const abs = isAbsolute(ref) ? ref : join(deps.home, ref);
    const there = await inRepo(abs);
    if (typeof there === "string") {
      logo = there;
    } else {
      logo = `${KEPT_DIR}/logos/${basename(abs)}`;
      const copy = await inRepo(logo);
      if (typeof copy !== "string") return refuse("outsideRepo", copy.outside);
      const existing = await readFile(join(root, logo)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (existing !== null && !existing.equals(had.bytes)) {
        return refuse(
          "outputTaken",
          `${logo} already holds a different logo than ${abs} — rename one of the two files`,
        );
      }
      if (existing === null) logoBytes = had.bytes;
    }
  }

  const look = (built.script.look ?? {}) as Record<string, unknown>;
  const script = DemoScriptSchema.safeParse({
    ...built.script,
    // The size it was filmed at, so CI films the same (a device is its own).
    ...(scene.meta.capture.device === undefined
      ? { viewport: scene.meta.capture.viewport }
      : {}),
    ...(logo === null || scene.branding.logo === null
      ? {}
      : {
          look: {
            ...look,
            branding: {
              ...scene.branding,
              logo: { ...scene.branding.logo, ref: logo },
            },
          },
        }),
  });
  if (!script.success) {
    const issue = script.error.issues[0];
    return refuse(
      "cannotRefilm",
      `the script built from take ${built.takeId} is refused at script.${(issue?.path ?? []).join(".")}: ${issue?.message ?? "by the script schema"}`,
    );
  }
  const kept: KeptVideo = {
    keptVersion: KEPT_VERSION,
    name: video.name,
    script: script.data,
    scale: scale ?? 1,
    logo,
    outputs: a.outputs.map((o) => ({
      path: o.path,
      fileType: o.fileType,
      aspect: o.aspect ?? scene.canvas.aspect,
      quality: o.quality,
    })),
    report: a.report,
    // The revision this file was built from: a later Studio edit changes it.
    from: {
      videoId: video.id,
      takeId: built.takeId,
      recordedRevision: read.revision,
    },
  };
  return { ok: true, kept, built, read, logoBytes, scaleGuess };
}

export type RewriteAnswer =
  | { rewritten: string }
  | { none: true }
  | { refused: string };

/**
 * A run into a kept video made a new version: the kept file follows, rebuilt
 * from that version exactly as `keep` builds it, with its outputs, report
 * and logo path as they were. Outputs are not re-exported (the next refresh
 * does). Nothing is written on a refusal, and a kept file that cannot be
 * read is said, never taken for "no file keeps this video".
 */
export async function rewriteKept(
  repoRoot: string,
  videoId: string,
  deps: KeepDeps,
  /** Why the file must not follow this run (it did not complete): said
   *  when a file keeps the video, which then stays as it was. */
  notNow?: string,
): Promise<RewriteAnswer> {
  const root = resolve(repoRoot);
  const rootReal = await realpath(root);
  const dir = join(root, KEPT_DIR);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { none: true };
    return {
      refused: `${KEPT_DIR} could not be read (${messageOf(error)}), so whether a kept file follows this run is unknown`,
    };
  }
  const unreadable: string[] = [];
  for (const name of names) {
    const rel = `${KEPT_DIR}/${name}`;
    let text: string;
    try {
      text = await readFile(join(dir, name), "utf8");
    } catch (error) {
      unreadable.push(`${rel} could not be read (${messageOf(error)})`);
      continue;
    }
    const parsed = parseKept(text, rel);
    if (!parsed.ok) {
      unreadable.push(parsed.detail);
      continue;
    }
    const old = parsed.kept;
    if (old.from.videoId !== videoId) continue;
    const own = await repoPath(root, rootReal, rel, "keep");
    if (typeof own !== "string") return { refused: own.outside };
    if (notNow !== undefined) {
      return {
        refused: `${rel} was not rewritten: ${notNow}, so it still holds the earlier script`,
      };
    }
    const video = await deps.videos.get(videoId);
    if (video === null) {
      return {
        refused: `${rel} keeps video ${videoId}, which the library no longer has`,
      };
    }
    const made = await buildKept(
      { root, rootReal, video, outputs: old.outputs, report: old.report },
      deps,
    );
    if (!made.ok)
      return { refused: `${rel} was not rewritten: ${made.detail}` };
    try {
      if (made.kept.logo !== null && made.logoBytes !== null) {
        await place(join(root, made.kept.logo), made.logoBytes);
      }
      await place(join(root, rel), serializeKept(made.kept));
    } catch (error) {
      return {
        refused: `${rel} could not be written (${messageOf(error)}), so it still describes the earlier version`,
      };
    }
    for (const u of unreadable) deps.log(`kept: ${u}`);
    if (made.scaleGuess !== null) deps.log(`kept: ${rel}: ${made.scaleGuess}`);
    return { rewritten: rel };
  }
  return unreadable.length > 0
    ? {
        refused: `${unreadable.join("; ")} — so whether a kept file follows this run is unknown`,
      }
    : { none: true };
}

/** What a re-film does not carry, named the way `keep` refuses it. */
export function leftBehind(refilm: RefilmInfo): string[] {
  return [
    ...refilm.notCarried.map((n) => `${n.kind} ${n.id}`),
    ...refilm.notes.flatMap((n) =>
      n.kind === "migrated" ? [`migrated: ${n.sentence}`] : [],
    ),
  ];
}

/**
 * The line a local refresh carries when the library holds a version, or
 * Studio edits, the kept file lacks; null when it does not. Edited is read
 * against the scene revision `keep` recorded, not the membership's `edited`
 * flag, which is also true for edits carried into the file at keep time.
 * A library that cannot be read is said, never taken for "nothing newer".
 */
export async function libraryAhead(
  kept: KeptVideo,
  file: string,
  deps: { videos: VideoStore; library: Library },
): Promise<string | null> {
  try {
    const video = await deps.videos.get(kept.from.videoId);
    // Kept on another machine: this library has nothing to be ahead of.
    if (video === null) return null;
    const all = await deps.videos.versions(video.id);
    const current = all.filter((v) => v.complete).at(-1) ?? all.at(-1);
    if (current === undefined) return null;
    const read = await deps.library.getSceneRead(current.takeId);
    if (read === null) {
      return `the library's current version of "${kept.name}" (take ${current.takeId}) has no scene.json, so whether it is ahead of ${file} cannot be told`;
    }
    if (
      current.takeId === kept.from.takeId &&
      read.revision === kept.from.recordedRevision
    )
      return null;
    const left = leftBehind({
      from: current.takeId,
      notCarried: notCarriedOf(read.scene),
      notes: read.notes.map((sentence) => ({
        kind: "migrated" as const,
        sentence,
      })),
    });
    return `the library has a newer version or Studio edits not in ${file}; run \`demoman keep ${kept.name}\` again to take them${left.length > 0 ? ` (keep will refuse the edits a re-film does not carry: ${left.join(", ")})` : ""}`;
  } catch (error) {
    return `whether the library is ahead of ${file} cannot be told: ${messageOf(error)}`;
  }
}

/** `path` as a repo-relative posix path when it is inside the repo once
 *  links are followed (`rootReal` is the root's realpath), else why not. */
export async function repoPath(
  root: string,
  rootReal: string,
  path: string,
  who: "keep" | "refresh",
): Promise<string | { outside: string }> {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  const real = await realOf(abs);
  const inside =
    real !== null &&
    (real === rootReal || real.startsWith(`${rootReal}${sep}`)) &&
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel);
  if (inside) return rel.split(sep).join("/");
  return {
    outside: `${path} is not inside the repo at ${root} (it resolves to ${real ?? "a link to nothing"}) — ${who} writes only into the repo it keeps the video in`,
  };
}

/**
 * The scale the take's motion was filmed at, or null with no motion frames:
 * for takes filmed before `meta.capture.displayScale` was recorded.
 * Screencast spans follow the display's DPR; `meta.capture.dpr` is
 * REPLAY_DPR on every authored take, the stills' scale, not the display's.
 * The widest span, since the encoder may keep a span smaller than it
 * arrived; to the nearest quarter, since an encoder's even-pixel width is
 * not another display and displays come at 1, 1.25, 1.5, 2; never under 1.
 */
function filmedScale(
  bundle: FrameBundle | null,
  viewportWidth: number,
): number | null {
  const widest = Math.max(
    0,
    ...(bundle?.motionSpans ?? []).map((s) => s.width),
  );
  if (widest === 0) return null;
  return Math.max(1, Math.round((widest / viewportWidth) * 4) / 4);
}

/** Where `abs` really is: the deepest part that exists, links followed,
 *  plus the rest as written. Null for a link to nothing, whose target
 *  cannot be told. */
async function realOf(abs: string): Promise<string | null> {
  const rest: string[] = [];
  let head = abs;
  for (;;) {
    try {
      return join(await realpath(head), ...rest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (
        await lstat(head).then(
          () => true,
          () => false,
        )
      )
        return null;
      rest.unshift(basename(head));
      head = dirname(head);
    }
  }
}

/** Writes beside `dest`, then renames over it: a kill leaves the old file
 *  or the new one, never half of one. Answers the file it renamed. */
export async function place(
  dest: string,
  bytes: Uint8Array | string,
): Promise<string> {
  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes);
    await rename(temp, dest);
    return temp;
  } catch (error) {
    // The write's own error is the one reported; a temp left behind is a
    // dot-less stray beside it, named by that error's path.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
