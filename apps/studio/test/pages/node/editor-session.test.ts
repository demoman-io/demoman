import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import {
  captureBundle,
  proceduralBundle,
} from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { createSession } from "../../../pages/src/editor/session";

function deps(overrides: Record<string, unknown> = {}) {
  const scene = readonlyScene();
  return {
    sceneId: scene.meta.id,
    loadScene: vi.fn().mockResolvedValue(scene),
    saveScene: vi.fn().mockResolvedValue(undefined),
    bundles: {
      active: vi.fn().mockResolvedValue({
        bundle: proceduralBundle(),
        replay: null,
        capture: null,
      }),
      load: vi.fn(),
    },
    newId: (() => {
      let n = 0;
      return () => `gen-${++n}`;
    })(),
    ...overrides,
  };
}

/**
 * A store that actually holds a scene, so a clobber against the last write
 * is observable rather than merely against a fixed mock return value.
 */
function backing() {
  let stored: SceneDocument = readonlyScene();
  return {
    get stored() {
      return stored;
    },
    set stored(v: SceneDocument) {
      stored = v;
    },
    persistHoverSensitive() {
      stored = { ...stored, flags: { mutating: false, hoverSensitive: true } };
    },
    deps(overrides: Record<string, unknown> = {}) {
      return {
        sceneId: "scene-readonly-001",
        loadScene: vi.fn(async () => stored),
        saveScene: vi.fn(async (scene: SceneDocument) => {
          stored = scene;
        }),
        bundles: {
          active: vi.fn().mockResolvedValue({
            bundle: proceduralBundle(),
            replay: null,
            capture: null,
          }),
          load: vi.fn(),
        },
        newId: (() => {
          let n = 0;
          return () => `gen-${++n}`;
        })(),
        ...overrides,
      };
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ticks = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("editor session", () => {
  it("loads the scene and its active bundle", async () => {
    const session = createSession(deps());
    await session.load();
    expect(session.snapshot().scene.meta.id).toBe("scene-readonly-001");
    expect(session.snapshot().bundle).not.toBeNull();
  });

  it("carries a capture failure into the snapshot when the capture bundle is serving", async () => {
    // The status reaching the editor's boundary is not the same as the
    // author being told. This is the assertion that makes it the latter —
    // it goes red if session.ts stops reading `active().capture` or stops
    // computing `captureSentence` from it. The serving bundle must itself be
    // the capture one (source: "capture") or the gate added for Important 4
    // suppresses it — see the next test for that direction.
    const d = deps({
      bundles: {
        active: vi.fn().mockResolvedValue({
          bundle: captureBundle(),
          replay: null,
          capture: {
            motion: "none",
            reason: "screencastUnavailable",
            coveredMs: 0,
            takeMs: 9000,
          },
        }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    expect(session.snapshot().captureSentence).toContain(
      "Motion couldn't be recorded",
    );
  });

  it("says nothing about the capture recording once a replay bundle is serving", async () => {
    // Same capture status as the test above, but the serving bundle's
    // source is "replay" — a complete replay has superseded the capture
    // bundle. The sentence would otherwise describe a bundle the author is
    // no longer looking at. Goes red if session.ts computes captureSentence
    // from `capture` alone again, without consulting `bundle?.source`.
    const d = deps({
      bundles: {
        active: vi.fn().mockResolvedValue({
          bundle: proceduralBundle(),
          replay: null,
          capture: {
            motion: "none",
            reason: "screencastUnavailable",
            coveredMs: 0,
            takeMs: 9000,
          },
        }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    expect(session.snapshot().captureSentence).toBeNull();
  });

  it("says nothing when the recording was healthy", async () => {
    const d = deps({
      bundles: {
        active: vi.fn().mockResolvedValue({
          bundle: proceduralBundle(),
          replay: null,
          capture: {
            motion: "full",
            reason: null,
            coveredMs: 9000,
            takeMs: 9000,
          },
        }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    expect(session.snapshot().captureSentence).toBeNull();
  });

  it("still reports the capture recording when the take produced no bundle at all", async () => {
    // `bundle: null` is exactly the state for `noKeyframes` and
    // `storageRefused` — a take that failed so completely that nothing was
    // written to serve. It must NOT be treated as "a different bundle is
    // serving": that gate exists to suppress this sentence once a *replay*
    // bundle supersedes the capture one, not to suppress it when there is no
    // bundle to look at in the first place. Goes red if session.ts gates
    // captureSentence on `bundle?.source !== "capture"` again, since
    // `bundle?.source` is `undefined` — and `undefined !== "capture"` — for
    // a null bundle exactly as it would be for a replay one.
    const d = deps({
      bundles: {
        active: vi.fn().mockResolvedValue({
          bundle: null,
          replay: null,
          capture: {
            motion: "none",
            reason: "noKeyframes",
            coveredMs: 0,
            takeMs: 9000,
          },
        }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    expect(session.snapshot().captureSentence).toContain(
      "Nothing could be photographed",
    );
  });

  it("persists every edit", async () => {
    const d = deps();
    const session = createSession(d);
    await session.load();
    await session.dispatch({ kind: "rename", name: "Checkout" });
    expect(d.saveScene).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ name: "Checkout" }),
      }),
    );
  });

  it("reverts an edit and surfaces the reason when persist's read fails", async () => {
    // persist() reads before it writes, so a failing READ now fails a write
    // that would previously have succeeded outright. It must behave like
    // any other rejected write: revert in memory and surface the reason.
    let loads = 0;
    const d = deps({
      loadScene: vi.fn(async () => {
        loads += 1;
        if (loads === 2) throw new Error("store unavailable");
        return readonlyScene();
      }),
    });
    const session = createSession(d);
    await session.load();
    await session.dispatch({
      kind: "setGap",
      afterActionId: "act-1",
      durationMs: 1111,
    });

    expect(session.snapshot().scene.edits.gaps).toEqual([]);
    expect(session.snapshot().error).toMatch(/store unavailable/);
    expect(d.saveScene).not.toHaveBeenCalled();
  });

  it("merges hoverSensitive into the session's own state, not just what gets written to the store", async () => {
    // Without this, snapshot().scene disagrees with the store the moment
    // persist() merges the flag into what it writes: anything rendering
    // from the snapshot would show the stale `false` until the next
    // refresh.
    const b = backing();
    const d = b.deps();
    const session = createSession(d);
    await session.load();

    // The background discovers it between this session's load and this
    // edit's own persist() read.
    b.persistHoverSensitive();

    await session.dispatch({ kind: "rename", name: "Checkout" });

    expect(session.snapshot().scene.flags.hoverSensitive).toBe(true);
    expect(b.stored.flags.hoverSensitive).toBe(true);
  });

  it("keeps a name renamed elsewhere when the editor did not rename, and its own when it did", async () => {
    // The Recordings card renames a take while an editor tab holds it
    // open (the card opens the editor in a new tab, since 2026-09-14). The
    // editor's next save must not write its loaded name back over that.
    const b = backing();
    const d = b.deps();
    const session = createSession(d);
    await session.load();
    const renamedOnCard = (name: string) => {
      b.stored = { ...b.stored, meta: { ...b.stored.meta, name } };
    };

    renamedOnCard("Signup flow");
    await session.dispatch({ kind: "setTrim", head: null });
    expect(b.stored.meta.name).toBe("Signup flow");
    expect(session.snapshot().scene.meta.name).toBe("Signup flow");

    // The editor's own rename is the newer intent and wins.
    renamedOnCard("Older card name");
    await session.dispatch({ kind: "rename", name: "Editor name" });
    expect(b.stored.meta.name).toBe("Editor name");

    // And once that has landed, a later card rename wins again.
    renamedOnCard("Newer card name");
    await session.dispatch({ kind: "setTrim", tail: null });
    expect(b.stored.meta.name).toBe("Newer card name");
    expect(session.snapshot().scene.meta.name).toBe("Newer card name");
  });

  // Final review I1. Every `renderMode` writer lives outside the editor now:
  // the run page's re-shoot promotion and the library card's "Back to your
  // recording". An editor tab held open across either must not write its
  // loaded value back on the next edit. Goes red if `persist()` stops
  // carrying the store's `renderMode`.
  it("carries the store's renderMode, never its own, in every write", async () => {
    const b = backing();
    const d = b.deps();
    const session = createSession(d);
    await session.load();
    const setStoredMode = (mode: "screen" | "demo" | undefined) => {
      const { renderMode: _mode, ...meta } = b.stored.meta;
      b.stored = {
        ...b.stored,
        meta: mode === undefined ? meta : { ...meta, renderMode: mode },
      };
    };
    // The premise: the session loaded a document that does not already say
    // `demo`, so the promotion below is a real change it did not see.
    expect(session.snapshot().scene.meta.renderMode).not.toBe("demo");

    // A re-shoot on the run page promotes the take while the editor is open.
    setStoredMode("demo");
    await session.dispatch({ kind: "setTrim", head: null });
    expect(d.saveScene).toHaveBeenLastCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ renderMode: "demo" }),
      }),
    );
    expect(b.stored.meta.renderMode).toBe("demo");
    expect(session.snapshot().scene.meta.renderMode).toBe("demo");

    // Then the library's Back sends it to `screen`: the editor, still
    // holding `demo`, writes `screen`.
    setStoredMode("screen");
    await session.dispatch({ kind: "setTrim", tail: null });
    expect(b.stored.meta.renderMode).toBe("screen");
    expect(session.snapshot().scene.meta.renderMode).toBe("screen");

    // A store with no `renderMode` at all is written without one.
    setStoredMode(undefined);
    await session.dispatch({ kind: "rename", name: "After" });
    expect(b.stored.meta.name).toBe("After");
    expect("renderMode" in b.stored.meta).toBe(false);
  });

  it("carries a failed replay's reason through to the snapshot", async () => {
    // The wrapper shape matters here: assigning `active()`'s result straight
    // to `bundle` would put an object with no `madeFrom` into `snapshot()`.
    const d = deps({
      bundles: {
        active: vi.fn().mockResolvedValue({
          bundle: null,
          replay: {
            outcome: "partial",
            reason: "waitTimeout",
            completed: 1,
            total: 3,
          },
          capture: null,
        }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    expect(session.snapshot().replaySentence).toMatch(/1 of 3/);
    expect(session.snapshot().replaySentence).toMatch(/did not happen within/);
    // A wait that timed out is a break to fix, and the page's headline says
    // so off this flag rather than deciding again for itself.
    expect(session.snapshot().replayRecoverable).toBe(false);
  });

  // A policy refusal is not a stop the editor owes a sentence for: the run
  // never started, and its own advice would be to turn on the setting that
  // the run page, not this one, now offers. `replaySentence` withholds it.
  it("withholds the sentence for a run the policy refused", async () => {
    const d = deps({
      bundles: {
        active: vi.fn().mockResolvedValue({
          bundle: null,
          replay: {
            outcome: "partial",
            reason: "mutating",
            completed: 0,
            total: 3,
          },
          capture: null,
        }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    expect(session.snapshot().replaySentence).toBeNull();
  });

  // Plan 2, Task 7. The editor no longer reads `replay:policy`, and the
  // session voices a stopped run whatever the setting now says: a re-shoot
  // that stopped leaves its status on disk, and the failure box is where the
  // author reads why. Goes red if the session withholds on a refusing policy.
  it("voices a stopped re-shoot's status in the snapshot", async () => {
    const stopped = {
      outcome: "partial",
      reason: "anchorNotRendered",
      completed: 1,
      total: 3,
    } as const;
    const d = deps({
      bundles: {
        active: vi.fn().mockResolvedValue({
          bundle: captureBundle(),
          replay: stopped,
          capture: null,
        }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    const sentence = session.snapshot().replaySentence;
    expect(sentence).toMatch(/1 of 3/);
    expect(sentence).toMatch(/re-shoot/i);
    // The editor has no rebuild to point at, so its sentence names none.
    expect(sentence).not.toMatch(/rebuil/i);
    expect(session.snapshot().replayRecoverable).toBe(true);
  });

  // Final review I4. The same guard over the two engine sentences that said
  // "rebuild" into this box and the run page's verdict: a cancel before the
  // run, and a take with every step cut. Goes red if either string in
  // `packages/replay-engine/src/explain.ts` names a rebuild again.
  it.each([
    { reason: "cancelledByAuthor", outcome: "partial", completed: 0 },
    { reason: "noActions", outcome: "complete", completed: 0 },
  ] as const)(
    "voices a $reason stop without naming a rebuild",
    async ({ reason, outcome, completed }) => {
      const d = deps({
        bundles: {
          active: vi.fn().mockResolvedValue({
            bundle: captureBundle(),
            replay: {
              outcome,
              reason,
              completed,
              total: reason === "noActions" ? 0 : 3,
            },
            capture: null,
          }),
          load: vi.fn(),
        },
      });
      const session = createSession(d);
      await session.load();
      const sentence = session.snapshot().replaySentence;
      // Premise: the mapped sentence is there, not withheld or the raw id.
      expect(sentence).not.toBeNull();
      expect(sentence).not.toContain(reason);
      expect(sentence).toMatch(/re-shoot/i);
      expect(sentence).not.toMatch(/rebuil/i);
    },
  );

  it("notifies subscribers on every change", async () => {
    const session = createSession(deps());
    const seen = vi.fn();
    session.subscribe(seen);
    await session.load();
    await session.dispatch({ kind: "rename", name: "x" });
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("hands out the log the frames were made from", async () => {
    const scene = readonlyScene();
    const bundle = { ...proceduralBundle(), madeFrom: madeFromOf(scene) };
    // Premise: the bundle really carries a record, or `madeFrom: null`
    // would pass this test for the wrong reason.
    expect(bundle.madeFrom).toHaveLength(3);
    const d = deps({
      bundles: {
        active: vi.fn().mockResolvedValue({
          bundle,
          replay: null,
          capture: null,
        }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    expect(session.snapshot().madeFrom).toEqual(bundle.madeFrom);
  });

  /**
   * Undo across a re-read (plan 3's final review, I6). `refresh()` is what
   * `load()` runs, and each re-read used to reset the history. The rebuild
   * that re-read under an open editor left with plan 2's Task 7; the rule
   * about which re-reads keep the history did not, and is driven here by a
   * second `load()` over a store something else wrote to.
   */
  // Review Focus 5 (Auto frame plan): switching an existing demo to Auto is
  // one undoable edit. Red if setAspect stops going through the history, or
  // takes more than one step to undo.
  it("switches a 16:9 demo to Auto as one undoable edit", async () => {
    const session = createSession(deps());
    await session.load();
    // Premise: the demo is 16:9, and there is nothing to undo yet.
    expect(session.snapshot().scene.canvas.aspect).toBe("16:9");
    expect(session.snapshot().canUndo).toBe(false);
    await session.dispatch({ kind: "setAspect", aspect: "auto" });
    expect(session.snapshot().scene.canvas.aspect).toBe("auto");
    await session.undo();
    expect(session.snapshot().scene.canvas.aspect).toBe("16:9");
    expect(session.snapshot().canUndo).toBe(false);
  });

  describe("undo history across a re-read", () => {
    it("keeps it when the re-read is the same document, with the two fields no edit owns carried", async () => {
      const b = backing();
      const d = b.deps();
      const session = createSession(d);
      await session.load();
      await session.dispatch({
        kind: "setGap",
        afterActionId: "act-1",
        durationMs: 2222,
      });
      // Premise: an entry to undo before the re-read.
      expect(session.snapshot().canUndo).toBe(true);
      // A re-shoot's two writes to the stored take: the flag only a run
      // discovers, and the render mode a promotion (or "Back to your
      // recording") moves.
      b.persistHoverSensitive();
      b.stored = {
        ...b.stored,
        meta: { ...b.stored.meta, renderMode: "screen" },
      };
      await session.load();
      // Premise: the re-read really did bring back a document that differs
      // in the two fields no edit owns — and only in them.
      expect(session.snapshot().scene.flags.hoverSensitive).toBe(true);
      expect(session.snapshot().scene.meta.renderMode).toBe("screen");
      expect(session.snapshot().canUndo).toBe(true);

      await session.undo();
      expect(session.snapshot().scene.edits.gaps).toEqual([]);
      // Rebased: the undo moved the pause and nothing the re-read owns.
      expect(b.stored.flags.hoverSensitive).toBe(true);
      expect(b.stored.meta.renderMode).toBe("screen");
    });

    it("clears it when the re-read changed the document", async () => {
      const b = backing();
      const d = b.deps();
      const session = createSession(d);
      await session.load();
      await session.dispatch({ kind: "rename", name: "Take two" });
      expect(session.snapshot().canUndo).toBe(true);
      // A retro re-shoot truncating the take to the steps it reached.
      b.stored = { ...b.stored, actions: b.stored.actions.slice(0, 1) };
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      await session.load();
      expect(session.snapshot().scene.actions).toHaveLength(1);
      expect(session.snapshot().canUndo).toBe(false);
      // Said, not silent — and naming the field that moved, which is the
      // question an author whose Ctrl+Z stopped working is asking.
      const cleared = info.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("undo history cleared"));
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatch(/document changed at scene\.actions/);
      info.mockRestore();
    });

    it("says nothing when the history was kept, or was empty", async () => {
      const b = backing();
      const d = b.deps();
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const session = createSession(d);
      await session.load();
      // Premise: nothing to undo, so a changed re-read drops nothing.
      expect(session.snapshot().canUndo).toBe(false);
      b.stored = { ...b.stored, actions: b.stored.actions.slice(0, 1) };
      await session.load();
      // Premise: the re-read did change the document.
      expect(session.snapshot().scene.actions).toHaveLength(1);
      expect(
        info.mock.calls.some(([line]) =>
          String(line).includes("undo history cleared"),
        ),
      ).toBe(false);
      info.mockRestore();
    });
  });

  it("hands out null for frames written before the record existed", async () => {
    const bundle = proceduralBundle();
    // Premise: the fixture bundle really carries no `madeFrom` field — the
    // fact this test exists to distinguish from an empty array.
    expect("madeFrom" in bundle).toBe(false);
    const d = deps({
      bundles: {
        active: vi
          .fn()
          .mockResolvedValue({ bundle, replay: null, capture: null }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    expect(session.snapshot().madeFrom).toBeNull();
  });

  it("survives an edit: the record describes the FRAMES, not the scene", async () => {
    // A retext must not change `madeFrom` — that is the entire mechanism by
    // which the retext is still visible as an approximation afterwards.
    const scene = readonlyScene();
    const bundle = { ...proceduralBundle(), madeFrom: madeFromOf(scene) };
    const d = deps({
      bundles: {
        active: vi.fn().mockResolvedValue({
          bundle,
          replay: null,
          capture: null,
        }),
        load: vi.fn(),
      },
    });
    const session = createSession(d);
    await session.load();
    const before = session.snapshot().madeFrom;
    expect(before).not.toBeNull();

    await session.dispatch({
      kind: "setGap",
      afterActionId: "act-1",
      durationMs: 3333,
    });
    // Premise: the dispatch actually changed the scene — or a `madeFrom`
    // that never moves would pass this test whether or not the edit did
    // anything at all.
    expect(session.snapshot().scene.edits.gaps[0]?.durationMs).toBe(3333);
    expect(session.snapshot().madeFrom).toEqual(before);
  });
});

describe("editor session — the write lane", () => {
  it("a pixel-affecting dispatch queued behind an ordinary load() is SAVED, not discarded — load() bumping nothing does not make the edit stale", async () => {
    // `load()` (a plain reload — no regenerate anywhere in this test) used
    // to bump a version counter regardless of whether anything the edit
    // depended on had actually changed, discarding a dispatch that queued
    // behind it with a message that was factually false: "Frames are
    // regenerating" when nothing was, and "can be made once it finishes"
    // when it had already been thrown away. Now the edit is computed fresh,
    // inside the lane, against whatever load() most recently produced —
    // there is no stale snapshot to detect, so nothing to discard.
    const b = backing();
    const loadGate = deferred<void>();
    let loads = 0;
    const d = b.deps();
    d.loadScene = vi.fn(async () => {
      loads += 1;
      if (loads === 2) await loadGate.promise;
      return b.stored;
    });
    const session = createSession(d);
    await session.load();
    // Something else persisted a newer scene (e.g. a re-shoot that just ran).
    b.persistHoverSensitive();
    const reloading = session.load();
    await ticks();
    const p = session.dispatch({
      kind: "setGap",
      afterActionId: "act-1",
      durationMs: 4444,
    });
    await ticks();
    loadGate.resolve();
    await reloading;
    await p;

    expect(session.snapshot().error).toBeNull();
    expect(b.stored.edits.gaps[0]?.durationMs).toBe(4444);

    await session.dispatch({ kind: "rename", name: "later" });
    expect(b.stored.flags.hoverSensitive).toBe(true);
  });

  it("two concurrent dispatches both land, rather than the second overwriting the first's effect", async () => {
    // dispatch used to compute `next` outside the lane, against `before`
    // captured at call time, and apply it inside. Two dispatches issued
    // back to back, with nothing to yield on between them, both captured
    // the SAME pre-edit `before` — so whichever one's lane job ran second
    // overwrote the first's effect entirely, rather than building on it.
    const d = deps();
    const session = createSession(d);
    await session.load();
    const p1 = session.dispatch({
      kind: "setGap",
      afterActionId: "act-1",
      durationMs: 5555,
    });
    const p2 = session.dispatch({ kind: "rename", name: "two" });
    await Promise.all([p1, p2]);

    expect(session.snapshot().scene.meta.name).toBe("two");
    expect(session.snapshot().scene.edits.gaps[0]?.durationMs).toBe(5555);
  });

  it("a dispatch racing an undo does not resurrect the change the undo just discarded", async () => {
    const d = deps();
    const session = createSession(d);
    await session.load();
    await session.dispatch({
      kind: "setGap",
      afterActionId: "act-1",
      durationMs: 5555,
    });
    const undoing = session.undo();
    const redispatching = session.dispatch({
      kind: "addZoom",
      marker: { actionId: "act-3", offsetMs: 0 },
      target: { kind: "element", anchorId: "a-checkout" },
      scale: 3,
    });
    await Promise.all([undoing, redispatching]);

    // The undo's revert must survive, and the concurrent edit must land ON
    // TOP of the reverted scene, not a stale pre-undo copy computed before
    // either job ran.
    expect(session.snapshot().scene.edits.gaps).toEqual([]);
    expect(session.snapshot().scene.camera).toHaveLength(1);
  });
});
