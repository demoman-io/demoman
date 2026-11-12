import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkeletonRead } from "@demoman/run-core";
import {
  FLOWS_DIR,
  LEGACY_FLOWS_DIR as KEPT_DIR,
  type KeptReceipt,
  type KeptVideo,
  keptFileName,
  RECEIPT_DIR,
  serializeKept,
  serializeReceipt,
} from "@demoman/run-core";
import { beforeEach, describe, expect, it } from "vitest";
import { libraryAhead } from "../src/executor/keep.js";
import type { Library } from "../src/executor/library.js";
import { type RefreshDeps, refreshKept } from "../src/executor/refresh.js";
import type { Version, VideoStore } from "../src/executor/videos.js";

const FLOW_ID = "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90";
const NAME = "Place an order";
const FILE = `${KEPT_DIR}/${keptFileName(NAME)}`;
const kept: KeptVideo = {
  keptVersion: 2,
  flow: FLOW_ID,
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
  outputs: [
    { path: "docs/o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
  ],
  report: null,
};
/** What the committed files show: video t1 at revision r1. */
const committed: KeptReceipt = {
  receiptVersion: 3,
  screensDir: "o.screens",
  flow: FLOW_ID,
  video: "t1",
  filmedAt: null,
  filmedCode: { none: "test" },
  screens: { steps: 1, screens: [{ step: null }] },
  recordedRevision: "r1",
};
const version = (takeId: string): Version => ({
  takeId,
  number: 1,
  createdAt: "",
  complete: true,
  // Carried edits made before keep set this; it must not decide anything.
  edited: true,
  hasScript: true,
  expired: null,
});

let repo: string;
let current: {
  takeId: string;
  revision: string;
  masks: string[];
  /** A Studio tail trim on act-1, when set. */
  tail?: boolean;
  skeleton: SkeletonRead;
};
let reads: number;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "demoman-ahead-"));
  await mkdir(join(repo, KEPT_DIR), { recursive: true });
  await writeFile(join(repo, FILE), serializeKept(kept));
  await mkdir(join(repo, RECEIPT_DIR), { recursive: true });
  await writeFile(
    join(repo, RECEIPT_DIR, keptFileName(NAME)),
    serializeReceipt(committed),
  );
  current = {
    takeId: "t1",
    revision: "r1",
    masks: [],
    skeleton: { kind: "none" },
  };
  reads = 0;
});

const deps = (): RefreshDeps => ({
  videos: {
    get: async () => {
      reads++;
      return { id: FLOW_ID, name: NAME };
    },
    // The flow's versions: the kept t1, and any newer one after it.
    versions: async () =>
      current.takeId === "t1"
        ? [version("t1")]
        : [version("t1"), version(current.takeId)],
  } as unknown as VideoStore,
  library: {
    getSceneRead: async () => ({
      scene: {
        edits: {
          masks: current.masks.map((id) => ({ id })),
          holds: [],
          ...(current.tail
            ? { trim: { tail: { actionId: "act-1", offsetMs: 900 } } }
            : {}),
        },
        camera: [],
      },
      revision: current.revision,
      notes: [],
    }),
    getSkeleton: async () => current.skeleton,
  } as unknown as Library,
  // The film itself is refused: the line must survive a video that fails.
  executor: () =>
    ({
      request: async () => ({ ok: false, reason: "x", detail: "no film" }),
      close: async () => undefined,
    }) as unknown as ReturnType<RefreshDeps["executor"]>,
  session: {} as RefreshDeps["session"],
  env: {},
  log: () => undefined,
});

const notes = async (library: "local" | "throwaway", d = deps()) =>
  (await refreshKept({ repoRoot: repo, library }, d)).videos[0]?.notes;

