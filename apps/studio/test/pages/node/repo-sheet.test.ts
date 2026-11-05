import { describe, expect, it } from "vitest";
import type { RepoEvent } from "../../../pages/src/platform/types";
import {
  type RepoSheetArgs,
  repoSheetModel,
} from "../../../pages/src/shell/repo-sheet";

/** A door whose add answers `job-1` and lets the test send its events. */
function door() {
  let send: (e: RepoEvent) => void = () => {};
  const bodies: unknown[] = [];
  const repo: RepoSheetArgs["repo"] = {
    addable: async () => ({ ok: false, reason: "x", label: "x", detail: "x" }),
    add: async (_id, body) => {
      bodies.push(body);
      return { jobId: "job-1" };
    },
    remove: async () => ({ removed: [], exportsLeft: [], notes: [] }),
    onRepo: (_job, fn) => {
      send = fn;
      return () => {};
    },
  };
  const args: RepoSheetArgs = {
    video: { id: "v1", name: "Checkout" },
    addable: { ok: true, root: "/r", defaultPath: "docs/demos/checkout.mp4" },
    repo,
    ci: null,
  };
  const tell = (e: Record<string, unknown>) =>
    send({ type: "repo", videoId: "v1", jobId: "job-1", ...e } as RepoEvent);
  return { args, bodies, tell };
}

const added = { phase: "added", file: "f.json", root: "/r" };

describe("repoSheetModel", () => {
  // Red if the model stops reading its defaults from `addable` (path) or from `add`'s defaults (commit, share).
  it("starts on the form with the default path, commit and share", () => {
    const m = repoSheetModel(door().args);
    expect(m.state.step).toBe("form");
    expect(m.fields).toEqual({
      path: "docs/demos/checkout.mp4",
      deliver: "commit",
      quality: "share",
    });
  });

  // Red if a `failed` event stops resolving the sheet with `added: null` and the detail.
  it("resolves added: null with the detail when the add fails", async () => {
    const d = door();
    const m = repoSheetModel(d.args);
    await m.submit();
    expect(m.state.step).toBe("running");
    d.tell({ phase: "failed", reason: "x", detail: "No room." });
    expect(await m.result).toEqual({
      added: null,
      prOpened: null,
      failed: "No room.",
    });
  });

  // Red if an added event with notes stops keeping the sheet on its last step.
  it("stays on the last step when the add came with notes", async () => {
    const d = door();
    const m = repoSheetModel(d.args);
    m.fields.deliver = "files";
    await m.submit();
    d.tell({ ...added, written: ["a.mp4"], notes: ["Check the scale."] });
    expect(m.state).toMatchObject({
      step: "last",
      written: ["a.mp4"],
      notes: ["Check the scale."],
    });
    expect(m.autoClosed).toBe(false);
    m.close();
    expect((await m.result).added?.notes).toEqual(["Check the scale."]);
  });

  // Red if delivery `files` with no notes stops closing without the last step (decision 3).
  it("closes by itself on files delivery with no notes", async () => {
    const d = door();
    const m = repoSheetModel(d.args);
    m.fields.deliver = "files";
    await m.submit();
    expect(d.bodies).toEqual([
      { path: "docs/demos/checkout.mp4", deliver: "files", quality: "share" },
    ]);
    d.tell({ ...added, written: ["a.mp4"], notes: [] });
    expect(m.autoClosed).toBe(true);
    expect((await m.result).added).toEqual({ written: ["a.mp4"], notes: [] });
  });

  // Red if commit delivery stops keeping the sheet open on the files to commit.
  it("stays on the last step for commit delivery even with no notes", async () => {
    const d = door();
    const m = repoSheetModel(d.args);
    await m.submit();
    d.tell({ ...added, written: ["a.mp4"], notes: [] });
    expect(m.state.step).toBe("last");
  });

  // Red if a refused add stops resolving the sheet with the refusal's sentence.
  it("resolves failed with the refusal's sentence when the add is refused", async () => {
    const d = door();
    d.args.repo.add = async () => {
      throw new Error("Already being added.");
    };
    const m = repoSheetModel(d.args);
    await m.submit();
    expect((await m.result).failed).toBe("Already being added.");
  });
});
