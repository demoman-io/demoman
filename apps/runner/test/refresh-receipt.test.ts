import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_FLOWS_DIR as KEPT_DIR,
  type KeptReceipt,
  type KeptScreens,
  type KeptVideo,
  keptFileName,
  parseReceipt,
  RECEIPT_DIR,
  REFRESH_LIST_FILE,
  serializeKept,
  serializeReceipt,
} from "@demoman/run-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RefreshDeps, refreshKept } from "../src/executor/refresh.js";
import type { Version, VideoStore } from "../src/executor/videos.js";

const FLOW = "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90";
const NAME = "Place an order";
const FILE = `${KEPT_DIR}/${keptFileName(NAME)}`;
const RECEIPT = `${RECEIPT_DIR}/${keptFileName(NAME)}`;
const MP4 = "docs/o.mp4";
/** A files flow's output: a bare name, written beside the list. */
const BARE = "o.mp4";
const OTHER_FLOW = "1a2b3c4d-0000-4000-8000-000000000001";
const GIF = "docs/o.gif";
const FILMED = "a".repeat(40);
/** When the fake run started: what a refresh-written receipt's filmedAt says. */
const STARTED = "2026-10-31T12:00:00.000Z";
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
  filmedAt: null,
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
/** Whether the fake run filmed uncommitted changes. */
let dirty: boolean;

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
  dirty = false;
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
              run: { startedAt: Date.parse(STARTED) },
              provenance: { takeId: "t-new" },
              filmedCode: {
                commit: FILMED,
                tree: "b".repeat(40),
                dirty,
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

  it("reads the receipt named after the recipe's file, not the flow's current name", async () => {
    // A rename that rewrote the name inside the file but left its file name.
    await writeV2({ ...recipe(), name: "Renamed in the studio" });
    // Premise: the two names make different files.
    expect(keptFileName("Renamed in the studio")).not.toBe(keptFileName(NAME));
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("unchanged");
    expect(compared).toEqual([{ committed: OLD, fresh: NEW }]);
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
  it("a dirty film's PR line says it filmed uncommitted changes", async () => {
    await writeV2();
    same = false;
    dirty = true;
    const v = await one();
    // Premise: the report the line reads says dirty.
    expect(v.filmedCode).toMatchObject({ commit: FILMED, dirty: true });
    expect(v.line).toContain("uncommitted");
  });
});

describe("a local refresh after a refresh wrote the receipt", () => {
  const version = (takeId: string, createdAt: string): Version => ({
    takeId,
    number: 1,
    createdAt,
    complete: true,
    edited: false,
    hasScript: true,
    expired: null,
  });
  /** The user's library: the flow, its one version, and a scene.json
   *  last saved at `saved`. */
  const local = async (createdAt: string, saved: string) => {
    const take = join(repo, "user-take");
    await mkdir(take, { recursive: true });
    await writeFile(join(take, "scene.json"), "{}");
    await utimes(join(take, "scene.json"), new Date(saved), new Date(saved));
    const d = deps();
    d.videos = {
      get: async () => ({ id: FLOW, name: NAME }),
      versions: async () => [version("t-user", createdAt)],
    } as unknown as VideoStore;
    d.library = {
      takeDir: () => take,
      getSceneRead: async () => ({
        scene: { edits: { masks: [], holds: [] }, camera: [] },
        revision: "r-user",
        notes: [],
      }),
    } as unknown as RefreshDeps["library"];
    return d;
  };
  const refreshedOnce = async () => {
    await writeV2();
    same = false;
    await one();
    const r = parseReceipt(
      await readFile(join(repo, RECEIPT), "utf8"),
      RECEIPT,
    );
    if (!r.ok) throw new Error(r.detail);
    // Premise: the receipt names a take the user's library does not hold,
    // and when it was filmed.
    expect(r.receipt).toMatchObject({ video: "t-new", filmedAt: STARTED });
  };
  const localNotes = async (d: RefreshDeps) =>
    (await refreshKept({ repoRoot: repo, library: "local" }, d)).videos[0]
      ?.notes;

  it("says nothing about the user's older video", async () => {
    await refreshedOnce();
    expect(
      await localNotes(
        await local("2026-10-30T09:00:00.000Z", "2026-10-30T09:00:01.000Z"),
      ),
    ).toEqual([]);
  });

  it("says the library is ahead when its version was made after the film", async () => {
    await refreshedOnce();
    const [note, ...rest] =
      (await localNotes(
        await local("2026-10-31T13:00:00.000Z", "2026-10-31T13:00:01.000Z"),
      )) ?? [];
    expect(note).toContain(
      `not in ${FILE} since it was recorded at ${STARTED}`,
    );
    expect(rest).toEqual([]);
  });

  it("says the library is ahead when its scene was saved after the film", async () => {
    await refreshedOnce();
    expect(
      (
        await localNotes(
          await local("2026-10-30T09:00:00.000Z", "2026-10-31T13:00:00.000Z"),
        )
      )?.[0],
    ).toContain("Studio edits");
  });

  it("with no filmedAt, says it cannot be told, never that the library is ahead", async () => {
    await writeV2(recipe(), receipt({ video: "t-gone", filmedAt: null }));
    const [note] =
      (await localNotes(
        await local("2026-10-31T13:00:00.000Z", "2026-10-31T13:00:01.000Z"),
      )) ?? [];
    expect(note).toContain(
      `whether the library is ahead of ${FILE} cannot be told`,
    );
    expect(note).not.toContain("has a newer video");
  });
});

describe("the files route", () => {
  let out: string;
  let prev: string;
  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), "demoman-out-"));
    prev = await mkdtemp(join(tmpdir(), "demoman-prev-"));
  });
  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
    await rm(prev, { recursive: true, force: true });
  });
  const stem = keptFileName(NAME).replace(/\.json$/, "");
  const RECEIPT_NAME = `${stem}.receipt.json`;
  const filesRecipe = (): KeptVideo => ({
    ...recipe([BARE]),
    deliver: "files",
  });
  const commitAll = () => {
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "-m",
        "kept",
      ],
      { cwd: repo },
    );
  };
  const status = () =>
    execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
  const refreshInto = async (
    more: { previous?: string; outDir?: string } = {},
  ) =>
    (
      await refreshKept(
        { repoRoot: repo, library: "throwaway", outDir: out, ...more },
        deps(),
      )
    ).videos;
  const listIn = async () =>
    JSON.parse(await readFile(join(out, REFRESH_LIST_FILE), "utf8"));

  it("a files flow writes into out-dir and commits nothing", async () => {
    await writeV2(filesRecipe(), null);
    commitAll();
    // Premise: the checkout is clean before, so a dirty one after is the refresh's doing.
    expect(status()).toBe("");
    const [v] = await refreshInto();
    expect(v?.outcome, JSON.stringify(v)).toBe("uncompared");
    expect(status()).toBe("");
    expect(await readFile(join(out, BARE), "utf8")).toBe("new mp4");
    const r = parseReceipt(
      await readFile(join(out, RECEIPT_NAME), "utf8"),
      RECEIPT_NAME,
    );
    expect(r).toMatchObject({
      ok: true,
      receipt: { video: "t-new", flow: FLOW },
    });
    const list = await listIn();
    expect(list.refreshVersion).toBe(1);
    expect(list.videos[0]).toMatchObject({
      outcome: "uncompared",
      video: "t-new",
      kept: FILE,
      files: [
        { path: BARE, fileType: "mp4", aspect: "16:9" },
        { path: RECEIPT_NAME, fileType: "json", aspect: null },
      ],
    });
  });

  it("a files flow with a previous receipt can be unchanged", async () => {
    await writeV2(filesRecipe(), null);
    await writeFile(join(prev, BARE), "delivered film");
    await writeFile(join(prev, RECEIPT_NAME), serializeReceipt(receipt()));
    const [v] = await refreshInto({ previous: prev });
    expect(v?.outcome, JSON.stringify(v)).toBe("unchanged");
    expect(compared).toEqual([{ committed: OLD, fresh: NEW }]);
    // Nothing to deliver: the previous folder's film stands.
    expect(existsSync(join(out, BARE))).toBe(false);
    expect((await listIn()).videos[0]).toMatchObject({
      outcome: "unchanged",
      sameAs: { video: "t1", commit: FILMED, dirty: false },
      files: [],
    });
  });

  it("with --previous the same folder as --out-dir, an unchanged flow's receipt and video stay in it", async () => {
    await writeV2(filesRecipe(), null);
    await writeFile(join(out, BARE), "delivered film");
    await writeFile(join(out, RECEIPT_NAME), serializeReceipt(receipt()));
    const [v] = await refreshInto({ previous: out });
    expect(v?.outcome, JSON.stringify(v)).toBe("unchanged");
    // Premise: the comparison read the receipt in that folder.
    expect(compared).toEqual([{ committed: OLD, fresh: NEW }]);
    // The next run, downloading this folder, compares with the same receipt.
    expect(await readFile(join(out, BARE), "utf8")).toBe("delivered film");
    expect(
      parseReceipt(
        await readFile(join(out, RECEIPT_NAME), "utf8"),
        RECEIPT_NAME,
      ),
    ).toMatchObject({ ok: true, receipt: { video: "t1" } });
  });

  it("with --previous the same folder as --out-dir, a changed flow replaces its receipt and video there", async () => {
    same = false;
    await writeV2(filesRecipe(), null);
    await writeFile(join(out, BARE), "delivered film");
    await writeFile(join(out, RECEIPT_NAME), serializeReceipt(receipt()));
    const [v] = await refreshInto({ previous: out });
    expect(v?.outcome, JSON.stringify(v)).toBe("changed");
    expect(await readFile(join(out, BARE), "utf8")).toBe("new mp4");
    expect(
      parseReceipt(
        await readFile(join(out, RECEIPT_NAME), "utf8"),
        RECEIPT_NAME,
      ),
    ).toMatchObject({ ok: true, receipt: { video: "t-new" } });
  });

  it("a files flow whose logo folder links out of the checkout fails before filming", async () => {
    const outside = await mkdtemp(join(tmpdir(), "demoman-logo-out-"));
    try {
      await writeFile(join(outside, "logo.png"), "a logo");
      await symlink(outside, join(repo, "brand"));
      await writeV2({ ...filesRecipe(), logo: "brand/logo.png" }, null);
      // Premise: the logo is readable through the link, so only containment refuses it.
      expect(existsSync(join(repo, "brand/logo.png"))).toBe(true);
      const [v] = await refreshInto();
      expect(v?.outcome, JSON.stringify(v)).toBe("failed");
      expect(v?.detail).toContain("brand/logo.png is not inside the repo");
      expect(runs).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("a previous receipt for another flow fails, naming both", async () => {
    await writeV2(filesRecipe(), null);
    await writeFile(
      join(prev, RECEIPT_NAME),
      serializeReceipt(receipt({ flow: OTHER_FLOW })),
    );
    const [v] = await refreshInto({ previous: prev });
    expect(v?.outcome).toBe("failed");
    expect(v?.detail).toContain(OTHER_FLOW);
    expect(v?.detail).toContain(FLOW);
    expect(runs).toEqual([]);
  });

  it("a previous folder that is not there means no previous: uncompared, naming it", async () => {
    await writeV2(filesRecipe(), null);
    const gone = join(prev, "nope");
    // Premise: it is not there.
    expect(existsSync(gone)).toBe(false);
    const [v] = await refreshInto({ previous: gone });
    expect(v?.outcome, JSON.stringify(v)).toBe("uncompared");
    expect(v?.notes).toEqual([
      `${gone} does not exist, so there was nothing to compare against`,
    ]);
    expect(compared).toEqual([]);
    expect(await readFile(join(out, BARE), "utf8")).toBe("new mp4");
  });

  it("a previous that exists but cannot be read as a folder fails, naming it", async () => {
    await writeV2(filesRecipe(), null);
    const file = join(prev, "a-file");
    await writeFile(file, "not a folder");
    const [v] = await refreshInto({ previous: file });
    expect(v?.outcome).toBe("failed");
    expect(v?.detail).toContain(file);
    expect(v?.detail).toContain("is not a folder");
    expect(runs).toEqual([]);
  });

  it("a list that cannot be written is reported with the finished videos", async () => {
    await writeV2(filesRecipe(), null);
    // The list's path is a folder: the rename onto it cannot succeed.
    await mkdir(join(out, REFRESH_LIST_FILE));
    const r = await refreshKept(
      { repoRoot: repo, library: "throwaway", outDir: out },
      deps(),
    );
    expect(r.videos[0]?.outcome).toBe("uncompared");
    expect(r.listError).toContain(join(out, REFRESH_LIST_FILE));
  });

  it("a files flow without --out-dir fails and the commit flow still refreshes", async () => {
    await writeV2(recipe(), null);
    const other = {
      ...filesRecipe(),
      flow: OTHER_FLOW,
      name: "Upload me",
    } satisfies KeptVideo;
    const otherFile = `${KEPT_DIR}/${keptFileName(other.name)}`;
    await writeFile(join(repo, otherFile), serializeKept(other));
    const videos = await refresh();
    const by = (f: string) => videos.find((v) => v.file === f);
    expect(by(otherFile)).toMatchObject({
      outcome: "failed",
      detail: expect.stringMatching(
        /^deliver files needs --out-dir .*setup --ci --artifact/,
      ),
    });
    expect(by(FILE)?.outcome, JSON.stringify(videos)).toBe("uncompared");
    // Premise: only the commit flow was filmed.
    expect(runs.map((a) => a.video)).toEqual([{ id: FLOW }]);
  });
});
