import type { DeviceId } from "./device.js";
import {
  type SceneAction,
  type SceneAnchor,
  type SceneBranding,
  type SceneCanvas,
  type SceneCursor,
  type SceneDocument,
  type SceneMotion,
  URL_SCRUB_PLACEHOLDER,
} from "./document.js";
import { stepsInsideRemoved } from "./removed.js";
import {
  cursorPolishNamed,
  type DragFrom,
  type DragTo,
  SCRIPT_VERSION,
  SCRIPT_VERSION_DEVICE,
  SCRIPT_VERSION_DRAG,
  SCRIPT_VERSION_MOTION,
  type ScriptTarget,
} from "./script.js";

/**
 * A recorded take, read back as the intent that made it.
 *
 * The ONE legal direction between the two formats (see `script.ts`): a take
 * becomes a script by DROPPING evidence — timestamps, markers, rects,
 * resolutions, side channels — and keeping what the author did. A recorded
 * scroll's rect is read for one fact before it is dropped: where the scroll
 * left its anchor (`landing.top`), which is what the author did and the only
 * thing that tells two scrolls to one tall block apart. Nothing here
 * writes a `SceneDocument`, and nothing may call this from `migrateToCurrent`.
 *
 * Where the take cannot honestly supply a field, the draft is left in a shape
 * `DemoScriptSchema` refuses AT THAT FIELD — absent, or carrying a key the
 * strict step schema does not know — and a `Hole` says why. The door's own
 * parse is then the gate: a draft with a hole cannot be run by accident, and
 * the refusal names the same path the hole does. The invariant, tested in
 * both directions: `holes.length === 0` iff the draft parses.
 */

export type DraftStep =
  | {
      do: "click";
      on?: ScriptTarget;
      button?: "middle" | "right";
      recorded?: string;
    }
  | {
      do: "type";
      into?: ScriptTarget;
      text?: string;
      host?: true;
      recorded?: string;
    }
  | { do: "hover"; on?: ScriptTarget; recorded?: string }
  | {
      do: "scrollTo";
      on?: ScriptTarget;
      recorded?: string;
      landing?: { top: number };
    }
  | {
      do: "waitFor";
      on?: ScriptTarget;
      until: "visible" | "hidden";
      recorded?: string;
    }
  | {
      do: "drag";
      from?: DragFrom;
      to?: DragTo;
      recorded?: string;
    }
  | { do: "waitForLoad"; recorded?: string };

/** `DemoScript`'s shape with every hole-able field optional. Deliberately NOT
 *  typed as `DemoScript`: no caller can hand a draft to a run without the
 *  parse. */
export interface ScriptDraft {
  /** `SCRIPT_VERSION_MOTION` when the take carries a `motion` block, or a
   *  cursor tilt or click bounce, which the draft's `look` then carries too;
   *  `SCRIPT_VERSION_DEVICE` when the take was filmed as a phone or tablet;
   *  `SCRIPT_VERSION` otherwise. */
  scriptVersion:
    | typeof SCRIPT_VERSION
    | typeof SCRIPT_VERSION_MOTION
    | typeof SCRIPT_VERSION_DEVICE
    | typeof SCRIPT_VERSION_DRAG;
  name: string;
  /** Absent when capture scrubbed the origin — a `scrubbedTarget` hole. */
  target?: string;
  /** The take's viewport. Absent when `device` is set: a device is a
   *  viewport, and a script naming both is refused. */
  viewport?: { width: number; height: number };
  /** The phone or tablet the take was filmed as (spec 2026-10-10 §4). */
  device?: DeviceId;
  steps: DraftStep[];
  /** The take the steps' `recorded` ids refer to. */
  recordedFrom?: string;
  look: {
    branding: SceneBranding;
    cursor: SceneCursor;
    canvas: SceneCanvas;
    /** The take's own, when it has one — absent on a take nobody tuned,
     *  which reads as `MOTION_DEFAULTS` on both sides. */
    motion?: SceneMotion;
  };
}

