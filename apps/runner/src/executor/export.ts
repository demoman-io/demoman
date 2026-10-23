import { randomUUID } from "node:crypto";
import type { FrameBundle, RenderTarget } from "@demoman/compositor";
import {
  contentTypeFor,
  DEFAULT_EXPORT_QUALITY,
  type ExportAnswer,
  type ExportQuality,
  type ExportReport,
  editedSinceRecorded,
  exportBaseName,
  exportFileName,
  type FileType,
  frameOf,
  GIF_BUDGET_BYTES,
  isExportQuality,
  MAX_STILL_SIDE,
  messageOf,
  reportForSave,
  reportForStillsSave,
  type StillsOptions,
  sceneDigest,
  sceneLabel,
  stillsFolder,
  targetCheckOf,
  targetFor,
  withSummary,
  zoomWarnings,
} from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { renderToFiles } from "../render.js";
import type { BrowserSession } from "./browser.js";
import type { Library } from "./library.js";
import { readLogo } from "./logo-ref.js";
import { checkExportFolder, saveExport, saveStillsFolder } from "./save.js";
import { readUserSettings } from "./user-settings.js";

export interface ExportDeps {
  library: Library;
  session: Pick<BrowserSession, "openWorkPage" | "headless">;
  /** Which door asked; the lease and the outputs row say so. */
  door: "agent" | "studio";
  /** The lease's job id; a fresh one when absent. */
  jobId?: string;
  home: string;
  outDir: string;
  log: (line: string) => void;
  /** Tests only: sees the work page, so a case can close it mid-render. */
  onWorkPage?: (page: Page) => void;
  /** Tests only: `ExecutorOptions.mp4MaxTier`. */
  maxTier?: RenderTarget;
}

const FILE_TYPES = ["mp4", "gif", "stills"] as const;

export type Exporting = Extract<ExportReport, { outcome: "exporting" }>;

/**
 * The CLI's `export`: the extension's `exportTake` (`adapters/agent-export.ts`)
 * with its ports swapped — the take library on disk for IndexedDB, a work page
 * of the CLI's own browser for the offscreen document, and a folder save for
 * chrome.downloads. Every decision that is not a port is the extension's own,
 * moved to run-core: the target (`targetFor`), the file name
 * (`exportFileName`/`exportBaseName`/`sceneLabel`), the report
 * (`reportForSave`) and the sentence (`withSummary`). It makes MP4, GIF or
 * stills (`fileType`, MP4 by default); stills save into a folder of their
 * own. Resolves for every
 * outcome; rejects only on a bug.
 */
