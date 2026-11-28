import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOWS_DIR, type KeptVideo, serializeKept } from "@demoman/run-core";
import { describe, expect, it } from "vitest";
import {
  flowRegionOf,
  flowScaleOf,
  flowSizeOf,
} from "../src/executor/flow-size.js";
import type { Library } from "../src/executor/library.js";
import type { VideoRecord, VideoStore } from "../src/executor/videos.js";

const video = { id: "v1", name: "Flow" } as VideoRecord;

const take = (takeId: string, complete = true) => ({
  takeId,
  number: 1,
  complete,
});

/** A store with these versions and a library answering `report.json` from
 *  `reports` by take id. */
const world = (
  versions: ReturnType<typeof take>[],
  reports: Record<string, Awaited<ReturnType<Library["getJson"]>>>,
) => ({
  store: { versions: async () => versions } as unknown as VideoStore,
  library: {
    getJson: async (id: string) => reports[id] ?? { missing: true },
  } as unknown as Library,
});

describe("flowSizeOf", () => {
  // Turns red when `flowSizeOf` stops reading `size` off the latest report.
  it("reads the latest complete video's reported size", async () => {
    const { store, library } = world([take("a"), take("b"), take("c", false)], {
      a: { value: { size: { width: 1, height: 1, from: "screen" } } },
      b: { value: { size: { width: 1280, height: 800, from: "screen" } } },
    });
    expect(await flowSizeOf(store, library, video)).toEqual({
      size: { width: 1280, height: 800 },
    });
  });

  // Turns red when the `from === "window"` line is removed: a fallback
  // would be pinned for good. Premise: the report does carry a usable size.
  it("does not carry a size measured from the window", async () => {
    const report = { size: { width: 900, height: 519, from: "window" } };
    expect(report.size.width).toBeGreaterThan(0);
    const { store, library } = world([take("a")], { a: { value: report } });
    expect(await flowSizeOf(store, library, video)).toEqual({});
  });

  // Turns red when a missing or unreadable report is swallowed: the run would
  // record at the screen with nothing in the log saying the flow's size was
  // not read.
  it("says why when the latest report cannot be read", async () => {
    const missing = await flowSizeOf(
      ...(Object.values(world([take("a")], {})) as [VideoStore, Library]),
      video,
    );
    expect(missing.size).toBeUndefined();
    expect(missing.why).toContain("is missing");
    const { store, library } = world([take("a")], {
      a: { unreadable: "not JSON" },
    });
    const unread = await flowSizeOf(store, library, video);
    expect(unread.size).toBeUndefined();
    expect(unread.why).toContain("not JSON");
  });

  it("has nothing to carry for a flow with no video", async () => {
    const { store, library } = world([], {});
    expect(await flowSizeOf(store, library, video)).toEqual({});
  });
});

/** A store with these versions and a library answering each take's scene
 *  capture and motion span widths. */
const scenes = (
  versions: ReturnType<typeof take>[],
  takes: Record<string, { displayScale?: number; spans?: number[] }>,
) => ({
  store: { versions: async () => versions } as unknown as VideoStore,
  library: {
    getScene: async (id: string) => {
      const t = takes[id];
      if (t === undefined) return null;
      return {
        meta: {
          capture: {
            viewport: { width: 1280, height: 800 },
            ...(t.displayScale === undefined
              ? {}
              : { displayScale: t.displayScale }),
          },
        },
      };
    },
    frameStore: (id: string) => ({
      getBundle: async () => ({
        motionSpans: (takes[id]?.spans ?? []).map((width) => ({ width })),
      }),
    }),
  } as unknown as Library,
});

describe("flowScaleOf", () => {
  // Turns red when `flowScaleOf` stops reading `displayScale` off the latest
  // complete video: a flow recorded at 1x would be recorded at 2x next.
  it("reads the latest complete video's recorded scale", async () => {
    const { store, library } = scenes(
      [take("a"), take("b"), take("c", false)],
      {
        a: { displayScale: 2 },
        b: { displayScale: 1 },
        c: { displayScale: 3 },
      },
    );
    expect(await flowScaleOf(store, library, video)).toEqual({ scale: 1 });
  });

  // A video from before the field: its motion frames say it, as keep reads
  // them. Turns red when the `filmedScale` fallback is removed.
  it("reads the scale off the motion frames of a video that predates the field", async () => {
    const { store, library } = scenes([take("a")], {
      a: { spans: [2560, 1280] },
    });
    expect(await flowScaleOf(store, library, video)).toEqual({ scale: 2 });
  });

  // Report before you forgive: a scale that cannot be read is said, never an
  // empty answer that reads as a flow's first run.
  it("says why when the latest video names no scale or is missing", async () => {
    const none = scenes([take("a")], { a: {} });
    const said = await flowScaleOf(none.store, none.library, video);
    expect(said.scale).toBeUndefined();
    expect(said.why).toContain("does not say the scale it was recorded at");
    const gone = scenes([take("a")], {});
    expect((await flowScaleOf(gone.store, gone.library, video)).why).toContain(
      "video a is missing",
    );
  });

  it("has nothing to carry for a flow with no video", async () => {
    const { store, library } = scenes([], {});
    expect(await flowScaleOf(store, library, video)).toEqual({});
  });
});

