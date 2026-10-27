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
import {
  KEPT_DIR,
  KEPT_VERSION,
  type KeptOutput,
  type KeptVideo,
  keptFileName,
  parseKept,
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
  | { ok: true; file: string; kept: KeptVideo; written: string[] }
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

  // The script a re-film would run, and everything it leaves behind.
  const built = await refilmFromVideo(deps.videos, deps.library, video);
  if (!built.ok) {
    const { reason, detail } = built.refusal;
    return refuse(
      reason === "unfilledHoles" ? "unfilledHoles" : "cannotRefilm",
      reason === "unfilledHoles" ? detail : `${detail} (${reason})`,
    );
  }
  const left = [
    ...built.refilm.notCarried.map((n) => `${n.kind} ${n.id}`),
    ...built.refilm.notes.flatMap((n) =>
      n.kind === "migrated" ? [`migrated: ${n.sentence}`] : [],
    ),
  ];
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
    scale: scene.meta.capture.dpr,
    logo,
    outputs: args.to.map((o, i) => ({
      path: outputPaths[i] as string,
      fileType: o.fileType,
      aspect: o.aspect ?? scene.canvas.aspect,
      quality: o.quality,
    })),
    report,
    // The revision this file was built from: a later Studio edit changes it.
    from: {
      videoId: video.id,
      takeId: built.takeId,
      recordedRevision: read.revision,
    },
  };

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
    return { ok: true, file: fileRel, kept, written };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch((error: unknown) =>
      deps.log(`keep: ${temp} was not removed (${messageOf(error)})`),
    );
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
