// packages/run-core/src/refilm/edited.ts
import type { MadeFromStep } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { anchorDigest, type SkeletonRead } from "./skeleton.js";

// What export owes a caller about a take whose scene.json no longer matches
// its frames (spec 2026-10-14 re-film §3). `madeFrom` is the frames' own
// record; the skeleton's digests catch a fingerprint edited in place.

export interface EditedStep {
  actionId: string;
  what: "text" | "kind" | "target" | "added" | "removed";
  /** For "text" and "kind": the filmed value (the text, or the step's kind). */
  was?: string | null;
  /** For "text" and "kind": the value scene.json now holds. */
  now?: string | null;
}

/** Whether a target edited in place (same anchorId, new fingerprint) can be
 *  looked for. Only a readable skeleton carries the digests to compare, so:
 *  - "checked": the digests were compared;
 *  - "noSkeleton": there is no skeleton (a take filmed before skeletons
 *    existed, or a non-CLI run). Every such take says so the same way, and
 *    the summary stays silent about it, so the field is the only record;
 *  - `{ unreadable }`: a script.json is there but could not be used, which
 *    is never read as an old take (spec §4); the summary says so. */
export type TargetCheck = "checked" | "noSkeleton" | { unreadable: string };

export function targetCheckOf(read: SkeletonRead): TargetCheck {
  switch (read.kind) {
    case "ok":
      return "checked";
    case "none":
      return "noSkeleton";
    case "unreadable":
      return { unreadable: read.error };
  }
}

/** Null when there is nothing to compare against: frames made before the
 *  record existed. The export then omits `warnings.editedSinceRecorded`,
 *  which its docblock says means exactly that. */
export function editedSinceRecorded(
  scene: SceneDocument,
  madeFrom: readonly MadeFromStep[] | null,
  read: SkeletonRead,
): EditedStep[] | null {
  if (madeFrom === null) return null;
  const filmed = new Map(madeFrom.map((m) => [m.actionId, m]));
  const anchors = new Map(scene.anchors.map((a) => [a.id, a]));
  const digests = new Map<string, string>();
  if (read.kind === "ok") {
    for (const s of read.skeleton.steps) {
      if (s.do !== "pause" && s.actionId !== null && s.anchorDigest !== null) {
        digests.set(s.actionId, s.anchorDigest);
      }
    }
  }
  const out: EditedStep[] = [];
  for (const action of scene.actions) {
    const then = filmed.get(action.id);
    if (then === undefined) {
      out.push({ actionId: action.id, what: "added" });
      continue;
    }
    if (then.kind !== action.kind) {
      out.push({
        actionId: action.id,
        what: "kind",
        was: then.kind,
        now: action.kind,
      });
      continue;
    }
    const now = action.kind === "type" ? action.text : null;
    if (action.kind === "type" && then.text !== now) {
      out.push({ actionId: action.id, what: "text", was: then.text, now });
      continue;
    }
    const anchorId = action.anchorId ?? null;
    if (anchorId !== then.anchorId) {
      out.push({ actionId: action.id, what: "target" });
      continue;
    }
    const digest = digests.get(action.id);
    if (digest !== undefined && anchorId !== null) {
      // A digest with no anchor behind it is an edit too: the anchor the
      // step named at filming is no longer in scene.json.
      const anchor = anchors.get(anchorId);
      if (anchor === undefined || anchorDigest(anchor.fingerprint) !== digest) {
        out.push({ actionId: action.id, what: "target" });
      }
    }
  }
  const present = new Set(scene.actions.map((a) => a.id));
  for (const m of madeFrom) {
    if (!present.has(m.actionId))
      out.push({ actionId: m.actionId, what: "removed" });
  }
  return out;
}
