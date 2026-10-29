import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ExportAnswer, sceneDigest } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExportDeps,
  type Exporting,
  exportTake,
} from "../src/executor/export.js";
import { createLibrary } from "../src/executor/library.js";
import { createVideoStore } from "../src/executor/videos.js";
import { launch } from "../src/launch.js";
import { makeDiskTake, putTake } from "./disk-take.js";
import { WALLPAPERS_DIR } from "./fixture.js";

const EXPORT_MS = 120_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

let home: string;
let outDir: string;
let take: Awaited<ReturnType<typeof makeDiskTake>>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-outputs-"));
  outDir = join(home, "out");
  await mkdir(outDir, { recursive: true });
  take = await makeDiskTake(home);
}, EXPORT_MS);

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const busyDir = () => join(home, "takes", take.takeId, ".busy");
const leases = () => readdir(busyDir()).catch(() => [] as string[]);

/** A session that opens work pages in a browser of its own, as the CLI's does. */
function depsFor(
  log: string[] = [],
): ExportDeps & { closeAll(): Promise<void> } {
  const opened: Awaited<ReturnType<typeof launch>>[] = [];
  const library = createLibrary(home);
  return {
    wallpapersDir: WALLPAPERS_DIR,
    library,
    videos: createVideoStore(home, library),
    door: "agent",
    home,
    outDir,
    log: (line) => log.push(line),
    session: {
      headless: true,
      async openWorkPage() {
        const launched = await launch({ headless: true });
        opened.push(launched);
        return { ok: true as const, page: launched.page };
      },
    },
    closeAll: async () => {
      await Promise.all(opened.map((l) => l.close()));
    },
  };
}

async function exportOnce(
  args: Record<string, unknown>,
  deps: ReturnType<typeof depsFor>,
  onProgress: (r: Exporting) => void = () => undefined,
): Promise<ExportAnswer> {
  try {
    return await exportTake({ takeId: take.takeId, ...args }, deps, onProgress);
  } finally {
    await deps.closeAll();
  }
}

describe("export lists what it saved, and holds a lease while it works", () => {
  it(
    "appends one outputs.json row matching the saved answer",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const answer = await exportOnce({ fileType: "mp4" }, depsFor());
      expect(answer.outcome).toBe("saved");
      if (answer.outcome !== "saved" || answer.fileType === "stills")
        throw new Error(`not a saved file: ${JSON.stringify(answer)}`);
      const rows = JSON.parse(
        await readFile(
          join(home, "takes", take.takeId, "outputs.json"),
          "utf8",
        ),
      ) as { path: string; sceneDigest: string; report: ExportAnswer }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.path).toBe(answer.file.path);
      expect(rows[0]?.sceneDigest).toBe(sceneDigest(take.original));
      expect(rows[0]?.report.summary).toBe(answer.summary);
    },
    EXPORT_MS,
  );

  it(
    "holds a lease named for the agent door during the render, and none after",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const during: unknown[] = [];
      const answer = await exportOnce({ fileType: "gif" }, depsFor(), (r) => {
        if (r.phase === "rendering" && during.length === 0) {
          during.push(
            readdir(busyDir()).then((names) =>
              Promise.all(
                names.map(async (n) =>
                  JSON.parse(await readFile(join(busyDir(), n), "utf8")),
                ),
              ),
            ),
          );
        }
      });
      expect(answer.outcome).toBe("saved");
      const held = (await during[0]) as unknown[];
      expect(held, "one lease while rendering").toHaveLength(1);
      expect(held[0]).toMatchObject({ op: "export", door: "agent" });
      expect(await leases()).toEqual([]);
    },
    EXPORT_MS,
  );

  it(
    "releases the lease after a renderFailed",
    async () => {
      const cut: SceneDocument = {
        ...take.original,
        edits: {
          ...take.original.edits,
          removed: [{ id: "all", start: null, end: null }],
        },
      };
      expect(
        cut.edits.removed,
        "the premise: one piece, the whole take, is removed",
      ).toEqual([{ id: "all", start: null, end: null }]);
      await putTake(home, take.takeId, cut, take.bundle);
      const answer = await exportOnce({ fileType: "stills" }, depsFor());
      expect(answer.outcome).toBe("renderFailed");
      expect(await leases()).toEqual([]);
      await putTake(home, take.takeId, take.original, take.bundle);
    },
    EXPORT_MS,
  );

  it(
    "stays saved, and says it is not listed, when outputs.json cannot be written",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const file = join(home, "takes", take.takeId, "outputs.json");
      await rm(file, { force: true });
      await mkdir(file); // a directory: the rename onto it fails
      const log: string[] = [];
      try {
        const answer = await exportOnce({ fileType: "gif" }, depsFor(log));
        expect(answer.outcome).toBe("saved");
        if (answer.outcome !== "saved") return;
        expect(answer.warnings.notListed?.error ?? "").not.toBe("");
        expect(answer.summary).toContain("not listed");
        expect(log.join("\n")).toContain("not listed");
      } finally {
        await rm(file, { recursive: true, force: true });
      }
    },
    EXPORT_MS,
  );

  it("opens @demoman/runner/studio under raw node with every name the Studio needs", async () => {
    const names = [
      "createLibrary",
      "LibraryError",
      "exportTake",
      "readKits",
      "readLogo",
      "listenOnLoopback",
      "classifyLaunchError",
      "chromiumInstallCommand",
      "loadedPlaywrightVersion",
      "usePrebuiltPages",
      "PAGE_ENTRIES",
    ];
    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import("@demoman/runner/studio"); console.log(JSON.stringify(Object.keys(m)));`,
      ],
      { cwd: join(HERE, "..") },
    );
    const exposed = JSON.parse(stdout) as string[];
    expect(exposed.sort()).toEqual(expect.arrayContaining(names.sort()));
  });
});

describe("export tagging", () => {
  it(
    "saves untagged and says why when the tag cannot be written",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const deps = {
        ...depsFor(),
        videos: {
          videoOf: async () => ({ videoId: "v" }) as never,
          get: async () => null,
        },
        tagBytes: () => ({
          ok: false as const,
          error: "the file has no room for a tag",
        }),
      };
      const answer = await exportOnce({ fileType: "gif" }, deps);
      if (answer.outcome !== "saved")
        throw new Error(`not saved: ${JSON.stringify(answer)}`);
      expect(answer.warnings.untagged).toEqual({
        error: "the file has no room for a tag",
      });
      expect(answer.summary).toContain("the file has no room for a tag");
    },
    EXPORT_MS,
  );
});