export async function exportTake(
  args: Record<string, unknown>,
  deps: ExportDeps,
  onProgress: (report: Exporting) => void,
): Promise<ExportAnswer> {
  const { library } = deps;
  const refused = (
    reason:
      | "noTakeId"
      | "takeNotFound"
      | "takeUnreadable"
      | "noFrames"
      | "invalidFileType"
      | "invalidStillsOptions"
      | "invalidQuality"
      | "invalidMaxMB",
    detail: string,
  ): ExportAnswer =>
    withSummary({ outcome: "refusedBeforeExport", reason, detail });
  const takeId = typeof args.takeId === "string" ? args.takeId.trim() : "";
  if (takeId === "") return refused("noTakeId", "no take id was given");
  // An id that cannot name a folder under takes/ names no take: not a
  // library that could not be read.
  if (!library.isTakeId(takeId)) {
    return refused(
      "takeNotFound",
      `there is no take ${takeId} in the library — "${takeId}" is not a take id`,
    );
  }
  // Only an absent argument means MP4: a `null` or a number is a caller's
  // mistake, and naming it beats exporting something else.
  const fileType = args.fileType === undefined ? "mp4" : args.fileType;
  if (typeof fileType !== "string") {
    return refused(
      "invalidFileType",
      `a file type is a string, not ${fileType === null ? "null" : typeof fileType} — ask for mp4, gif or stills`,
    );
  }
  if (!FILE_TYPES.includes(fileType as (typeof FILE_TYPES)[number])) {
    return refused(
      "invalidFileType",
      `"${fileType}" is not a file type an export makes — ask for mp4, gif or stills`,
    );
  }
  const asked = fileType as FileType;
  const stills = stillsOptionsOf(args.stills, asked);
  if (typeof stills === "string")
    return refused("invalidStillsOptions", stills);
  // Nothing asked: GitHub's size under a cap, else the user's Export
  // quality from Settings, which the summary says it could not read.
  const fallback =
    args.maxMB !== undefined
      ? { quality: "share" as const }
      : args.quality === undefined && asked === "mp4"
        ? await settingsQuality(deps)
        : { quality: DEFAULT_EXPORT_QUALITY };
  const quality = qualityOf(args.quality, asked, fallback.quality);
  if (typeof quality === "object") {
    return refused("invalidQuality", quality.refusal);
  }
  const maxBytes = maxBytesOf(args.maxMB, asked);
  if (maxBytes !== null && typeof maxBytes === "object") {
    return refused("invalidMaxMB", maxBytes.refusal);
  }
  const store = library.frameStore(takeId);
  let sceneRead: Awaited<ReturnType<Library["getSceneRead"]>>;
  let bundle: Awaited<ReturnType<typeof store.getBundle>>;
  try {
    sceneRead = await library.getSceneRead(takeId);
    bundle = sceneRead === null ? null : await store.getBundle(takeId);
  } catch (error) {
    return refused(
      "takeUnreadable",
      `the library could not be read for take ${takeId} (${messageOf(error)})`,
    );
  }
  if (sceneRead === null) {
    return refused("takeNotFound", `there is no take ${takeId} in the library`);
  }
  const { scene, notes } = sceneRead;
  if (bundle === null) {
    return refused(
      "noFrames",
      `take ${takeId} has no frames to render — run its script again`,
    );
  }
  // Only a take that exists: a lease on a missing one would make its folder.
  let lease: Awaited<ReturnType<Library["lease"]>>;
  try {
    lease = await library.lease(takeId, {
      op: "export",
      door: deps.door,
      jobId: deps.jobId ?? randomUUID(),
    });
  } catch (error) {
    return refused(
      "takeUnreadable",
      `take ${takeId} could not be marked as being exported (${messageOf(error)})`,
    );
  }
  try {
    const answer = await exportLeased({
      takeId,
      asked,
      stills,
      quality,
      ...(fallback.unreadable === undefined
        ? {}
        : { settingUnreadable: fallback.unreadable }),
      maxBytes,
      scene,
      notes,
      bundle,
      store,
      deps,
      onProgress,
    });
    return answer.outcome === "saved"
      ? await listed(answer, takeId, scene, deps)
      : answer;
  } finally {
    try {
      await lease.release();
    } catch (error) {
      deps.log(
        `the export lease on ${takeId} would not release (${messageOf(error)})`,
      );
    }
  }
}

/** Appends the saved answer to the take's `outputs.json`. A row that cannot
 *  be written leaves the answer `saved` and says so (`warnings.notListed`). */
async function listed(
  answer: ExportAnswer,
  takeId: string,
  scene: SceneDocument,
  deps: ExportDeps,
): Promise<ExportAnswer> {
  if (answer.outcome !== "saved") return answer;
  const { summary: _summary, ...report } = answer;
  try {
    await deps.library.appendOutput(takeId, {
      path:
        answer.fileType === "stills" ? answer.folder.path : answer.file.path,
      fileType: answer.fileType,
      aspect: answer.aspect,
      byteLength:
        answer.fileType === "stills"
          ? answer.folder.files.reduce((sum, f) => sum + f.byteLength, 0)
          : answer.file.byteLength,
      renderedAt: new Date().toISOString(),
      sceneDigest: sceneDigest(scene),
      report: answer,
    });
    return answer;
  } catch (error) {
    const said = messageOf(error);
    deps.log(`take ${takeId}: the export is saved but not listed (${said})`);
    return withSummary({
      ...report,
      warnings: { ...report.warnings, notListed: { error: said } },
    });
  }
}

