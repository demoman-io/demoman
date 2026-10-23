import type { SceneAction } from "@demoman/scene-schema";

/**
 * What each action kind means to a cursor planner and to the walk — one entry
 * per kind, and the compiler refuses a kind without one.
 *
 * Why a table: these decisions were ~20 scattered branches, and one of them
 * was made nowhere at all. Every step that named an element became a cursor
 * stop, so a scroll sent the cursor to whatever paragraph sat mid-screen
 * (the author's take of 2026-09-29). Nobody decided that; nothing could.
 * The repo has made this move before: `RECOVERABLE`, `REASON_TEXT` and
 * `NOT_KEPT` were hand-kept sets until each became a `Record`.
 *
 * Not here: what a verb DOES (the mouse and key events). That is the verb's
 * implementation and lives in `performVerb`.
 */
export interface VerbTraits {
  /**
   * The cursor travels to this step's element before the verb. False for a
   * scroll — a wheel or trackpad leaves the pointer where it is while the
   * page moves — and for a wait, which acts on nothing.
   */
  cursorTravels: boolean;
  /**
   * How the walk brings the element into view: `nearest`, the shortest
   * correction; `landing`, back to the recorded top (centred without one —
   * see `ScrollAim` in `@demoman/replay-engine`); `none`, not at all.
   */
  approach: "nearest" | "landing" | "none";
}

export const VERBS: Record<SceneAction["kind"], VerbTraits> = {
  click: { cursorTravels: true, approach: "nearest" },
  type: { cursorTravels: true, approach: "nearest" },
  moveTo: { cursorTravels: true, approach: "nearest" },
  scrollTo: { cursorTravels: false, approach: "landing" },
  waitFor: { cursorTravels: false, approach: "none" },
  drag: { cursorTravels: true, approach: "nearest" },
};
