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

/** A still screen of the committed video: the step it follows (null for the
 *  opening) and when it ends, in output milliseconds. */
export type KeptMoment = { step: number | null; ms: number };
/** The same shape as the compositor's `Screens`: the file's format is owned here. */
export type KeptScreens = { steps: number; moments: KeptMoment[] };

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
  keptVersion: 1;
  name: string;
  script: DemoScript;
  scale: number;
  logo: string | null;
  /** An uploaded image background's repo path, copied in by keep as the
   *  logo is; null for a built-in, a colour, or a file kept before
   *  wallpapers (the key is absent there). */
  wallpaper: string | null;
  outputs: KeptOutput[];
  screens: KeptScreens;
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
  const wallpaper = raw.wallpaper ?? null;
  if (wallpaper !== null && !repoRelative(wallpaper))
    return bad("wallpaper must be null or a repo-relative path without ..");
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
  const sc = raw.screens;
  if (!isObj(sc))
    return bad(
      `${raw.name} has no screens — it was kept before they were recorded; run \`demoman keep ${raw.name}\` again to record them`,
    );
  if (!Number.isInteger(sc.steps) || (sc.steps as number) < 0)
    return bad("screens.steps must be a whole number of steps");
  if (!Array.isArray(sc.moments) || sc.moments.length === 0)
    return bad("screens.moments must list at least one still screen");
  const moments: KeptMoment[] = [];
  const seen = new Set<number | null>();
  for (const [i, m] of sc.moments.entries()) {
    const at = `screens.moments[${i}]`;
    if (!isObj(m)) return bad(`${at} is not an object`);
    if (typeof m.ms !== "number" || !Number.isFinite(m.ms) || m.ms < 0)
      return bad(`${at}.ms must be a non-negative number`);
    if (m.ms <= (moments[i - 1]?.ms ?? -1))
      return bad(`${at}.ms must be greater than the one before it`);
    if (m.step !== null) {
      if (!Number.isInteger(m.step) || (m.step as number) < 0)
        return bad(`${at}.step must be null or a whole step number`);
      if ((m.step as number) >= (sc.steps as number))
        return bad(
          `${at}.step ${m.step} is not below screens.steps ${sc.steps}`,
        );
      if (seen.has(m.step as number))
        return bad(`${at}.step ${m.step} is named by an earlier moment`);
      seen.add(m.step as number);
    } else if (seen.has(null))
      return bad(`${at}.step is a second final screen`);
    else seen.add(null);
    moments.push({ step: m.step as number | null, ms: m.ms });
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
      wallpaper,
      outputs,
      screens: { steps: sc.steps as number, moments },
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
    // Only when there is one: a file kept before wallpapers reads the same.
    ...(k.wallpaper === null ? {} : { wallpaper: k.wallpaper }),
    outputs: k.outputs.map((o) => ({
      path: o.path,
      fileType: o.fileType,
      aspect: o.aspect,
      quality: o.quality,
    })),
    screens: {
      steps: k.screens.steps,
      moments: k.screens.moments.map((m) => ({ step: m.step, ms: m.ms })),
    },
    report: k.report,
    from: {
      videoId: k.from.videoId,
      takeId: k.from.takeId,
      recordedRevision: k.from.recordedRevision,
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
