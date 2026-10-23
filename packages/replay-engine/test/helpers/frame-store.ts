import type { FrameBundle } from "@demoman/compositor";
import type { EngineStore } from "../../src/index.js";

/**
 * The engine's frame store with nothing behind it but maps: the two
 * `EngineStore` writes the engine makes, `putSpan` for the node frame
 * encoder (`frame-encoder-node.ts`), and the reads the tests check them
 * with.
 *
 * Until 2026-10-20 this implemented the extension's whole `FrameStore`
 * (parked frames, sweeps, budgets, statuses), because the tests that used
 * it lived in `apps/extension`. Those parts were the extension's storage
 * lifecycle and left with it.
 */
export interface MemoryFrameStore extends EngineStore {
  putSpan(sceneId: string, index: number, bytes: Uint8Array): Promise<string>;
  getBundle(
    sceneId: string,
    source: FrameBundle["source"],
  ): Promise<FrameBundle | null>;
  load(ref: string): Promise<Uint8Array>;
  refs(): string[];
}

export function createMemoryFrameStore(): MemoryFrameStore {
  const blobs = new Map<string, Uint8Array>();
  const bundles = new Map<string, FrameBundle>();
  return {
    async putKeyframe(sceneId, index, bytes) {
      const ref = `kf:${sceneId}:${index}`;
      blobs.set(ref, bytes);
      return ref;
    },
    async putSpan(sceneId, index, bytes) {
      const ref = `span:${sceneId}:${index}`;
      blobs.set(ref, bytes);
      return ref;
    },
    async putBundle(sceneId, bundle) {
      bundles.set(`${sceneId}:${bundle.source}`, bundle);
    },
    async getBundle(sceneId, source) {
      return bundles.get(`${sceneId}:${source}`) ?? null;
    },
    async load(ref) {
      const bytes = blobs.get(ref);
      if (bytes === undefined) throw new Error(`no frame at ref ${ref}`);
      return bytes;
    },
    refs: () => [...blobs.keys()],
  };
}