export type HoleField =
  | "text"
  | "on"
  | "into"
  | "button"
  | "host"
  | "target"
  | "from"
  | "to";
export type HoleReason =
  | "scrubbedTarget"
  | "redacted"
  | "unnameable"
  | "ambiguousAtCapture"
  | "brokenAtCapture"
  | "buttonNotScriptable"
  | "hostField";

/** What capture saw of an element a script cannot name, so an agent can
 *  choose — every script-sayable field, plus the capture's candidate count. */
export interface HoleSaw {
  stableId: string | null;
  role: string | null;
  name: string | null;
  text: string | null;
  candidates: number;
}

export interface Hole {
  /** Index into `draft.steps`; null for a hole in the script itself
   *  (`target`), which belongs to no step. */
  step: number | null;
  /** The source action; null when `step` is. */
  actionId: string | null;
  field: HoleField;
  reason: HoleReason;
  sentence: string;
  saw?: HoleSaw;
  /** For `scrubbedTarget`: the origin as capture stored it, placeholders and
   *  all — which page it was, without the values it was reached with. */
  recorded?: string;
}

export type DerivationNote =
  | { kind: "cut"; step: number; actionId: string }
  | { kind: "trimmed"; step: number; actionId: string; end: "head" | "tail" }
  | { kind: "untitled" }
  /**
   * A recorded scroll whose rect misses the capture viewport, so it carries no
   * `landing` and the run will centre it. The rect was measured after the page
   * had moved on (the anchor is chosen from mid-screen, so it spanned the
   * screen when chosen) — it is not where the author left it, and the
   * derivation says so here rather than letting the centring happen silently.
   */
  | { kind: "landingOffscreen"; step: number; actionId: string };

export type Derivation =
  | {
      outcome: "derived";
      takeId: string;
      draft: ScriptDraft;
      holes: Hole[];
      notes: DerivationNote[];
    }
  | { outcome: "nothingToDerive"; takeId: string; reason: "noActions" };

/** A non-empty string or nothing — `accessibleName` and `textContent` may be
 *  `""` by the document schema, and a script target needs `min(1)`. */
const named = (value: string | null): string | null =>
  value === null || value === "" ? null : value;

/** The tiers an `unnameable` hole can have won by: the picture, or a named
 *  tier whose field the recording kept empty. */
type UnnameableTier =
  | "imagePatch"
  | "stableId"
  | "roleName"
  | "text"
  | "treePath";
type TargetFailure =
  | { reason: "unnameable"; tier: UnnameableTier }
  | { reason: "ambiguousAtCapture" }
  | { reason: "brokenAtCapture" };
type TargetAnswer =
  | { ok: true; target: ScriptTarget }
  | ({ ok: false } & TargetFailure);

/**
 * The tier that WON at capture, when a script can say it — never the first
 * non-null fingerprint field. The ladder falls through a tier that matched
 * several elements, so a `text` win on an element that also has a role and
 * name means `{role, name}` was not unique on that page; emitting it would
 * hand the run a tie the take already measured. And the authored run builds a
 * fingerprint with exactly one strategy set, so the winning tier alone is
 * what that run will consult.
 */
function targetOf(anchor: SceneAnchor): TargetAnswer {
  const f = anchor.fingerprint;
  switch (anchor.resolution.strategy) {
    case "stableId": {
      const stableId = named(f.stableId);
      return stableId === null
        ? { ok: false, reason: "unnameable", tier: "stableId" }
        : { ok: true, target: { stableId } };
    }
    case "roleName": {
      const role = named(f.role);
      const name = named(f.accessibleName);
      return role === null || name === null
        ? { ok: false, reason: "unnameable", tier: "roleName" }
        : { ok: true, target: { role, name } };
    }
    case "text": {
      const text = named(f.textContent);
      return text === null
        ? { ok: false, reason: "unnameable", tier: "text" }
        : { ok: true, target: { text } };
    }
    case "treePath": {
      // A position in the page: what a recorded scroll usually lands on, an
      // unnamed section mid-screen (`chooseScrollAnchor`). Measured by
      // capture, so carrying it is not a guess.
      const treePath = named(f.treePath);
      return treePath === null
        ? { ok: false, reason: "unnameable", tier: "treePath" }
        : { ok: true, target: { treePath } };
    }
    case "ambiguous":
      return { ok: false, reason: "ambiguousAtCapture" };
    case "broken":
      return { ok: false, reason: "brokenAtCapture" };
    case "imagePatch":
      // A picture: the one tier a script cannot say.
      return { ok: false, reason: "unnameable", tier: "imagePatch" };
  }
}

