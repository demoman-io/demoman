import type {
  DemoScript,
  SceneDocument,
  ScriptTrim,
  ZoomIntent,
} from "@demoman/scene-schema";

// What a CLI run keeps of its script beside the take (spec 2026-10-14
// re-film §1): the order, the pauses, which action each step made, and the
// look. Never the typed text, a target or the start URL — `scene.json`
// strips secrets from those, and a copy here would put them back on disk.

export const SKELETON_VERSION = 2;

type Verb = DemoScript["steps"][number]["do"];

export type SkeletonStep =
  | { do: "pause"; ms: number }
  | {
      do: Exclude<Verb, "pause">;
      actionId: string | null;
      anchorDigest: string | null;
      /** Where the step's own beat ended, in ms after its marker; null when
       *  the run never performed it, or the file is a v1. */
      finishMs: number | null;
      /** When the camera was back at full frame after the latest zoom at or
       *  before this step, in ms after its marker; null if none. */
      zoomOutMs: number | null;
      /** What the script asked of a click's or drag's zoom, as `look` is. */
      zoom?: ZoomIntent;
    };

export interface ScriptSkeleton {
  skeletonVersion: 2;
  name: string;
  scriptVersion: DemoScript["scriptVersion"];
  viewport: NonNullable<DemoScript["viewport"]> | null;
  device: NonNullable<DemoScript["device"]> | null;
  /** The script's account (launch C2); absent on a skeleton written before
   *  accounts, or for a script that named none. A re-film signs in as it. */
  account?: string;
  /** The look the script asked for, kept as the record of what it asked.
   *  A re-film does not use it: it takes the take's own look from
   *  scene.json, so a take restyled in the studio keeps that look
   *  (`mergeSkeleton`). */
  look: NonNullable<DemoScript["look"]> | null;
  /** What the script asked for the video's ends; null if it asked none. */
  trim: ScriptTrim | null;
  steps: SkeletonStep[];
}

/** What the library found at `script.json`: no file (a take from before
 *  skeletons, or the extension's), one, or one it could not use — told
 *  apart, so a broken file is never read as an old take. */
export type SkeletonRead =
  | { kind: "none" }
  | { kind: "ok"; skeleton: ScriptSkeleton }
  | { kind: "unreadable"; error: string };

type Fingerprint = {
  stableId: string | null;
  role: string | null;
  accessibleName: string | null;
  textContent: string | null;
  treePath: string | null;
};

/** FNV-1a, 32-bit, over the fingerprint's naming fields. Not a security
 *  hash: it exists so export can see a hand edit to an anchor that kept its
 *  id (`editedSinceRecorded`), and holds no plaintext. */
