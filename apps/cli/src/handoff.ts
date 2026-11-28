import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import {
  commitPathsOf,
  outputPathRefusal,
  repoRelative,
} from "@demoman/run-core";
import {
  type GitRunner,
  type RefreshResult,
  readKeptFlows,
} from "@demoman/runner/package";
import { toCommit } from "./deliver.js";

export const HANDOFF_VERSION = 1;

/** What the refresh job leaves for the deliver job: the result, and the
 *  files the commit takes, each stored under a plain numbered name. */
export type HandOff = {
  handoffVersion: 1;
  demoman: string;
  commit: string;
  named: boolean;
  result: RefreshResult;
  files: { path: string; stored: string }[];
  folders: string[];
};

const said = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export async function writeHandOff(
  dir: string,
  a: {
    repoRoot: string;
    result: RefreshResult;
    named: boolean;
    commit: string;
    version: string;
  },
): Promise<{ written: number } | { failed: string }> {
  const exists = await stat(dir).then(
    () => true,
    () => false,
  );
  if (exists) return { failed: `${dir} already exists` };
  let tmp: string | null = null;
  let step = "creating the temporary folder";
  try {
    tmp = await mkdtemp(join(dirname(dir), ".demoman-handoff-"));
    await mkdir(join(tmp, "files"));
    const files: HandOff["files"] = [];
    const folders: string[] = [];
    // Every carried file is also a numbered copy: names under the hand-off never start with a dot.
    const carry = async (path: string) => {
      if (files.some((f) => f.path === path)) return;
      const stored = `files/${files.length}`;
      step = `copying ${path}`;
      await copyFile(join(a.repoRoot, path), join(tmp as string, stored));
      files.push({ path, stored });
    };
    for (const v of a.result.videos.filter(toCommit)) {
      for (const out of v.outputs) {
        step = `reading ${out}`;
        const s = await stat(join(a.repoRoot, out)).catch(() => null);
        if (!s)
          return await undo(
            tmp,
            `${out}, which refresh says it wrote, is not in the checkout`,
          );
        if (!s.isDirectory()) {
          await carry(out);
          continue;
        }
        if (!folders.includes(out)) folders.push(out);
        const entries = await readdir(join(a.repoRoot, out), {
          withFileTypes: true,
        });
        for (const e of entries) {
          if (!e.isFile())
            return await undo(
              tmp,
              `${out}/${e.name} in a screens folder is not a plain file`,
            );
          await carry(`${out}/${e.name}`);
        }
      }
    }
    step = "writing handoff.json";
    const handoff: HandOff = {
      handoffVersion: HANDOFF_VERSION,
      demoman: a.version,
      commit: a.commit,
      named: a.named,
      result: a.result,
      files,
      folders,
    };
    await writeFile(join(tmp, "handoff.json"), JSON.stringify(handoff));
    step = `moving the hand-off to ${dir}`;
    await rename(tmp, dir);
    return { written: files.length };
  } catch (e) {
    return await undo(tmp, `${step}: ${said(e)}`);
  }
}

async function undo(tmp: string | null, failed: string) {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  return { failed };
}

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

/** Why a parsed handoff.json is not a hand-off this reader can check, or null. */
function shapeRefusal(h: Record<string, unknown>): string | null {
  const files = h.files as { path?: unknown; stored?: unknown }[];
  if (
    !Array.isArray(files) ||
    !files.every(
      (f) => typeof f?.path === "string" && typeof f.stored === "string",
    )
  )
    return "files must list a string path and stored for each";
  if (!strings(h.folders)) return "folders must list strings";
  const result = h.result as Record<string, unknown> | null;
  if (typeof result !== "object" || result === null)
    return "result is not an object";
  if (result.listError !== undefined && typeof result.listError !== "string")
    return "result.listError is not a string";
  if (!Array.isArray(result.videos)) return "result.videos is not a list";
  for (const [i, v] of result.videos.entries()) {
    if (typeof v !== "object" || v === null)
      return `result.videos[${i}] is not an object`;
    const bad = VIDEO_FIELDS.find(([k, , ok]) => !ok(v[k]));
    if (bad)
      return `result.videos[${i}] (${String(v.name)}): ${bad[0]} is not ${bad[1]}`;
  }
  return null;
}

