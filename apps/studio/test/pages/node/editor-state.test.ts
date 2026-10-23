import { describe, expect, it } from "vitest";
import {
  mutatingScene,
  readonlyScene,
} from "../../../../../packages/replay-engine/test/helpers/scenes";
import type { HoverReport } from "../../../pages/src/editor/hover-report";
import {
  initEditor,
  redo,
  runCommand,
  UNDO_LIMIT,
  undo,
} from "../../../pages/src/editor/state";

function ids(): () => string {
  let n = 0;
  return () => `gen-${++n}`;
}

describe("editor state", () => {
  it("applies a command and records the previous document", () => {
    const state = runCommand(
      initEditor(readonlyScene()),
      { kind: "rename", name: "b" },
      ids(),
    );
    expect(state.scene.meta.name).toBe("b");
    expect(state.past).toHaveLength(1);
    expect(state.past[0]?.meta.name).toBe("Orders walkthrough");
  });

  it("undoes and redoes", () => {
    const edited = runCommand(
      initEditor(readonlyScene()),
      { kind: "rename", name: "b" },
      ids(),
    );
    const back = undo(edited);
    expect(back.scene.meta.name).toBe("Orders walkthrough");
    expect(redo(back).scene.meta.name).toBe("b");
  });

  it("drops the redo stack once a new command lands", () => {
    const edited = runCommand(
      initEditor(readonlyScene()),
      { kind: "rename", name: "b" },
      ids(),
    );
    const branched = runCommand(
      undo(edited),
      { kind: "rename", name: "c" },
      ids(),
    );
    expect(branched.future).toEqual([]);
    expect(redo(branched).scene.meta.name).toBe("c");
  });

  it("bounds the undo stack", () => {
    let state = initEditor(readonlyScene());
    for (let i = 0; i < UNDO_LIMIT + 10; i++) {
      state = runCommand(state, { kind: "rename", name: `n${i}` }, ids());
    }
    expect(state.past).toHaveLength(UNDO_LIMIT);
  });

  // `EditorState.notice` and `runCommand`'s `noticeFor` call retired with
  // spec §2's edit-time notice (Task 10): four tests used to live here,
  // pinning that a pixel-affecting edit's tier and routes were attached to
  // the command's own result — "attaches the tier notice produced by the
  // command", the regenerating-tier counterpart, and the trailing/
  // non-trailing delete contrast. `runCommand` computes no such thing now,
  // and since plan 2's Task 7 it takes no policy at all. `isPixelAffecting`
  // left with the rebuild (it had no caller); `frozenRoutes` is the agent
  // door's, tested in `replay-routes.test.ts`.

  it("leaves the document untouched when a command throws", () => {
    const before = initEditor(readonlyScene());
    const after = runCommand(
      before,
      { kind: "setGap", afterActionId: "act-3", durationMs: 100 },
      ids(),
    );
    expect(after.scene).toBe(before.scene);
    expect(after.past).toEqual([]);
    expect(after.error).toMatch(/no step after/);
  });

  it("marks the scene dirty when it changes and clean after a save", () => {
    const state = runCommand(
      initEditor(readonlyScene()),
      { kind: "rename", name: "b" },
      ids(),
    );
    expect(state.dirty).toBe(true);
  });

  const FAKE_REPORT: HoverReport = {
    removable: ["act-2"],
    checked: 2,
    unchecked: 1,
    failed: false,
  };

  it("leaves the hover report untouched by a command that changes nothing in the video", () => {
    const before: ReturnType<typeof initEditor> = {
      ...initEditor(mutatingScene()),
      hoverReport: FAKE_REPORT,
    };
    const state = runCommand(before, { kind: "rename", name: "x" }, ids());
    expect(state.hoverReport).toBe(FAKE_REPORT);
  });

  it("retires the hover report on undo, even though undo never runs runCommand", () => {
    // `changesActionIds` classifies a COMMAND; undo swaps in a previously
    // recorded document it never inspects. `removable` naming ids from a
    // scene that is neither on screen before nor after this call is the
    // same defect `runCommand`'s own guard exists to prevent — undo/redo
    // just reach it by a different door.
    const edited: ReturnType<typeof initEditor> = {
      ...runCommand(
        initEditor(readonlyScene()),
        { kind: "rename", name: "b" },
        ids(),
      ),
      hoverReport: FAKE_REPORT,
    };
    const back = undo(edited);
    expect(back.scene.meta.name).toBe("Orders walkthrough");
    expect(back.hoverReport).toBeNull();
  });

  it("retires the hover report on redo", () => {
    const edited: ReturnType<typeof initEditor> = {
      ...runCommand(
        initEditor(readonlyScene()),
        { kind: "rename", name: "b" },
        ids(),
      ),
      hoverReport: null,
    };
    const back: ReturnType<typeof initEditor> = {
      ...undo(edited),
      hoverReport: FAKE_REPORT,
    };
    const forward = redo(back);
    expect(forward.scene.meta.name).toBe("b");
    expect(forward.hoverReport).toBeNull();
  });
});

describe("a branding edit that changes nothing", () => {
  it("pushes no undo entry and leaves the scene clean", () => {
    const start = initEditor(readonlyScene());
    const stored = start.scene.branding.background;
    // Premise: the fixture's background is a gradient, so restating its
    // From is what the From box commits for a case-only retype once parsed.
    expect(stored.kind).toBe("gradient");
    if (stored.kind !== "gradient") return;
    const same = runCommand(
      start,
      { kind: "setBranding", patch: { gradient: { from: stored.from } } },
      ids(),
    );
    expect(same.past).toHaveLength(0);
    expect(same.dirty).toBe(false);
    expect(same.scene).toBe(start.scene);

    // A real change still is one.
    expect(stored.from).not.toBe("#e03131");
    const changed = runCommand(
      start,
      { kind: "setBranding", patch: { gradient: { from: "#e03131" } } },
      ids(),
    );
    expect(changed.past).toHaveLength(1);
    expect(changed.dirty).toBe(true);
  });
});
