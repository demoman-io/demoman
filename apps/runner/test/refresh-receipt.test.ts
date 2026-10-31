import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEPT_DIR,
  type KeptReceipt,
  type KeptScreens,
  type KeptVideo,
  keptFileName,
  parseReceipt,
  RECEIPT_DIR,
  serializeKept,
  serializeReceipt,
} from "@demoman/run-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RefreshDeps, refreshKept } from "../src/executor/refresh.js";
import type { VideoStore } from "../src/executor/videos.js";

const FLOW = "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90";
const NAME = "Place an order";
const FILE = `${KEPT_DIR}/${keptFileName(NAME)}`;
const RECEIPT = `${RECEIPT_DIR}/${keptFileName(NAME)}`;
const MP4 = "docs/o.mp4";
const GIF = "docs/o.gif";
const FILMED = "a".repeat(40);
const OLD: KeptScreens = { steps: 1, moments: [{ step: null, ms: 500 }] };
const NEW: KeptScreens = { steps: 1, moments: [{ step: null, ms: 700 }] };

const recipe = (outputs = [MP4]): KeptVideo => ({
  keptVersion: 2,
  flow: FLOW,
  deliver: "commit",
  name: NAME,
  script: {
    scriptVersion: 1,
    name: NAME,
    target: "http://localhost:1/app",
    viewport: { width: 1280, height: 800 },
    steps: [{ do: "waitForLoad" }],
  } as KeptVideo["script"],
  scale: 1,
  logo: null,
  wallpaper: null,
  outputs: outputs.map((path) => ({
    path,
    fileType: path.endsWith(".gif") ? ("gif" as const) : ("mp4" as const),
    aspect: "16:9" as const,
    quality: "share" as const,
  })),
  report: null,
});
const receipt = (more: Partial<KeptReceipt> = {}): KeptReceipt => ({
  receiptVersion: 1,
  flow: FLOW,
  video: "t1",
  filmedCode: { none: "test" },
  screens: OLD,
  recordedRevision: "r1",
  ...more,
});
/** A kept file as Demoman wrote it before receipts: screens and `from` in it. */
const v1Text = (k: KeptVideo): string => {
  const { flow: _f, deliver: _d, ...rest } = JSON.parse(serializeKept(k));
  return `${JSON.stringify({ ...rest, keptVersion: 1, screens: OLD, from: { videoId: FLOW, takeId: "t1", recordedRevision: "r1" } }, null, 2)}\n`;
};

let repo: string;
let runs: Record<string, unknown>[];
let compared: { committed: KeptScreens; fresh: KeptScreens }[];
let same: boolean;
/** Run while filming: what changes in the repo between the read and the write. */
let duringRun: (() => Promise<void>) | null;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "demoman-receipt-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    ],
    { cwd: repo },
  );
  await mkdir(join(repo, KEPT_DIR), { recursive: true });
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, MP4), "committed film");
  runs = [];
  compared = [];
  same = true;
  duringRun = null;
});
afterEach(() => rm(repo, { recursive: true, force: true }));

const writeV2 = async (k = recipe(), r: KeptReceipt | null = receipt()) => {
  await writeFile(join(repo, FILE), serializeKept(k));
  if (r !== null) {
    await mkdir(join(repo, RECEIPT_DIR), { recursive: true });
    await writeFile(join(repo, RECEIPT), serializeReceipt(r));
  }
};

const deps = (): RefreshDeps => ({
  videos: {} as VideoStore,
  library: {} as RefreshDeps["library"],
  executor: ({ outDir }) =>
    ({
      request: async (op: string, args: Record<string, unknown>) => {
        if (op === "run") {
          runs.push(args);
          await duringRun?.();
          return {
            ok: true,
            value: {
              outcome: "complete",
              verdict: { kind: "matches" },
              frames: { degradations: [] },
              steps: [{}],
              provenance: { takeId: "t-new" },
              filmedCode: {
                commit: FILMED,
                tree: "b".repeat(40),
                dirty: false,
              },
            },
          };
        }
        const path = join(outDir, `out.${args.fileType}`);
        await writeFile(path, `new ${args.fileType}`);
        return {
          ok: true,
          value: {
            outcome: "saved",
            fileType: args.fileType,
            file: { path },
            screens: NEW,
            warnings: { logo: null },
          },
        };
      },
      close: async () => undefined,
    }) as unknown as ReturnType<RefreshDeps["executor"]>,
  session: {} as RefreshDeps["session"],
  samePicture: async (_c, _f, _t, committed, fresh) => {
    compared.push({ committed, fresh });
    return { same, detail: same ? "the same" : "50% of the picture changed" };
  },
  env: {},
  log: () => undefined,
});

const refresh = async (d = deps()) =>
  (await refreshKept({ repoRoot: repo, library: "throwaway" }, d)).videos;
const one = async (d = deps()) => {
  const videos = await refresh(d);
  expect(videos, JSON.stringify(videos)).toHaveLength(1);
  return videos[0] as NonNullable<(typeof videos)[number]>;
};

