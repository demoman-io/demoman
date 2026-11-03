import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOWS_DIR,
  type KeptReceipt,
  type KeptVideo,
  keptFileName,
  RECEIPT_DIR,
  serializeKept,
  serializeReceipt,
} from "@demoman/run-core";
import { beforeEach, describe, expect, it } from "vitest";
import { checkCurrent } from "../src/executor/refresh-check.js";

const AT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const flow = (
  n: number,
  name: string,
  deliver: "commit" | "files" = "commit",
): KeptVideo => ({
  keptVersion: 2,
  flow: `0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a9${n}`,
  deliver,
  name,
  script: {
    scriptVersion: 1,
    name,
    target: "http://localhost:1/app",
    viewport: { width: 1280, height: 800 },
    steps: [{ do: "waitForLoad" }],
  } as KeptVideo["script"],
  scale: 1,
  logo: null,
  wallpaper: null,
  outputs: [
    {
      path:
        deliver === "files"
          ? `${keptFileName(name).replace(/\.json$/, "")}.mp4`
          : `docs/${n}.mp4`,
      fileType: "mp4",
      aspect: "16:9",
      quality: "share",
    },
  ],
  report: deliver === "files" ? null : `docs/${n}.json`,
});
const receipt = (
  k: KeptVideo,
  code: KeptReceipt["filmedCode"],
): KeptReceipt => ({
  receiptVersion: 1,
  flow: k.flow,
  video: "t1",
  filmedAt: null,
  filmedCode: code,
  screens: { steps: 1, moments: [{ step: null, ms: 500 }] },
  recordedRevision: null,
});

let repo: string;
let previous: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "demoman-check-"));
  previous = await mkdtemp(join(tmpdir(), "demoman-check-prev-"));
  await mkdir(join(repo, FLOWS_DIR), { recursive: true });
  await mkdir(join(repo, RECEIPT_DIR), { recursive: true });
});
const add = async (k: KeptVideo, r: KeptReceipt | null) => {
  const file = keptFileName(k.name);
  await writeFile(join(repo, FLOWS_DIR, file), serializeKept(k));
  if (r === null) return;
  const at =
    k.deliver === "files"
      ? join(previous, file.replace(/\.json$/, ".receipt.json"))
      : join(repo, RECEIPT_DIR, file);
  await writeFile(at, serializeReceipt(r));
};
/** Git as the check asks it: the paths changed between a commit and HEAD. */
const changed =
  (paths: string[] | { none: string }) => async (commit: string) => {
    expect(commit).toBe(AT);
    return paths;
  };

