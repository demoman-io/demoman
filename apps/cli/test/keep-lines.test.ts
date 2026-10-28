import type { KeepAnswer } from "@demoman/runner/package";
import { describe, expect, it } from "vitest";
import { keepLines } from "../src/keep-lines.js";

describe("keepLines", () => {
  // Red if the screens note is left off: nothing else prints it.
  it("prints the screens note beside the platform note", () => {
    const lines = keepLines({
      ok: true,
      kept: { name: "Add a task" },
      file: ".demoman/videos/add-a-task.json",
      written: ["docs/a.mp4", ".demoman/videos/add-a-task.json"],
      screensNote: "4 of 4 screens are still",
      platformNote: "kept on macOS: x",
    } as Extract<KeepAnswer, { ok: true }>);
    expect(lines).toEqual([
      'Kept "Add a task" in .demoman/videos/add-a-task.json',
      "  wrote docs/a.mp4",
      "  4 of 4 screens are still",
      "  kept on macOS: x",
    ]);
  });
});
