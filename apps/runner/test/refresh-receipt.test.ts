import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
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
  screensDirOf,
  scriptDigest,
  serializeKept,
  serializeReceipt,
} from "@demoman/run-core";
import { screenImageName } from "@demoman/run-core/render";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATES_NOTE,
  type RefreshDeps,
  refreshKept,
} from "../src/executor/refresh.js";
import type { Version, VideoStore } from "../src/executor/videos.js";

const FLOW = "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90";
const NAME = "Place an order";
const FILE = `${KEPT_DIR}/${keptFileName(NAME)}`;
const RECEIPT = `${RECEIPT_DIR}/${keptFileName(NAME)}`;
/** The receipt's folder of screen images, beside it. */
const SCREENS = `${RECEIPT_DIR}/${screensDirOf(RECEIPT)}`;
/** The screens render's size: the output target's. */
const SIZE = { width: 1920, height: 1080 };
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
  screensDir: null,
  screensSize: null,
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
/** What the screens comparison was handed: each side's folder and screens. */
let screensCompared: {
  committed: { dir: string; screens: KeptScreens; size: unknown };
  fresh: { dir: string; screens: KeptScreens; size: unknown };
}[];
/** Every export the executor was asked for, in order. */
let exports: Record<string, unknown>[];
/** An output type whose full export fails. */
let failExport: string | null;
let same: boolean;
/** The size the fake screens render reports. */
let freshSize: { width: number; height: number };
/** Run while filming: what changes in the repo between the read and the write. */
let duringRun: (() => Promise<void>) | null;
/** Whether the fake run filmed uncommitted changes. */
let dirty: boolean;
/** What the fake run's stored report says its last screen showed. */
let storedDates: string[] | null;
/** Every line refresh logged. */
let logged: string[];

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
  screensCompared = [];
  exports = [];
  failExport = null;
  same = true;
  freshSize = SIZE;
  duringRun = null;
  dirty = false;
  storedDates = null;
  logged = [];
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
  executor: ({ outDir, home }) =>
    ({
      request: async (op: string, args: Record<string, unknown>) => {
        if (op === "run") {
          runs.push(args);
          await duringRun?.();
          // The report the run stores, as the executor's run writes it.
          await mkdir(join(home, "takes", "t-new"), { recursive: true });
          await writeFile(
            join(home, "takes", "t-new", "report.json"),
            JSON.stringify({
              provenance: { takeId: "t-new" },
              ...(storedDates === null ? {} : { datesOnScreen: storedDates }),
            }),
          );
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
        exports.push(args);
        if (args.screensOnly === true) {
          // The screens render: one image per screen, in a folder of its own.
          const folder = await mkdtemp(join(outDir, "screens-"));
          for (const m of NEW.moments)
            await writeFile(
              join(folder, screenImageName(m.step)),
              `new ${screenImageName(m.step)}`,
            );
          return {
            ok: true,
            value: {
              outcome: "saved",
              fileType: "screens",
              folder: { path: folder },
              screens: NEW,
              size: freshSize,
              warnings: { logo: null, wallpaperWarning: null },
            },
          };
        }
        if (args.fileType === failExport)
          return {
            ok: true,
            value: {
              outcome: "renderFailed",
              error: "injected",
              summary: "the render failed: injected",
            },
          };
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
  sameScreens: async (committed, fresh) => {
    screensCompared.push({ committed, fresh });
    return { same, detail: same ? "the same" : "50% of the picture changed" };
  },
  env: {},
  log: (line) => void logged.push(line),
});

const refresh = async (d = deps()) =>
  (await refreshKept({ repoRoot: repo, library: "throwaway" }, d)).videos;
const one = async (d = deps()) => {
  const videos = await refresh(d);
  expect(videos, JSON.stringify(videos)).toHaveLength(1);
  return videos[0] as NonNullable<(typeof videos)[number]>;
};

describe("a refresh against the receipt", () => {
  it("a v1 repo refreshes the same picture as added, its file untouched, and gains a receipt with images", async () => {
    const text = v1Text(recipe());
    await writeFile(join(repo, FILE), text);
    // Premise: the file is the v1 shape, and no receipt sits beside it.
    expect(JSON.parse(text).keptVersion).toBe(1);
    expect(existsSync(join(repo, RECEIPT))).toBe(false);
    const v = await one();
    // `added`: its receipt and images are written, and must be committed.
    expect(v.outcome, JSON.stringify(v)).toBe("added");
    expect(v.sameAs).toEqual({ video: "t1" });
    // Compared against the v1 file's own screens.
    expect(compared).toEqual([{ committed: OLD, fresh: NEW }]);
    expect(await readFile(join(repo, FILE), "utf8")).toBe(text);
    expect(v.notes).toEqual([
      `${FILE} had no screen images, so this refresh exported to compare; the next one compares its screens`,
    ]);
    // The receipt beside it still names the committed video.
    expect(await receiptOf()).toMatchObject({
      receiptVersion: 2,
      video: "t1",
      recordedRevision: "r1",
    });
    expect(v.outputs).toEqual([SCREENS, RECEIPT]);
  });

  it("a changed film writes outputs and the receipt, never the recipe", async () => {
    await writeV2();
    const before = await readFile(join(repo, FILE), "utf8");
    same = false;
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("changed");
    expect(v.outputs).toEqual([MP4, SCREENS, RECEIPT]);
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
    // Red if refresh stops recording the script the files now show.
    expect(r.receipt.scriptDigest).toBe(scriptDigest(recipe().script));
    expect(v.video).toBe("t-new");
    expect(v.screens).toEqual(NEW);
  });

  it("reads the receipt named after the recipe's file, not the flow's current name", async () => {
    // A rename that rewrote the name inside the file but left its file name.
    await writeV2({ ...recipe(), name: "Renamed in the studio" });
    // Premise: the two names make different files.
    expect(keptFileName("Renamed in the studio")).not.toBe(keptFileName(NAME));
    const v = await one();
    // A v1 receipt the same: added, with its images.
    expect(v.outcome, JSON.stringify(v)).toBe("added");
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
    // A v1 receipt: written again as v2, with its images.
    expect(v.outputs).toEqual([GIF, SCREENS, RECEIPT]);
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
    expect(v.outputs).toEqual([MP4, SCREENS, RECEIPT]);
  });

  it("a v1 file whose judged output is gone is uncompared, and still untouched", async () => {
    const text = v1Text(recipe());
    await writeFile(join(repo, FILE), text);
    await rm(join(repo, MP4));
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("uncompared");
    expect(v.notes).toEqual([`${MP4} is missing`]);
    expect(await readFile(join(repo, FILE), "utf8")).toBe(text);
    expect(v.outputs).toEqual([MP4, SCREENS, RECEIPT]);
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

  it("a malformed filmedCode is unknown: never copied into the receipt, and said", async () => {
    await writeV2();
    same = false;
    const d = deps();
    const make = d.executor;
    d.executor = (o) => {
      const ex = make(o);
      return {
        ...ex,
        request: async (op: string, a: Record<string, unknown>) => {
          const out = await ex.request(op as "run", a as never);
          if (op === "run" && out.ok)
            (out.value as { filmedCode: unknown }).filmedCode = { commit: 42 };
          return out;
        },
      } as typeof ex;
    };
    const v = await one(d);
    // Premise: the film was delivered, so a receipt was written.
    expect(v.outcome, JSON.stringify(v)).toBe("changed");
    expect(v.filmedCode).toBeNull();
    const r = parseReceipt(
      await readFile(join(repo, RECEIPT), "utf8"),
      RECEIPT,
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.receipt.filmedCode).toEqual({
      none: expect.stringContaining("filmedCode is malformed"),
    });
    expect(v.notes.join(" ")).toContain("filmedCode is malformed");
  });
});

/** A version 2 receipt, and its folder of the committed screens' images. */
const writeWithScreens = async (k = recipe()) => {
  await writeV2(
    k,
    receipt({
      receiptVersion: 2,
      screensDir: screensDirOf(RECEIPT),
      screensSize: SIZE,
    }),
  );
  await mkdir(join(repo, SCREENS), { recursive: true });
  for (const m of OLD.moments)
    await writeFile(
      join(repo, SCREENS, screenImageName(m.step)),
      `old ${screenImageName(m.step)}`,
    );
};
/** Each export as what it rendered: "screens", or the output's type. */
const exported = () =>
  exports.map((e) => (e.screensOnly === true ? "screens" : e.fileType));
/** Every file under `paths` (a folder's files by name), as bytes or gone. */
const snapshot = async (paths: string[]) => {
  const out: Record<string, string | null> = {};
  for (const p of paths) {
    const at = join(repo, p);
    if (!existsSync(at)) out[p] = null;
    else if ((await readdir(at).catch(() => null)) !== null)
      for (const n of await readdir(at))
        out[`${p}/${n}`] = await readFile(join(at, n), "utf8");
    else out[p] = await readFile(at, "utf8");
  }
  return out;
};
const receiptOf = async () => {
  const r = parseReceipt(await readFile(join(repo, RECEIPT), "utf8"), RECEIPT);
  if (!r.ok) throw new Error(r.detail);
  return r.receipt;
};

describe("a refresh decides from the screens, then exports", () => {
  it("v2, same: renders the screens alone, exports nothing, writes nothing", async () => {
    await writeWithScreens();
    const before = await snapshot([MP4, RECEIPT, SCREENS]);
    // Premise: the committed images are there to compare with.
    expect(before[`${SCREENS}/final.png`]).toBe("old final.png");
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("unchanged");
    // Red if an unchanged video still runs the full export.
    expect(exported()).toEqual(["screens"]);
    expect(exports[0]).toMatchObject({
      takeId: "t-new",
      fileType: "mp4",
      aspect: "16:9",
      unlisted: true,
    });
    expect(screensCompared).toEqual([
      {
        committed: { dir: join(repo, SCREENS), screens: OLD, size: SIZE },
        fresh: { dir: expect.any(String), screens: NEW, size: SIZE },
      },
    ]);
    expect(compared).toEqual([]);
    expect(v.detail).toBe(`${MP4}: the same`);
    expect(v.outputs).toEqual([]);
    expect(v.sameAs).toEqual({ video: "t1" });
    expect(await snapshot([MP4, RECEIPT, SCREENS])).toEqual(before);
  });

  it("v2, same, with an output not committed: exports only that one, added", async () => {
    await writeWithScreens(recipe([MP4, GIF]));
    // Premise: the GIF was never committed.
    expect(existsSync(join(repo, GIF))).toBe(false);
    const before = await snapshot([MP4, RECEIPT, SCREENS]);
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("added");
    expect(exported()).toEqual(["screens", "gif"]);
    expect(v.outputs).toEqual([GIF]);
    expect(v.detail).toContain(`${GIF} is new`);
    expect(await readFile(join(repo, GIF), "utf8")).toBe("new gif");
    expect(await snapshot([MP4, RECEIPT, SCREENS])).toEqual(before);
  });

  it("v2, changed: exports every output after the screens, and writes them with the images and receipt", async () => {
    await writeWithScreens(recipe([MP4, GIF]));
    same = false;
    freshSize = { width: 1280, height: 720 };
    // Premise: the fresh render's size is not the committed receipt's.
    expect((await receiptOf()).screensSize).toEqual(SIZE);
    expect(freshSize).not.toEqual(SIZE);
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("changed");
    expect(exported()).toEqual(["screens", "mp4", "gif"]);
    // The screens decide: the changed video's export is not compared again.
    expect(screensCompared).toHaveLength(1);
    expect(compared).toEqual([]);
    expect(v.outputs).toEqual([MP4, GIF, SCREENS, RECEIPT]);
    expect(await readFile(join(repo, MP4), "utf8")).toBe("new mp4");
    expect(await snapshot([SCREENS])).toEqual({
      [`${SCREENS}/final.png`]: "new final.png",
    });
    expect(await receiptOf()).toMatchObject({
      receiptVersion: 2,
      video: "t-new",
      screens: NEW,
      screensDir: screensDirOf(RECEIPT),
      screensSize: freshSize,
    });
    expect(v.screens).toEqual(NEW);
    // The list names files, not the images' folder.
    expect(v.files.map((f) => f.path)).toEqual([MP4, GIF, RECEIPT]);
  });

  it("a changed video whose second export fails writes nothing, its receipt and images as they were", async () => {
    await writeWithScreens(recipe([MP4, GIF]));
    await writeFile(join(repo, GIF), "committed gif");
    same = false;
    failExport = "gif";
    const before = await snapshot([MP4, GIF, RECEIPT, SCREENS]);
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("failed");
    // Premise: the first output's export ran before the second failed.
    expect(exported()).toEqual(["screens", "mp4", "gif"]);
    expect(v.detail).toBe(`${GIF}: the render failed: injected`);
    expect(v.outputs).toEqual([]);
    expect(await snapshot([MP4, GIF, RECEIPT, SCREENS])).toEqual(before);
  });

  it("v1: exports to compare, says so, and writes the receipt v2 and its images", async () => {
    await writeV2();
    // Premise: the committed receipt is version 1, naming no images.
    expect(
      JSON.parse(await readFile(join(repo, RECEIPT), "utf8")).receiptVersion,
    ).toBe(1);
    const v = await one();
    // Added, not unchanged: its receipt and images are written, and a
    // delivery commits only changed, added or uncompared videos.
    expect(v.outcome, JSON.stringify(v)).toBe("added");
    expect(v.line).toContain(NAME);
    expect(exported()).toEqual(["screens", "mp4"]);
    expect(compared).toEqual([{ committed: OLD, fresh: NEW }]);
    expect(screensCompared).toEqual([]);
    expect(v.notes).toEqual([
      `${RECEIPT} had no screen images, so this refresh exported to compare; the next one compares its screens`,
    ]);
    expect(await readFile(join(repo, MP4), "utf8")).toBe("committed film");
    expect(v.outputs).toEqual([SCREENS, RECEIPT]);
    // The committed video is still the one the receipt names; its images
    // are the screens judged the same as it.
    expect(await receiptOf()).toMatchObject({
      receiptVersion: 2,
      video: "t1",
      screens: NEW,
      screensDir: screensDirOf(RECEIPT),
      screensSize: SIZE,
    });
    expect(await snapshot([SCREENS])).toEqual({
      [`${SCREENS}/final.png`]: "new final.png",
    });
    // The next one compares its screens.
    exports.length = 0;
    const next = await one();
    expect(next.outcome, JSON.stringify(next)).toBe("unchanged");
    expect(exported()).toEqual(["screens"]);
    expect(next.notes).toEqual([]);
  });

  it("v2 whose images folder is missing fails, naming the missing image, and writes nothing", async () => {
    await writeWithScreens();
    await rm(join(repo, SCREENS), { recursive: true });
    const before = await snapshot([MP4, RECEIPT]);
    // The real comparison: it reads the images before it opens a page.
    const d = deps();
    d.sameScreens = undefined;
    const v = await one(d);
    expect(v.outcome, JSON.stringify(v)).toBe("failed");
    expect(v.detail).toBe(
      `${MP4} could not be compared with its new screens, so nothing was replaced: ${join(repo, SCREENS, "final.png")} is missing`,
    );
    expect(exported()).toEqual(["screens"]);
    expect(v.outputs).toEqual([]);
    expect(await snapshot([MP4, RECEIPT, SCREENS])).toEqual({
      ...before,
      [SCREENS]: null,
    });
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
      getSkeleton: async () => ({ kind: "none" }),
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
    // Red: drop "going by time" — a clock comparison across machines reads
    // as a fact.
    expect(note).toContain(
      `not in ${FILE} (going by time: made or edited after it was recorded at ${STARTED}, by that machine's clock)`,
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

  it("a files flow with a previous v1 receipt and the same picture is added, its receipt written again", async () => {
    await writeV2(filesRecipe(), null);
    await writeFile(join(prev, BARE), "delivered film");
    await writeFile(join(prev, RECEIPT_NAME), serializeReceipt(receipt()));
    const [v] = await refreshInto({ previous: prev });
    // A v1 receipt the same: added, its receipt written again with images.
    expect(v?.outcome, JSON.stringify(v)).toBe("added");
    expect(compared).toEqual([{ committed: OLD, fresh: NEW }]);
    // No output to deliver: the previous folder's film stands.
    expect(existsSync(join(out, BARE))).toBe(false);
    expect((await listIn()).videos[0]).toMatchObject({
      outcome: "added",
      sameAs: { video: "t1", commit: FILMED, dirty: false },
      // Its v1 receipt, written again as v2 beside its images.
      files: [{ path: RECEIPT_NAME, fileType: "json", aspect: null }],
    });
    expect(existsSync(join(out, `${stem}.receipt.screens`, "final.png"))).toBe(
      true,
    );
  });

  it("with --previous the same folder as --out-dir, the same picture's video stays and its receipt still names it", async () => {
    await writeV2(filesRecipe(), null);
    await writeFile(join(out, BARE), "delivered film");
    await writeFile(join(out, RECEIPT_NAME), serializeReceipt(receipt()));
    const [v] = await refreshInto({ previous: out });
    // A v1 receipt the same: added, its receipt written again with images.
    expect(v?.outcome, JSON.stringify(v)).toBe("added");
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

  it("a files flow's images sit beside its receipt in the folder, and the next refresh compares them", async () => {
    await writeV2(filesRecipe(), null);
    const [first] = await refreshInto({ previous: out });
    expect(first?.outcome, JSON.stringify(first)).toBe("uncompared");
    const images = join(out, `${stem}.receipt.screens`);
    expect(await readdir(images)).toEqual(["final.png"]);
    expect(first?.outputs).toEqual([
      BARE,
      `${stem}.receipt.screens`,
      RECEIPT_NAME,
    ]);
    exports.length = 0;
    const [next] = await refreshInto({ previous: out });
    expect(next?.outcome, JSON.stringify(next)).toBe("unchanged");
    expect(exported()).toEqual(["screens"]);
    expect(screensCompared.map((c) => c.committed.dir)).toEqual([images]);
  });

  it("a files delivery cut short leaves no old receipt, so the next refresh is uncompared", async () => {
    same = false;
    await writeV2({ ...recipe([BARE, "o.gif"]), deliver: "files" }, null);
    await writeFile(join(out, BARE), "delivered film");
    await writeFile(join(out, RECEIPT_NAME), serializeReceipt(receipt()));
    // The second output cannot be written: its name is a folder.
    await mkdir(join(out, "o.gif"));
    const [v] = await refreshInto({ previous: out });
    expect(v?.outcome, JSON.stringify(v)).toBe("failed");
    // Premise: the first output was written before the second failed.
    expect(v?.detail).toContain(`wrote ${BARE}`);
    expect(await readFile(join(out, BARE), "utf8")).toBe("new mp4");
    // Red: keep the old receipt — the next run pairs it with the new video.
    expect(existsSync(join(out, RECEIPT_NAME))).toBe(false);
    await rm(join(out, "o.gif"), { recursive: true });
    same = true;
    compared.length = 0;
    const [next] = await refreshInto({ previous: out });
    expect(next?.outcome, JSON.stringify(next)).toBe("uncompared");
    expect(next?.notes.join(" ")).toContain(`${RECEIPT_NAME} is missing`);
    expect(compared).toEqual([]);
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

// Red when a pinned refresh records at the real date, or the note on dates
// fires without evidence or where a pin already holds them (DEM-79).
describe("pinned dates", () => {
  const PINNED = "2026-11-06T09:00:00Z";
  const pinned = (): RefreshDeps => ({ ...deps(), pinnedNow: PINNED });

  it("a pinned refresh passes pinnedNow to its run", async () => {
    await writeWithScreens();
    await one(pinned());
    expect(runs.map((r) => r.pinnedNow)).toEqual([PINNED]);
  });

  it("an unpinned refresh passes none", async () => {
    await writeWithScreens();
    await one();
    expect(runs.map((r) => "pinnedNow" in r)).toEqual([false]);
  });

  it("writes pinnedNow into the receipt it delivers", async () => {
    await writeWithScreens();
    same = false;
    const v = await one(pinned());
    expect(v.outcome, JSON.stringify(v)).toBe("changed");
    expect((await receiptOf()).pinnedNow).toBe(PINNED);
  });

  it("an unpinned refresh writes no pinnedNow", async () => {
    await writeWithScreens();
    same = false;
    await one();
    expect("pinnedNow" in (await receiptOf())).toBe(false);
  });

  it("a replaced video that showed dates gets DATES_NOTE when unpinned", async () => {
    await writeWithScreens();
    same = false;
    storedDates = ["Dec 4, 2026"];
    const v = await one();
    const said = JSON.stringify({ v, logged });
    expect(v.outcome, said).toBe("changed");
    expect(v.notes, said).toContain(DATES_NOTE(["Dec 4, 2026"]));
    expect(
      logged.some((l) => l.includes(NAME) && l.includes("Dec 4, 2026")),
      said,
    ).toBe(true);
  });

  it("no note when the page showed no dates", async () => {
    await writeWithScreens();
    same = false;
    const v = await one();
    expect(v.outcome).toBe("changed");
    expect(v.notes.join(" ")).not.toContain("DEMOMAN_NOW");
  });

  it("no note when pinned", async () => {
    await writeWithScreens();
    same = false;
    storedDates = ["Dec 4, 2026"];
    const v = await one(pinned());
    expect(v.outcome).toBe("changed");
    expect(v.notes.join(" ")).not.toContain("DEMOMAN_NOW");
  });

  it("no note when the picture is the same, even with an output written", async () => {
    // The same picture with an output not yet committed: delivered as added,
    // so it reaches the end of delivery where the note is decided.
    await writeWithScreens(recipe([MP4, GIF]));
    storedDates = ["Dec 4, 2026"];
    const v = await one();
    expect(v.outcome, JSON.stringify(v)).toBe("added");
    expect(v.notes.join(" ")).not.toContain("DEMOMAN_NOW");
  });
});