/** How an `unnameable` hole's element was found, in the words its sentence
 *  uses — the tier that won, and for a named tier, that its field was empty. */
const HOW_FOUND: Record<UnnameableTier, string> = {
  imagePatch: "was found by its picture",
  stableId: "was found by its id, but the recording kept no usable id",
  roleName:
    "was found by its role and name, but the recording kept no usable role and name",
  text: "was found by its text, but the recording kept no usable text",
  treePath:
    "was found by its position in the page, but the recording kept no usable position",
};

function sawOf(anchor: SceneAnchor): HoleSaw {
  const f = anchor.fingerprint;
  return {
    stableId: named(f.stableId),
    role: named(f.role),
    name: named(f.accessibleName),
    text: named(f.textContent),
    candidates: anchor.resolution.candidates,
  };
}

function targetSentence(
  n: number,
  field: "on" | "into" | "from",
  failure: TargetFailure,
  anchor: SceneAnchor,
): string {
  // A drag's start is `{ on: target }`, not the target itself.
  const shape =
    field === "from"
      ? `{ "on": … } with {stableId}, {role, name} or {text}`
      : "{stableId}, {role, name} or {text}";
  const fix = `Add "${field}" as ${shape} — "saw" lists what the recording saw, or take the name from an accessibility snapshot of the page.`;
  switch (failure.reason) {
    case "ambiguousAtCapture":
      return `Step ${n}'s element matched ${anchor.resolution.candidates} elements when it was recorded, so no name the recording saw picks it out. ${fix}`;
    case "brokenAtCapture":
      return `Step ${n}'s element could not be found again when it was recorded, so the recording holds no name that is known to reach it. ${fix}`;
    case "unnameable":
      return `Step ${n}'s element ${HOW_FOUND[failure.tier]}, so the recording holds nothing a script can name it by. ${fix}`;
  }
}

/**
 * Whether capture replaced any part of this URL with the placeholder — a
 * query value or a path segment. A real path segment that happens to read
 * "redacted" is indistinguishable, and is reported as scrubbed: asking the
 * agent to confirm a URL costs one look, and running a guessed one costs a
 * run against the wrong page.
 */
function wasScrubbed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  return (
    url.pathname.split("/").includes(URL_SCRUB_PLACEHOLDER) ||
    [...url.searchParams.values()].includes(URL_SCRUB_PLACEHOLDER)
  );
}

function indexOfAction(
  doc: SceneDocument,
  actionId: string | undefined,
): number {
  return actionId === undefined
    ? -1
    : doc.actions.findIndex((a) => a.id === actionId);
}

