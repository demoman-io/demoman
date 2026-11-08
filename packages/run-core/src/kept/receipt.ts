// The receipt: what a kept flow's committed files show, written beside the
// recipe (.demoman/videos/) under .demoman/receipts/.

import { isInstant } from "../app/file.js";
import { type FilmedCode, parseFilmedCode } from "../replay/report.js";
import { isFlowId } from "../served-words.js";
import type { KeptMoment, KeptScreens } from "./file.js";

export const RECEIPT_VERSION = 2;
export const RECEIPT_DIR = ".demoman/receipts";

export type KeptReceipt = {
  /** 2 when it names a screen folder; 1 when it names none. */
  receiptVersion: 1 | 2;
  flow: string;
  /** The take id of the video the files were rendered from. */
  video: string;
  /** When that video's run started (ISO), from its report; null when it is
   *  not known, which is never read as "now". */
  filmedAt: string | null;
  filmedCode: FilmedCode;
  screens: KeptScreens;
  /** The scene revision the files were built from; `libraryAhead` reads it. */
  recordedRevision: string | null;
  /** The folder of still screen images, relative to the receipt's folder;
   *  null exactly when receiptVersion is 1. */
  screensDir: string | null;
  /** The output target's size, which the screens' windows are measured in;
   *  null exactly when receiptVersion is 1. */
  screensSize: { width: number; height: number } | null;
  /** `scriptDigest` of the script the committed files were delivered from;
   *  absent from a receipt written before it was recorded. */
  scriptDigest?: string;
  /** The instant the video was recorded at, when the repo pinned one
   *  (`now` in app.json, DEM-79); absent when it was not pinned. */
  pinnedNow?: string;
};

/** The folder a receipt's screen images live in, beside it: `order.json`
 *  names `order.screens`. */
export function screensDirOf(receiptFile: string): string {
  const base = receiptFile.split(/[\\/]/).pop() ?? receiptFile;
  return `${base.replace(/\.json$/, "")}.screens`;
}

const isWholePixels = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) > 0;