describe("a refresh against the receipt", () => {
  it("a v1 repo refreshes unchanged and its file is untouched", async () => {
    const text = v1Text(recipe());
    await writeFile(join(repo, FILE), text);
    // Premise: the file is the v1 shape, and no receipt sits beside it.
    expect(JSON.parse(text).keptVersion).toBe(1);
    expect(existsSync(join(repo, RECEIPT))).toBe(false);
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("unchanged");
    expect(v.sameAs).toEqual({ video: "t1" });
    // Compared against the v1 file's own screens.
    expect(compared).toEqual([{ committed: OLD, fresh: NEW }]);
    expect(await readFile(join(repo, FILE), "utf8")).toBe(text);
    expect(existsSync(join(repo, RECEIPT))).toBe(false);
    expect(v.outputs).toEqual([]);
  });

  it("a changed film writes outputs and the receipt, never the recipe", async () => {
    await writeV2();
    const before = await readFile(join(repo, FILE), "utf8");
    same = false;
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("changed");
    expect(v.outputs).toEqual([MP4, RECEIPT]);
    expect(await readFile(join(repo, FILE), "utf8")).toBe(before);
    expect(await readFile(join(repo, MP4), "utf8")).toBe("new mp4");
    const r = parseReceipt(
      await readFile(join(repo, RECEIPT), "utf8"),
      RECEIPT,
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.receipt.video).toBe("t-new");
    expect(r.receipt.screens).toEqual(NEW);
    expect(r.receipt.filmedCode).toMatchObject({ commit: FILMED });
    expect(v.video).toBe("t-new");
    expect(v.screens).toEqual(NEW);
  });

  it("films the kept flow by its id", async () => {
    await writeV2();
    await one();
    expect(runs.map((a) => a.video)).toEqual([{ id: FLOW }]);
  });

  it("the PR line names the report's filmed commit, not HEAD", async () => {
    await writeV2();
    same = false;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    // Premise: HEAD is not the commit the report says it filmed.
    expect(head.slice(0, 7)).not.toBe(FILMED.slice(0, 7));
    const v = await one();
    expect(v.line).toContain(FILMED.slice(0, 7));
    expect(v.line).not.toContain(head.slice(0, 7));
    expect(v.filmedCode).toMatchObject({ commit: FILMED });
  });

  it("two kept files with one flow both fail, naming both", async () => {
    await writeV2();
    const copy = `${KEPT_DIR}/copy.json`;
    await writeFile(
      join(repo, copy),
      serializeKept({ ...recipe(), name: "A copy" }),
    );
    const videos = await refresh();
    expect(videos.map((v) => [v.file, v.outcome])).toEqual([
      [copy, "failed"],
      [FILE, "failed"],
    ]);
    for (const v of videos) {
      expect(v.detail).toContain(copy);
      expect(v.detail).toContain(FILE);
    }
    expect(runs).toEqual([]);
  });

  it("a same-picture film with a missing output is added, not changed", async () => {
    await writeV2(recipe([MP4, GIF]));
    // Premise: the GIF was never committed.
    expect(existsSync(join(repo, GIF))).toBe(false);
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("added");
    expect(v.outputs).toEqual([GIF]);
    expect(v.detail).toContain(`${GIF} is new`);
    expect(await readFile(join(repo, MP4), "utf8")).toBe("committed film");
    // The receipt still says what the judged output shows: the old film.
    expect(
      parseReceipt(await readFile(join(repo, RECEIPT), "utf8"), RECEIPT),
    ).toMatchObject({ ok: true, receipt: { video: "t1" } });
  });

  it("with no receipt, delivers as new, never unchanged, and says the receipt is missing", async () => {
    await writeV2(recipe(), null);
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("uncompared");
    expect(v.detail).toBe("nothing to compare against; delivered as new");
    expect(v.notes).toEqual([`${RECEIPT} is missing`]);
    expect(compared).toEqual([]);
    expect(v.outputs).toEqual([MP4, RECEIPT]);
  });

  it("a v1 file whose judged output is gone is uncompared, and still untouched", async () => {
    const text = v1Text(recipe());
    await writeFile(join(repo, FILE), text);
    await rm(join(repo, MP4));
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("uncompared");
    expect(v.notes).toEqual([`${MP4} is missing`]);
    expect(await readFile(join(repo, FILE), "utf8")).toBe(text);
    expect(v.outputs).toEqual([MP4, RECEIPT]);
  });

  it("fails an unreadable receipt, naming it, before filming", async () => {
    await writeV2();
    await writeFile(join(repo, RECEIPT), "{ torn");
    const v = await one();
    expect(v.outcome).toBe("failed");
    expect(v.detail).toContain(`${RECEIPT}: is not valid JSON`);
    expect(runs).toEqual([]);
  });

  it("fails a receipt for another flow, naming both", async () => {
    const other = "1a2b3c4d-0000-4000-8000-000000000001";
    await writeV2(recipe(), receipt({ flow: other }));
    const v = await one();
    expect(v.outcome).toBe("failed");
    expect(v.detail).toContain(other);
    expect(v.detail).toContain(FLOW);
    expect(runs).toEqual([]);
  });

  it("a write that fails partway fails, naming what it wrote", async () => {
    await writeV2(recipe(), null);
    // The receipt's folder becomes a file: the receipt, written last, cannot be.
    duringRun = () => writeFile(join(repo, RECEIPT_DIR), "in the way");
    const v = await one();
    expect(runs, "premise: it filmed").toHaveLength(1);
    expect(v.outcome, JSON.stringify(v)).toBe("failed");
    expect(v.detail).toContain(`wrote ${MP4}, then could not write`);
    expect(v.outputs).toEqual([MP4]);
  });
});