export function anchorDigest(fp: Fingerprint): string {
  const text = JSON.stringify([
    fp.stableId,
    fp.role,
    fp.accessibleName,
    fp.textContent,
    fp.treePath,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function skeletonOf(
  script: DemoScript,
  steps: readonly {
    index: number;
    actionId: string | null;
    timing?: { finishMs: number; zoomOutMs: number | null };
  }[],
  scene: SceneDocument,
): ScriptSkeleton {
  const walked = new Map(steps.map((s) => [s.index, s]));
  const actions = new Map(scene.actions.map((a) => [a.id, a]));
  const anchors = new Map(scene.anchors.map((a) => [a.id, a]));
  return {
    skeletonVersion: SKELETON_VERSION,
    name: script.name,
    scriptVersion: script.scriptVersion,
    viewport: script.viewport ?? null,
    device: script.device ?? null,
    ...(script.account === undefined ? {} : { account: script.account }),
    look: script.look ?? null,
    trim: script.trim ?? null,
    steps: script.steps.map((step, index): SkeletonStep => {
      if (step.do === "pause") return { do: "pause", ms: step.ms };
      const done = walked.get(index);
      const actionId = done?.actionId ?? null;
      const anchorId =
        actionId === null ? null : (actions.get(actionId)?.anchorId ?? null);
      const anchor = anchorId === null ? undefined : anchors.get(anchorId);
      return {
        do: step.do,
        actionId,
        anchorDigest:
          anchor === undefined ? null : anchorDigest(anchor.fingerprint),
        finishMs: done?.timing?.finishMs ?? null,
        zoomOutMs: done?.timing?.zoomOutMs ?? null,
        ...("zoom" in step && step.zoom !== undefined
          ? { zoom: step.zoom }
          : {}),
      };
    }),
  };
}

/** Every verb an action step can have. A `Record` over the script's own
 *  union, as `ACTS_ON_THE_PAGE` in scene-schema's script.ts is: a verb added
 *  to `DemoScript` and forgotten here would refuse every skeleton holding it
 *  as "unknown", so the compiler refuses the omission instead. */
const VERBS: Record<Exclude<Verb, "pause">, true> = {
  click: true,
  type: true,
  hover: true,
  scrollTo: true,
  waitFor: true,
  // Its digest is the start's anchor: the end is re-measured from the script.
  drag: true,
  press: true,
  waitForLoad: true,
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nullOr = (v: unknown, test: (v: unknown) => boolean) =>
  v === null || test(v);

/** Checks the shape `skeletonOf` writes. A hand-written file is not
 *  forgiven: whatever is wrong is named, and the re-film falls back saying
 *  so (`skeletonUnreadable`). */
export function parseSkeleton(
  raw: unknown,
): { ok: true; skeleton: ScriptSkeleton } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  if (!isObject(raw)) return no("script.json is not a JSON object");
  const v1 = raw.skeletonVersion === 1;
  if (!v1 && raw.skeletonVersion !== SKELETON_VERSION) {
    return no(
      `script.json has skeletonVersion ${JSON.stringify(raw.skeletonVersion)}; this Demoman reads 1 and ${SKELETON_VERSION}`,
    );
  }
  if (typeof raw.name !== "string") return no("script.json has no name");
  if (typeof raw.scriptVersion !== "number")
    return no("script.json has no scriptVersion");
  for (const key of ["viewport", "device", "look"] as const) {
    if (!(key in raw))
      return no(`script.json has no ${key} (null when the script named none)`);
  }
  if (!nullOr(raw.viewport, isObject))
    return no("script.json's viewport is not an object or null");
  if (!nullOr(raw.device, (v) => typeof v === "string"))
    return no("script.json's device is not a name or null");
  if (!nullOr(raw.look, isObject))
    return no("script.json's look is not an object or null");
  if (raw.account !== undefined && typeof raw.account !== "string")
    return no("script.json's account is not a name");
  if (!v1 && !("trim" in raw))
    return no("script.json has no trim (null when the script named none)");
  if (!v1 && !nullOr(raw.trim, isObject))
    return no("script.json's trim is not an object or null");
  if (!Array.isArray(raw.steps)) return no("script.json has no steps");
  for (const [i, step] of raw.steps.entries()) {
    if (!isObject(step)) return no(`script.json's steps.${i} is not an object`);
    if (step.do === "pause") {
      if (typeof step.ms !== "number")
        return no(`script.json's steps.${i} is a pause with no ms`);
      continue;
    }
    if (typeof step.do !== "string" || !Object.hasOwn(VERBS, step.do)) {
      return no(
        `script.json's steps.${i} has an unknown verb ${JSON.stringify(step.do)}`,
      );
    }
    if (
      !("actionId" in step) ||
      !nullOr(step.actionId, (v) => typeof v === "string")
    ) {
      return no(
        `script.json's steps.${i} has no actionId (null when the run never performed it)`,
      );
    }
    if (
      !("anchorDigest" in step) ||
      !nullOr(step.anchorDigest, (v) => typeof v === "string")
    ) {
      return no(`script.json's steps.${i} has no anchorDigest`);
    }
    if (v1) continue;
    for (const key of ["finishMs", "zoomOutMs"] as const) {
      if (!(key in step) || !nullOr(step[key], (v) => typeof v === "number"))
        return no(`script.json's steps.${i}'s ${key} is not a number or null`);
    }
    if (
      step.zoom !== undefined &&
      step.zoom !== false &&
      typeof step.zoom !== "number"
    )
      return no(`script.json's steps.${i}'s zoom is not false or a scale`);
  }
  if (!v1) return { ok: true, skeleton: raw as unknown as ScriptSkeleton };
  // A v1 file asked nothing of the ends and measured no finish.
  const steps = (raw.steps as Record<string, unknown>[]).map((step) =>
    step.do === "pause" ? step : { ...step, finishMs: null, zoomOutMs: null },
  );
  return {
    ok: true,
    skeleton: {
      ...raw,
      skeletonVersion: SKELETON_VERSION,
      trim: null,
      steps,
    } as unknown as ScriptSkeleton,
  };
}
