import {
  type Derivation,
  type DraftStep,
  type Hole,
  type SceneDocument,
  type ScriptDraft,
  scriptFromTake,
} from "@demoman/scene-schema";
import type { SkeletonRead } from "./skeleton.js";

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

export type MergedStep = DraftStep | { do: "pause"; ms: number };

export interface MergedDraft
  extends Omit<ScriptDraft, "steps" | "look" | "scriptVersion"> {
  scriptVersion: number;
  /** The skeleton's account (launch C2), kept so the re-film signs in as it. */
  account?: string;
  steps: MergedStep[];
  look?: unknown;
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
  /** The take's own `meta.name` as scene.json holds it — never the
   *  derivation's, which stands in "untitled take …" for a blank one. A
   *  take renamed in the studio keeps that name; a blank one takes the
   *  name the script was filmed under. */
  sceneName: string;
}

type Placed = { step: MergedStep; from: number | null };

export function mergeSkeleton(
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
          detail: `step ${k + 1} was a ${s.do} when recorded and its action in scene.json is now a ${found.step.do}; a re-recording does not guess which you meant — derive the take, write the step as you want it, and run that draft`,
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
      name: options.sceneName.trim() === "" ? sk.name : options.sceneName,
      ...(sk.viewport === null ? {} : { viewport: sk.viewport }),
      ...(sk.device === null ? {} : { device: sk.device }),
      ...(sk.account === undefined ? {} : { account: sk.account }),
      steps: placed.map((p) => p.step),
    },
    holes: remapped,
    notes,
  };
}

/** Every editor edit bound to the old take's action ids, which a new take
 *  does not share: the re-film's report names each one left behind. */
export function notCarriedOf(scene: SceneDocument): NotCarried[] {
  const e = scene.edits;
  return [
    ...(e.removed ?? []).map((r) => ({ kind: "removed" as const, id: r.id })),
    ...(e.splits ?? []).map((p) => ({ kind: "split" as const, id: p.id })),
    ...e.masks.map((m) => ({ kind: "mask" as const, id: m.id })),
    ...e.holds.map((h) => ({ kind: "hold" as const, id: h.id })),
    ...(e.gaps ?? []).map((g) => ({ kind: "gap" as const, id: g.id })),
    ...(e.trim?.head === undefined
      ? []
      : [{ kind: "trim" as const, id: "head" }]),
    ...(e.trim?.tail === undefined
      ? []
      : [{ kind: "trim" as const, id: "tail" }]),
    // Only the editor writes a zoom's `point` (aimed where the author
    // clicked the Zoom lane) or `end` (a return the author placed); every
    // other zoom is one the new take generates again from its own clicks.
    ...scene.camera
      .filter((c) => c.point !== undefined || c.end !== undefined)
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
      detail: `take ${scene.meta.id} has no steps left in scene.json to record again`,
    };
  }
  const merged = mergeSkeleton(derivation, read, {
    onVerbChange: "refuse",
    sceneName: scene.meta.name,
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
      detail: `${merged.holes.map((h) => h.sentence.trim()).join(" ")} A re-recording never invents a value — derive the take, fill ${merged.holes.length === 1 ? "the hole" : "the holes"}, and run the draft`,
    };
  }
  const { target, ...rest } = merged.draft;
  return {
    ok: true,
    script: { ...rest, target: target ?? "", recordedFrom: scene.meta.id },
    refilm: {
      from: scene.meta.id,
      notes: merged.notes,
      notCarried: notCarriedOf(scene),
    },
  };
}