type Screens =
  | { ok: true; screens: KeptScreens }
  | { ok: false; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The one check of a screens object, whichever file holds it. `at` names
 *  the field in each message ("screens"). */
export function parseScreens(sc: unknown, at: string): Screens {
  const bad = (what: string): Screens => ({ ok: false, detail: what });
  if (!isObj(sc)) return bad(`${at} is not an object`);
  if (!Number.isInteger(sc.steps) || (sc.steps as number) < 0)
    return bad(`${at}.steps must be a whole number of steps`);
  if (!Array.isArray(sc.moments) || sc.moments.length === 0)
    return bad(`${at}.moments must list at least one still screen`);
  const moments: KeptMoment[] = [];
  const seen = new Set<number | null>();
  for (const [i, m] of sc.moments.entries()) {
    const mAt = `${at}.moments[${i}]`;
    if (!isObj(m)) return bad(`${mAt} is not an object`);
    if (typeof m.ms !== "number" || !Number.isFinite(m.ms) || m.ms < 0)
      return bad(`${mAt}.ms must be a non-negative number`);
    if (m.ms <= (moments[i - 1]?.ms ?? -1))
      return bad(`${mAt}.ms must be greater than the one before it`);
    if (m.step !== null) {
      if (!Number.isInteger(m.step) || (m.step as number) < 0)
        return bad(`${mAt}.step must be null or a whole step number`);
      if ((m.step as number) >= (sc.steps as number))
        return bad(
          `${mAt}.step ${m.step} is not below ${at}.steps ${sc.steps}`,
        );
      if (seen.has(m.step as number))
        return bad(`${mAt}.step ${m.step} is named by an earlier moment`);
      seen.add(m.step as number);
    } else if (seen.has(null))
      return bad(`${mAt}.step is a second final screen`);
    else seen.add(null);
    const w = m.window;
    if (w !== undefined) {
      if (!isObj(w)) return bad(`${mAt}.window is not an object`);
      // Numbers, finite, each: a string or Infinity would pass a bare `> 0`.
      for (const [key, least] of [
        ["x", null],
        ["y", null],
        ["width", "positive"],
        ["height", "positive"],
        ["radius", "0 or more"],
      ] as const) {
        const v = w[key];
        if (
          typeof v !== "number" ||
          !Number.isFinite(v) ||
          (least === "positive" && v <= 0) ||
          (least === "0 or more" && v < 0)
        )
          return bad(
            `${mAt}.window.${key} must be a finite number${least === null ? "" : `, ${least}`}`,
          );
      }
    }
    moments.push({
      step: m.step as number | null,
      ms: m.ms,
      ...(isObj(w)
        ? {
            window: {
              x: w.x as number,
              y: w.y as number,
              width: w.width as number,
              height: w.height as number,
              radius: w.radius as number,
            },
          }
        : {}),
    });
  }
  if (sc.look !== undefined && (typeof sc.look !== "string" || sc.look === ""))
    return bad(`${at}.look must be a non-empty string`);
  return {
    ok: true,
    screens: {
      steps: sc.steps as number,
      moments,
      ...(typeof sc.look === "string" ? { look: sc.look } : {}),
    },
  };
}

type Parsed =
  | { ok: true; receipt: KeptReceipt }
  | { ok: false; detail: string };

export function parseReceipt(text: string, file: string): Parsed {
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
  if (raw.receiptVersion !== 1 && raw.receiptVersion !== 2)
    return bad(
      `receiptVersion is ${JSON.stringify(raw.receiptVersion)}; this Demoman reads 1 and 2`,
    );
  const receiptVersion: 1 | 2 = raw.receiptVersion === 2 ? 2 : 1;
  if (typeof raw.flow !== "string" || !isFlowId(raw.flow))
    return bad("flow must be a flow id");
  if (typeof raw.video !== "string" || raw.video === "")
    return bad("video must be a non-empty string");
  // Missing in a receipt written before it was recorded: unknown.
  const filmedAt = raw.filmedAt ?? null;
  if (
    filmedAt !== null &&
    (typeof filmedAt !== "string" || Number.isNaN(Date.parse(filmedAt)))
  )
    return bad("filmedAt must be an ISO time or null");
  const filmedCode = parseFilmedCode(raw.filmedCode);
  if (filmedCode === null)
    return bad("filmedCode must be { commit, tree, dirty } or { none: <why> }");
  const recordedRevision = raw.recordedRevision;
  if (recordedRevision !== null && typeof recordedRevision !== "string")
    return bad("recordedRevision must be a string or null");
  const screens = parseScreens(raw.screens, "screens");
  if (!screens.ok) return bad(screens.detail);
  let screensDir: string | null = null;
  let screensSize: KeptReceipt["screensSize"] = null;
  if (receiptVersion === 2) {
    const dir = raw.screensDir;
    if (
      typeof dir !== "string" ||
      dir === "" ||
      dir.startsWith("/") ||
      dir.split(/[\\/]/).includes("..")
    )
      return bad("screensDir must be a folder beside the receipt");
    const size = raw.screensSize;
    if (
      !isObj(size) ||
      !isWholePixels(size.width) ||
      !isWholePixels(size.height)
    )
      return bad("screensSize must be { width, height } in whole pixels");
    screensDir = dir;
    screensSize = { width: size.width, height: size.height };
  } else if (raw.screensDir !== undefined || raw.screensSize !== undefined)
    return bad("screensDir needs receiptVersion 2");
  const digest = raw.scriptDigest;
  if (digest !== undefined && (typeof digest !== "string" || digest === ""))
    return bad("scriptDigest must be a non-empty string");
  const pinned = raw.pinnedNow;
  if (
    pinned !== undefined &&
    (typeof pinned !== "string" || !isInstant(pinned))
  )
    return bad("pinnedNow must be an ISO 8601 instant with a zone");
  return {
    ok: true,
    receipt: {
      receiptVersion,
      flow: raw.flow,
      video: raw.video,
      filmedAt,
      filmedCode,
      screens: screens.screens,
      recordedRevision,
      screensDir,
      screensSize,
      ...(digest === undefined ? {} : { scriptDigest: digest }),
      ...(pinned === undefined ? {} : { pinnedNow: pinned }),
    },
  };
}

export function serializeReceipt(r: KeptReceipt): string {
  if ((r.screensDir === null) !== (r.screensSize === null))
    throw new Error(
      "a receipt names its screen folder and size together, or neither",
    );
  const ordered = {
    // Version 2 only when it names a folder, so no receipt names one nobody wrote.
    receiptVersion: r.screensDir === null ? 1 : 2,
    flow: r.flow,
    video: r.video,
    filmedAt: r.filmedAt,
    filmedCode: r.filmedCode,
    recordedRevision: r.recordedRevision,
    ...(r.scriptDigest === undefined ? {} : { scriptDigest: r.scriptDigest }),
    ...(r.pinnedNow === undefined ? {} : { pinnedNow: r.pinnedNow }),
    ...(r.screensDir === null || r.screensSize === null
      ? {}
      : { screensDir: r.screensDir, screensSize: r.screensSize }),
    // `window` and `look` only when recorded, as the recipe once wrote them.
    screens: {
      steps: r.screens.steps,
      moments: r.screens.moments.map((m) => ({
        step: m.step,
        ms: m.ms,
        ...(m.window === undefined
          ? {}
          : {
              window: {
                x: m.window.x,
                y: m.window.y,
                width: m.window.width,
                height: m.window.height,
                radius: m.window.radius,
              },
            }),
      })),
      ...(r.screens.look === undefined ? {} : { look: r.screens.look }),
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