describe("a refresh says when the library is ahead of the file", () => {
  it("says nothing when the library's version is the one kept", async () => {
    expect(await notes("local")).toEqual([]);
    expect(reads).toBe(1); // the library was read
  });
  it("says to keep again after a carried edit (same take, new revision)", async () => {
    current.revision = "r2";
    const [line, ...rest] = (await notes("local")) ?? [];
    expect(line).toContain(`not in ${FILE}`);
    expect(line).toContain(`run \`demoman add ${NAME}\` again to take them`);
    expect(line).not.toContain("refuse");
    expect(rest).toEqual([]);
  });
  it("says so for a newer take", async () => {
    current.takeId = "t2";
    expect((await notes("local"))?.[0]).toContain("demoman add");
  });
  it("names a mask keep would refuse", async () => {
    current.revision = "r2";
    current.masks = ["m1"];
    expect((await notes("local"))?.[0]).toContain("mask m1");
  });
  it("names a Studio tail only when the skeleton cannot write it back", async () => {
    current.revision = "r2";
    current.tail = true;
    expect((await notes("local"))?.[0]).toContain("trim tail");
    // The step's finish is known: the re-record writes the tail into the
    // script, so add has nothing to refuse.
    current.skeleton = {
      kind: "ok",
      skeleton: {
        skeletonVersion: 2,
        name: NAME,
        scriptVersion: 1,
        viewport: null,
        device: null,
        look: null,
        steps: [
          {
            do: "click",
            actionId: "act-1",
            anchorDigest: null,
            finishMs: 400,
            zoomOutMs: null,
          },
        ],
      },
    };
    const note = (await notes("local"))?.[0];
    expect(note).toContain("run `demoman add");
    expect(note).not.toContain("trim tail");
  });
  it("says the library cannot be read, rather than saying nothing", async () => {
    const d = deps();
    d.videos = {
      get: async () => {
        throw new Error("videos.json is torn");
      },
    } as unknown as VideoStore;
    expect((await notes("local", d))?.[0]).toContain(
      "cannot be told: videos.json is torn",
    );
  });
  it("films with leaveKept, so its own run never rewrites the kept file", async () => {
    const runs: Record<string, unknown>[] = [];
    const d = deps();
    d.executor = () =>
      ({
        request: async (op: string, args: Record<string, unknown>) => {
          if (op === "run") runs.push(args);
          return { ok: false, reason: "x", detail: "no film" };
        },
        close: async () => undefined,
      }) as unknown as ReturnType<RefreshDeps["executor"]>;
    await notes("local", d);
    expect(runs.length, "premise: refresh asked for a run").toBeGreaterThan(0);
    for (const args of runs) expect(args.leaveKept).toBe(true);
  });
  it("never reads the library in a throwaway refresh", async () => {
    const boom = () => {
      throw new Error("the library was read");
    };
    const d = deps();
    d.videos = { get: boom, versions: boom } as unknown as VideoStore;
    d.library = { getSceneRead: boom } as unknown as Library;
    current.revision = "r2";
    expect(await notes("throwaway", d)).toEqual([]);
  });
});

describe("a kept file that does not parse", () => {
  it("is one failure when `only` names it, not also a missing video", async () => {
    await writeFile(join(repo, FILE), "{ not json");
    const { videos } = await refreshKept(
      { repoRoot: repo, library: "local", only: [NAME] },
      deps(),
    );
    expect(
      videos.map((v) => v.detail),
      JSON.stringify(videos),
    ).toHaveLength(1);
    expect(videos[0]?.detail).not.toContain("the repo has no flow named");
    expect(videos[0]?.file).toBe(FILE);
  });
});

describe("a flow in .demoman/flows/", () => {
  it("is refreshed and found by name with `only`", async () => {
    const moved = `${FLOWS_DIR}/${keptFileName(NAME)}`;
    await mkdir(join(repo, FLOWS_DIR), { recursive: true });
    await rename(join(repo, FILE), join(repo, moved));
    const { videos } = await refreshKept(
      { repoRoot: repo, library: "local", only: [NAME] },
      deps(),
    );
    expect(
      videos.map((v) => v.file),
      JSON.stringify(videos),
    ).toEqual([moved]);
    expect(videos[0]?.detail ?? "").not.toContain("the repo has no flow named");
  });

  // Red: match `only` by keptFileName again — "place the orders" names
  // place-the-orders.json, which no flow is in (DEM-68).
  it("is found by a name the library reads as the same, as the library matches", async () => {
    const { videos } = await refreshKept(
      { repoRoot: repo, library: "local", only: ["place the orders"] },
      deps(),
    );
    // Premise: the words differ from the flow's, and so do their files.
    expect(keptFileName("place the orders")).not.toBe(keptFileName(NAME));
    expect(
      videos.map((v) => v.file),
      JSON.stringify(videos),
    ).toEqual([FILE]);
    expect(videos[0]?.detail ?? "").not.toContain("the repo has no flow named");
  });
});

describe("one file name in both folders, as two flows", () => {
  it("fails both and says to delete the old file", async () => {
    const twin = `${FLOWS_DIR}/${keptFileName(NAME)}`;
    await mkdir(join(repo, FLOWS_DIR), { recursive: true });
    await writeFile(
      join(repo, twin),
      serializeKept({ ...kept, flow: "3e9b4f85-a06d-4c31-8d74-5fb08b9cad23" }),
    );
    const { videos } = await refreshKept(
      { repoRoot: repo, library: "local" },
      deps(),
    );
    expect(
      videos.map((v) => v.file),
      JSON.stringify(videos),
    ).toEqual([twin, FILE]);
    for (const v of videos) {
      expect(v.outcome).toBe("failed");
      expect(v.detail).toBe(
        `${twin} and ${FILE} are two different flows with one file name — rename one of the two flows, then refresh again`,
      );
    }
  });
});

