import {
  type Derivation,
  type DraftStep,
  type Hole,
  SCRIPT_VERSION_EDITS,
  type SceneDocument,
  type ScriptDraft,
  type ScriptTrim,
  SHOWN_STEP,
  scriptFromTake,
  type ZoomIntent,
  ZoomIntentSchema,
} from "@demoman/scene-schema";
import type { ScriptSkeleton, SkeletonRead } from "./skeleton.js";

// The re-film's script (spec 2026-10-14 re-film §2): the skeleton's order,
// pauses and look, with each acting step's content — target, typed text,
// landing — taken from the take's CURRENT scene.json through
// `scriptFromTake`. Every step the merge cannot place is named.

export type RefilmNote =
  | { kind: "noSkeleton" }
  | { kind: "skeletonUnreadable"; error: string }
  | {
      kind: "stepDropped";
      index: number;
      actionId: string | null;
      why: "actionGone" | "neverPerformed";
    }
  /** What reading an older scene.json took away from it (its migration's
   *  own sentence): an edit gone before notCarried could name it. */
  | { kind: "migrated"; sentence: string }
  /** A step in scene.json the saved script did not have (added by hand):
   *  filmed all the same, after the step it follows in scene.json. */
  | { kind: "actionAdded"; actionId: string }
  /** `derive` only: the step was a `was` when filmed and its action in
   *  scene.json is now a `now`; the draft takes the scene's. Check that step
   *  before running the draft. A re-film refuses this instead. */
  | {
      kind: "verbChanged";
      index: number;
      actionId: string;
      was: string;
      now: string;
    }
  /** A Studio trim marker inside its step, which a script cannot name: the
   *  start is the step's marker, the end right after its action. */
  | { kind: "trimClampedToStep"; side: "start" | "end" }
  /** A zoom edit the scene holds that the script cannot carry: on a step
   *  that is not a click or drag, or a scale outside `ZoomIntentSchema`'s. */
  | {
      kind: "zoomNotWritten";
      actionId: string;
      why: "notClickOrDrag" | "invalidScale";
    };

export interface NotCarried {
  kind: "removed" | "split" | "mask" | "hold" | "gap" | "trim" | "zoom";
  id: string;
}

export interface RefilmInfo {
  from: string;
  notes: RefilmNote[];
  notCarried: NotCarried[];
}

type Zoomable = Extract<DraftStep, { do: "click" | "drag" }>;
export type MergedStep =
  | Exclude<DraftStep, Zoomable>
  | (Zoomable & { zoom?: ZoomIntent })
  | { do: "pause"; ms: number };

export interface MergedDraft
  extends Omit<ScriptDraft, "steps" | "look" | "scriptVersion"> {
  scriptVersion: number;
  /** The skeleton's account (launch C2), kept so the re-film signs in as it. */
  account?: string;
  steps: MergedStep[];
  look?: unknown;
  /** The Studio's trim, written back (spec 2026-11-01 video-as-code §4). */
  trim?: ScriptTrim;
}

export type Merge =
  | { ok: true; draft: MergedDraft; holes: Hole[]; notes: RefilmNote[] }
  | { ok: false; reason: "invalidScript"; field: string; detail: string };

type Derived = Extract<Derivation, { outcome: "derived" }>;

export interface MergeOptions {
  /** A skeleton step whose verb no longer matches its action in scene.json
   *  (a hand edit that turned a `type` into a `click`): `"refuse"` answers
   *  `invalidScript` (a re-film never guesses which was meant), `"useScene"`
   *  takes the scene's step and notes it (`verbChanged`), for a draft the
   *  author checks before running it. */
  onVerbChange: "refuse" | "useScene";
  /** The take's scene.json, as the library read it. Its `meta.name` —
   *  never the derivation's, which stands in "untitled take …" for a blank
   *  one — names the script: a take renamed in the studio keeps that name;
   *  a blank one takes the name the script was filmed under. Its trim and
   *  zoom edits are written back into the script. */
  scene: SceneDocument;
}

type Placed = { step: MergedStep; from: number | null };

