import type { CiState } from "@demoman/studio-protocol";
import { describe, expect, it } from "vitest";
import type { CiEvent, RepoEvent } from "../../../pages/src/platform/types";
import {
  type RepoSheetArgs,
  repoSheetModel,
} from "../../../pages/src/shell/repo-sheet";

/** A door whose add answers `job-1` and lets the test send its events. */
function door() {
  let send: (e: RepoEvent) => void = () => {};
  const offs = { repo: 0, ci: 0 };
  const bodies: unknown[] = [];
  const repo: RepoSheetArgs["repo"] = {
    folders: async () => ({ folders: [], more: false }),
    addable: async () => ({ ok: false, reason: "x", label: "x", detail: "x" }),
    add: async (_id, body) => {
      bodies.push(body);
      return { jobId: "job-1" };
    },
    remove: async () => ({ removed: [], exportsLeft: [], notes: [] }),
    onRepo: (_job, fn) => {
      send = fn;
      return () => {
        offs.repo += 1;
      };
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
  return { args, bodies, tell, offs };
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

/** A CI door that answers `state`, and lets the test send events and see bodies. */
function ciDoor(state: CiState) {
  let send: (e: CiEvent) => void = () => {};
  const planBodies: Array<{ root: string; choices: object; secrets: object }> =
    [];
  const applyBodies: unknown[] = [];
  const prBodies: Array<{ branch: string; title: string; files: string[] }> =
    [];
  const ci: NonNullable<RepoSheetArgs["ci"]> = {
    state: async () => state,
    plan: async (b) => {
      planBodies.push(b);
      return { jobId: "ci-1" };
    },
    apply: async (b) => {
      applyBodies.push(b);
      return { jobId: "ci-2" };
    },
    openPr: async (b) => {
      prBodies.push(b);
      return {
        opened: {
          number: 4,
          url: "https://gh/pr/4",
          branch: b.branch,
          sha: "s",
        },
      };
    },
    onCi: (_job, fn) => {
      send = fn;
      return () => {
        d.offs.ci += 1;
      };
    },
  };
  const d = door();
  d.args.ci = ci;
  d.args.video = { id: "v1", name: "Checkout" };
  const tellCi = (e: Record<string, unknown>) =>
    send({ type: "ci", jobId: "ci-1", ...e } as CiEvent);
  return { ...d, planBodies, applyBodies, prBodies, tellCi };
}

const addedAt = {
  phase: "added",
  file: "checkout.json",
  root: "/r",
  written: [".demoman/flows/checkout.json", "docs/demos/checkout.mp4"],
  notes: [],
};

async function lastStepOf(state: CiState) {
  const d = ciDoor(state);
  const m = repoSheetModel(d.args);
  await m.submit();
  d.tell(addedAt);
  await new Promise((r) => setTimeout(r, 0));
  return { d, m };
}

describe("repoSheetModel with CI", () => {
  // Red if the last step stops reading the repo's CI through ciSteps.
  it.each([
    [{ kind: "notSetUp" }, "form"],
    [{ kind: "setUp" }, "setUp"],
  ] as Array<[CiState, string]>)("%j leads to %s", async (state, k) => {
    const { m } = await lastStepOf(state);
    expect(m.state).toMatchObject({ step: "last", pr: null });
    expect(m.ci?.step.k).toBe(k);
  });

  // Red if the pull request stops using the add's file name, title and exactly its written files (Decision 5).
  it("opens the later add's pull request from its own files", async () => {
    const { d, m } = await lastStepOf({ kind: "setUp" });
    await m.openPr();
    expect(d.prBodies).toEqual([
      expect.objectContaining({
        branch: "demoman/add-checkout",
        title: 'Add the "Checkout" flow',
        files: addedAt.written,
      }),
    ]);
    expect(m.state).toMatchObject({ pr: { url: "https://gh/pr/4" } });
    m.close();
    expect((await m.result).prOpened).toBe("https://gh/pr/4");
  });

  // Red if Open pull request is offered on a repo whose CI is not set up.
  it("opens no pull request when CI is not set up", async () => {
    const { d, m } = await lastStepOf({ kind: "notSetUp" });
    await m.openPr();
    expect(d.prBodies).toEqual([]);
  });

  // Red if the add's or the CI's listener stays after the sheet ends.
  it("stops listening once the add ends and when the sheet closes", async () => {
    const { d, m } = await lastStepOf({ kind: "notSetUp" });
    // Premise: the add ended on the last step, not by finishing the sheet.
    expect(m.state.step).toBe("last");
    expect(d.offs.repo).toBe(1);
    await m.ci?.check({});
    expect(d.offs.ci).toBe(0);
    m.close();
    expect(d.offs.ci).toBe(1);
  });

  // Red if Not now stops resolving without a pull request and toasting that CI is not set up.
  it("Not now resolves with prOpened null and says CI is not set up", async () => {
    const { m } = await lastStepOf({ kind: "notSetUp" });
    m.notNow();
    expect(await m.result).toMatchObject({
      prOpened: null,
      added: { written: addedAt.written },
    });
    expect(m.toast).toBe('Added "Checkout" to the repo. CI is not set up.');
  });

  // Red if the running line shows the timings or the refresh's renames.
  it("leaves timing and rename lines out of its running line", async () => {
    const d = ciDoor({ kind: "notSetUp" });
    const m = repoSheetModel(d.args);
    await m.submit();
    d.tell({ phase: "adding", line: "add: exporting docs/a.mp4" });
    d.tell({ phase: "adding", line: "timing run 3.2s" });
    d.tell({ phase: "adding", line: "refresh: renamed a.tmp over a.mp4" });
    expect(m.state).toEqual({
      step: "running",
      line: "add: exporting docs/a.mp4",
    });
  });

  // Red if the queued line stops matching the export panel's (no "Queued (0)").
  it("says Queued… or how many are ahead", async () => {
    const d = door();
    const m = repoSheetModel(d.args);
    await m.submit();
    d.tell({ phase: "queued", position: 0 });
    expect(m.state).toEqual({ step: "running", line: "Queued…" });
    d.tell({ phase: "queued", position: 2 });
    expect(m.state).toEqual({ step: "running", line: "Queued (2 ahead)" });
  });
});
