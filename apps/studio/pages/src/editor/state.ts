import type { SceneDocument } from "@demoman/scene-schema";
import { sameBranding } from "./branding";
import { applyCommand, type EditCommand } from "./commands";
import type { HoverReport } from "./hover-report";
import type { IdSource } from "./ports";

/** Deep enough for a session's worth of edits, shallow enough to stay cheap. */
export const UNDO_LIMIT = 50;

export interface EditorState {
  scene: SceneDocument;
  past: SceneDocument[];
  future: SceneDocument[];
  /** A rejected command's message. Rejection is a bug in the caller, not in the document. */
  error: string | null;
  /** Whether the scene differs from what is in the store. */
  dirty: boolean;
  /**
   * The develop-time pixel check's finding, or null before it has run. Advisory
   * only: nothing here edits the scene, because a wrong `still` would delete a
   * real hover and undo history resets on every scene re-read.
   */
  hoverReport: HoverReport | null;
}

export function initEditor(scene: SceneDocument): EditorState {
  return {
    scene,
    past: [],
    future: [],
    error: null,
    dirty: false,
    hoverReport: null,
  };
}

/**
 * Undo is a stack of whole documents rather than a stack of inverse
 * commands. They are small JSON and there is no diffing machinery to get
 * wrong; an editor without undo is a trap, and this is the cheap version of
 * not being one.
 */
export function runCommand(
  state: EditorState,
  command: EditCommand,
  newId: IdSource,
): EditorState {
  let next: SceneDocument;
  try {
    next = applyCommand(state.scene, command, newId);
  } catch (error) {
    return {
      ...state,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // A branding edit that changes nothing — "#1B2A4A" typed over the stored
  // "#1b2a4a", Reset to a kit the demo already matches — is not an edit:
  // it used to push an undo entry that undid nothing, and mark the scene
  // dirty for a save that wrote what was there.
  if (
    command.kind === "setBranding" &&
    sameBranding(state.scene.branding, next.branding)
  ) {
    return { ...state, error: null };
  }
  return {
    scene: next,
    past: [...state.past, state.scene].slice(-UNDO_LIMIT),
    future: [],
    error: null,
    dirty: true,
    // Removing or restoring a piece changes which steps are in the video,
    // and the report is a finding about exactly that.
    hoverReport:
      command.kind === "removePiece" ||
      command.kind === "restorePiece" ||
      command.kind === "setRemovedEdge"
        ? null
        : state.hoverReport,
  };
}

export function undo(state: EditorState): EditorState {
  const previous = state.past[state.past.length - 1];
  if (!previous) return state;
  return {
    ...state,
    scene: previous,
    past: state.past.slice(0, -1),
    future: [state.scene, ...state.future],
    error: null,
    dirty: true,
    // Undo/redo swap in an entirely different, previously-recorded
    // document, which may hold other steps in the video than the one the
    // report was made against. Unconditional, like `error` above.
    hoverReport: null,
  };
}

export function redo(state: EditorState): EditorState {
  const [next, ...rest] = state.future;
  if (!next) return state;
  return {
    ...state,
    scene: next,
    past: [...state.past, state.scene].slice(-UNDO_LIMIT),
    future: rest,
    error: null,
    dirty: true,
    // See `undo`'s comment: the same swap-in-a-different-document reasoning
    // applies symmetrically here.
    hoverReport: null,
  };
}

export function markSaved(state: EditorState): EditorState {
  return { ...state, dirty: false };
}
