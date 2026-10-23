import type {
  SceneAnchor,
  ScriptTarget,
  StrategyName,
} from "@demoman/scene-schema";

/**
 * A fingerprint with the target's one strategy set and every other field null.
 *
 * Null is not a placeholder here, it is the claim: the step names the one
 * thing it knows, and every other field would be an observation nobody made
 * for this run. A `treePath` target is itself an observation — capture made
 * it when the take was recorded, and `scriptFromTake` carried it across — so
 * it is the one field set, exactly as the other shapes' fields are.
 * `Fingerprint`'s own refinement accepts this — one usable strategy is the
 * bar.
 *
 * Moved here from `authored.ts` (plan 2) and exported on the page door: the
 * sensor's snapshot checks each target it lists by resolving exactly this
 * fingerprint, so a run and a snapshot cannot build it two ways.
 */
export function fingerprintFromTarget(
  target: ScriptTarget,
): SceneAnchor["fingerprint"] {
  const blank: SceneAnchor["fingerprint"] = {
    stableId: null,
    role: null,
    accessibleName: null,
    textContent: null,
    treePath: null,
    boundingRect: null,
    imagePatchRef: null,
    dataKey: null,
  };
  // Every member, then `never`: an `in` chain ending in a bare return read a
  // `treePath` target as `textContent: undefined`, and this shape makes the
  // compiler refuse a member added to the union and forgotten here.
  if ("stableId" in target) return { ...blank, stableId: target.stableId };
  if ("role" in target)
    return { ...blank, role: target.role, accessibleName: target.name };
  if ("text" in target) return { ...blank, textContent: target.text };
  if ("treePath" in target) return { ...blank, treePath: target.treePath };
  const unknown: never = target;
  throw new Error(`unknown script target ${JSON.stringify(unknown)}`);
}

/**
 * The script target a capture's winning strategy names, or null when the
 * strategy is not one a script can name (an unbroken tie, nothing found, the
 * image-patch tier) or its field is empty. `fingerprintFromTarget` is its
 * inverse for every non-null answer.
 */
export function targetFromFingerprint(
  strategy: StrategyName,
  fp: SceneAnchor["fingerprint"],
): ScriptTarget | null {
  switch (strategy) {
    case "stableId":
      return fp.stableId === null ? null : { stableId: fp.stableId };
    case "roleName":
      return fp.role === null || fp.accessibleName === null
        ? null
        : { role: fp.role, name: fp.accessibleName };
    case "text":
      return fp.textContent === null ? null : { text: fp.textContent };
    case "treePath":
      return fp.treePath === null ? null : { treePath: fp.treePath };
    default:
      return null;
  }
}