export function mergeSkeleton(
  derivation: Derived,
  read: SkeletonRead,
  options: MergeOptions,
): Merge {
  const merged = placeSteps(derivation, read, options);
  if (!merged.ok) return merged;
  const back = writeBack(
    merged.draft,
    options.scene,
    read.kind === "ok" ? read.skeleton : undefined,
  );
  return {
    ...merged,
    draft: back.draft,
    notes: [...merged.notes, ...back.notes],
  };
}

function placeSteps(
  derivation: Derived,
  read: SkeletonRead,
  options: MergeOptions,
): Merge {
  const { draft, holes } = derivation;
  if (read.kind !== "ok") {
    return {
      ok: true,
      draft,
      holes,
      notes: [
        read.kind === "none"
          ? { kind: "noSkeleton" }
          : { kind: "skeletonUnreadable", error: read.error },
      ],
    };
  }
  const sk = read.skeleton;
  const byAction = new Map(
    draft.steps.map((step, i) => [step.recorded, { step, i }] as const),
  );
  const notes: RefilmNote[] = [];
  /** Each merged step, with the draft index it came from (null: a pause). */
  const placed: Placed[] = [];
  const used = new Set<number>();
  for (const [k, s] of sk.steps.entries()) {
    if (s.do === "pause") {
      placed.push({ step: { do: "pause", ms: s.ms }, from: null });
      continue;
    }
    if (s.actionId === null) {
      notes.push({
        kind: "stepDropped",
        index: k,
        actionId: null,
        why: "neverPerformed",
      });
      continue;
    }
    const found = byAction.get(s.actionId);
    if (found === undefined) {
      notes.push({
        kind: "stepDropped",
        index: k,
        actionId: s.actionId,
        why: "actionGone",
      });
      continue;
    }
    if (found.step.do !== s.do) {
      if (options.onVerbChange === "refuse") {
        return {
          ok: false,
          reason: "invalidScript",
          field: `steps.${k}.do`,
          detail: `step ${k + 1} was a ${s.do} when filmed and its action in scene.json is now a ${found.step.do}; filming again does not guess which you meant — derive the video, write the step as you want it, and run that draft`,
        };
      }
      notes.push({
        kind: "verbChanged",
        index: k,
        actionId: s.actionId,
        was: s.do,
        now: found.step.do,
      });
    }
    used.add(found.i);
    placed.push({ step: found.step, from: found.i });
  }
  // A step scene.json has and the saved script did not (added by hand) is
  // filmed too: right after the step before it in scene.json that was
  // placed, or first when none was. Taken in scene order, so two added in a
  // row stay in that order.
  for (const [i, step] of draft.steps.entries()) {
    if (used.has(i)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (!used.has(j)) continue;
      at = placed.findIndex((p) => p.from === j) + 1;
      break;
    }
    placed.splice(at, 0, { step, from: i });
    used.add(i);
    if (step.recorded !== undefined)
      notes.push({ kind: "actionAdded", actionId: step.recorded });
  }
  /** Old draft index → new merged index, for the holes. */
  const moved = new Map<number, number>();
  for (const [k, p] of placed.entries()) {
    if (p.from !== null) moved.set(p.from, k);
  }
  const remapped = holes.flatMap((h): Hole[] => {
    if (h.step === null) return [h];
    const to = moved.get(h.step);
    return to === undefined ? [] : [{ ...h, step: to }];
  });
  // The look is the take's own, from scene.json: a take restyled in the editor
  // keeps that look on a re-film, whatever the skeleton saved.
  const { viewport: _v, device: _d, ...rest } = draft;
  return {
    ok: true,
    draft: {
      ...rest,
      scriptVersion: Math.max(sk.scriptVersion, draft.scriptVersion),
      name:
        options.scene.meta.name.trim() === ""
          ? sk.name
          : options.scene.meta.name,
      ...(sk.viewport === null ? {} : { viewport: sk.viewport }),
      ...(sk.device === null ? {} : { device: sk.device }),
      ...(sk.account === undefined ? {} : { account: sk.account }),
      steps: placed.map((p) => p.step),
    },
    holes: remapped,
    notes,
  };
}