async function exportLeased(a: {
  takeId: string;
  asked: FileType;
  stills: StillsOptions;
  quality: ExportQuality;
  /** Why the Settings quality could not be read, when `quality` is the
   *  default in its place. */
  settingUnreadable?: string;
  /** `maxMB` in bytes, or null for no cap. */
  maxBytes: number | null;
  scene: SceneDocument;
  /** What reading the take took away (`getSceneRead`'s notes). */
  notes: string[];
  bundle: FrameBundle;
  store: ReturnType<Library["frameStore"]>;
  deps: ExportDeps;
  onProgress: (report: Exporting) => void;
}): Promise<ExportAnswer> {
  const {
    takeId,
    asked,
    stills,
    quality,
    settingUnreadable,
    maxBytes,
    scene,
    notes,
    bundle,
    store,
    deps,
    onProgress,
  } = a;
  const { library } = deps;

  const aspect = scene.canvas.aspect;
  // The function the extension's offscreen renderer resolves its target through.
  const target = targetFor(asked, aspect, bundle, frameOf(scene), {
    maxTier: deps.maxTier,
    quality,
  });
  if (deps.maxTier !== undefined) {
    // Said only when the cap changed something: a take whose keyframes back
    // no more than the cap renders as it would have anyway.
    const free = targetFor(asked, aspect, bundle, frameOf(scene), { quality });
    if (free.width !== target.width || free.height !== target.height) {
      deps.log(
        `take ${takeId}: export capped at ${target.width}x${target.height}, not ${free.width}x${free.height} (tests only)`,
      );
    }
  }
  const logo =
    scene.branding.logo === null
      ? null
      : await readLogo(deps.home, scene.branding.logo.ref);
  const madeFrom = bundle.madeFrom ?? null;
  // Every step scene.json changed since filming: the video shows each as
  // filmed, so the caller is told (re-film §3).
  // One read of script.json serves both the edits and the check on it.
  const read = await library.getSkeleton(takeId);
  const edited = editedSinceRecorded(scene, madeFrom, read);

  // Before the render, not after it: a folder that cannot take the file
  // would otherwise cost the whole render to find out.
  const folder = await checkExportFolder(deps.outDir);
  if (folder !== null) {
    return withSummary({
      outcome: "saveFailed",
      takeId,
      error: folder.error,
      beforeRender: true,
      fileType: asked,
    });
  }

  onProgress({ outcome: "exporting", phase: "rendering", done: 0, total: 0 });
  // Default relaunch: an export may be the first call that needs a browser,
  // or come after the author closed the window.
  const work = await deps.session.openWorkPage();
  if (!work.ok) {
    return withSummary({ outcome: "renderFailed", takeId, error: work.detail });
  }
  deps.onWorkPage?.(work.page);
  let rendered: Awaited<ReturnType<typeof renderToFiles>>;
  try {
    rendered = await renderToFiles({
      scene,
      bundle,
      store,
      page: work.page,
      target,
      fileType: asked,
      logo,
      // As wide as fits: sharp on a Retina screen when the take is short,
      // narrower (and said) when it is long.
      ...(asked === "gif" ? { gifBudget: { maxBytes: GIF_BUDGET_BYTES } } : {}),
      // A cap steps down to the share target for this frame and no further
      // in size (`nextCapStep`): Auto's share frame is its own, re-solved.
      ...(maxBytes === null
        ? {}
        : {
            mp4Cap: {
              maxBytes,
              share: targetFor(asked, aspect, bundle, frameOf(scene), {
                maxTier: deps.maxTier,
                quality: "share",
              }),
            },
          }),
      // Always for stills, so the CLI's defaults apply: the window no wider
      // than the recording, and the whole window rather than the video's
      // camera, which at a step's own instant is often mid-move.
      ...(asked === "stills" ? { stills } : {}),
      onFrame: (done, total, width, pass) =>
        onProgress({
          outcome: "exporting",
          phase: "rendering",
          done,
          total,
          ...(width === undefined ? {} : { width }),
          // A capped MP4's fps and quality steps keep the width: which
          // render this is says the count started again.
          ...(pass === undefined ? {} : { pass }),
        }),
    });
  } catch (error) {
    // The author closing the window is not a fault in the render, and says
    // so: an agent told "Target page, context or browser has been closed"
    // cannot tell the user what to do. Headless has no window anyone could
    // close: its page going away is the browser crashing.
    const said = !work.page.isClosed()
      ? `the render failed: ${messageOf(error)}`
      : deps.session.headless
        ? `Demoman's headless browser lost the page it renders in before the video was finished: the browser crashed, or the page closed itself (${messageOf(error)}) — export again`
        : `the window Demoman renders in was closed before the video was finished (${messageOf(error)}) — export again, and leave it open`;
    return withSummary({ outcome: "renderFailed", takeId, error: said });
  } finally {
    if (!work.page.isClosed()) {
      await work.page.close().catch((closing: unknown) => {
        deps.log(`the render's page would not close (${messageOf(closing)})`);
      });
    }
  }

  onProgress({ outcome: "exporting", phase: "saving", done: 0, total: 0 });
  const base = exportBaseName(sceneLabel(scene.meta));
  const warnings = {
    // The take's own skips under the floor and the render's caps and
    // narrowings: an export whose zooms did not play as asked says which.
    zooms: zoomWarnings(scene, rendered.loweredZooms),
    // What reading the take took away from it (schema 12: text overlays).
    migration: notes,
    ...(edited === null ? {} : { editedSinceRecorded: edited }),
    targetCheck: targetCheckOf(read),
    // A re-film leaves every mask behind; an edited take's summary says so.
    masks: scene.edits.masks.length,
  };
  if (asked === "stills") {
    // The same guard as the file below: no stills is a failed render.
    if (rendered.files.length === 0) {
      return withSummary({
        outcome: "renderFailed",
        takeId,
        error: "the render produced no stills",
      });
    }
    const saved = await saveStillsFolder(
      deps.outDir,
      stillsFolder(aspect, base),
      // `renderStills` names every still on the marker path, so the
      // fallback only applies to caller-supplied times, which exportTake
      // never passes.
      rendered.files.map((f, i) => ({
        name: f.name ?? `still-${i}.png`,
        bytes: f.bytes,
      })),
    );
    return withSummary(
      reportForStillsSave({
        takeId,
        saved,
        aspect,
        target: rendered.rendered,
        facts: {
          logoWarning: rendered.logoWarning,
          unavailableSpans: rendered.unavailableSpans,
          detailViolations: rendered.detailViolations,
          unplacedStills: rendered.unplacedStills,
        },
        ...warnings,
        ...(rendered.stillsCapped === undefined
          ? {}
          : { stillsCapped: rendered.stillsCapped }),
      }),
    );
  }
  // A render that answered with no file is a failed render, not a saved one.
  const [file] = rendered.files;
  if (file === undefined) {
    return withSummary({
      outcome: "renderFailed",
      takeId,
      error: "the render produced no file",
    });
  }
  const name = exportFileName(asked, aspect, base);
  const saved = await saveExport(deps.outDir, name, file.bytes);
  return withSummary(
    reportForSave({
      takeId,
      fileType: asked,
      file: {
        ref: `${takeId}:${name}`,
        name,
        byteLength: file.bytes.byteLength,
        contentType: contentTypeFor(asked),
        detailViolations: rendered.detailViolations,
        unavailableSpans: rendered.unavailableSpans,
        ...(rendered.logoWarning === null
          ? {}
          : { logoWarning: rendered.logoWarning }),
      },
      saved,
      aspect,
      // What was rendered, not what was asked for: a budgeted GIF renders
      // wider than its target when it can.
      target: rendered.rendered,
      ...warnings,
      ...(rendered.gifBudget === undefined
        ? {}
        : { gifSize: rendered.gifBudget }),
      // The CLI's MP4 says what it was made at and how big it came out; the
      // extension's export sets neither, so its summary stays as it was.
      ...(asked === "mp4"
        ? {
            videoSize: {
              quality,
              byteLength: file.bytes.byteLength,
              ...(settingUnreadable === undefined ? {} : { settingUnreadable }),
              ...(rendered.videoCap === undefined
                ? {}
                : { cap: rendered.videoCap }),
            },
          }
        : {}),
    }),
  );
}

