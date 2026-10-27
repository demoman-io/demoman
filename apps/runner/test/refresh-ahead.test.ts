import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEPT_DIR,
  type KeptVideo,
  keptFileName,
  serializeKept,
} from "@demoman/run-core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Library } from "../src/executor/library.js";
import { type RefreshDeps, refreshKept } from "../src/executor/refresh.js";
import type { Version, VideoStore } from "../src/executor/videos.js";

const NAME = "Place an order";
const FILE = `${KEPT_DIR}/${keptFileName(NAME)}`;
const kept: KeptVideo = {
  keptVersion: 1,
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
  outputs: [
    { path: "docs/o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
  ],
  report: null,
  from: { videoId: "v1", takeId: "t1", recordedRevision: "r1" },
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
let current: { takeId: string; revision: string; masks: string[] };
let reads: number;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "demoman-ahead-"));
  await mkdir(join(repo, KEPT_DIR), { recursive: true });
  await writeFile(join(repo, FILE), serializeKept(kept));
  current = { takeId: "t1", revision: "r1", masks: [] };
  reads = 0;
});

const deps = (): RefreshDeps => ({
  home: repo,
  videos: {
    get: async () => {
      reads++;
      return { id: "v1", name: NAME };
    },
    versions: async () => [version(current.takeId)],
  } as unknown as VideoStore,
  library: {
    getSceneRead: async () => ({
      scene: {
        edits: {
          masks: current.masks.map((id) => ({ id })),
          holds: [],
        },
        camera: [],
      },
      revision: current.revision,
      notes: [],
    }),
  } as unknown as Library,
  // The film itself is refused: the line must survive a video that fails.
  executor: () =>
    ({
      request: async () => ({ ok: false, reason: "x", detail: "no film" }),
      close: async () => undefined,
    }) as unknown as ReturnType<RefreshDeps["executor"]>,
  session: {} as RefreshDeps["session"],
  env: {},
  git: async () => ({ code: 0, stdout: "abc\n", stderr: "" }),
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
    expect(line).toContain(`run \`demoman keep ${NAME}\` again to take them`);
    expect(line).not.toContain("refuse");
    expect(rest).toEqual([]);
  });
  it("says so for a newer take", async () => {
    current.takeId = "t2";
    expect((await notes("local"))?.[0]).toContain("demoman keep");
  });
  it("names a mask keep would refuse", async () => {
    current.revision = "r2";
    current.masks = ["m1"];
    expect((await notes("local"))?.[0]).toContain("mask m1");
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
