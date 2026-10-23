import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { OutputRecord } from "@demoman/run-core";
import { createLibrary } from "@demoman/runner/studio";
import { migrateToCurrent, type SceneDocument } from "@demoman/scene-schema";
import type { BundleAnswer } from "@demoman/studio-protocol";

// A take built on disk through the runner's own built library, the approach
// of apps/runner/test/disk-take.ts. The routes serve bytes verbatim and
// never decode them, so the keyframes are distinct marked bytes rather than
// painted JPEGs (which would need a browser to make).

const FIXTURE = fileURLToPath(
  new URL(
    "../../../../packages/scene-schema/fixtures/readonly-scene.json",
    import.meta.url,
  ),
);

export type Bundle = NonNullable<BundleAnswer["bundle"]>;

/** The keyframe bytes at `index`: marked, so a test can tell them apart. */
export const keyframeBytes = (index: number): Uint8Array =>
  new Uint8Array([0xff, 0xd8, 0xff, index, 1, 2, 3, 0xff, 0xd9]);

export async function sceneFixture(id?: string): Promise<SceneDocument> {
  const scene = migrateToCurrent(
    JSON.parse(await readFile(FIXTURE, "utf8")) as unknown,
  );
  return id === undefined ? scene : { ...scene, meta: { ...scene.meta, id } };
}

/** Builds a take in `home`'s library: its frames, bundle, status and scene. */
export async function seedTake(
  home: string,
  o: {
    id?: string;
    status?: unknown;
    /** How many keyframes (default 3), at 400 ms apart after the first. */
    keyframes?: number;
    /** Bytes for keyframe `i`; default is the marked stand-in. */
    bytesOf?: (index: number) => Uint8Array;
    /** Adds one motion span (ref `span:<takeId>:0`) to bundle and store. */
    span?: boolean;
  } = {},
): Promise<{ takeId: string; scene: SceneDocument; bundle: Bundle }> {
  const scene = await sceneFixture(o.id);
  const takeId = scene.meta.id;
  const library = createLibrary(home);
  const store = library.frameStore(takeId);
  const viewport = { width: 1280, height: 800 };
  const keyframes = await Promise.all(
    (o.keyframes === undefined
      ? [0, 400, 3200]
      : Array.from({ length: o.keyframes }, (_, i) => i * 400)
    ).map(async (sourceTimeMs, i) => {
      const bytes = (o.bytesOf ?? keyframeBytes)(i);
      return {
        sourceTimeMs,
        ref: await store.putKeyframe(takeId, i, bytes),
        width: viewport.width,
        height: viewport.height,
        actionId: null,
        byteLength: bytes.byteLength,
      };
    }),
  );
  const motionSpans: Bundle["motionSpans"] = [];
  if (o.span === true) {
    const ref = `span:${takeId}:0`;
    await store.putSpan(ref, new Uint8Array([1, 2, 3]));
    motionSpans.push({
      startMs: 0,
      endMs: 400,
      ref,
      width: viewport.width,
      height: viewport.height,
      fps: 30,
      byteLength: 3,
    });
  }
  const bundle: Bundle = {
    bundleVersion: 1,
    sceneId: takeId,
    source: "replay",
    dpr: 1,
    viewport,
    keyframes,
    motionSpans,
    cursorSamples: [{ sourceTimeMs: 0, x: 10, y: 10 }],
    cursorGaps: [],
    anchorRects: [],
    markers: [],
    degradations: [],
    madeFrom: scene.actions.map((action) => ({
      actionId: action.id,
      kind: action.kind,
      anchorId: action.anchorId ?? null,
      text: action.kind === "type" ? action.text : null,
      cut: false,
    })),
  };
  await store.putBundle(takeId, bundle);
  if (o.status !== undefined) {
    await library.putJson(takeId, "status.json", o.status);
  }
  await library.putScene(scene);
  return { takeId, scene, bundle };
}

/** One `outputs.json` row for `path`, through the library's own append. */
export async function seedOutput(
  home: string,
  takeId: string,
  path: string,
): Promise<void> {
  const row: OutputRecord = {
    path,
    fileType: "mp4",
    aspect: "16:9",
    byteLength: 1,
    renderedAt: "2026-10-16T00:00:00.000Z",
    sceneDigest: "digest",
    report: { outcome: "saved" } as unknown as OutputRecord["report"],
  };
  await createLibrary(home).appendOutput(takeId, row);
}
