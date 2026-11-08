import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
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
  FLOWS_DIR,
  frameOf,
  judgedOutput,
  KEPT_VERSION,
  type KeptDeliver,
  type KeptOutput,
  type KeptReceipt,
  type KeptScreens,
  type KeptVideo,
  keptFileName,
  LEGACY_FLOWS_DIR,
  notCarriedOf,
  parseFilmedCode,
  parseKept,
  parseReceipt,
  RECEIPT_DIR,
  REFRESH_LIST_FILE,
  type RefilmInfo,
  type RunReport,
  screensDirOf,
  scriptDigest,
  serializeKept,
  serializeReceipt,
  servedRunReport,
  targetFor,
} from "@demoman/run-core";
import { DemoScriptSchema } from "@demoman/scene-schema";
import { messageOf } from "../report.js";
import { type AccountsFound, chooseAccount, findAccounts } from "./accounts.js";
import { type ExportDeps, exportTake } from "./export.js";
import { readKeptFlows, repoFlowFiles } from "./kept-flows.js";
import type { Library } from "./library.js";
import { readLogo } from "./logo-ref.js";
import { refilmFromVideo } from "./refilm.js";
import { type GitRunner, readRepo } from "./repo.js";
import { createSessionStore, type SessionFile, siteOf } from "./sessions.js";
import { sameName } from "./video-match.js";
import { sharesRepo, type VideoRecord, type VideoStore } from "./videos.js";
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
  /** The request itself is refused (a `files` output given as a path, or
   *  a name two flows in this repo share). */
  | "keepRefused"
  /** The recipe was written but the old file it replaces could not be
   *  removed: two files name the flow until it is deleted. */
  | "repoFlowUnwritable";

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
      /** The old `.demoman/videos/` file this keep moved here, or null. */
      moved: string | null;
      kept: KeptVideo;
      /** The repo key the library's mark records; null when the checkout
       *  has none. A page's own In repo paint uses it as the flow's project. */
      key: string | null;
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
  const here = await deps.videos.resolve(
    repo.ok ? { key: repo.repo.key } : { none: repo.none },
  );
  const records = await deps.videos.list();
  const mine = records.filter(
    (v): v is VideoRecord => !("unreadable" in v) && sharesRepo(v.repo, here),
  );
  const byName = mine.filter((v) => v.name === args.video);
  const byId = mine.find((v) => v.id === args.video);
  // Two keys merged into one repo can bring two flows of one name together.
  if (byId === undefined && byName.length > 1) {
    return refuse(
      "keepRefused",
      `${byName.length} flows in this repo are called "${args.video}" (${byName.map((v) => v.id).join(" and ")}), so nothing was added — pass the id of the one to add`,
    );
  }
  const video = byId ?? byName[0];
  if (video === undefined) {
    const unread = records.flatMap((v) =>
      "unreadable" in v ? [`${v.id}: ${v.unreadable}`] : [],
    );
    return refuse(
      "unknownVideo",
      `no flow "${args.video}" (an id or an exact name) in your library to add to this repo${mine.length > 0 ? `; the flows you can add are ${mine.map((v) => `"${v.name}"`).join(", ")}` : ""}${unread.length > 0 ? `; ${unread.length} flow record(s) could not be read (${unread.join("; ")})` : ""}`,
    );
  }

  // Every path keep writes, inside the repo once links are followed.
  const fileRel = `${FLOWS_DIR}/${keptFileName(video.name)}`;
  // The same file in the old folder: moved here when this keep writes.
  const legacyRel = `${LEGACY_FLOWS_DIR}/${basename(fileRel)}`;
  let moveFrom: string | null = null;
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
        `${p} is named twice by this add — give each output its own ${deliver === "files" ? "name" : "path"}`,
      );
    }
    paths.push(p);
  }
  const outputPaths = paths.slice(0, args.to.length);
  const report = args.report === undefined ? null : (paths.at(-1) ?? null);

  // The paths other kept videos already write.
  for (const rel of await repoFlowFiles(root)) {
    const name = basename(rel);
    const other = parseKept(await readFile(join(root, rel), "utf8"), rel);
    if (!other.ok) {
      deps.log(
        `${other.detail} — so its outputs were not checked against this add's`,
      );
      continue;
    }
    const { kept } = other;
    // Refused, not moved: keep writes only this keep's files, and moving
    // another recipe and its receipt is renameKept's, with its undo steps.
    if (rel === legacyRel && kept.flow === video.id) {
      const at = await inRepo(rel);
      if (typeof at !== "string") return refuse("outsideRepo", at.outside);
      moveFrom = rel;
      continue;
    }
    if (kept.flow === video.id && rel !== fileRel) {
      return refuse(
        "outputTaken",
        `${rel} already holds this flow (${video.id}), so adding it as "${video.name}" would write a second recipe for it, ${fileRel} — move ${rel} to ${fileRel}${kept.deliver === "commit" ? ` and ${RECEIPT_DIR}/${name} to ${receiptRel}` : ""}, then add it again`,
      );
    }
    if (rel === fileRel || rel === legacyRel) {
      if (kept.flow === video.id) continue;
      return refuse(
        "outputTaken",
        `${rel} already holds the flow "${kept.name}" (${kept.flow}), whose name makes the same file — rename one of the two flows`,
      );
    }
    const theirs = [...kept.outputs.map((o) => o.path), kept.report];
    const clash = paths.find((p) => theirs.includes(p));
    if (clash !== undefined) {
      return refuse(
        "outputTaken",
        `${clash} is already an output of the flow "${kept.name}" in ${rel} — choose another path, or remove it from ${rel}`,
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
    const judged = judgedOutput(base.outputs);
    for (const o of deliver === "files" ? [] : base.outputs) {
      deps.log(`add: exporting ${o.path}`);
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
      rendered.push(await readFile(answer.file.path));
    }
    // The images a refresh compares with: the judged output's screens alone.
    let screens: KeptScreens | undefined;
    let shots: { dir: string; size: { width: number; height: number } } | null =
      null;
    if (deliver === "commit") {
      const o = base.outputs[judged] as KeptOutput;
      deps.log(`add: rendering the screens of ${o.path}`);
      const shot = await exportTake(
        {
          takeId: built.takeId,
          fileType: o.fileType,
          aspect: o.aspect,
          unlisted: true,
          screensOnly: true,
          ...(o.fileType === "mp4" ? { quality: o.quality } : {}),
        },
        { ...deps.export, outDir: temp },
        () => undefined,
      );
      if (shot.outcome !== "saved" || shot.fileType !== "screens") {
        return refuse("exportFailed", `${o.path}'s screens: ${shot.summary}`);
      }
      if (shot.warnings.logo !== null) {
        return refuse(
          "logoUnreadable",
          `${o.path}'s screens were rendered without the logo: ${shot.warnings.logo}`,
        );
      }
      if (shot.warnings.wallpaperWarning?.kind === "leftOut") {
        return refuse(
          "wallpaperUnreadable",
          `${o.path}'s screens were rendered without the wallpaper: ${shot.warnings.wallpaperWarning.sentence}`,
        );
      }
      screens = shot.screens;
      shots = { dir: shot.folder.path, size: shot.size };
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
            receiptVersion: 2,
            screensDir: screensDirOf(receiptRel),
            screensSize: shots?.size ?? null,
            flow: video.id,
            video: built.takeId,
            filmedAt: filmedAtOf(runReport),
            filmedCode: filmedCodeOf(runReport),
            screens,
            recordedRevision: made.from.recordedRevision,
            scriptDigest: scriptDigest(kept.script),
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
            `add: ${report} is written by the next refresh — the run report of "${video.name}" ${"missing" in runReport ? "is missing" : `could not be read (${runReport.unreadable})`}`,
          );
        }
      }
      if (receipt !== null) {
        // Before the receipt, as the outputs are: it never names images
        // that are not there.
        if (shots !== null && receipt.screensDir !== null) {
          const at = join(dirname(receiptRel), receipt.screensDir);
          await placeFolder(join(root, at), shots.dir, deps.log);
          written.push(at);
        }
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
        ...(repo.ok && { key: repo.repo.key }),
      });
      if (!marked.ok) {
        markNote = `the library could not mark "${video.name}" as in the repo (${marked.reason}), so it will not show In repo until you add it again`;
      }
    } catch (error) {
      markNote = `the library could not mark "${video.name}" as in the repo (${messageOf(error)}), so it will not show In repo until you add it again`;
    }
    // After the mark: the new file is the flow's recipe either way, so the
    // library never points at the old one the refusal says to delete.
    if (moveFrom !== null) {
      try {
        await rm(join(root, moveFrom));
      } catch (error) {
        return refuse(
          "repoFlowUnwritable",
          `wrote ${written.join(", ")}, but could not remove the old ${moveFrom} (${messageOf(error)}), so two files now name "${video.name}" — delete ${moveFrom}${markNote === undefined ? "" : `; ${markNote}`}`,
        );
      }
    }
    return {
      ok: true,
      file: fileRel,
      moved: moveFrom,
      kept,
      key: repo.ok ? repo.repo.key : null,
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
            platformNote: `added on ${platform === "darwin" ? "macOS" : platform}: the first refresh in CI records it again on Linux, whose fonts differ, and replaces its outputs once; after that, refresh in CI only`,
          }),
    };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch((error: unknown) =>
      deps.log(`add: ${temp} was not removed (${messageOf(error)})`),
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

export type Vetted =
  | {
      ok: true;
      built: Extract<Awaited<ReturnType<typeof refilmFromVideo>>, { ok: true }>;
      read: NonNullable<Awaited<ReturnType<Library["getSceneRead"]>>>;
    }
  | { ok: false; reason: KeepRefusal; label: string; detail: string };

/**
 * Whether `video` can be added to the checkout at `root`: the one place
 * these checks are made, for `buildKept` and for `checkAddable`. In order:
 * re-film, edits left behind, scene present, account, hand sign-in.
 * `accounts` and `sessions` are caches a listing passes so each is read once.
 */
export async function vetForAdd(
  video: VideoRecord,
  root: string,
  deps: Pick<KeepDeps, "home" | "library" | "videos">,
  cache: {
    accounts?: Map<string, AccountsFound>;
    sessions?: SessionFile[];
  } = {},
): Promise<Vetted> {
  const refuse = (
    reason: KeepRefusal,
    label: string,
    detail: string,
  ): Vetted => ({ ok: false, reason, label, detail });
  const built = await refilmFromVideo(deps.videos, deps.library, video);
  if (!built.ok) {
    const { reason, detail } = built.refusal;
    return reason === "unfilledHoles"
      ? refuse("unfilledHoles", "has typed text the video never read", detail)
      : refuse(
          "cannotRefilm",
          "can't be recorded again",
          `${detail} (${reason})`,
        );
  }
  const left = leftBehind(built.refilm);
  if (left.length > 0) {
    const kind = built.refilm.notCarried[0]?.kind;
    return refuse(
      "notCarried",
      kind === undefined
        ? "has edits a new video does not carry"
        : (NOT_CARRIED_LABEL[kind] ?? `has a ${kind}`),
      `video ${built.takeId} of "${video.name}" has edits a new video does not carry, so a refresh would drop them: ${left.join(", ")} — remove them in the Studio, or record the flow again, then add it`,
    );
  }
  const read = await deps.library.getSceneRead(built.takeId);
  if (read === null) {
    return refuse(
      "cannotRefilm",
      "can't be recorded again",
      `video ${built.takeId} of "${video.name}" has no scene.json any more`,
    );
  }

  // A site signed in to by hand cannot be signed in to by a refresh in CI.
  const target = String(built.script.target);
  const named =
    typeof built.script.account === "string" ? built.script.account : undefined;
  let found = cache.accounts?.get(root);
  if (found === undefined) {
    found = await findAccounts(root);
    cache.accounts?.set(root, found);
  }
  const choice = chooseAccount(found, target, named);
  if (choice.kind === "refused")
    return refuse("cannotRefilm", "can't be recorded again", choice.detail);
  if (choice.kind === "manual") {
    const site = siteOf(target);
    const store = createSessionStore(deps.home);
    let saved = cache.sessions;
    if (saved === undefined) {
      try {
        saved = (await store.read()).files;
      } catch (error) {
        return refuse(
          "cannotRefilm",
          "can't be recorded again",
          `whether ${target} is signed in to by hand cannot be told: ${messageOf(error)}`,
        );
      }
      cache.sessions = saved;
    }
    // Every loopback port shares the `localhost` file, so a sign-in made to
    // another port is another local app's, not this flow's (DEM-46).
    const otherApp = (f: SessionFile) =>
      site === "localhost" &&
      portOf(f.startUrl) !== null &&
      portOf(f.startUrl) !== portOf(target);
    if (
      saved.some(
        (f) => f.account === undefined && f.site === site && !otherApp(f),
      )
    ) {
      return refuse(
        "handSignIn",
        "signed in by hand",
        `"${video.name}" records ${target}, which this machine signs in to with a session saved by hand (demoman signin, ${store.pathOf(site ?? "")}); a refresh in CI cannot sign in that way — add a demo account for ${new URL(target).origin} to .demoman/accounts.json, record the flow again as it, then add it`,
      );
    }
  }
  return { ok: true, built, read };
}

/** A URL's port, the scheme's default when it names none; null unparseable. */
function portOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}

