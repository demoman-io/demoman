import type { KeepAnswer } from "@demoman/runner/package";
import { describe, expect, it } from "vitest";
import { keepLines, removeLines } from "../src/keep-lines.js";

describe("keepLines", () => {
  // Red if the screens note is left off: nothing else prints it.
  it("prints the screens note beside the platform note", () => {
    const lines = keepLines({
      ok: true,
      kept: { name: "Add a task" },
      file: ".demoman/flows/add-a-task.json",
      written: ["docs/a.mp4", ".demoman/flows/add-a-task.json"],
      screensNote: "4 of 4 screens are still",
      platformNote: "kept on macOS: x",
      moved: null,
    } as Extract<KeepAnswer, { ok: true }>);
    expect(lines).toEqual([
      'Added "Add a task" to the repo: .demoman/flows/add-a-task.json',
      "  wrote docs/a.mp4",
      "  4 of 4 screens are still",
      "  kept on macOS: x",
    ]);
  });

  // Red if markNote is left off, or screensNote printed as "undefined".
  it("prints a files keep without screens, and says when the flow was not marked kept", () => {
    const lines = keepLines({
      ok: true,
      kept: { name: "Add a task" },
      file: ".demoman/flows/add-a-task.json",
      written: [".demoman/flows/add-a-task.json"],
      receipt: null,
      markNote: 'the library could not mark "Add a task" as kept (x)',
      moved: null,
    } as Extract<KeepAnswer, { ok: true }>);
    expect(lines).toEqual([
      'Added "Add a task" to the repo: .demoman/flows/add-a-task.json',
      '  the library could not mark "Add a task" as kept (x)',
    ]);
  });

  // Red if `moved` is not printed: the old file's removal is said nowhere else.
  it("says which old file it moved", () => {
    const lines = keepLines({
      ok: true,
      kept: { name: "Add a task" },
      file: ".demoman/flows/add-a-task.json",
      written: [".demoman/flows/add-a-task.json"],
      moved: ".demoman/videos/add-a-task.json",
    } as Extract<KeepAnswer, { ok: true }>);
    expect(lines).toEqual([
      'Added "Add a task" to the repo: .demoman/flows/add-a-task.json',
      "  moved it from .demoman/videos/add-a-task.json",
    ]);
  });
});

describe("removeLines", () => {
  it("names what it removed and the exports it left", () => {
    expect(
      removeLines({
        ok: true,
        name: "Add a task",
        removed: [
          ".demoman/flows/add-a-task.json",
          ".demoman/receipts/add-a-task.json",
        ],
        exportsLeft: ["docs/a.mp4", "docs/a.gif"],
      }),
    ).toEqual([
      'Removed "Add a task" from the repo: .demoman/flows/add-a-task.json, .demoman/receipts/add-a-task.json.',
      "Its exports stay: docs/a.mp4, docs/a.gif.",
      "Commit the change.",
    ]);
  });

  it("leaves out the exports line when there are none", () => {
    expect(
      removeLines({
        ok: true,
        name: "A",
        removed: [".demoman/flows/a.json"],
        exportsLeft: [],
      }),
    ).toEqual([
      'Removed "A" from the repo: .demoman/flows/a.json.',
      "Commit the change.",
    ]);
  });

  it("prints a failure's detail", () => {
    expect(
      removeLines({
        ok: false,
        reason: "notInRepo",
        detail: 'no flow "B" in this repo',
      }),
    ).toEqual(['no flow "B" in this repo']);
  });
});