/** The user's Export quality (`<home>/settings.json`), and why it could not
 *  be read when it could not: then the default, and the log says so too. */
async function settingsQuality(
  deps: ExportDeps,
): Promise<{ quality: ExportQuality; unreadable?: string }> {
  const settings = await readUserSettings(deps.home);
  const unreadable = settings.problems?.exportQuality;
  if (unreadable === undefined) return { quality: settings.exportQuality };
  deps.log(
    `export: Export quality is ${settings.exportQuality}: ${unreadable}`,
  );
  return { quality: settings.exportQuality, unreadable };
}

/**
 * `export`'s `quality` argument, `fallback` when absent: `share` when a
 * `maxMB` is given, GitHub's drag-in, so a cap starts at the size it will
 * most likely end at rather than rendering down to it; else the user's
 * Export quality. Only an MP4 has a quality to choose; on a GIF or stills
 * it would be ignored, and an ignored request reads as one that was
 * followed.
 */
function qualityOf(
  given: unknown,
  fileType: FileType,
  fallback: ExportQuality,
): ExportQuality | { refusal: string } {
  if (given === undefined) return fallback;
  if (!isExportQuality(given)) {
    return {
      refusal: `quality is "high" (60 fps, about 30 MB for 30 s, the default), "share" (as small as stays crisp, for GitHub) or "full" (the largest file), not ${JSON.stringify(given) ?? typeof given}`,
    };
  }
  if (fileType !== "mp4") {
    return {
      refusal: `quality applies only to an MP4, not to ${fileType === "gif" ? "a GIF" : "stills"} — leave it out, or ask for fileType "mp4"`,
    };
  }
  return given;
}

