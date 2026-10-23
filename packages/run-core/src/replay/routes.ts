import type { ReplayPolicy } from "@demoman/replay-engine";
import type { SceneDocument } from "@demoman/scene-schema";

/*
 * Moved from `src/editor/capability.ts` on 2026-09-27 (task 7 of the
 * agent-door plan), unchanged apart from this header and its import paths —
 * see `docs/superpowers/specs/2026-09-26-agent-door-and-editor-removal-
 * design.md` §5 and §6: "Surface in the editor, engine at the door — they
 * are a refusal's advice."
 *
 * 2026-09-28 (plan 2 of the agent door, Task 7): `Tier`, `CapabilityPolicy`
 * and `tierOf` followed, verbatim, from the `capability.ts` they had stayed
 * behind in — they are read at the door (`frozenRoutes`, and through it
 * `RunReport.refused.routes`), and the editor's last uses of this file (the
 * export's rebuild-failure row, and the inspector's `replacementPath`) left
 * with the rebuild. `capability.ts` is deleted; its `isPixelAffecting` and
 * `waitsForRebuild` had no caller left. Spec §5, amended 2026-09-28:
 * "`tierOf` and `CapabilityPolicy` are read at the door."
 *
 * `NoticeRoute` is moved, not deleted: `src/core/replay/report.ts`'s
 * `RunReport.refused.routes` carries it, landing where these routes were
 * always aimed — at a caller who can act on them, rather than at a
 * popover's dead end.
 */

/**
 * `frozen` no longer means "this scene writes data". It means replay is
 * switched off for this scene — which is what v9's tier was always about,
 * and was indistinguishable while the two were the same fact (see
 * `ReplayPolicy`'s docblock).
 */
export type Tier = "regenerating" | "frozen";

/**
 * Only `mayReplay` — never `mutating` or `writes` — decides the tier here,
 * so a caller with just the resolved boolean (a test, or a narrower
 * consumer) can supply it without fabricating the rest of `ReplayPolicy`.
 */
export type CapabilityPolicy = Pick<ReplayPolicy, "mayReplay">;

/**
 * `_scene` stays in the signature even though only `policy.mayReplay` is
 * read below: every caller already holds a scene, and v8 §12's Part II
 * matrix (a later task) decides per-scene on more than this one flag.
 * Underscore-prefixed for the linter — a parameter kept for a documented
 * future need, not a leftover from an incomplete refactor.
 *
 * `null` is admitted for one caller, and it is not a convenience: a run
 * refused at the agent door has no take yet (`frozenRoutes`, and
 * `RunReport.refused.routes` behind it), and the tier a refusal reports does
 * not depend on one — `mayReplay` is false, so it is `frozen` whatever
 * document there is or is not. When the Part II matrix does read the scene,
 * this parameter is where a null has to be answered for, and the type is what
 * will force that.
 */
export function tierOf(
  _scene: SceneDocument | null,
  policy: CapabilityPolicy,
): Tier {
  return policy.mayReplay ? "regenerating" : "frozen";
}

export type NoticeRoute =
  | { kind: "replacement"; anchorId: string | null }
  | { kind: "reRecord" }
  | { kind: "safeEnvironment" }
  | { kind: "enableMutatingReplay" };

/**
 * The ways out of a scene whose rebuilds are switched off.
 *
 * What is left of `noticeFor` after spec §2 retired the edit-time notice. The
 * notice was a card that appeared when an edit could not reach the pixels;
 * the chip is a standing count instead, and these routes moved into its
 * popover — turning rebuilds on is still first, because it is still the
 * recommended action, and the prose in `approximations.ts` names them in
 * this order.
 *
 * THREE, not four. "Use a replacement overlay" was the fourth, and it could
 * never land from here: the chip and the export's failure row are about the
 * take, not about one edit, so the route carried `anchorId: null` and every
 * press dead-ended in a sentence (plan 3's final review, I5). It is offered
 * per retext line in the chip's popover instead (`main.ts`'s
 * `approximationLines`), carrying that step's own anchor, so every button
 * offered can land.
 *
 * The chip, its popover, `approximations.ts` and the export's failure row
 * have all since left the editor (plan 2 of the agent door, Tasks 6 and 7);
 * the agent door's `RunReport.refused.routes` is this function's caller now.
 *
 * Empty when the policy allows a rebuild: there is nothing to work around.
 *
 * `scene: null` is the agent door's case: a run the policy refused never
 * assembled a take, and the three routes out of a frozen one are the same
 * either way (see `tierOf`, which is where the null is answered for). Passing
 * a stand-in document instead would have meant fabricating one, which is the
 * thing that whole design forbids.
 */
export function frozenRoutes(
  scene: SceneDocument | null,
  policy: CapabilityPolicy,
): NoticeRoute[] {
  if (tierOf(scene, policy) !== "frozen") return [];
  return [
    { kind: "enableMutatingReplay" },
    { kind: "reRecord" },
    { kind: "safeEnvironment" },
  ];
}