/** The finish and zoom-out of the step that filmed `actionId`, or null when
 *  either the skeleton or that finish is unknown: the one answer to whether
 *  a Studio tail can be written back, read by the merge and `notCarriedOf`. */
function tailBase(
  skeleton: ScriptSkeleton | undefined,
  actionId: string,
): { finishMs: number; zoomOutMs: number | null } | null {
  const step = skeleton?.steps.find(
    (s) => s.do !== "pause" && s.actionId === actionId,
  );
  if (step === undefined || step.do === "pause" || step.finishMs === null)
    return null;
  return { finishMs: step.finishMs, zoomOutMs: step.zoomOutMs };
}

/** The scene's trim and zoom edits as the script's `trim` and step `zoom`
 *  (spec §4), inverting how a run writes them. Zoom intent is read from the
 *  scene alone, never the skeleton's record of what the script asked. */
function writeBack(
  draft: MergedDraft,
  scene: SceneDocument,
  skeleton: ScriptSkeleton | undefined,
): { draft: MergedDraft; notes: RefilmNote[] } {
  const notes: RefilmNote[] = [];
  const steps = [...draft.steps];
  const at = (actionId: string): number => {
    const k = steps.findIndex(
      (s) => s.do !== "pause" && s.recorded === actionId,
    );
    // Every action in scene.json is a draft step, and the merge places each.
    if (k === -1)
      throw new Error(
        `write-back: action "${actionId}" is in scene.json and in no step of the merged script`,
      );
    return k;
  };
  const shown = steps.flatMap((s, i) => (SHOWN_STEP[s.do] ? [i + 1] : []));
  const trim: ScriptTrim = {};
  const { head, tail } = scene.edits.trim ?? {};
  if (head !== undefined) {
    const step = at(head.actionId) + 1;
    if (head.offsetMs > 0)
      notes.push({ kind: "trimClampedToStep", side: "start" });
    trim.start = {
      ...(step === shown[0] ? {} : { step }),
      ms: head.offsetMs > 0 ? 0 : 0 - head.offsetMs,
    };
  }
  const base = tail === undefined ? null : tailBase(skeleton, tail.actionId);
  if (tail !== undefined && base !== null) {
    const step = at(tail.actionId) + 1;
    const { finishMs, zoomOutMs } = base;
    const zoomedOut =
      zoomOutMs === null ? finishMs : Math.max(finishMs, zoomOutMs);
    let end: NonNullable<ScriptTrim["end"]>;
    if (tail.offsetMs >= zoomedOut) end = { ms: tail.offsetMs - zoomedOut };
    else if (tail.offsetMs >= finishMs)
      end = { ms: tail.offsetMs - finishMs, after: "action" };
    else {
      notes.push({ kind: "trimClampedToStep", side: "end" });
      end = { ms: 0, after: "action" };
    }
    trim.end = { ...(step === shown.at(-1) ? {} : { step }), ...end };
  }
  const intents = new Map<string, ZoomIntent>();
  for (const s of scene.zoomsSkipped ?? []) {
    if (s.reason === "off") intents.set(s.actionId, false);
    else if ("askedScale" in s && s.askedScale !== undefined)
      intents.set(s.actionId, { scale: s.askedScale });
  }
  for (const c of scene.camera) {
    // An absent scale fails `ZoomIntentSchema` below, and is named there.
    if (c.source === "click" && c.scaleSetBy !== undefined)
      intents.set(c.marker.actionId, { scale: c.scale as number });
  }
  for (const [actionId, zoom] of intents) {
    const k = at(actionId);
    const step = steps[k] as MergedStep;
    if (step.do !== "click" && step.do !== "drag")
      notes.push({ kind: "zoomNotWritten", actionId, why: "notClickOrDrag" });
    else if (!ZoomIntentSchema.safeParse(zoom).success)
      notes.push({ kind: "zoomNotWritten", actionId, why: "invalidScale" });
    else steps[k] = { ...step, zoom };
  }
  const zoomed = steps.some((s) => "zoom" in s);
  const trimmed = trim.start !== undefined || trim.end !== undefined;
  return {
    draft: {
      ...draft,
      ...(trimmed || zoomed
        ? {
            scriptVersion: Math.max(draft.scriptVersion, SCRIPT_VERSION_EDITS),
          }
        : {}),
      ...(trimmed ? { trim } : {}),
      steps,
    },
    notes,
  };
}

