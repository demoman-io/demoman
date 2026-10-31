import type { MadeFromStep } from "@demoman/compositor";
import {
  type SceneDocument,
  type ScriptStep,
  type ScriptTarget,
  type StrategyName,
  targetStrategy,
} from "@demoman/scene-schema";

/**
 * What a run report can say about one place its film disagrees with the
 * script that asked for it — or, for `"unverifiable"`, that no comparison
 * could be made at all.
 *
 * Four kinds, not `approximations.ts`'s seven: `"text"` is that file's
 * `retext` kind carried over unchanged in spirit (the film types something
 * else than the script asked for); `"element"` is new, from the resolver
 * strategy a run actually recorded against the one the script named;
 * `"missing"` is `insert`/`removed` collapsed into one fact, because there
 * is no earlier version of a FRESH document for a step to have been
 * inserted into or removed from — it is simply not in the film. `insert`,
 * `reorder`, `uncut` and `removed` do not apply to a document nobody has
 * edited yet, so they do not reach this union at all (spec §6: "the
 * comparison is a provenance verdict and lifts; ... four kinds lose their
 * producer entirely" — three of the four here, `reorder` being the fourth,
 * since a script's own step order is what the run performed, not something
 * a later edit could have shuffled).
 */
export type Divergence =
  | { kind: "text"; actionId: string; wanted: string; got: string | null }
  | {
      kind: "element";
      actionId: string;
      wanted: ScriptTarget;
      strategy: StrategyName;
      candidates: number;
    }
  | { kind: "missing"; actionId: string; reason: string }
  /** A drag the page ignored: it arrived and changed nothing on screen. */
  | { kind: "ignored"; actionId: string; reason: string }
  | { kind: "unverifiable"; reason: string }
  /** Typed text the field did not end up holding (the page cleared or
   *  rewrote it): the video shows the typing, the app does not keep it. */
  | {
      kind: "fieldDoesNotHold";
      actionId: string;
      wanted: string;
      value: string;
    };

export interface Verdict {
  kind: "matches" | "diverged";
  diverged: Divergence[];
}

/** The one sentence `buildVerdict` (`report.ts`) prints when `madeFrom` is
 *  absent — never an empty `diverged` list, because "we cannot tell" and
 *  "nothing diverged" are opposite answers (spec §2, rule 2). */
/** The sentence `buildVerdict` prints when the run produced no take at all —
 *  a refusal, or a run that performed no step. Distinct from `NO_RECORD`,
 *  which is frames that exist and carry no provenance: here there is no
 *  intended log to compare anything to, which is the stronger absence. */
export const NO_TAKE =
  "the run produced no video, so there is nothing for the script's steps to be compared against";

export const NO_RECORD =
  "these frames carry no record of what produced them, so which of the script's steps they show cannot be checked";

/** A step naming an element, narrowed to what a comparison needs: the
 *  script's own intent and what the run's resolver actually recorded for
 *  it. Structurally satisfied by `StepReport` (`report.ts`) without an
 *  import either way has to carry at runtime — this file only ever reads
 *  these four fields. */
export interface ResolvedIntent {
  actionId: string | null;
  intent: ScriptStep;
  strategy: StrategyName | null;
  candidates: number | null;
  fieldHolds?: { value: string; holds: boolean };
}

/** The step's target, whichever key it lives under — `waitForLoad` and
 *  `pause` name none. */
function targetOfStep(step: ScriptStep): ScriptTarget | null {
  if ("into" in step) return step.into;
  if ("from" in step) return step.from.on;
  if ("on" in step) return step.on;
  return null;
}

/** Which resolver strategy an agent's own `ScriptTarget` could honestly
 *  claim without having seen the page — the one its shape names. A run that
 *  resolved by anything else settled for less than the script asked for. */
function strategyOfTarget(target: ScriptTarget): StrategyName {
  // One reading of a target's shape for the whole codebase. This used to end
  // in a bare `return "text"`, which read a `treePath` target as a text match
  // and reported every position step that resolved by position as settling
  // for less than it asked.
  return targetStrategy(target);
}

/**
 * The field-by-field structural compare `approximations.ts` uses to say
 * which of an editor's edits the frames on screen do not show, lifted and
 * re-aimed at a different question: not which of the author's edits the
 * frames do not show, but which of the SCRIPT's steps the film does not
 * show (spec §2, §6). Same technique — walk the intended actions, look each
 * one up in `madeFrom` by id, compare kind-specific fields — pointed at
 * `scene.actions` (standing in for the script's own intended log, the
 * document a completed run would have produced) instead of an edited
 * document, and widened by the `"element"` check below, which the editor's
 * comparison had no reason to make: an edit never records a resolver
 * strategy, and a script does.
 *
 * Returns a plain list, empty when nothing diverged — it never decides
 * `"matches"` on its own. `buildRunReport` (`report.ts`) is what applies the
 * run's own `outcome` before trusting an empty list: CLAUDE.md's "report
 * before you forgive" is exactly the rule that a stopped run's frames
 * matching the steps that DID run must not be read as the film matching the
 * script, which asked for more than that.
 */
export function compareToScript(
  scene: SceneDocument,
  madeFrom: readonly MadeFromStep[],
  resolved: readonly ResolvedIntent[],
): Divergence[] {
  const was = new Map(madeFrom.map((step) => [step.actionId, step]));
  const found: Divergence[] = [];

  for (const action of scene.actions) {
    const then = was.get(action.id);
    if (then === undefined) {
      found.push({
        kind: "missing",
        actionId: action.id,
        reason: "the video does not show this step",
      });
      continue;
    }
    if (
      action.kind === "type" &&
      then.kind === "type" &&
      action.text !== then.text
    ) {
      found.push({
        kind: "text",
        actionId: action.id,
        wanted: action.text ?? "",
        got: then.text,
      });
    }
  }

  for (const step of resolved) {
    if (
      step.actionId !== null &&
      step.fieldHolds?.holds === false &&
      step.intent.do === "type"
    ) {
      found.push({
        kind: "fieldDoesNotHold",
        actionId: step.actionId,
        wanted: step.intent.text,
        value: step.fieldHolds.value,
      });
    }
    if (step.actionId === null || step.strategy === null) continue;
    const target = targetOfStep(step.intent);
    if (target === null) continue;
    const wanted = strategyOfTarget(target);
    if (step.strategy !== wanted) {
      found.push({
        kind: "element",
        actionId: step.actionId,
        wanted: target,
        strategy: step.strategy,
        candidates: step.candidates ?? 0,
      });
    }
  }

  return found;
}
