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
  stat,
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
import { type FrameBundle, wallpaperShape } from "@demoman/compositor";
import {
  type FilmedCode,
  frameOf,
  judgedOutput,
  KEPT_DIR,
  KEPT_VERSION,
  type KeptDeliver,
  type KeptOutput,
  type KeptReceipt,
  type KeptScreens,
  type KeptVideo,
  keptFileName,
  notCarriedOf,
  parseKept,
  parseReceipt,
  RECEIPT_DIR,
  REFRESH_LIST_FILE,
  type RefilmInfo,
  type RunReport,
  serializeKept,
  serializeReceipt,
  servedRunReport,
  targetFor,
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
import { sameName } from "./video-match.js";
import {
  sharesRepo,
  type VideoRecord,
  type VideoRepo,
  type VideoStore,
} from "./videos.js";
import { readWallpaper } from "./wallpaper-read.js";

export type KeepRefusal =
  | "unknownVideo"
  | "notCarried"
  | "unfilledHoles"
  | "handSignIn"
  | "outsideRepo"
  | "outputTaken"
  | "exportFailed"
  | "logoUnreadable"
  /** The take's wallpaper or uploaded image cannot be had (read before
   *  any export), or an export left it out: the video would be on the
   *  gradient. One that is only too small (`soft`) is kept. */
  | "wallpaperUnreadable"
  /** Any other reason a re-film of the video's version refuses (its own
   *  reason and sentence in the detail), or an accounts.json that will not
   *  choose an account: a refresh would refuse the same way. */
  | "cannotRefilm"
  /** The request itself is refused (a `files` output given as a path). */
  | "keepRefused";

/** What a built kept file was made from. */
type KeptFrom = { takeId: string; recordedRevision: string };

export interface KeepDeps {
  home: string;
  library: Library;
  videos: VideoStore;
  export: ExportDeps;
  git: GitRunner;
  log: (line: string) => void;
  /** process.platform unless given: tests say which side they are on. */
  platform?: NodeJS.Platform;
}

export type KeepAnswer =
  | {
      ok: true;
      file: string;
      kept: KeptVideo;
      /** What `deliver: "commit"` wrote beside the recipe; null for `files`. */
      receipt: KeptReceipt | null;
      /** "k of n screens are still": what a refresh compares at. Said for
       *  `commit` only: `files` renders nothing here. */
      screensNote?: string;
      /** Said when the library could not mark the flow kept: the keep
       *  stands, and the Library will not show it as kept until it does. */
      markNote?: string;
      written: string[];
      /** Said when `kept.scale` is a guess: the take records none. */
      scaleGuess?: string;
      /** Said when kept off Linux: CI's fonts differ, so its first refresh
       *  replaces the outputs once. */
      platformNote?: string;
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
    /** `commit` (the default) renders the outputs into the repo; `files`
     *  writes the recipe alone and leaves delivery to `--out-dir`. */
    deliver?: KeptDeliver;
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
  const platform = deps.platform ?? process.platform;
  const deliver = args.deliver ?? "commit";
  if (deliver === "files") {
    const path = [...args.to.map((o) => o.path), args.report ?? ""].find(
      (p) => /[/\\]/.test(p) || p === "." || p === "..",
    );
    if (path !== undefined) {
      return refuse(
        "keepRefused",
        `files outputs are file names, not paths (got "${path}": no /, no \\, not . or ..)`,
      );
    }
  }

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
      `this repo has no flow "${args.video}" (an id or an exact name)${mine.length > 0 ? `; its flows are ${mine.map((v) => `"${v.name}"`).join(", ")}` : ""}${unread.length > 0 ? `; ${unread.length} flow record(s) could not be read (${unread.join("; ")})` : ""}`,
    );
  }

  // Every path keep writes, inside the repo once links are followed.
  const fileRel = `${KEPT_DIR}/${keptFileName(video.name)}`;
  const inRepo = (path: string) => repoPath(root, rootReal, path, "keep");
  // The kept file itself: `.demoman` or its `videos` can be a link too.
  const own = await inRepo(fileRel);
  if (typeof own !== "string") return refuse("outsideRepo", own.outside);
  // Its receipt, named after the recipe's file: `.demoman/receipts` can be
  // a link out of the repo too.
  const receiptRel = `${RECEIPT_DIR}/${basename(fileRel)}`;
  if (deliver === "commit") {
    const receiptAt = await inRepo(receiptRel);
    if (typeof receiptAt !== "string")
      return refuse("outsideRepo", receiptAt.outside);
  }
  const paths: string[] = [];
  // `files` outputs are names for --out-dir, not places in this repo: the
  // same clash checks run over the bare names, which must not be the names
  // a refresh gives its own files there either.
  for (const asked of [...args.to.map((o) => o.path), args.report]) {
    if (asked === undefined) continue;
    let p = asked;
    if (deliver === "files") {
      if (asked === REFRESH_LIST_FILE || asked.endsWith(".receipt.json")) {
        return refuse(
          "outputTaken",
          `${asked} is a name a refresh gives its own ${asked === REFRESH_LIST_FILE ? "list" : "receipts"} in --out-dir — give the output another name`,
        );
      }
    } else {
      const at = await inRepo(asked);
      if (typeof at !== "string") return refuse("outsideRepo", at.outside);
      p = at;
    }
    if (paths.includes(p) || p === fileRel) {
      return refuse(
        "outputTaken",
        `${p} is named twice by this keep — give each output its own ${deliver === "files" ? "name" : "path"}`,
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
    // Refused, not moved: keep writes only this keep's files, and moving
    // another recipe and its receipt is renameKept's, with its undo steps.
    if (kept.flow === video.id && rel !== fileRel) {
      return refuse(
        "outputTaken",
        `${rel} already keeps this flow (${video.id}), so keeping it as "${video.name}" would write a second recipe for it, ${fileRel} — move ${rel} to ${fileRel}${kept.deliver === "commit" ? ` and ${RECEIPT_DIR}/${name} to ${receiptRel}` : ""}, then keep again`,
      );
    }
    if (rel === fileRel) {
      if (kept.flow === video.id) continue;
      return refuse(
        "outputTaken",
        `${rel} already keeps the flow "${kept.name}" (${kept.flow}), whose name makes the same file — rename one of the two flows`,
      );
    }
    const theirs = [...kept.outputs.map((o) => o.path), kept.report];
    const clash = paths.find((p) => theirs.includes(p));
    if (clash !== undefined) {
      return refuse(
        "outputTaken",
        `${clash} is already kept by the flow "${kept.name}" in ${rel} — choose another path, or remove it from ${rel}`,
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
      deliver,
    },
    deps,
  );
  if (!made.ok) return refuse(made.reason, made.detail);
  // A recipe its own reader refuses (an empty name, say) is never written:
  // every later run and refresh would refuse it.
  const reread = parseKept(serializeKept(made.kept), fileRel);
  if (!reread.ok) {
    return refuse("keepRefused", `${reread.detail} — so nothing was written`);
  }
  const { built, logoBytes, wallpaperBytes } = made;
  const base = made.kept;
  const { logo, wallpaper } = base;

  const temp = await mkdtemp(join(tmpdir(), "demoman-keep-"));
  try {
    const rendered: Uint8Array[] = [];
    let screens: KeptScreens | undefined;
    const judged = judgedOutput(base.outputs);
    for (const [i, o] of deliver === "files" ? [] : base.outputs.entries()) {
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
      if (answer.warnings.wallpaperWarning?.kind === "leftOut") {
        return refuse(
          "wallpaperUnreadable",
          `${o.path} was rendered without its wallpaper: ${answer.warnings.wallpaperWarning.sentence}`,
        );
      }
      if (i === judged) screens = answer.screens;
      rendered.push(await readFile(answer.file.path));
    }
    if (
      deliver === "commit" &&
      (screens === undefined || screens.moments.length === 0)
    ) {
      return refuse(
        "exportFailed",
        `${base.outputs[judged]?.path}, the output a refresh judges, has no still screen to compare against — a refresh would have nothing to check; nothing was written`,
      );
    }
    const kept: KeptVideo = base;
    const runReport =
      deliver === "files"
        ? null
        : await deps.library.getJson(built.takeId, "report.json");

    const receipt: KeptReceipt | null =
      deliver === "files" || screens === undefined
        ? null
        : {
            receiptVersion: 1,
            flow: video.id,
            video: built.takeId,
            filmedAt: filmedAtOf(runReport),
            filmedCode: filmedCodeOf(runReport),
            screens,
            recordedRevision: made.from.recordedRevision,
          };
    const written: string[] = [];
    try {
      for (const [i, o] of deliver === "files" ? [] : kept.outputs.entries()) {
        await place(join(root, o.path), rendered[i] as Uint8Array);
        written.push(o.path);
      }
      if (logo !== null && logoBytes !== null) {
        await place(join(root, logo), logoBytes);
        written.push(logo);
      }
      if (wallpaper !== null && wallpaperBytes !== null) {
        await place(join(root, wallpaper), wallpaperBytes);
        written.push(wallpaper);
      }
      if (deliver === "commit" && report !== null && runReport !== null) {
        if ("value" in runReport) {
          await place(
            join(root, report),
            `${JSON.stringify(servedRunReport(runReport.value as RunReport), null, 2)}\n`,
          );
          written.push(report);
        } else {
          deps.log(
            `keep: ${report} is written by the next refresh — video ${built.takeId}'s run report ${"missing" in runReport ? "is missing" : `could not be read (${runReport.unreadable})`}`,
          );
        }
      }
      if (receipt !== null) {
        await place(join(root, receiptRel), serializeReceipt(receipt));
        written.push(receiptRel);
      }
      // Last: the recipe never names a render that is not there.
      await place(join(root, fileRel), serializeKept(kept));
      written.push(fileRel);
    } catch (error) {
      return refuse(
        "exportFailed",
        `${written.length > 0 ? `wrote ${written.join(", ")}, then ` : ""}could not write into ${root} (${messageOf(error)}), so ${fileRel} was not written`,
      );
    }
    // The Library lists a flow as kept from this mark. A failure is said on
    // the answer; the keep itself stands, its files are written.
    let markNote: string | undefined;
    try {
      const marked = await deps.videos.setKept(video.id, {
        root,
        file: fileRel,
      });
      if (!marked.ok) {
        markNote = `the library could not mark "${video.name}" as kept (${marked.reason}), so it will not show as kept until you keep it again`;
      }
    } catch (error) {
      markNote = `the library could not mark "${video.name}" as kept (${messageOf(error)}), so it will not show as kept until you keep it again`;
    }
    return {
      ok: true,
      file: fileRel,
      kept,
      receipt,
      ...(receipt === null
        ? {}
        : {
            screensNote: `${receipt.screens.moments.length} of ${receipt.screens.steps + 1} screens are still`,
          }),
      ...(markNote === undefined ? {} : { markNote }),
      written,
      ...(made.scaleGuess === null ? {} : { scaleGuess: made.scaleGuess }),
      ...(platform === "linux"
        ? {}
        : {
            platformNote: `kept on ${platform === "darwin" ? "macOS" : platform}: the first refresh in CI films it again on Linux, whose fonts differ, and replaces its outputs once; after that, refresh in CI only`,
          }),
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
      from: KeptFrom;
      built: { takeId: string };
      read: { revision: string };
      /** The logo's bytes when they are to be copied into the repo. */
      logoBytes: Uint8Array | null;
      /** The uploaded image's, likewise. */
      wallpaperBytes: Uint8Array | null;
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
    deliver: KeptDeliver;
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
      `video ${built.takeId} of "${video.name}" has edits a re-film does not carry, so a refresh would drop them: ${left.join(", ")} — remove them in the Studio, or film the flow again, then keep it`,
    );
  }
  const read = await deps.library.getSceneRead(built.takeId);
  if (read === null) {
    return refuse(
      "cannotRefilm",
      `video ${built.takeId} of "${video.name}" has no scene.json any more`,
    );
  }
  const { scene } = read;
  const bundle = await deps.library
    .frameStore(built.takeId)
    .getBundle(built.takeId);
  // The run's own record first; takes filmed before it, their motion frames.
  const scale =
    scene.meta.capture.displayScale ??
    filmedScale(bundle, scene.meta.capture.viewport.width);
  const scaleGuess =
    scale === null
      ? `1x is a guess: video ${built.takeId} records no filmed scale and has no motion frames to read one from, so refresh films it at 1x — if it was filmed at another scale, set "scale" in the kept file to it, or the first refresh replaces a video that did not change`
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
        `"${video.name}" films ${target}, which this machine signs in to with a session saved by hand (demoman signin, ${store.pathOf(site ?? "")}); a refresh in CI cannot sign in that way — add a demo account for ${new URL(target).origin} to .demoman/accounts.json, film the flow again as it, then keep it`,
      );
    }
  }

  // A file the script names, by its repo path: copied in under `folder`
  // when it lives outside the repo, unless the same bytes are there.
  const ownCopy = async (
    abs: string,
    bytes: Uint8Array,
    folder: string,
    noun: string,
  ): Promise<
    { path: string; bytes: Uint8Array | null } | { refused: Built }
  > => {
    const there = await inRepo(abs);
    if (typeof there === "string") return { path: there, bytes: null };
    const path = `${KEPT_DIR}/${folder}/${basename(abs)}`;
    const copy = await inRepo(path);
    if (typeof copy !== "string")
      return { refused: refuse("outsideRepo", copy.outside) };
    const existing = await readFile(join(root, path)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (existing !== null && !existing.equals(bytes)) {
      return {
        refused: refuse(
          "outputTaken",
          `${path} already holds a different ${noun} than ${abs} — rename one of the two files`,
        ),
      };
    }
    return { path, bytes: existing === null ? bytes : null };
  };

  // The logo: by its repo path, copied in when it lives outside the repo.
  let logo: string | null = null;
  let logoBytes: Uint8Array | null = null;
  if (scene.branding.logo !== null) {
    const { ref } = scene.branding.logo;
    const had = await readLogo(deps.home, ref);
    if (!had.ok)
      return refuse("logoUnreadable", `the video's logo: ${had.error}`);
    const own = await ownCopy(
      isAbsolute(ref) ? ref : join(deps.home, ref),
      had.bytes,
      "logos",
      "logo",
    );
    if ("refused" in own) return own.refused;
    logo = own.path;
    logoBytes = own.bytes;
  }

  // The wallpaper, read as each output's export will read it, so one that
  // cannot be had is refused before anything renders. A built-in is in
  // every install; an uploaded image is copied in as the logo is, or a
  // refresh in CI would film every version on the gradient.
  let wallpaper: string | null = null;
  let wallpaperBytes: Uint8Array | null = null;
  const background = scene.branding.background;
  // Each output's shape as its export decides it (`wallpaperShape` of its
  // target), so an Auto take filmed on a phone is checked as portrait.
  const shapes = new Set(
    a.outputs.map((o) =>
      wallpaperShape(
        targetFor(
          o.fileType,
          o.aspect ?? scene.canvas.aspect,
          bundle,
          frameOf(scene),
          { quality: o.quality },
        ),
      ),
    ),
  );
  for (const shape of shapes) {
    const had = await readWallpaper(
      deps.home,
      deps.export.wallpapersDir,
      background,
      shape,
    );
    if (had === null) break;
    if (!had.ok)
      return refuse(
        "wallpaperUnreadable",
        `the video's wallpaper: ${had.error}`,
      );
    if (background.kind !== "image" || wallpaper !== null) continue;
    const own = await ownCopy(
      isAbsolute(background.ref)
        ? background.ref
        : join(deps.home, background.ref),
      had.bytes,
      "wallpapers",
      "wallpaper",
    );
    if ("refused" in own) return own.refused;
    wallpaper = own.path;
    wallpaperBytes = own.bytes;
  }

  const look = (built.script.look ?? {}) as Record<string, unknown>;
  const script = DemoScriptSchema.safeParse({
    ...built.script,
    // The size it was filmed at, so CI films the same (a device is its own).
    ...(scene.meta.capture.device === undefined
      ? { viewport: scene.meta.capture.viewport }
      : {}),
    ...(logo === null && wallpaper === null
      ? {}
      : {
          look: {
            ...look,
            branding: {
              ...scene.branding,
              ...(logo === null || scene.branding.logo === null
                ? {}
                : { logo: { ...scene.branding.logo, ref: logo } }),
              ...(wallpaper === null
                ? {}
                : {
                    // The take's own blur with it, as wallpaper-own keeps it.
                    background: {
                      ...background,
                      kind: "image",
                      ref: wallpaper,
                    },
                  }),
            },
          },
        }),
  });
  if (!script.success) {
    const issue = script.error.issues[0];
    return refuse(
      "cannotRefilm",
      `the script built from video ${built.takeId} is refused at script.${(issue?.path ?? []).join(".")}: ${issue?.message ?? "by the script schema"}`,
    );
  }
  const kept: KeptVideo = {
    keptVersion: KEPT_VERSION,
    flow: video.id,
    name: video.name,
    script: script.data,
    scale: scale ?? 1,
    logo,
    wallpaper,
    deliver: a.deliver,
    outputs: a.outputs.map((o) => ({
      path: o.path,
      fileType: o.fileType,
      aspect: o.aspect ?? scene.canvas.aspect,
      quality: o.quality,
    })),
    report: a.report,
  };
  return {
    ok: true,
    kept,
    // The revision this file was built from: a later Studio edit changes it.
    from: { takeId: built.takeId, recordedRevision: read.revision },
    built,
    read,
    logoBytes,
    wallpaperBytes,
    scaleGuess,
  };
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
    if (old.flow !== videoId) continue;
    const own = await repoPath(root, rootReal, rel, "keep");
    if (typeof own !== "string") return { refused: own.outside };
    // The receipt is named after the recipe's file, never the flow's name.
    const receiptFile = `${RECEIPT_DIR}/${name}`;
    if (old.deliver === "commit") {
      const at = await repoPath(root, rootReal, receiptFile, "keep");
      if (typeof at !== "string") {
        return { refused: `${rel} was not rewritten: ${at.outside}` };
      }
    }
    const video = await deps.videos.get(videoId);
    // A flow kept before the library marked kept flows: marked now, so a
    // rename takes keep's path and the recipe's file follows its name.
    if (video !== null && video.kept === undefined) {
      try {
        const marked = await deps.videos.setKept(videoId, { root, file: rel });
        if (!marked.ok)
          deps.log(
            `kept: ${rel}: the library could not mark flow ${videoId} as kept (${marked.reason})`,
          );
      } catch (error) {
        deps.log(
          `kept: ${rel}: the library could not mark flow ${videoId} as kept (${messageOf(error)})`,
        );
      }
    }
    if (notNow !== undefined) {
      return {
        refused: `${rel} was not rewritten: ${notNow}, so it still holds the earlier script`,
      };
    }
    if (video === null) {
      return {
        refused: `${rel} keeps video ${videoId}, which the library no longer has`,
      };
    }
    const made = await buildKept(
      {
        root,
        rootReal,
        video,
        outputs: old.outputs,
        report: old.report,
        deliver: old.deliver,
      },
      deps,
    );
    if (!made.ok)
      return { refused: `${rel} was not rewritten: ${made.detail}` };
    // The receipt keeps what the committed files show (their screens and
    // filmed code), which a rewrite does not replace; only the video and
    // revision it points at follow the recipe. A v1 file carries its own.
    let receipt: KeptReceipt | null = null;
    if (old.deliver === "commit") {
      const had = await readReceiptFile(join(root, receiptFile), receiptFile);
      const prior = "receipt" in had ? had.receipt : parsed.migrated;
      if (prior === null) {
        return {
          refused: `${rel} was not rewritten: ${"detail" in had ? had.detail : `${receiptFile} is missing`}, so what its outputs show is unknown`,
        };
      }
      receipt = {
        ...prior,
        video: made.from.takeId,
        recordedRevision: made.from.recordedRevision,
      };
    }
    try {
      if (made.kept.logo !== null && made.logoBytes !== null) {
        await place(join(root, made.kept.logo), made.logoBytes);
      }
      if (made.kept.wallpaper !== null && made.wallpaperBytes !== null) {
        await place(join(root, made.kept.wallpaper), made.wallpaperBytes);
      }
      if (receipt !== null) {
        await place(join(root, receiptFile), serializeReceipt(receipt));
      }
      await place(join(root, rel), serializeKept(made.kept));
    } catch (error) {
      return {
        refused: `${rel} could not be written (${messageOf(error)}), so it still describes the earlier video`,
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

export type RenameKeptAnswer =
  | { ok: true; file: string }
  | {
      ok: false;
      /** `keptCheckoutMissing`: the recipe or its receipt cannot be read;
       *  `nameTaken`: the library or the checkout has the name already;
       *  `keptUnwritable`: a write failed, or a path leaves the repo — its
       *  detail says which steps were done before it. */
      reason: "keptCheckoutMissing" | "nameTaken" | "keptUnwritable";
      detail: string;
    };

/**
 * A kept flow's rename: the recipe under the new name's file with its new
 * `name`, the receipt beside it, the library's record and its pointer, and
 * last the old recipe removed. Every check runs before anything is written,
 * so a refusal leaves the old name everywhere. A step that fails undoes
 * the ones before it, newest first, and the answer says so; an undo that
 * fails too is named with what it left. Never answers renamed on a failure.
 */
export async function renameKept(
  a: { root: string; file: string; name: string },
  deps: { videos: VideoStore },
): Promise<RenameKeptAnswer> {
  const refuse = (
    reason: "keptCheckoutMissing" | "nameTaken" | "keptUnwritable",
    detail: string,
  ): RenameKeptAnswer => ({ ok: false, reason, detail });
  const root = resolve(a.root);
  const rootReal = await realpath(root);
  // The record's file is checked before it is read: a link out of the repo
  // is neither read nor renamed.
  const own = await repoPath(root, rootReal, a.file, "keep");
  if (typeof own !== "string") {
    return refuse("keptUnwritable", `${own.outside}, so nothing was renamed`);
  }
  let text: string;
  try {
    text = await readFile(join(root, a.file), "utf8");
  } catch (error) {
    return refuse(
      "keptCheckoutMissing",
      `${a.file} in ${root} could not be read (${messageOf(error)}), so nothing was renamed`,
    );
  }
  const parsed = parseKept(text, a.file);
  if (!parsed.ok) {
    return refuse(
      "keptCheckoutMissing",
      `${parsed.detail}, so nothing was renamed`,
    );
  }
  const old = parsed.kept;
  const records = await deps.videos.list();
  const rec = records.find(
    (r): r is VideoRecord => !("unreadable" in r) && r.id === old.flow,
  );
  if (rec === undefined) {
    return refuse(
      "keptCheckoutMissing",
      `${a.file} keeps flow ${old.flow}, which this library does not have, so nothing was renamed`,
    );
  }
  const holder = records.find(
    (r): r is VideoRecord =>
      !("unreadable" in r) &&
      r.id !== rec.id &&
      sharesRepo(r.repo, rec.repo) &&
      sameName(r.name, a.name),
  );
  if (holder !== undefined) {
    return refuse(
      "nameTaken",
      `Another flow is already called "${holder.name}".`,
    );
  }
  const file = `${KEPT_DIR}/${keptFileName(a.name)}`;
  const oldReceipt = `${RECEIPT_DIR}/${basename(a.file)}`;
  const receipt = `${RECEIPT_DIR}/${keptFileName(a.name)}`;
  const moves = file !== a.file;
  for (const p of [file, oldReceipt, receipt]) {
    const inside = await repoPath(root, rootReal, p, "keep");
    if (typeof inside !== "string") {
      return refuse(
        "keptUnwritable",
        `${inside.outside}, so nothing was renamed`,
      );
    }
  }
  // The receipt goes with the recipe; a v1 recipe carries its own, which
  // the v2 recipe written below does not, so it is written out.
  let carry: (() => Promise<unknown>) | null = null;
  const had =
    old.deliver === "commit"
      ? await readReceiptFile(join(root, oldReceipt), oldReceipt)
      : ({ missing: true } as const);
  if (old.deliver === "commit") {
    if ("detail" in had) {
      return refuse(
        "keptCheckoutMissing",
        `${had.detail}, so nothing was renamed`,
      );
    }
    if ("receipt" in had && moves) {
      carry = () => rename(join(root, oldReceipt), join(root, receipt));
    } else if ("missing" in had && parsed.migrated !== null) {
      const migrated = parsed.migrated;
      carry = () => place(join(root, receipt), serializeReceipt(migrated));
    }
  }
  if (moves) {
    for (const p of carry === null ? [file] : [file, receipt]) {
      if (
        await lstat(join(root, p)).then(
          () => true,
          () => false,
        )
      ) {
        return refuse(
          "nameTaken",
          `${p} already exists in ${root}, so nothing was renamed`,
        );
      }
    }
  }
  // Each step: what it does, how it is undone, and what is left when the
  // undo fails too. The old recipe goes last, so until then a failure can
  // put every step back.
  type Step = {
    what: string;
    run: () => Promise<unknown>;
    undo: () => Promise<unknown>;
    left: string;
  };
  const failed = (r: { ok: boolean }, why: string) => {
    if (!r.ok) throw new Error(why);
  };
  const steps: Step[] = [
    {
      what: `write ${file}`,
      run: () =>
        place(join(root, file), serializeKept({ ...old, name: a.name })),
      undo: () =>
        moves ? rm(join(root, file)) : place(join(root, a.file), text),
      left: moves
        ? `${file} is left beside ${a.file}`
        : `${file} is left naming the flow "${a.name}"`,
    },
  ];
  if (carry !== null) {
    steps.push({
      what: `move ${oldReceipt} to ${receipt}`,
      run: carry,
      undo: () =>
        "missing" in had
          ? rm(join(root, receipt))
          : rename(join(root, receipt), join(root, oldReceipt)),
      left: `the receipt is left at ${receipt}`,
    });
  }
  steps.push(
    {
      what: "rename the library's flow",
      run: async () => {
        const r = await deps.videos.rename(rec.id, a.name);
        if (!r.ok) {
          throw new Error(
            r.reason === "nameTaken"
              ? `another flow is called "${r.holder.name}"`
              : `flow ${rec.id} is not in the library`,
          );
        }
      },
      undo: async () =>
        failed(
          await deps.videos.rename(rec.id, rec.name),
          `"${rec.name}" could not be given back`,
        ),
      left: `the library's flow is left named "${a.name}"`,
    },
    {
      what: `point the library's flow at ${file}`,
      run: async () =>
        failed(
          await deps.videos.setKept(rec.id, { root, file }),
          `flow ${rec.id} is not in the library`,
        ),
      undo: async () =>
        failed(
          await deps.videos.setKept(rec.id, rec.kept ?? null),
          `flow ${rec.id} is not in the library`,
        ),
      left: `the library's flow is left pointing at ${file}`,
    },
  );
  if (moves) {
    steps.push({
      what: `remove ${a.file}`,
      run: () => rm(join(root, a.file)),
      undo: async () => undefined,
      left: "",
    });
  }
  const done: Step[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      const left: string[] = [];
      for (const d of done.reverse()) {
        try {
          await d.undo();
        } catch (undoError) {
          left.push(`${d.left} (${messageOf(undoError)})`);
        }
      }
      return refuse(
        "keptUnwritable",
        `"${old.name}" was not renamed: could not ${step.what} (${messageOf(error)})${
          left.length === 0
            ? "; every step before it was undone, so the old name stands everywhere"
            : `, and not every step could be undone: ${left.join("; ")}`
        }`,
      );
    }
    done.push(step);
  }
  return { ok: true, file };
}

export async function readReceiptFile(
  path: string,
  rel: string,
): Promise<{ receipt: KeptReceipt } | { missing: true } | { detail: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { missing: true };
    return { detail: `${rel} could not be read (${messageOf(error)})` };
  }
  const parsed = parseReceipt(text, rel);
  return parsed.ok ? { receipt: parsed.receipt } : { detail: parsed.detail };
}

/** The code the run filmed, from its report; never re-read from git. */
function filmedCodeOf(
  report: Awaited<ReturnType<Library["getJson"]>> | null,
): FilmedCode {
  if (report === null) return { none: "no run report was read" };
  if ("missing" in report)
    return { none: "the run report is missing from the library" };
  if ("unreadable" in report)
    return { none: `the run report could not be read (${report.unreadable})` };
  return (
    (report.value as RunReport).filmedCode ?? {
      none: "the run report records no filmed code",
    }
  );
}

/** When the run started (ISO), from its report; null when not known. */
export function filmedAtOf(
  report: Awaited<ReturnType<Library["getJson"]>> | null,
): string | null {
  const at =
    report !== null && "value" in report
      ? (report.value as Partial<RunReport>).run?.startedAt
      : undefined;
  return typeof at === "number" && Number.isFinite(at)
    ? new Date(at).toISOString()
    : null;
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
 * A receipt whose video this library does not hold (a refresh filmed it in a
 * library thrown away after) is read by time: the library is ahead only
 * when its current version was made, or its scene saved, after the
 * receipt's video was filmed. A library that cannot be read, or a receipt
 * that does not say when, is said, never taken for "nothing newer".
 */
export async function libraryAhead(
  kept: KeptVideo,
  receipt: KeptReceipt | null,
  file: string,
  deps: { videos: VideoStore; library: Library },
): Promise<string | null> {
  try {
    const video = await deps.videos.get(kept.flow);
    // Kept on another machine: this library has nothing to be ahead of.
    if (video === null) return null;
    if (receipt === null) {
      return `${file} has no receipt to compare the library with; run \`demoman keep ${kept.name}\` again`;
    }
    const all = await deps.videos.versions(video.id);
    const current = all.filter((v) => v.complete).at(-1) ?? all.at(-1);
    if (current === undefined) return null;
    const read = await deps.library.getSceneRead(current.takeId);
    if (read === null) {
      return `the library's current video of "${kept.name}" (${current.takeId}) has no scene.json, so whether it is ahead of ${file} cannot be told`;
    }
    let since = "";
    if (all.some((v) => v.takeId === receipt.video)) {
      if (
        current.takeId === receipt.video &&
        read.revision === receipt.recordedRevision
      )
        return null;
    } else {
      if (receipt.filmedAt === null) {
        return `whether the library is ahead of ${file} cannot be told: its receipt names video ${receipt.video}, which this library does not have, and does not say when it was filmed`;
      }
      const filmed = Date.parse(receipt.filmedAt);
      const saved = (
        await stat(join(deps.library.takeDir(current.takeId), "scene.json"))
      ).mtimeMs;
      if (!(Date.parse(current.createdAt) > filmed || saved > filmed))
        return null;
      since = ` since it was filmed at ${receipt.filmedAt}`;
    }
    const left = leftBehind({
      from: current.takeId,
      notCarried: notCarriedOf(read.scene),
      notes: read.notes.map((sentence) => ({
        kind: "migrated" as const,
        sentence,
      })),
    });
    return `the library has a newer video or Studio edits not in ${file}${since}; run \`demoman keep ${kept.name}\` again to take them${left.length > 0 ? ` (keep will refuse the edits a re-film does not carry: ${left.join(", ")})` : ""}`;
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