export function scriptFromTake(doc: SceneDocument): Derivation {
  const takeId = doc.meta.id;
  if (doc.actions.length === 0) {
    return { outcome: "nothingToDerive", takeId, reason: "noActions" };
  }

  const anchors = new Map(doc.anchors.map((a) => [a.id, a]));
  const holes: Hole[] = [];
  const notes: DerivationNote[] = [];
  const steps: DraftStep[] = [];

  const cut = stepsInsideRemoved(doc);
  const head = indexOfAction(doc, doc.edits.trim?.head?.actionId);
  const tail = indexOfAction(doc, doc.edits.trim?.tail?.actionId);

  doc.actions.forEach((action: SceneAction, i) => {
    const n = i + 1;
    const hole = (h: Omit<Hole, "step" | "actionId">): void => {
      holes.push({ step: i, actionId: action.id, ...h });
    };

    if (cut.has(action.id)) {
      notes.push({ kind: "cut", step: i, actionId: action.id });
    }
    if (head !== -1 && i < head) {
      notes.push({
        kind: "trimmed",
        step: i,
        actionId: action.id,
        end: "head",
      });
    }
    if (tail !== -1 && i > tail) {
      notes.push({
        kind: "trimmed",
        step: i,
        actionId: action.id,
        end: "tail",
      });
    }

    // An anchorless wait is a navigation wait — the same reading the engine
    // makes (`walk.ts`, `waitFor` with `anchorId === null`).
    if (action.kind === "waitFor" && action.anchorId === null) {
      steps.push({ do: "waitForLoad", recorded: action.id });
      return;
    }

    const found = anchors.get(action.anchorId as string);
    if (found === undefined) {
      // `SceneDocumentSchema` refuses a dangling anchorId, so a document that
      // parsed cannot reach this. Thrown rather than skipped: a step dropped
      // here would be a script that silently does less than the take did.
      throw new Error(
        `scriptFromTake: action "${action.id}" names anchor "${action.anchorId}", which this take does not have`,
      );
    }
    const field =
      action.kind === "type" ? "into" : action.kind === "drag" ? "from" : "on";
    const answer = targetOf(found);
    // Absent, not undefined-valued, when there is a hole: the schema must
    // refuse the missing field by its own name.
    const on = answer.ok ? { on: answer.target } : {};
    const into = answer.ok ? { into: answer.target } : {};
    if (!answer.ok) {
      hole({
        field,
        reason: answer.reason,
        sentence: targetSentence(n, field, answer, found),
        saw: sawOf(found),
      });
    }

    switch (action.kind) {
      case "click": {
        if (action.button === "middle" || action.button === "right") {
          steps.push({
            do: "click",
            ...on,
            button: action.button,
            recorded: action.id,
          });
          hole({
            field: "button",
            reason: "buttonNotScriptable",
            sentence: `Step ${n} was a ${action.button} click, and a script can only click with the left button. Deleting "button" makes it a left click — a different action from the one recorded.`,
          });
        } else {
          steps.push({ do: "click", ...on, recorded: action.id });
        }
        return;
      }
      case "type": {
        const step: Extract<DraftStep, { do: "type" }> = {
          do: "type",
          ...into,
          recorded: action.id,
        };
        if (action.redacted || action.text === null) {
          hole({
            field: "text",
            reason: "redacted",
            sentence: `Step ${n} typed into a field whose text the recording never read — a credential, a secret, or rich text the sensor stopped following. Add "text" with a demo value.`,
          });
        } else {
          step.text = action.text;
        }
        if (action.host === true) {
          step.host = true;
          hole({
            field: "host",
            reason: "hostField",
            sentence: `Step ${n} typed into a rich-text editor at the caret. A script's type step selects everything in the field and replaces it, so running this will erase that editor's whole contents on the live app. Delete "host" only if that is what you want.`,
          });
        }
        steps.push(step);
        return;
      }
      case "moveTo":
        steps.push({ do: "hover", ...on, recorded: action.id });
        return;
      case "scrollTo": {
        // Where the scroll left its anchor, by the walk's own rule
        // (`scrollAimOf`): a rect that meets the viewport is a landing the
        // author had. No rect is a take from before `action.rect` existed,
        // and centres as it always did.
        const rect = action.rect;
        const { height } = doc.meta.capture.viewport;
        if (rect === undefined) {
          steps.push({ do: "scrollTo", ...on, recorded: action.id });
        } else if (rect.y < height && rect.y + rect.height > 0) {
          steps.push({
            do: "scrollTo",
            ...on,
            recorded: action.id,
            landing: { top: rect.y },
          });
        } else {
          notes.push({
            kind: "landingOffscreen",
            step: i,
            actionId: action.id,
          });
          steps.push({ do: "scrollTo", ...on, recorded: action.id });
        }
        return;
      }
      case "waitFor":
        // Anything but "hidden", with an anchor, waits for visible — the
        // engine's own reading (`wantVisible` in `walk.ts`).
        steps.push({
          do: "waitFor",
          ...on,
          recorded: action.id,
          until: action.condition === "hidden" ? "hidden" : "visible",
        });
        return;
      case "drag": {
        // The spots and the end's form as the script asked them, so a re-run
        // reproduces the same points from fresh boxes.
        const at = action.fromAt === undefined ? {} : { at: action.fromAt };
        const step: Extract<DraftStep, { do: "drag" }> = {
          do: "drag",
          ...(answer.ok ? { from: { on: answer.target, ...at } } : {}),
          recorded: action.id,
        };
        if ("by" in action.to) {
          step.to = { by: action.to.by };
        } else {
          const end =
            action.toAnchorId === null
              ? undefined
              : anchors.get(action.toAnchorId);
          const toAnswer = end === undefined ? null : targetOf(end);
          if (toAnswer?.ok === true) {
            step.to = {
              on: toAnswer.target,
              ...(action.to.at === undefined ? {} : { at: action.to.at }),
            };
          } else {
            hole({
              field: "to",
              reason: toAnswer === null ? "unnameable" : toAnswer.reason,
              sentence: `Step ${n} was a drag whose drop target cannot be named from the recording. Add "to" with a target, or an offset as { "by": { "x": …, "y": … } }.`,
              ...(end === undefined ? {} : { saw: sawOf(end) }),
            });
          }
        }
        steps.push(step);
        return;
      }
      default: {
        const unknown: never = action;
        throw new Error(
          `scriptFromTake: no step for ${JSON.stringify(unknown)}`,
        );
      }
    }
  });

  // The start URL is a field of the script, not of a step, so its hole is the
  // first in the list and names no step.
  const origin = doc.meta.capture.originUrl;
  const scrubbed = wasScrubbed(origin);
  if (scrubbed) {
    holes.unshift({
      step: null,
      actionId: null,
      field: "target",
      reason: "scrubbedTarget",
      sentence: `The start URL was recorded as ${origin} — Demoman replaces query values and secret-looking path segments before a take reaches disk, so the page the author started on cannot be read back. Fill the target with the real start URL.`,
      recorded: origin,
    });
  }

  let name = doc.meta.name;
  if (name.trim() === "") {
    name = `untitled take ${takeId}`;
    notes.push({ kind: "untitled" });
  }

  return {
    outcome: "derived",
    takeId,
    draft: {
      // A take whose camera the author tuned keeps it on a re-run: before
      // 2026-10-09 `look` had no `motion`, and the re-run came back on the
      // defaults with nothing said. The version follows the key — see
      // `SCRIPT_VERSION_MOTION` — so a take nobody tuned still derives the
      // version-1 script it always did. A tuned tilt or click bounce needs
      // the same version (`cursorPolishNamed`), motion block or not.
      // A phone take declares the device version, which is past motion's,
      // so it may carry the take's motion too.
      scriptVersion: doc.actions.some((a) => a.kind === "drag")
        ? SCRIPT_VERSION_DRAG
        : doc.meta.capture.device !== undefined
          ? SCRIPT_VERSION_DEVICE
          : doc.motion === undefined && !cursorPolishNamed(doc.cursor)
            ? SCRIPT_VERSION
            : SCRIPT_VERSION_MOTION,
      name,
      ...(scrubbed ? {} : { target: origin }),
      ...(doc.meta.capture.device === undefined
        ? { viewport: doc.meta.capture.viewport }
        : { device: doc.meta.capture.device.preset }),
      steps,
      recordedFrom: takeId,
      look: {
        branding: doc.branding,
        cursor: doc.cursor,
        canvas: doc.canvas,
        ...(doc.motion === undefined ? {} : { motion: doc.motion }),
      },
    },
    holes,
    notes,
  };
}
