import type { FrameBundle, MadeFromStep } from "@demoman/compositor";
import type { CapabilityPolicy } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { captureSentence } from "../core/capture-explain";
import {
  type ReplayStatus,
  replayRecoverable,
  replaySentence,
} from "../core/replay/status";
import type { CaptureStatus } from "../core/storage/types";
import type { EditCommand } from "./commands";
import type { HoverReport } from "./hover-report";
import type { BundleSource, IdSource } from "./ports";
import {
  type EditorState,
  initEditor,
  markSaved,
  redo,
  runCommand,
  undo,
} from "./state";

export interface SessionSnapshot {
  scene: SceneDocument;
  bundle: FrameBundle | null;
  /**
   * The action log the frames on screen recorded themselves as made from,
   * or null when they carry none.
   *
   * A fact about the FRAMES, so an edit does not touch it — which is what
   * lets the editor say a typed step's text differs from what was filmed.
   * It moves only when `refresh()` reads a different bundle.
   */
  madeFrom: readonly MadeFromStep[] | null;
  /** Why the last re-shoot stopped, in the editor's voice. Null when none
   *  ran, one ran clean, or the policy refused it (see `VOICED`). */
  replaySentence: string | null;
  /** Whether that stop was a non-breakage — the author's own cancel, or a
   *  retry-and-it-works case. The page's headline reads this so it cannot
   *  contradict the sentence. */
  replayRecoverable: boolean;
  /** What the take's own motion recording managed to capture, in the
   *  editor's voice. A different fact from `replaySentence` — this is about
   *  the take itself, not about a re-shoot — and null for both the
   *  healthy states: a full recording, and a genuinely static page. */
  captureSentence: string | null;
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** The develop-time pixel check's finding, or null before it has run. */
  hoverReport: HoverReport | null;
}

export interface SessionDeps {
  sceneId: string;
  loadScene(sceneId: string): Promise<SceneDocument>;
  saveScene(scene: SceneDocument): Promise<void>;
  bundles: Pick<BundleSource, "active">;
  newId: IdSource;
}

/**
 * The policy `replaySentence` is asked under: one that allows a run, always.
 *
 * Plan 2 of the agent door, Task 7 (2026-09-28). The editor used to read
 * `replay:policy` at boot and hand the answer in here, and `replaySentence`
 * withheld its sentence while the policy refused — because every sentence
 * ends in advice to run again, and the editor's own rebuild could not take
 * that advice under a refusal. The editor offers no rebuild any more, so that
 * reason does not apply here: a re-shoot runs on the run page, which reads the
 * policy itself, and a stopped one leaves a status this session is owed a
 * sentence for.
 *
 * What still holds: `"mutating"` — a run the policy refused, which never
 * started — is withheld inside `replaySentence` whatever this says. The one
 * behaviour change: a stopped re-shoot's sentence still shows after the
 * author turns the setting off, where it used to go quiet.
 *
 * A constant rather than a narrowed `replaySentence`: that function was
 * lifted to `src/core/replay/` for a door-side consumer too (`status.ts`'s
 * header), which would hold a real policy to ask it under.
 */
const VOICED: CapabilityPolicy = { mayReplay: true };

/**
 * A document with the two fields no edit owns set aside — see `refresh()`.
 * Key order is normalised, because a document that went through the store
 * and one built by an edit can hold the same fields in a different order.
 */
function comparable(scene: SceneDocument): string {
  const { renderMode: _mode, ...meta } = scene.meta;
  const normalised = {
    ...scene,
    meta,
    flags: { ...scene.flags, hoverSensitive: false },
  };
  return JSON.stringify(normalised, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : value,
  );
}

/** Whether a re-read is the document the history was built on. False for the
 *  placeholder a session starts from, which has no `meta` at all. */
function sameDocument(held: SceneDocument, read: SceneDocument): boolean {
  if (held.meta === undefined || held.flags === undefined) return false;
  return comparable(held) === comparable(read);
}

/**
 * Where two documents first part, as `path: before -> after`, in the same
 * normalised terms `sameDocument` compares — or null when they do not.
 *
 * For the one line `refresh()` owes when it drops the undo history: an
 * author whose Ctrl+Z stopped working after a rebuild is owed the field that
 * moved under them, not a history that quietly emptied.
 */