describe("a local refresh films outside the user's library", () => {
  /** Each executor's library, by its home, under the run's own rules for
   *  `video` (executor.ts): an id the repo keeps is adopted, any other
   *  unknown id is videoNotFound, a name this repo already has is
   *  nameTaken, and a run into a video adds a version. */
  const libraries = new Map<string, { ids: Set<string>; names: Set<string> }>();
  const runs: { home: string; video: Record<string, unknown> }[] = [];
  const filming = (userHas: boolean): RefreshDeps => {
    libraries.clear();
    runs.length = 0;
    libraries.set(repo, {
      ids: new Set(userHas ? [FLOW_ID] : []),
      names: new Set(userHas ? [NAME] : []),
    });
    const d = deps();
    if (!userHas)
      d.videos = {
        get: async () => null,
        versions: async () => [],
      } as unknown as VideoStore;
    d.executor = ({ home }) =>
      ({
        request: async (_op: string, args: Record<string, unknown>) => {
          const video = args.video as Record<string, unknown>;
          runs.push({ home, video });
          const lib = libraries.get(home) ?? {
            ids: new Set(),
            names: new Set(),
          };
          libraries.set(home, lib);
          const refuse = (reason: string, detail: string) => ({
            ok: true,
            value: { outcome: "refusedBeforeRun", reason, detail },
          });
          if ("id" in video) {
            if (video.id === FLOW_ID) lib.ids.add(FLOW_ID);
            if (!lib.ids.has(String(video.id)))
              return refuse("videoNotFound", `no video has the id ${video.id}`);
            // A new version of the user's video: the take a refresh made.
            if (home === repo) current.takeId = "t-refresh";
          } else {
            if (lib.names.has(String(video.new)))
              return refuse(
                "nameTaken",
                `video "${video.new}" already has that name`,
              );
            lib.names.add(String(video.new));
            lib.ids.add(`v${lib.ids.size + 2}`);
          }
          return refuse("x", "no film");
        },
        close: async () => undefined,
      }) as unknown as ReturnType<RefreshDeps["executor"]>;
    return d;
  };
  const refreshOnce = async (d: RefreshDeps) =>
    (await refreshKept({ repoRoot: repo, library: "local" }, d)).videos[0];

  it("refreshes a video kept on another machine twice without nameTaken", async () => {
    const d = filming(false);
    await refreshOnce(d);
    const second = await refreshOnce(d);
    expect(runs.length, "premise: both refreshes ran").toBeGreaterThanOrEqual(
      2,
    );
    expect(second?.detail, JSON.stringify(runs)).not.toContain("nameTaken");
    expect(second?.detail).toBe("x: no film");
  });

  it("leaves the next refresh with nothing to say about the library", async () => {
    const d = filming(true);
    expect(await refreshOnce(d).then((v) => v?.notes)).toEqual([]);
    expect(runs.length, "premise: the refresh filmed").toBeGreaterThan(0);
    expect((await refreshOnce(d))?.notes, JSON.stringify(runs)).toEqual([]);
  });
});

describe("libraryAhead, given the receipt", () => {
  const receipt = committed;
  const ahead = (r: KeptReceipt | null, d = deps()) =>
    libraryAhead(kept, r, FILE, d);

  it("says nothing when the receipt names the library's current video and revision", async () => {
    expect(await ahead(receipt)).toBeNull();
  });
  it("says to keep again when the receipt's revision is older", async () => {
    current.revision = "r2";
    expect(await ahead(receipt)).toContain(`run \`demoman add ${NAME}\` again`);
  });
  it("says to keep again when the receipt's video is older", async () => {
    current.takeId = "t2";
    expect(await ahead(receipt)).toContain("demoman add");
  });
  it("with no receipt, says there is none to compare when the library holds the flow", async () => {
    expect(await ahead(null)).toBe(
      `${FILE} has no receipt to compare the library with; run \`demoman add ${NAME}\` again`,
    );
  });
  it("a files flow with no receipt says it comes from --previous, never to add again", async () => {
    // Red: the commit-flow advice — add writes a files flow no receipt.
    const files = { ...kept, deliver: "files" as const };
    const note = await libraryAhead(files, null, FILE, deps());
    expect(note).toBe(
      `${FILE} delivers files, whose receipt comes from --previous (an earlier refresh's --out-dir); with none, whether the library is ahead of it cannot be told`,
    );
  });
  it("with no receipt, says nothing when the library has no such flow", async () => {
    const d = deps();
    d.videos = { get: async () => null } as unknown as VideoStore;
    expect(await ahead(null, d)).toBeNull();
  });
});
