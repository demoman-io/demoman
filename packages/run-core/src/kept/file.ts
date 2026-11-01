// The kept-video file: everything a re-film needs, committed under .demoman/videos/.
import { type DemoScript, DemoScriptSchema } from "@demoman/scene-schema";
import { EXPORT_QUALITY_VALUES, type ExportQuality } from "../export/target.js";
import { isFlowId } from "../served-words.js";
import { normaliseName } from "../video-name.js";
import { type KeptReceipt, parseScreens, RECEIPT_VERSION } from "./receipt.js";

export const KEPT_VERSION = 2;
/** The first format: screens and `from` lived in the recipe. Read, never written. */
const KEPT_V1 = 1;
/** Where a repo flow's recipe lives. */
export const FLOWS_DIR = ".demoman/flows";
/** Where repos added before `demoman add` keep them: read, and moved to
 *  FLOWS_DIR when the recipe is written next (repo-flows design, Part A). */
export const LEGACY_FLOWS_DIR = ".demoman/videos";

/** Where a flow's files go: into the repo at the recipe's paths, or into the
 *  caller's out dir by bare file name. */
export type KeptDeliver = "commit" | "files";

export type KeptOutput = {
  path: string;
  fileType: "mp4" | "gif";
  aspect: "auto" | "16:9" | "9:16";
  quality: ExportQuality;
};

/** The app's window on a screen, in the film's own output pixels, with its
 *  corners' radius (the compositor's `ScreenMoment.window`). */
export type KeptWindow = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
};
/** A still screen of the committed video: the step it follows (null for the
 *  opening) and when it ends, in output milliseconds. `window` is absent
 *  from a file kept before it was recorded (2026-10-28): refresh then
 *  compares that screen's whole picture. */
export type KeptMoment = {
  step: number | null;
  ms: number;
  window?: KeptWindow;
};
/** The same shape as the compositor's `Screens`: the file's format is owned
 *  here. `look` (`lookDigest`) is absent from a file kept before it. */
export type KeptScreens = {
  steps: number;
  moments: KeptMoment[];
  look?: string;
};

/** The output a refresh judges: the first non-9:16 MP4, else the first
 *  non-9:16, else the first MP4, else the first. */
export function judgedOutput(outputs: KeptOutput[]): number {
  const wide = (o: KeptOutput) => o.aspect !== "9:16";
  const mp4 = (o: KeptOutput) => o.fileType === "mp4";
  for (const pick of [
    (o: KeptOutput) => wide(o) && mp4(o),
    wide,
    mp4,
    () => true,
  ]) {
    const i = outputs.findIndex(pick);
    if (i >= 0) return i;
  }
  return 0;
}

export interface KeptVideo {
  keptVersion: 2;
  /** The flow's id. */
  flow: string;
  name: string;
  script: DemoScript;
  scale: number;
  logo: string | null;
  /** An uploaded image background's repo path, copied in by keep as the
   *  logo is; null for a built-in, a colour, or a file kept before
   *  wallpapers (the key is absent there). */
  wallpaper: string | null;
  deliver: KeptDeliver;
  /** Paths are repo-relative for `commit`, bare file names for `files`. */
  outputs: KeptOutput[];
  /** Likewise: a repo path, or a file name, or null. */
  report: string | null;
}

