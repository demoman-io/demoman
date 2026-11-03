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
      "Sign up: its recording names no commit (not a git checkout)",
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