const str = (x: unknown) => typeof x === "string";
const OUTCOMES: unknown[] = [
  "changed",
  "added",
  "uncompared",
  "unchanged",
  "failed",
];
/** Every field of a video that deliver() and refreshLines read, with its type. */
const VIDEO_FIELDS: [string, string, (x: unknown) => boolean][] = [
  ["name", "a string", str],
  ["file", "a string", str],
  ["detail", "a string", str],
  ["outcome", `one of ${OUTCOMES.join(", ")}`, (x) => OUTCOMES.includes(x)],
  [
    "deliver",
    '"commit", "files" or null',
    (x) => x === "commit" || x === "files" || x === null,
  ],
  ["outputs", "a list of strings", strings],
  ["line", "a string or null", (x) => x === null || str(x)],
  ["notes", "a list of strings", strings],
  ["fix", "a string or absent", (x) => x === undefined || str(x)],
  [
    "evidence",
    "absent or { folder, noStill }",
    (x) => {
      if (x === undefined) return true;
      const e = x as { folder?: unknown; noStill?: unknown } | null;
      return (
        typeof e === "object" &&
        e !== null &&
        str(e.folder) &&
        (e.noStill === null || str(e.noStill))
      );
    },
  ],
];

/** The deliver job's read of what the refresh job left. The refresh job ran
 *  the app's code, so every path is checked against the kept flows of this
 *  checkout before anything in it is touched; the first check that fails
 *  refuses the whole hand-off. */
export async function readHandOff(
  dir: string,
  a: { repoRoot: string; version: string; git: GitRunner },
): Promise<
  | {
      handOff: HandOff;
      place(): Promise<{ ok: true } | { failed: string }>;
    }
  | { refused: string }