/**
 * `export`'s `maxMB` argument in bytes (`maxMB × 1,000,000`), null when
 * absent, or the sentence that refuses it. A number above 0, for an MP4
 * only: a GIF has its own budget and stills no single file, and an ignored
 * cap reads as one that was met.
 */
export function maxBytesOf(
  given: unknown,
  fileType: FileType,
): number | null | { refusal: string } {
  if (given === undefined) return null;
  // A cap under one byte is no cap a file can meet, and would be said as
  // "0 MB".
  if (
    typeof given !== "number" ||
    !Number.isFinite(given) ||
    Math.round(given * 1_000_000) < 1
  ) {
    // NaN and Infinity are named as themselves, not as JSON's `null`.
    const said =
      typeof given === "number"
        ? String(given)
        : (JSON.stringify(given) ?? typeof given);
    return {
      refusal: `maxMB is a number of megabytes of at least 0.000001 (one byte), like 9.5 for GitHub's 10 MB, not ${said}`,
    };
  }
  if (fileType !== "mp4") {
    return {
      refusal: `maxMB applies only to an MP4, not to ${fileType === "gif" ? "a GIF" : "stills"} — leave it out, or ask for fileType "mp4"`,
    };
  }
  return Math.round(given * 1_000_000);
}

/**
 * `export`'s `stills` argument, or the sentence that refuses it. Only for
 * stills: on another file type it would be ignored, and an ignored request
 * reads as one that was followed.
 */
function stillsOptionsOf(
  given: unknown,
  fileType: FileType,
): StillsOptions | string {
  if (given === undefined) return {};
  if (fileType !== "stills") {
    return `stills options apply only to stills, not to ${fileType === "gif" ? "a GIF" : "an MP4"} — leave them out, or ask for fileType "stills"`;
  }
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    return `stills options are an object, like { "width": 1920, "zoom": "step" }, not ${given === null ? "null" : Array.isArray(given) ? "a list" : typeof given}`;
  }
  const { width, zoom, ...rest } = given as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    return `stills options take width and zoom, not ${unknown.join(", ")}`;
  }
  const options: StillsOptions = {};
  if (width !== undefined) {
    if (width === "native") {
      options.width = "native";
    } else if (
      typeof width === "number" &&
      Number.isInteger(width) &&
      width >= MIN_STILL_WIDTH &&
      width <= MAX_STILL_SIDE
    ) {
      options.width = width;
    } else {
      return `a still's width is a whole number of pixels from ${MIN_STILL_WIDTH} to ${MAX_STILL_SIDE}, or "native" for the recording's own size — not ${JSON.stringify(width)}`;
    }
  }
  if (zoom !== undefined) {
    if (zoom !== "none" && zoom !== "step") {
      return `a still's zoom is "none" (the whole window) or "step" (the step's zoom, all the way in) — not ${JSON.stringify(zoom)}`;
    }
    options.zoom = zoom;
  }
  return options;
}

/** Narrower than this, a still of a product page is unreadable. */
const MIN_STILL_WIDTH = 320;
