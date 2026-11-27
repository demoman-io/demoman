/**
 * A JavaScript dialog in the video. The walk answers the dialog at
 * once and records `DIALOG_BEAT_MS` on the action as the card's hold, so the
 * render reads the beat rather than deciding it again.
 */
import type { DialogRecord, SceneDocument } from "@demoman/scene-schema";

/** How long the dialog card holds on screen, in output ms. */
export const DIALOG_BEAT_MS = 1500;

/** The last part of the beat, in ms, in which the answer's button is drawn pressed. */
export const DIALOG_PRESS_MS = 300;

/**
 * One action's dialogs as one hold at its marker: the beats the walk
 * recorded, summed, and the cards drawn over it in the order they opened.
 * Never an `edits.holds` entry, which `migrateHoldsToGaps` would turn into a
 * gap: it is read from the action's record on every plan.
 */
export interface PlannedDialogHold {
  actionId: string;
  durationMs: number;
  cards: DialogRecord[];
}

/** The holds a take's dialogs ask for: none for a take without any. */
export function planDialogs(scene: SceneDocument): PlannedDialogHold[] {
  return scene.actions.flatMap((action) => {
    const cards = "dialogs" in action ? (action.dialogs ?? []) : [];
    if (cards.length === 0) return [];
    return [
      {
        actionId: action.id,
        durationMs: cards.reduce((sum, card) => sum + card.beatMs, 0),
        cards,
      },
    ];
  });
}