const NOT_CARRIED_LABEL: Record<string, string> = {
  trim: "has a trim",
  removed: "has a cut",
  split: "has a split",
  mask: "has a mask",
  zoom: "has a placed zoom",
  hold: "has a hold",
  gap: "has a gap",
};

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
  const vetted = await vetForAdd(a.video, root, deps);
  if (!vetted.ok) return refuse(vetted.reason, vetted.detail);
  const { built, read } = vetted;
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
      ? `1x is a guess: "${video.name}" does not say the scale it was recorded at and has no motion frames to read one from, so refresh records it at 1x — if it was recorded at another scale, set "scale" in the recipe file to it, or the first refresh replaces a video that did not change`
      : null;

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
    const path = `${FLOWS_DIR}/${folder}/${basename(abs)}`;
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
  let files: string[];
  let duplicates: Awaited<ReturnType<typeof readKeptFlows>>["duplicates"];
  try {
    files = await repoFlowFiles(root);
    ({ duplicates } = await readKeptFlows(root));
  } catch (error) {
    return {
      refused: `the repo's flow folders could not be read (${messageOf(error)}), so whether a repo flow follows this run is unknown`,
    };
  }
  if (files.length === 0) return { none: true };
  const twice = duplicates.find((d) => d.flow === videoId);
  if (twice !== undefined) {
    return {
      refused: `${twice.files.join(" and ")} both name this flow — delete one of them; neither was rewritten`,
    };
  }
  const unreadable: string[] = [];
  for (const rel of files) {
    const name = basename(rel);
    let text: string;
    try {
      text = await readFile(join(root, rel), "utf8");
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
    // Or one marked at a file since moved (a teammate's add): re-pointed.
    if (
      video !== null &&
      (video.kept === undefined ||
        (video.kept.root === root && video.kept.file !== rel))
    ) {
      try {
        const read = await readRepo(root, deps.git);
        const marked = await deps.videos.setKept(videoId, {
          root,
          file: rel,
          ...(read.ok && { key: read.repo.key }),
        });
        if (!marked.ok)
          deps.log(
            `refresh: ${rel}: the library could not mark flow ${videoId} as in the repo (${marked.reason})`,
          );
      } catch (error) {
        deps.log(
          `refresh: ${rel}: the library could not mark flow ${videoId} as in the repo (${messageOf(error)})`,
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
    // The receipt describes the film that made the committed files, which
    // a rewrite does not replace, so it is left as it is. A v1 file carries
    // its own, which the v2 recipe written below does not: written out.
    let receipt: KeptReceipt | null = null;
    if (old.deliver === "commit") {
      const had = await readReceiptFile(join(root, receiptFile), receiptFile);
      if ("detail" in had || ("missing" in had && parsed.migrated === null)) {
        return {
          refused: `${rel} was not rewritten: ${"detail" in had ? had.detail : `${receiptFile} is missing`}, so what its outputs show is unknown`,
        };
      }
      if ("missing" in had) receipt = parsed.migrated;
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
    for (const u of unreadable) deps.log(`refresh: ${u}`);
    if (made.scaleGuess !== null)
      deps.log(`refresh: ${rel}: ${made.scaleGuess}`);
    return { rewritten: rel };
  }
  return unreadable.length > 0
    ? {
        refused: `${unreadable.join("; ")} — so whether a repo flow follows this run is unknown`,
      }
    : { none: true };
}

export type RenameKeptAnswer =
  | { ok: true; file: string }
  | {
      ok: false;
      /** `repoCheckoutMissing`: the recipe or its receipt cannot be read;
       *  `nameTaken`: the library or the checkout has the name already;
       *  `repoFlowUnwritable`: a write failed, or a path leaves the repo — its
       *  detail says which steps were done before it. */
      reason: "repoCheckoutMissing" | "nameTaken" | "repoFlowUnwritable";
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
    reason: "repoCheckoutMissing" | "nameTaken" | "repoFlowUnwritable",
    detail: string,
  ): RenameKeptAnswer => ({ ok: false, reason, detail });
  const root = resolve(a.root);
  const rootReal = await realpath(root);
  // The record's file is checked before it is read: a link out of the repo
  // is neither read nor renamed.
  const own = await repoPath(root, rootReal, a.file, "keep");
  if (typeof own !== "string") {
    return refuse(
      "repoFlowUnwritable",
      `${own.outside}, so nothing was renamed`,
    );
  }
  let text: string;
  try {
    text = await readFile(join(root, a.file), "utf8");
  } catch (error) {
    return refuse(
      "repoCheckoutMissing",
      `${a.file} in ${root} could not be read (${messageOf(error)}), so nothing was renamed`,
    );
  }
  const parsed = parseKept(text, a.file);
  if (!parsed.ok) {
    return refuse(
      "repoCheckoutMissing",
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
      "repoCheckoutMissing",
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
  const file = `${FLOWS_DIR}/${keptFileName(a.name)}`;
  const oldReceipt = `${RECEIPT_DIR}/${basename(a.file)}`;
  const receipt = `${RECEIPT_DIR}/${keptFileName(a.name)}`;
  const moves = file !== a.file;
  for (const p of [file, oldReceipt, receipt]) {
    const inside = await repoPath(root, rootReal, p, "keep");
    if (typeof inside !== "string") {
      return refuse(
        "repoFlowUnwritable",
        `${inside.outside}, so nothing was renamed`,
      );
    }
  }
  // The receipt goes with the recipe; a v1 recipe carries its own, which
  // the v2 recipe written below does not, so it is written out.
  let carry: (() => Promise<unknown>) | null = null;
  // The receipt's screen folder goes with it: the old name is free to be
  // kept again, and must not take the folder a renamed flow reads.
  let screens: { from: string; to: string; receipt: KeptReceipt } | null = null;
  const had =
    old.deliver === "commit"
      ? await readReceiptFile(join(root, oldReceipt), oldReceipt)
      : ({ missing: true } as const);
  if (old.deliver === "commit") {
    if ("detail" in had) {
      return refuse(
        "repoCheckoutMissing",
        `${had.detail}, so nothing was renamed`,
      );
    }
    // A move to the same file name in the new folder keeps its receipt.
    if ("receipt" in had && moves && receipt !== oldReceipt) {
      carry = () => rename(join(root, oldReceipt), join(root, receipt));
      if (had.receipt.screensDir !== null) {
        screens = {
          from: `${RECEIPT_DIR}/${had.receipt.screensDir}`,
          to: `${RECEIPT_DIR}/${screensDirOf(receipt)}`,
          receipt: had.receipt,
        };
      }
    } else if ("missing" in had && parsed.migrated !== null) {
      const migrated = parsed.migrated;
      carry = () => place(join(root, receipt), serializeReceipt(migrated));
    }
  }
  // A file of the new name in the old folder would be a second recipe for
  // it (readKeptFlows refuses both), unless it is the one being moved.
  const legacy = `${LEGACY_FLOWS_DIR}/${keptFileName(a.name)}`;
  if (moves) {
    for (const p of [
      file,
      ...(carry === null ? [] : [receipt]),
      ...(screens === null ? [] : [screens.to]),
      ...(legacy === a.file ? [] : [legacy]),
    ]) {
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
  if (screens !== null) {
    const { from, to, receipt: r } = screens;
    steps.push(
      {
        what: `move ${from} to ${to}`,
        run: () => rename(join(root, from), join(root, to)),
        undo: () => rename(join(root, to), join(root, from)),
        left: `the screens are left at ${to}`,
      },
      {
        what: `point ${receipt} at ${to}`,
        run: () =>
          place(
            join(root, receipt),
            serializeReceipt({ ...r, screensDir: screensDirOf(receipt) }),
          ),
        undo: () => place(join(root, receipt), serializeReceipt(r)),
        left: `${receipt} is left naming ${to}`,
      },
    );
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
          await deps.videos.setKept(rec.id, {
            root,
            file,
            // The mark is renamed in place: its repo is the one it named.
            ...(rec.kept?.root === root &&
              rec.kept.key !== undefined && { key: rec.kept.key }),
          }),
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
        "repoFlowUnwritable",
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
  return filmedCodeIn(report.value);
}

/** A report's filmedCode, or why it has none: a malformed one is unknown,
 *  said, and never copied into a receipt. */
export function filmedCodeIn(report: unknown): FilmedCode {
  const raw = (report as { filmedCode?: unknown } | null)?.filmedCode;
  if (raw === undefined)
    return { none: "the run report does not say which commit it recorded" };
  return (
    parseFilmedCode(raw) ?? {
      none: `the run report's filmedCode is malformed (${JSON.stringify(raw)}), so the filmed code is unknown`,
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
      // add writes a files flow no receipt: an earlier refresh's --out-dir has it.
      return kept.deliver === "files"
        ? `${file} delivers files, whose receipt comes from --previous (an earlier refresh's --out-dir); with none, whether the library is ahead of it cannot be told`
        : `${file} has no receipt to compare the library with; run \`demoman add ${kept.name}\` again`;
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
        return `whether the library is ahead of ${file} cannot be told: its receipt names video ${receipt.video}, which this library does not have, and does not say when it was recorded`;
      }
      // No clock-free order exists here: the receipt's video was filmed in a
      // library thrown away after (CI's), so nothing in this one names it.
      // Two machines' clocks are compared, so skew can flip the answer only
      // for a version made or saved within that skew (seconds, under NTP)
      // of the film; the note says it went by time.
      const filmed = Date.parse(receipt.filmedAt);
      const saved = (
        await stat(join(deps.library.takeDir(current.takeId), "scene.json"))
      ).mtimeMs;
      if (!(Date.parse(current.createdAt) > filmed || saved > filmed))
        return null;
      since = ` (going by time: made or edited after it was recorded at ${receipt.filmedAt}, by that machine's clock)`;
    }
    // The skeleton says whether a Studio tail can be written back, as the
    // re-record that `add` runs reads it.
    const skeleton = await deps.library.getSkeleton(current.takeId);
    const left = leftBehind({
      from: current.takeId,
      notCarried: notCarriedOf(
        read.scene,
        skeleton.kind === "ok" ? skeleton.skeleton : undefined,
      ),
      notes: read.notes.map((sentence) => ({
        kind: "migrated" as const,
        sentence,
      })),
    });
    return `the library has a newer video or Studio edits not in ${file}${since}; run \`demoman add ${kept.name}\` again to take them${left.length > 0 ? ` (add will refuse the edits a new video does not carry: ${left.join(", ")})` : ""}`;
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
    outside: `${path} is not inside the repo at ${root} (it resolves to ${real ?? "a link to nothing"}) — ${who === "keep" ? "add" : "refresh"} writes only into the repo the flow is in`,
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

/**
 * `place` for a folder: `from`'s files are copied into a finished folder
 * beside `dest`, which then takes its name by rename, so `dest` is never
 * half written. The folder it replaces is moved aside first and removed
 * after; one that will not go is said to `log`, never a failed place.
 * Returns the temp folder's path.
 */
export async function placeFolder(
  dest: string,
  from: string,
  log: (line: string) => void,
): Promise<string> {
  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.${randomUUID()}.tmp`;
  const aside = `${dest}.${randomUUID()}.old`;
  let moved = false;
  try {
    await cp(from, temp, { recursive: true });
    moved = await rename(dest, aside).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      },
    );
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    if (moved)
      await rename(aside, dest).catch((back: unknown) => {
        throw new Error(
          `${messageOf(error)}, and the folder it was replacing could not be put back from ${aside} (${messageOf(back)})`,
        );
      });
    throw error;
  }
  if (moved)
    await rm(aside, { recursive: true, force: true }).catch((error: unknown) =>
      log(`refresh: ${aside} was not removed (${messageOf(error)})`),
    );
  return temp;
}

export type RemoveAnswer =
  | {
      ok: true;
      name: string;
      removed: string[];
      exportsLeft: string[];
      /** Said when the library's mark on the flow could not be cleared. */
      markNote?: string;
    }
  | {
      ok: false;
      reason: "notInRepo" | "duplicateFlow" | "repoFlowUnwritable";
      detail: string;
    };

/**
 * `demoman remove`: a repo flow's recipe and its receipt deleted, its
 * committed exports left where they are (docs may link them). The flow is
 * found by id or exact name among the repo's files. Given the library, its
 * mark on the flow is cleared when it names the removed recipe, so the
 * Studio does not show a recipe that is gone. A refusal removes nothing; a
 * receipt that cannot be removed after the recipe went is said with the
 * file left behind.
 */
export async function removeRepoFlow(
  a: { root: string; flow: string },
  deps?: { videos: VideoStore },
): Promise<RemoveAnswer> {
  const refuse = (
    reason: "notInRepo" | "duplicateFlow" | "repoFlowUnwritable",
    detail: string,
  ): RemoveAnswer => ({ ok: false, reason, detail });
  const root = resolve(a.root);
  const rootReal = await realpath(root);
  const { entries, duplicates } = await readKeptFlows(root);
  const flows = entries.flatMap((e) => ("kept" in e ? [e] : []));
  const matches = flows.filter(
    (e) => e.kept.flow === a.flow || e.kept.name === a.flow,
  );
  if (matches.length === 0) {
    const unread = entries.flatMap((e) =>
      "unreadable" in e ? [e.unreadable] : [],
    );
    return refuse(
      "notInRepo",
      `this repo has no flow "${a.flow}" (an id or an exact name)${flows.length > 0 ? `; its flows are ${flows.map((e) => `"${e.kept.name}"`).join(", ")}` : "; it has none"}${unread.length > 0 ? `; ${unread.length} file(s) could not be read (${unread.join("; ")})` : ""}`,
    );
  }
  const files = matches.map((e) => e.file);
  const dup = duplicates.find((d) => files.some((f) => d.files.includes(f)));
  if (dup !== undefined || matches.length > 1) {
    const named = dup?.files ?? files;
    return refuse(
      "duplicateFlow",
      `${named.join(" and ")} both name "${a.flow}" — delete one of them, then remove again; nothing was removed`,
    );
  }
  const [{ file, kept }] = matches as [(typeof matches)[number]];
  const receipt = `${RECEIPT_DIR}/${basename(file)}`;
  for (const p of [file, receipt]) {
    let inside: Awaited<ReturnType<typeof repoPath>>;
    try {
      inside = await repoPath(root, rootReal, p, "keep");
    } catch (error) {
      return refuse(
        "repoFlowUnwritable",
        `whether ${p} is there cannot be told (${messageOf(error)}), so nothing was removed`,
      );
    }
    if (typeof inside !== "string") {
      return refuse(
        "repoFlowUnwritable",
        `${inside.outside}, so nothing was removed`,
      );
    }
  }
  // Only "no such file" is absence: any other error is not knowing.
  const there = (p: string): Promise<boolean | { unknown: string }> =>
    lstat(join(root, p)).then(
      () => true,
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? false : { unknown: messageOf(error) },
    );
  const receiptThere = await there(receipt);
  if (typeof receiptThere !== "boolean") {
    return refuse(
      "repoFlowUnwritable",
      `whether ${receipt} is there cannot be told (${receiptThere.unknown}), so nothing was removed`,
    );
  }
  try {
    await rm(join(root, file));
  } catch (error) {
    return refuse(
      "repoFlowUnwritable",
      `could not remove ${file} (${messageOf(error)}), so nothing was removed`,
    );
  }
  const removed = [file];
  if (receiptThere) {
    try {
      await rm(join(root, receipt));
      removed.push(receipt);
    } catch (error) {
      return refuse(
        "repoFlowUnwritable",
        `removed ${file}, but could not remove its receipt (${messageOf(error)}) — delete ${receipt}`,
      );
    }
  }
  const screensDir = `${RECEIPT_DIR}/${screensDirOf(receipt)}`;
  const screensThere = await there(screensDir);
  if (screensThere === true) {
    try {
      await rm(join(root, screensDir), { recursive: true });
      removed.push(screensDir);
    } catch (error) {
      return refuse(
        "repoFlowUnwritable",
        `removed ${file}, but could not remove its screens (${messageOf(error)}) — delete ${screensDir}`,
      );
    }
  } else if (screensThere !== false) {
    return refuse(
      "repoFlowUnwritable",
      `removed ${file}, but whether ${screensDir} is there cannot be told (${screensThere.unknown}) — delete it if it is`,
    );
  }
  // Remove never touches an export: one not known to be absent is listed.
  const exportsLeft: string[] = [];
  if (kept.deliver === "commit") {
    for (const o of kept.outputs)
      if ((await there(o.path)) !== false) exportsLeft.push(o.path);
  }
  let markNote: string | undefined;
  if (deps !== undefined) {
    const unmark = (why: string) =>
      `the library still marks "${kept.name}" as in the repo (${why}); the Studio shows it In repo until it is cleared`;
    try {
      const record = await deps.videos.get(kept.flow);
      if (record?.kept?.root === root && record.kept.file === file) {
        const cleared = await deps.videos.setKept(kept.flow, null);
        if (!cleared.ok) markNote = unmark(cleared.reason);
      }
    } catch (error) {
      markNote = unmark(messageOf(error));
    }
  }
  return {
    ok: true,
    name: kept.name,
    removed,
    exportsLeft,
    ...(markNote === undefined ? {} : { markNote }),
  };
}
