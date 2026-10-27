// The kept-video file: everything a re-film needs, committed under .demoman/videos/.
import { type DemoScript, DemoScriptSchema } from "@demoman/scene-schema";
import { EXPORT_QUALITY_VALUES, type ExportQuality } from "../export/target.js";
import { normaliseName } from "../video-name.js";

export const KEPT_VERSION = 1;
export const KEPT_DIR = ".demoman/videos";

export type KeptOutput = {
  path: string;
  fileType: "mp4" | "gif";
  aspect: "auto" | "16:9" | "9:16";
  quality: ExportQuality;
};

export interface KeptVideo {
  keptVersion: 1;
  name: string;
  script: DemoScript;
  scale: number;
  logo: string | null;
  outputs: KeptOutput[];
  report: string | null;
  from: { videoId: string; takeId: string; recordedRevision: string };
}

type Parsed = { ok: true; kept: KeptVideo } | { ok: false; detail: string };

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
  if (raw.keptVersion !== KEPT_VERSION)
    return bad(
      `keptVersion is ${JSON.stringify(raw.keptVersion)}; this Demoman reads ${KEPT_VERSION}`,
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
  if (raw.report !== null && !repoRelative(raw.report))
    return bad("report must be null or a repo-relative path without ..");
  if (!Array.isArray(raw.outputs) || raw.outputs.length === 0)
    return bad("outputs must list at least one output");
  const outputs: KeptOutput[] = [];
  for (const [i, o] of raw.outputs.entries()) {
    if (!isObj(o)) return bad(`outputs[${i}] is not an object`);
    if (!repoRelative(o.path))
      return bad(
        `outputs[${i}].path must be repo-relative, posix, without ..; got ${JSON.stringify(o.path)}`,
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
  const f = raw.from;
  if (
    !isObj(f) ||
    typeof f.videoId !== "string" ||
    typeof f.takeId !== "string" ||
    typeof f.recordedRevision !== "string"
  )
    return bad("from needs string videoId, takeId and recordedRevision");
  return {
    ok: true,
    kept: {
      keptVersion: KEPT_VERSION,
      name: raw.name,
      script: script.data,
      scale: raw.scale,
      logo: raw.logo,
      outputs,
      report: raw.report,
      from: {
        videoId: f.videoId,
        takeId: f.takeId,
        recordedRevision: f.recordedRevision,
      },
    },
  };
}

/** Two names the video library treats as equal give one file. */
export function keptFileName(name: string): string {
  return `${normaliseName(name).replace(/ /g, "-") || "video"}.json`;
}

export function serializeKept(k: KeptVideo): string {
  const ordered = {
    keptVersion: k.keptVersion,
    name: k.name,
    script: k.script,
    scale: k.scale,
    logo: k.logo,
    outputs: k.outputs.map((o) => ({
      path: o.path,
      fileType: o.fileType,
      aspect: o.aspect,
      quality: o.quality,
    })),
    report: k.report,
    from: {
      videoId: k.from.videoId,
      takeId: k.from.takeId,
      recordedRevision: k.from.recordedRevision,
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