describe("checkCurrent", () => {
  const SINCE = "ffff00001111222233334444555566667777aaaa";
  it("is current when only refresh files changed since the last successful refresh, though the receipt is older", async () => {
    const a = flow(1, "Place an order");
    await add(a, receipt(a, { commit: AT, tree: "t", dirty: false }));
    // A README fix after the recording: an unchanged refresh wrote nothing.
    const r = await checkCurrent(
      { repoRoot: repo, since: SINCE },
      {
        changedSince: async (c) =>
          c === AT ? ["README.md"] : c === SINCE ? [] : { none: `asked ${c}` },
      },
    );
    expect(r).toEqual({
      current: true,
      lines: [
        "Place an order: current (nothing but refresh files changed since ffff000, the last successful refresh)",
      ],
    });
  });

  it("says when the last successful refresh cannot be compared, and judges by the receipts", async () => {
    const a = flow(1, "Place an order");
    await add(a, receipt(a, { commit: AT, tree: "t", dirty: false }));
    const r = await checkCurrent(
      { repoRoot: repo, since: SINCE },
      {
        changedSince: async (c) =>
          c === SINCE ? { none: "fatal: bad object" } : [],
      },
    );
    expect(r).toEqual({
      current: true,
      lines: [
        "Place an order: current (recorded at a1b2c3d)",
        "the last successful refresh, ffff000, could not be compared with HEAD (fatal: bad object); each flow is judged by its receipt",
      ],
    });
  });

  it("still records when something changed since both the recording and the last refresh", async () => {
    const a = flow(1, "Place an order");
    await add(a, receipt(a, { commit: AT, tree: "t", dirty: false }));
    const r = await checkCurrent(
      { repoRoot: repo, since: SINCE },
      { changedSince: async () => ["src/app.tsx"] },
    );
    expect(r.current).toBe(false);
    expect(r.lines).toEqual([
      "Place an order: recorded at a1b2c3d; 1 other file changed since",
    ]);
  });

  it("reads a version 1 recipe's own receipt, as refresh does, and the anchor makes it current", async () => {
    const a = flow(1, "Place an order");
    // keptVersion 1 carried its receipt inside the recipe (`migrated`).
    const { flow: id, deliver: _d, keptVersion: _k, ...rest } = a;
    const v1 = {
      ...rest,
      keptVersion: 1,
      from: { videoId: id, takeId: "t1", recordedRevision: "r1" },
      screens: { steps: 1, moments: [{ step: null, ms: 500 }] },
    };
    await writeFile(
      join(repo, FLOWS_DIR, keptFileName(a.name)),
      JSON.stringify(v1),
    );
    const alone = await checkCurrent(
      { repoRoot: repo },
      { changedSince: changed([]) },
    );
    expect(alone).toEqual({
      current: false,
      lines: [
        "Place an order: recorded with no commit (kept before receipts were recorded)",
      ],
    });
    const anchored = await checkCurrent(
      { repoRoot: repo, since: SINCE },
      {
        changedSince: async (c) => (c === SINCE ? ["docs/1.mp4"] : { none: c }),
      },
    );
    expect(anchored.current).toBe(true);
  });

  it("never lets the anchor cover an unreadable recipe or a new one", async () => {
    const a = flow(1, "Place an order");
    await writeFile(join(repo, FLOWS_DIR, "broken.json"), "{");
    await add(a, null);
    const r = await checkCurrent(
      { repoRoot: repo, since: SINCE },
      // The new recipe is itself a change since the last refresh.
      { changedSince: async () => [`${FLOWS_DIR}/${keptFileName(a.name)}`] },
    );
    expect(r.current).toBe(false);
    expect(
      r.lines.some((l) => l.startsWith(`${FLOWS_DIR}/broken.json: `)),
    ).toBe(true);
    expect(r.lines).toContain("Place an order: no receipt yet");
  });

  it("is current when only paths a refresh writes changed since each recording", async () => {
    const a = flow(1, "Place an order");
    const b = flow(2, "Open reports");
    await add(a, receipt(a, { commit: AT, tree: "t", dirty: false }));
    await add(b, receipt(b, { commit: AT, tree: "t", dirty: false }));
    // The refresh's own PR: both videos, a report and the receipts.
    const r = await checkCurrent(
      { repoRoot: repo },
      {
        changedSince: changed([
          "docs/1.mp4",
          "docs/2.mp4",
          "docs/1.json",
          `${RECEIPT_DIR}/${keptFileName(a.name)}`,
        ]),
      },
    );
    expect(r.lines).toEqual([
      "Open reports: current (recorded at a1b2c3d)",
      "Place an order: current (recorded at a1b2c3d)",
    ]);
    expect(r.current).toBe(true);
  });

  it("must record when anything else changed, and says how much", async () => {
    const a = flow(1, "Place an order");
    await add(a, receipt(a, { commit: AT, tree: "t", dirty: false }));
    const r = await checkCurrent(
      { repoRoot: repo },
      { changedSince: changed(["docs/1.mp4", "src/app.tsx", "src/b.css"]) },
    );
    expect(r).toEqual({
      current: false,
      lines: [
        "Place an order: recorded at a1b2c3d; 2 other files changed since",
      ],
    });
  });

  it("must record a flow with no receipt, a dirty recording, or one with no commit", async () => {
    const a = flow(1, "Place an order");
    const b = flow(2, "Open reports");
    const c = flow(3, "Sign up");
    await add(a, null);
    await add(b, receipt(b, { commit: AT, tree: "t", dirty: true }));
    await add(c, receipt(c, { none: "not a git checkout" }));
    const r = await checkCurrent(
      { repoRoot: repo },
      { changedSince: changed([]) },
    );
    expect(r.current).toBe(false);
    expect(r.lines).toEqual([
      "Open reports: recorded from uncommitted changes",
      "Place an order: no receipt yet",
      "Sign up: recorded with no commit (not a git checkout)",
    ]);
  });

  it("reads a files flow's receipt from --previous", async () => {
    const a = flow(1, "Place an order", "files");
    await add(a, receipt(a, { commit: AT, tree: "t", dirty: false }));
    const without = await checkCurrent(
      { repoRoot: repo },
      { changedSince: changed([]) },
    );
    expect(without.lines).toEqual(["Place an order: no receipt yet"]);
    const r = await checkCurrent(
      { repoRoot: repo, previous },
      { changedSince: changed([]) },
    );
    expect(r).toEqual({
      current: true,
      lines: ["Place an order: current (recorded at a1b2c3d)"],
    });
  });

  it("never reads no flows, an unreadable receipt or a git failure as current", async () => {
    expect(
      await checkCurrent({ repoRoot: repo }, { changedSince: changed([]) }),
    ).toEqual({ current: false, lines: ["no repo flows"] });
    const a = flow(1, "Place an order");
    await add(a, receipt(a, { commit: AT, tree: "t", dirty: false }));
    await writeFile(join(repo, RECEIPT_DIR, keptFileName(a.name)), "{");
    const bad = await checkCurrent(
      { repoRoot: repo },
      { changedSince: changed([]) },
    );
    expect(bad.current).toBe(false);
    expect(bad.lines[0]).toMatch(/^Place an order: .*is not valid JSON/);
    await add(a, receipt(a, { commit: AT, tree: "t", dirty: false }));
    const git = await checkCurrent(
      { repoRoot: repo },
      { changedSince: changed({ none: `fatal: bad object ${AT}` }) },
    );
    expect(git).toEqual({
      current: false,
      lines: [
        `Place an order: recorded at a1b2c3d, which git cannot compare with HEAD (fatal: bad object ${AT})`,
      ],
    });
  });
});