function firstDifference(
  held: SceneDocument,
  read: SceneDocument,
): string | null {
  const walk = (a: unknown, b: unknown, path: string): string | null => {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (
      a !== null &&
      b !== null &&
      typeof a === "object" &&
      typeof b === "object"
    ) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of [...keys].sort()) {
        const found = walk(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          `${path}.${key}`,
        );
        if (found !== null) return found;
      }
    }
    const short = (v: unknown): string =>
      JSON.stringify(v)?.slice(0, 80) ?? "undefined";
    return `${path}: ${short(a)} -> ${short(b)}`;
  };
  return walk(
    JSON.parse(comparable(held)),
    JSON.parse(comparable(read)),
    "scene",
  );
}

/** `scene` with the store's `renderMode` — or none, when the store has
 *  none. The editor owns no writer of that field; see `persist()`. */
function withStoredRenderMode(
  scene: SceneDocument,
  stored: SceneDocument,
): SceneDocument {
  const { renderMode: _mode, ...meta } = scene.meta;
  return {
    ...scene,
    meta:
      stored.meta.renderMode === undefined
        ? meta
        : { ...meta, renderMode: stored.meta.renderMode },
  };
}

/** A history entry carrying the re-read's `renderMode` and `hoverSensitive`,
 *  so stepping back through it moves only what the author edited. */
function rebased(entry: SceneDocument, read: SceneDocument): SceneDocument {
  const carried = withStoredRenderMode(entry, read);
  return {
    ...carried,
    flags: { ...entry.flags, hoverSensitive: read.flags.hoverSensitive },
  };
}

/**
 * The one place scene and bundle are held together.
 *
 * The page owns exactly one of these and renders from `snapshot()`. Keeping
 * the coordination here rather than in `main.ts` is what makes the re-read
 * rules — including the `hoverSensitive` merge — testable with no DOM and no
 * extension.
 */