> {
  const no = (refused: string) => ({ refused });
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(join(dir, "handoff.json"), "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error("it is not a JSON object");
  } catch (e) {
    return no(
      `the hand-off at ${dir} has no readable handoff.json (${said(e)})`,
    );
  }
  try {
    if (raw.handoffVersion !== HANDOFF_VERSION)
      return no(
        `the hand-off was written by a hand-off format this Demoman does not read (format ${JSON.stringify(raw.handoffVersion)}; this Demoman reads ${HANDOFF_VERSION})`,
      );
    if (raw.demoman !== a.version)
      return no(
        `the hand-off was written by demoman ${String(raw.demoman)}, delivered by ${a.version}; the workflow must pin one version`,
      );
    const head = await a.git(["rev-parse", "HEAD"], a.repoRoot);
    if (head.code !== 0)
      return no(
        `this checkout's HEAD could not be read (${head.stderr.trim()})`,
      );
    const at = head.stdout.trim();
    if (raw.commit !== at)
      return no(
        `refresh recorded at ${String(raw.commit)} and this checkout is at ${at}`,
      );
    const shape = shapeRefusal(raw);
    if (shape)
      return no(
        `the hand-off at ${dir} has no readable handoff.json (${shape})`,
      );
    const h = raw as HandOff;

    const paths = [...h.files.map((f) => f.path), ...h.folders];
    for (const p of paths)
      if (!repoRelative(p) || outputPathRefusal(p) !== null)
        return no(`the hand-off names ${p}, which no flow may write`);

    // The declared set comes from this checkout, never from the hand-off.
    const { entries } = await readKeptFlows(a.repoRoot);
    const files = new Set<string>();
    const screens = new Set<string>();
    for (const e of entries)
      if ("kept" in e && e.kept.deliver === "commit") {
        const c = commitPathsOf(e.kept, e.file);
        for (const f of c.files) files.add(f);
        screens.add(c.screens);
      }
    const undeclared = [
      ...h.files
        .map((f) => f.path)
        .filter((p) => !files.has(p) && !screens.has(posix.dirname(p))),
      ...h.folders.filter((p) => !screens.has(p)),
    ];
    if (undeclared.length > 0)
      return no(
        `the hand-off names ${undeclared[0]}, which no commit flow at ${at} declares`,
      );

    const videos = h.result.videos.filter(toCommit);
    for (const v of videos) {
      const e = entries.find((e) => e.file === v.file);
      if (e && "kept" in e && e.kept.deliver === "commit") continue;
      const why = e && "unreadable" in e ? ` (${e.unreadable})` : "";
      return no(
        `the hand-off delivers ${v.name} (${v.file}), which is not a commit flow here${why}`,
      );
    }

    const outputs = new Set(videos.flatMap((v) => v.outputs));
    const carried = new Set(h.files.map((f) => f.path));
    const disagree = [
      ...[...outputs].filter((o) => !carried.has(o) && !h.folders.includes(o)),
      ...h.files
        .map((f) => f.path)
        .filter(
          (p) => !outputs.has(p) && !h.folders.includes(posix.dirname(p)),
        ),
      ...h.folders.filter((f) => !outputs.has(f)),
    ];
    if (disagree.length > 0)
      return no(`the hand-off and its result disagree on ${disagree[0]}`);

    // Neither the record nor its folder may be a link: lstat on files/<n>
    // looks only at <n>, and would read through a linked files/.
    for (const top of ["handoff.json", "files"]) {
      const s = await lstat(join(dir, top)).catch(() => null);
      if (s?.isSymbolicLink())
        return no(
          `the hand-off's ${top} is a symlink, which a hand-off never holds`,
        );
    }

    for (const f of h.files) {
      // lstat, not stat: a symlink would carry whatever it points at.
      const why = !/^files\/[^/]+$/.test(f.stored)
        ? "outside files/"
        : await lstat(join(dir, f.stored)).then(
            (s) =>
              s.isFile()
                ? null
                : s.isSymbolicLink()
                  ? "a symlink"
                  : s.isDirectory()
                    ? "a folder"
                    : "not a plain file",
            (e: NodeJS.ErrnoException) => e.code ?? said(e),
          );
      if (why !== null)
        return no(
          `${f.stored} for ${f.path} is missing or not a plain file (${why})`,
        );
    }

    // Two levels, not a recursive readdir, which follows a linked folder.
    // Nothing deeper can be listed: files/<n> is a plain file or refused.
    const listed = new Set([
      "handoff.json",
      "files",
      ...h.files.map((f) => f.stored),
    ]);
    const held = [
      ...(await readdir(dir)),
      ...(
        await readdir(join(dir, "files")).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return [];
          throw e;
        })
      ).map((n) => `files/${n}`),
    ];
    for (const entry of held)
      if (!listed.has(entry))
        return no(
          `the hand-off holds ${entry}, which its handoff.json does not list`,
        );

    return { handOff: h, place: () => placeHandOff(dir, a.repoRoot, h) };
  } catch (e) {
    return no(`reading the hand-off at ${dir}: ${said(e)}`);
  }
}

/** Empties each carried folder, then copies each stored file to its path. */
async function placeHandOff(
  dir: string,
  repoRoot: string,
  h: HandOff,
): Promise<{ ok: true } | { failed: string }> {
  let step = "";
  try {
    for (const f of h.folders) {
      step = `emptying ${f}`;
      await rm(join(repoRoot, f), { recursive: true, force: true });
      await mkdir(join(repoRoot, f), { recursive: true });
    }
    for (const f of h.files) {
      step = `placing ${f.path}`;
      await mkdir(dirname(join(repoRoot, f.path)), { recursive: true });
      await copyFile(join(dir, f.stored), join(repoRoot, f.path));
    }
    return { ok: true };
  } catch (e) {
    return { failed: `${step}: ${said(e)}` };
  }
}
