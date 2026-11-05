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
      return () => {};
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
const stopOf = (extra: object) => ({ reason: "x", detail: "d", ...extra });

async function lastStepOf(state: CiState) {
  const d = ciDoor(state);
  const m = repoSheetModel(d.args);
  await m.submit();
  d.tell(addedAt);
  await new Promise((r) => setTimeout(r, 0));
  return { d, m };
}

describe("repoSheetModel CI steps", () => {
  // Red if a CiState stops leading to its own step (notSetUp form, setUp pull request, note for noGh and unreadable, working for running).
  it.each([
    [{ kind: "notSetUp" }, "form"],
    [{ kind: "setUp" }, "pr"],
    [{ kind: "noGh", detail: "gh is not signed in." }, "note"],
    [{ kind: "unreadable", detail: "Cannot read." }, "note"],
    [{ kind: "running", jobId: "ci-1" }, "working"],
  ] as Array<[CiState, string]>)("%j leads to %s", async (state, k) => {
    const { m } = await lastStepOf(state);
    expect(m.state).toMatchObject({ step: "last", ci: { k } });
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
    m.close();
    expect((await m.result).prOpened).toBe("https://gh/pr/4");
  });

  // Red if an appHoles stop stops returning to the hole fields, or the next Check stops calling plan again.
  it("returns to the holes on appHoles and plans again on Check", async () => {
    const { d, m } = await lastStepOf({ kind: "notSetUp" });
    await m.check({});
    d.tellCi({
      phase: "done",
      step: "plan",
      answer: stopOf({
        reason: "appHoles",
        proposal: {
          draft: {
            appVersion: 1,
            install: [],
            start: null,
            url: null,
            timeoutSeconds: 60,
          },
          source: { kind: "agent" },
          holes: [{ field: "start", why: "w" }],
        },
      }),
    });
    expect(m.state).toMatchObject({
      ci: { k: "form", stop: { reason: "appHoles" } },
    });
    m.holes.start = "pnpm dev";
    await m.check({});
    expect(d.planBodies).toHaveLength(2);
    expect(d.planBodies[1]).toMatchObject({
      choices: { app: { start: "pnpm dev" }, appBy: "person" },
    });
  });

  // Red if a stop other than appHoles/secretMissing stops ending on the stopped step.
  it("ends on the stop for any other reason", async () => {
    const { d, m } = await lastStepOf({ kind: "notSetUp" });
    await m.check({});
    d.tellCi({
      phase: "done",
      step: "plan",
      answer: stopOf({ reason: "alreadySetUp" }),
    });
    expect(m.state).toMatchObject({ ci: { k: "stopped" } });
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

  // Red if a finished job's answer stops showing on reopening instead of offering setup again.
  it("shows a finished job's result", async () => {
    const { m } = await lastStepOf({
      kind: "finished",
      jobId: "ci-9",
      step: "plan",
      answer: stopOf({ reason: "alreadySetUp" }),
    });
    expect(m.state).toMatchObject({ ci: { k: "stopped" } });
  });
});