/** Every editor edit bound to the old take's action ids, which a new take
 *  does not share: the re-film's report names each one left behind. A trim
 *  and a zoom the merge writes back into the script (spec 2026-11-01 §4) are
 *  carried, so not listed: the head always, a tail when `skeleton` holds its
 *  step's finish. */
export function notCarriedOf(
  scene: SceneDocument,
  skeleton?: ScriptSkeleton,
): NotCarried[] {
  const e = scene.edits;
  return [
    ...(e.removed ?? []).map((r) => ({ kind: "removed" as const, id: r.id })),
    ...(e.splits ?? []).map((p) => ({ kind: "split" as const, id: p.id })),
    ...e.masks.map((m) => ({ kind: "mask" as const, id: m.id })),
    ...e.holds.map((h) => ({ kind: "hold" as const, id: h.id })),
    ...(e.gaps ?? []).map((g) => ({ kind: "gap" as const, id: g.id })),
    ...(e.trim?.tail === undefined ||
    tailBase(skeleton, e.trim.tail.actionId) !== null
      ? []
      : [{ kind: "trim" as const, id: "tail" }]),
    // `source` says who made a zoom: an author's is theirs, a click's is
    // generated again by the new take (its scale and removal are written
    // back). With none (a take saved before v15), only the editor writes a
    // `point` (aimed where the author clicked the Zoom lane) or `end` (a
    // return the author placed).
    ...scene.camera
      .filter((c) =>
        c.source === undefined
          ? c.point !== undefined || c.end !== undefined
          : c.source === "author",
      )
      .map((c) => ({ kind: "zoom" as const, id: c.id })),
  ];
}

export type RefilmBuild =
  | { ok: true; script: Record<string, unknown>; refilm: RefilmInfo }
  | {
      ok: false;
      reason: "invalidScript" | "unfilledHoles" | "nothingToRerecord";
      field: string | null;
      detail: string;
    };

const holePath = (h: Hole) =>
  h.step === null ? h.field : `steps.${h.step}.${h.field}`;

export function refilmScript(
  scene: SceneDocument,
  read: SkeletonRead,
): RefilmBuild {
  const derivation = scriptFromTake(scene);
  // The only way a re-film has nothing to act on: every step scene.json
  // holds is filmed (one the saved script lacked is placed, `actionAdded`),
  // so the merge cannot leave a script of pauses alone.
  if (derivation.outcome === "nothingToDerive") {
    return {
      ok: false,
      reason: "nothingToRerecord",
      field: null,
      detail: `video ${scene.meta.id} has no steps left in scene.json to film again`,
    };
  }
  const merged = mergeSkeleton(derivation, read, {
    onVerbChange: "refuse",
    scene,
  });
  if (!merged.ok) return merged;
  if (merged.holes.length > 0) {
    const paths = merged.holes.map(holePath);
    // Each hole's own sentence says what is missing and why; the close is
    // the route, since a re-film never invents a value.
    return {
      ok: false,
      reason: "unfilledHoles",
      field: paths.join(", "),
      detail: `${merged.holes.map((h) => h.sentence.trim()).join(" ")} Filming again never invents a value — derive the video, fill ${merged.holes.length === 1 ? "the hole" : "the holes"}, and run the draft`,
    };
  }
  const { target, ...rest } = merged.draft;
  return {
    ok: true,
    script: { ...rest, target: target ?? "", recordedFrom: scene.meta.id },
    refilm: {
      from: scene.meta.id,
      notes: merged.notes,
      notCarried: notCarriedOf(
        scene,
        read.kind === "ok" ? read.skeleton : undefined,
      ),
    },
  };
}