type Parsed =
  | { ok: true; kept: KeptVideo; migrated: KeptReceipt | null }
  | { ok: false; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A repo-relative posix path: not absolute, no `..`, no backslashes. */
const repoRelative = (p: unknown): p is string =>
  typeof p === "string" &&
  p !== "" &&
  !p.startsWith("/") &&
  !/^[A-Za-z]:/.test(p) &&
  !p.includes("\\") &&
  !p.split("/").includes("..");

/** A bare file name: what a `files` recipe's outputs are. */
const bareName = (p: unknown): p is string =>
  repoRelative(p) && !p.includes("/");

export function parseKept(text: string, file: string): Parsed {
  const bad = (what: string): Parsed => ({
    ok: false,
    detail: `${file}: ${what}`,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return bad(`is not valid JSON (${e instanceof Error ? e.message : e})`);
  }
  if (!isObj(raw)) return bad("is not a JSON object");
  const v1 = raw.keptVersion === KEPT_V1;
  if (!v1 && raw.keptVersion !== KEPT_VERSION)
    return bad(
      `keptVersion is ${JSON.stringify(raw.keptVersion)}; this Demoman reads ${KEPT_V1} and ${KEPT_VERSION}`,
    );
  if (typeof raw.name !== "string" || raw.name === "")
    return bad("name must be a non-empty string");
  const script = DemoScriptSchema.safeParse(raw.script);
  if (!script.success) {
    const i = script.error.issues[0];
    return bad(
      `script.${(i?.path ?? []).join(".")}: ${i?.message ?? "refused by the script schema"}`,
    );
  }
  if (typeof raw.scale !== "number" || !(raw.scale > 0))
    return bad("scale must be a positive number");
  if (raw.logo !== null && !repoRelative(raw.logo))
    return bad("logo must be null or a repo-relative path without ..");
  const wallpaper = raw.wallpaper ?? null;
  if (wallpaper !== null && !repoRelative(wallpaper))
    return bad("wallpaper must be null or a repo-relative path without ..");
  const deliver = v1 ? "commit" : raw.deliver;
  if (deliver !== "commit" && deliver !== "files")
    return bad('deliver must be "commit" or "files"');
  const pathOk = deliver === "files" ? bareName : repoRelative;
  const pathRule =
    deliver === "files"
      ? "a bare file name (no /, no ..)"
      : "repo-relative, posix, without ..";
  if (raw.report !== null && !pathOk(raw.report))
    return bad(`report must be null or ${pathRule}`);
  let flow: string;
  if (v1) {
    const f = raw.from;
    if (
      !isObj(f) ||
      typeof f.videoId !== "string" ||
      typeof f.takeId !== "string" ||
      typeof f.recordedRevision !== "string"
    )
      return bad("from needs string videoId, takeId and recordedRevision");
    if (!isFlowId(f.videoId))
      return bad(`from.videoId ${JSON.stringify(f.videoId)} is not a flow id`);
    flow = f.videoId;
  } else {
    if (typeof raw.flow !== "string" || !isFlowId(raw.flow))
      return bad(`flow ${JSON.stringify(raw.flow)} is not a flow id`);
    flow = raw.flow;
  }
  if (!Array.isArray(raw.outputs) || raw.outputs.length === 0)
    return bad("outputs must list at least one output");
  const outputs: KeptOutput[] = [];
  for (const [i, o] of raw.outputs.entries()) {
    if (!isObj(o)) return bad(`outputs[${i}] is not an object`);
    if (!pathOk(o.path))
      return bad(
        `outputs[${i}].path must be ${pathRule}; got ${JSON.stringify(o.path)}`,
      );
    if (o.fileType !== "mp4" && o.fileType !== "gif")
      return bad(`outputs[${i}].fileType must be "mp4" or "gif"`);
    if (o.aspect !== "auto" && o.aspect !== "16:9" && o.aspect !== "9:16")
      return bad(`outputs[${i}].aspect must be "auto", "16:9" or "9:16"`);
    if (!(EXPORT_QUALITY_VALUES as readonly unknown[]).includes(o.quality))
      return bad(
        `outputs[${i}].quality must be one of ${EXPORT_QUALITY_VALUES.join(", ")}`,
      );
    outputs.push({
      path: o.path,
      fileType: o.fileType,
      aspect: o.aspect,
      quality: o.quality as ExportQuality,
    });
  }
  let migrated: KeptReceipt | null = null;
  if (v1) {
    if (!isObj(raw.screens))
      return bad(
        `${raw.name} has no screens — it was kept before they were recorded; run \`demoman keep ${raw.name}\` again to record them`,
      );
    const sc = parseScreens(raw.screens, "screens");
    if (!sc.ok) return bad(sc.detail);
    const f = raw.from as Record<string, string>;
    migrated = {
      receiptVersion: RECEIPT_VERSION,
      flow,
      video: f.takeId as string,
      filmedAt: null,
      filmedCode: { none: "kept before receipts were recorded" },
      screens: sc.screens,
      recordedRevision: f.recordedRevision as string,
    };
  }
  return {
    ok: true,
    kept: {
      keptVersion: KEPT_VERSION,
      flow,
      name: raw.name,
      script: script.data,
      scale: raw.scale,
      logo: raw.logo,
      wallpaper,
      deliver,
      outputs,
      report: raw.report,
    },
    migrated,
  };
}

/** Two names the video library treats as equal give one file. */
export function keptFileName(name: string): string {
  return `${normaliseName(name).replace(/ /g, "-") || "video"}.json`;
}

export function serializeKept(k: KeptVideo): string {
  const ordered = {
    keptVersion: k.keptVersion,
    flow: k.flow,
    name: k.name,
    script: k.script,
    scale: k.scale,
    logo: k.logo,
    // Only when there is one: a file kept before wallpapers reads the same.
    ...(k.wallpaper === null ? {} : { wallpaper: k.wallpaper }),
    deliver: k.deliver,
    outputs: k.outputs.map((o) => ({
      path: o.path,
      fileType: o.fileType,
      aspect: o.aspect,
      quality: o.quality,
    })),
    report: k.report,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