describe("flowRegionOf", () => {
  const region = { timeZone: "Asia/Tokyo", locale: "de-DE" };
  const library = (capture: Record<string, unknown> | null) =>
    ({
      getScene: async () => (capture === null ? null : { meta: { capture } }),
    }) as unknown as Library;
  const store = (versions: ReturnType<typeof take>[]) =>
    ({ versions: async () => versions }) as unknown as VideoStore;

  // Red when the latest take's pins are not read: a later run would pin
  // whichever machine it ran on.
  it("pins the latest video's time zone and locale", async () => {
    expect(
      await flowRegionOf(store([take("a")]), library(region), video),
    ).toEqual({ pin: region });
  });

  // Decide once: a flow recorded before the pins stays unpinned, so its
  // video does not change. Red when it pins this machine's instead.
  it("leaves a flow whose video names none unpinned, saying why", async () => {
    const plan = await flowRegionOf(store([take("a")]), library({}), video);
    expect(plan.pin).toBe("none");
    expect("why" in plan && plan.why).toContain("recorded before");
  });

  it("pins this machine's for a flow with no video and no kept file", async () => {
    expect(await flowRegionOf(store([]), library(null), video)).toEqual({
      pin: "thisMachine",
    });
  });

  // Report before you forgive: a missing take pins this machine's and says so.
  it("says why when the latest video is missing", async () => {
    const plan = await flowRegionOf(store([take("a")]), library(null), video);
    expect(plan).toEqual({ pin: "thisMachine", why: "video a is missing" });
  });

  /** A repo whose kept file for the flow names `kept` (absent: no region). */
  const keptRepo = async (region?: KeptVideo["region"]) => {
    const root = await mkdtemp(join(tmpdir(), "demoman-flow-region-"));
    const id = "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90";
    const kept: KeptVideo = {
      keptVersion: 2,
      flow: id,
      name: "Flow",
      script: {
        scriptVersion: 1,
        name: "Flow",
        target: "http://localhost:4000/",
        steps: [{ do: "waitForLoad" }],
      } as KeptVideo["script"],
      scale: 2,
      ...(region === undefined ? {} : { region }),
      logo: null,
      wallpaper: null,
      deliver: "commit",
      outputs: [
        {
          path: "docs/f.mp4",
          fileType: "mp4",
          aspect: "auto",
          quality: "share",
        },
      ],
      report: null,
    };
    await mkdir(join(root, FLOWS_DIR), { recursive: true });
    await writeFile(join(root, FLOWS_DIR, "flow.json"), serializeKept(kept));
    const adopted = {
      id,
      name: "Flow",
      kept: { root, file: `${FLOWS_DIR}/flow.json` },
    } as VideoRecord;
    return { adopted, done: () => rm(root, { recursive: true, force: true }) };
  };

  // How refresh reads them, in a library with no video of the flow. Red
  // when the kept-file branch is dropped: every pinned refresh would fail.
  it("pins the kept file's for a flow with no video here, and leaves one kept before them unpinned", async () => {
    const pinned = await keptRepo(region);
    const old = await keptRepo();
    try {
      expect(
        await flowRegionOf(store([]), library(null), pinned.adopted),
      ).toEqual({ pin: region });
      expect(
        (await flowRegionOf(store([]), library(null), old.adopted)).pin,
      ).toBe("none");
    } finally {
      await pinned.done();
      await old.done();
    }
  });

  // A video that cannot be read falls back to the kept file, not to this
  // machine's, which its take would then record as the flow's for good.
  it("reads the kept file when the latest video is missing", async () => {
    const pinned = await keptRepo(region);
    try {
      expect(
        await flowRegionOf(store([take("a")]), library(null), pinned.adopted),
      ).toEqual({ pin: region });
    } finally {
      await pinned.done();
    }
  });
});
