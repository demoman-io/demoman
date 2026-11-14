import { describe, expect, it } from "vitest";
import { flowSizeOf } from "../src/executor/flow-size.js";
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