export function createSession(deps: SessionDeps) {
  let state: EditorState = initEditor({} as SceneDocument);
  let bundle: FrameBundle | null = null;
  /** The name as last loaded from, or written to, the store. `persist()`
   *  treats a session whose name still equals this as one that has not
   *  renamed, and lets a name renamed elsewhere (a Recordings card, since
   *  2026-09-14) through rather than writing the loaded one back over it. */
  let knownName: string | null = null;
  let replay: ReplayStatus | null = null;
  let capture: CaptureStatus | null = null;
  const listeners = new Set<(snapshot: SessionSnapshot) => void>();

  /**
   * Everything this session itself writes or re-reads runs here, one at a
   * time.
   *
   * Serialising every write (and the re-read) against this lane means each
   * of this session's OWN jobs computes its effect against
   * whatever `state` actually is when its own turn comes, not a copy
   * captured before it queued, so there is nothing for a later job in this
   * lane to have superseded.
   *
   * It does not, and cannot, close the window against a write from some
   * OTHER surface entirely — another tab or client, or a re-shoot run on
   * the run page. Those never touch this lane; they go through
   * `persist()`'s own merge instead, which is narrower than this lane's
   * guarantee. See `persist()`'s docblock.
   *
   * (Until 2026-09-28 the editor's own rebuild ran beside this lane, and
   * edits that changed what it was making were refused while it ran. That
   * rebuild moved to the run page, and the refusal went with it.)
   */
  let lane: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lane.then(fn, fn);
    lane = run.catch(() => {});
    return run;
  };

  const snapshot = (): SessionSnapshot => ({
    scene: state.scene,
    bundle,
    /**
     * The action log the frames on screen recorded themselves as made from,
     * or null when they carry none.
     *
     * A fact about the FRAMES, so an edit does not touch it. It moves only
     * when `refresh()` reads a different bundle.
     */
    madeFrom: bundle?.madeFrom ?? null,
    // The sentence a stopped run owes the author, or null. The page shows it
    // beside the failure box; without it a failed replay is indistinguishable
    // from one that never ran, which is the distinction this whole state
    // exists for.
    //
    // Under `VOICED`, not a policy read from the setting — see its docblock.
    replaySentence: replaySentence(replay, VOICED, state.scene),
    replayRecoverable: replayRecoverable(replay),
    // The take's own recording is a fact about what was captured, not an
    // offer to run anything, so there is nothing here for a policy to refuse.
    //
    // Gated on the *serving* bundle not being a different (replay) one: once
    // a complete replay supersedes the capture bundle, `bundle.source`
    // becomes "replay" and this fact stops being about what the author is
    // looking at — it is history about a bundle no longer on screen.
    // `capture` itself is left alone by a replay (see replay-runner), so
    // without this gate the sentence would outlive its own relevance.
    //
    // `bundle === null` must NOT suppress this: it is precisely the state
    // when a take produces no bundle at all (`noKeyframes`, `storageRefused`)
    // — the cases where the author most needs to be told what happened.
    // Suppress only when a genuinely different bundle is serving.
    captureSentence:
      capture === null || (bundle !== null && bundle.source !== "capture")
        ? null
        : captureSentence(capture),
    error: state.error,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    hoverReport: state.hoverReport,
  });

  const emit = (): void => {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  };

  /**
   * Merge what the editor never owns, then write.
   *
   * `hoverSensitive` is set only by a replay run and only ever to true, so
   * OR-ing it keeps an editor write from erasing a discovery the editor
   * never saw. This NARROWS that window; it does not close it. The read and
   * the write are separate awaits, so a background write landing between
   * them is still overwritten — reduced from the whole of a run to
   * one store round-trip, with no change in how quietly it happens.
   *
   * Closing it properly means the store owning the merge — a compare-and-
   * set, or a `mutate(id, fn)` that reads and writes inside one transaction
   * — rather than this function reading and writing across an await it does
   * not hold. Recorded as a known limitation rather than pretended away.
   *
   * Merges only `hoverSensitive`: it is the one field documented as
   * background-owned and monotonic. Do not generalise this to other flags.
   *
   * And `meta.renderMode`, on a third rule: the editor writes it nowhere.
   * Its only writers are the run page's re-shoot promotion
   * (`src/adapters/reshoot.ts`) and the library card's "Back to your
   * recording", so every write carries the store's value, whatever this
   * session loaded. Without that, one trim in a tab left open across a
   * re-shoot quietly put the take back on `screen` (final review I1).
   *
   * And `meta.name`, on a different rule: a name this session has not
   * changed since it last loaded or wrote one is not this session's to
   * write, so a rename made on a Recordings card meanwhile survives the
   * next edit here. A rename made here is newer intent and wins.
   *
   * Returns the document actually written, which can differ from `scene` by
   * that one field — callers must assign it back onto `state.scene` rather
   * than assuming what they proposed is what landed.
   */
  const persist = async (scene: SceneDocument): Promise<SceneDocument> => {
    const current = await deps.loadScene(deps.sceneId);
    let merged =
      current.flags.hoverSensitive && !scene.flags.hoverSensitive
        ? { ...scene, flags: { ...scene.flags, hoverSensitive: true } }
        : scene;
    if (
      knownName !== null &&
      scene.meta.name === knownName &&
      current.meta.name !== knownName
    ) {
      merged = { ...merged, meta: { ...merged.meta, name: current.meta.name } };
    }
    merged = withStoredRenderMode(merged, current);
    await deps.saveScene(merged);
    knownName = merged.meta.name;
    return merged;
  };

  /**
   * Read scene and bundle from their owners.
   *
   * `load()` is this. The editor calls it at open; it re-read after every
   * rebuild too, until the rebuild left the editor on 2026-09-28. The rules
   * below still hold for any re-read, because replay may set
   * `flags.hoverSensitive` to true and never to false, and only a replay can
   * discover it, so the background is the source of truth across that
   * boundary. Writing an in-memory copy back over the result would clear a
   * flag that had just been earned.
   *
   * Runs on the write lane, alongside every other write, for the same
   * reason: a write queued behind this can then be computed fresh against
   * the scene this just loaded, rather than something older.
   *
   * Undo history survives a re-read of the SAME document, and only that
   * (plan 3's final review, I6). When export rebuilt on the way out, the
   * rebuild re-read twice — after the run, and after the `demo` promotion —
   * so resetting on every re-read wiped the author's history on every
   * Rebuild and export: retext, export, Ctrl+Z, nothing. "The same" is the
   * document the history was built on, less the two fields no edit owns and
   * a re-read legitimately moves: `meta.renderMode` (which frames play, set
   * by the promotion and by "Back to your recording") and
   * `flags.hoverSensitive` (set only by a replay run). Every history entry is
   * rebased onto the re-read's values for those two, or an undo would write
   * the pre-promotion `screen` back and quietly swap the rebuilt frames for
   * the recording.
   *
   * A re-read that changed anything else — a retro re-shoot truncating the
   * take to the steps it reached, a rename from a Recordings card — clears
   * the history, deliberately: an entry built on the old document would let
   * `undo()` resurrect exactly what the background just replaced.
   */
  const refresh = (): Promise<void> =>
    serialize(async () => {
      const scene = await deps.loadScene(deps.sceneId);
      // `active()` returns `{ bundle, replay, capture }`, never a bare
      // bundle. Assigning the wrapper here would put an object with no
      // `keyframes`, `markers` or `madeFrom` in place of a real bundle —
      // every reader downstream, from the compositor's own plan to
      // `snapshot().madeFrom` above, would silently operate on the wrong
      // shape instead of throwing where the mistake was made.
      const active = await deps.bundles.active(deps.sceneId);
      bundle = active.bundle;
      replay = active.replay;
      capture = active.capture;
      const kept = sameDocument(state.scene, scene);
      if (!kept && (state.past.length > 0 || state.future.length > 0)) {
        // Deliberate (see above), but never silent: an emptied history reads
        // exactly like "nothing to undo". `info`, because a document the
        // background changed is an expected outcome, not a fault.
        console.info(
          `[demoman] editor: undo history cleared on re-read — the document changed at ${firstDifference(state.scene, scene)}`,
        );
      }
      state = kept
        ? {
            ...initEditor(scene),
            past: state.past.map((entry) => rebased(entry, scene)),
            future: state.future.map((entry) => rebased(entry, scene)),
          }
        : initEditor(scene);
      knownName = scene.meta.name;
      emit();
    });

  return {
    load: refresh,
    snapshot,

    subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async dispatch(command: EditCommand): Promise<void> {
      await serialize(async () => {
        // Computed HERE, against whatever `state` is at execution time, not
        // before the lane. Computing it early and applying it after is how
        // two concurrent edits used to lose one of themselves (the second
        // one's `next`, built from a `before` that never saw the first
        // one's effect, simply overwrote it), and how a dispatch could
        // resurrect a scene a concurrent undo had just discarded — the same
        // before-vs-live mistake this method's own discard branch used to
        // make against the editor's old rebuild. There is no staleness to detect in
        // `state` any more, because there is no snapshot of IT old enough to
        // go stale — `state` is always read fresh, this instant. `persist()`
        // below reads its own, separate copy of the STORE's document,
        // moments before it writes; that one can still go stale between its
        // own read and write. See `persist()`'s docblock.
        const before = state;
        const next = runCommand(state, command, deps.newId);
        if (next.scene === before.scene) {
          state = next;
          emit();
          return;
        }
        state = next;
        try {
          state = { ...state, scene: await persist(state.scene) };
        } catch (error) {
          // Revert: the store never took this edit, and leaving it in
          // memory would show the author a change that vanishes on the
          // next reload. `persist` reads before it writes, so a failing
          // READ now fails a write that would previously have succeeded —
          // all the more reason it must not fail silently.
          state = {
            ...before,
            error: error instanceof Error ? error.message : String(error),
          };
          emit();
          return;
        }
        state = markSaved(state);
        emit();
      });
    },

    async undo(): Promise<void> {
      await serialize(async () => {
        // Same reasoning as dispatch: recompute against live state, inside
        // the lane, rather than a copy captured before it.
        const previous = undo(state);
        if (previous.scene === state.scene) return;
        const before = state;
        state = previous;
        try {
          state = { ...state, scene: await persist(state.scene) };
        } catch (error) {
          state = {
            ...before,
            error: error instanceof Error ? error.message : String(error),
          };
          emit();
          return;
        }
        state = markSaved(state);
        emit();
      });
    },

    async redo(): Promise<void> {
      await serialize(async () => {
        const next = redo(state);
        if (next.scene === state.scene) return;
        const before = state;
        state = next;
        try {
          state = { ...state, scene: await persist(state.scene) };
        } catch (error) {
          state = {
            ...before,
            error: error instanceof Error ? error.message : String(error),
          };
          emit();
          return;
        }
        state = markSaved(state);
        emit();
      });
    },

    /**
     * Resolves once every write on the lane has run — including any queued
     * behind it while this waited. For leaving the page: a rename committed
     * by the very blur that pressed Back is queued but not yet sent, and
     * navigating in the same task drops it with nothing to say so. The lane
     * never rejects (`serialize` catches it), so this never does either; a
     * write that failed says so in `snapshot().error` as it always has.
     */
    async settled(): Promise<void> {
      let tail: Promise<unknown>;
      do {
        tail = lane;
        await tail;
      } while (tail !== lane);
    },

    /**
     * Stores the develop-time pixel check's finding. Deliberately bypasses
     * `runCommand`: the report is a derived finding about the scene, not an
     * edit to it, so it must not push an undo entry or mark the document
     * dirty — see `EditorState.hoverReport`'s docblock for why a wrong
     * `still` must stay a proposal, never an automatic edit.
     */
    setHoverReport(report: HoverReport | null): void {
      state = { ...state, hoverReport: report };
      emit();
    },
  };
}
