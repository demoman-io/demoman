import type {
  EditorStore,
  StoredOutput,
} from "../../../pages/src/editor/ports";

/**
 * The EditorStore contract with no IndexedDB behind it.
 *
 * `flags`, when given, is the raw FLAGS map underneath `clearFlags` — the
 * same `<sceneId>:<source>` shape the real adapter's object store once held,
 * written only by the deleted `readStale`/`setStale` pair. Nothing in this
 * codebase writes them any more (`approximations` replaced the flag on
 * 2026-09-24), so the only reason a test would seed or read this directly is
 * to prove `clearFlags` still reaps a row a pre-2026-09-24 document left
 * behind — see `storage-delete.test.ts`. Passing a `Map` the caller keeps a
 * reference to is this fake's equivalent of the real adapter's raw
 * IndexedDB access: seed it before, read it back after.
 */
export function createMemoryEditorStore(
  flags: Map<string, boolean> = new Map(),
): EditorStore {
  const outputs = new Map<string, StoredOutput & { sceneId: string }>();
  const bytes = new Map<string, Uint8Array>();
  const assets = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async putOutput(sceneId, output, data) {
      bytes.set(output.ref, data);
      outputs.set(output.ref, { ...output, sceneId });
    },
    async listOutputs(sceneId) {
      return [...outputs.values()]
        .filter((o) => o.sceneId === sceneId)
        .sort((a, b) => b.renderedAt.localeCompare(a.renderedAt))
        .map(({ sceneId: _s, ...o }) => o);
    },
    async readOutput(ref) {
      const row = outputs.get(ref);
      if (row === undefined) return null;
      const { sceneId: _s, ...o } = row;
      return o;
    },
    async readOutputBytes(ref) {
      return bytes.get(ref) ?? null;
    },
    async putAsset(ref, data, contentType) {
      assets.set(ref, { bytes: data, contentType });
    },
    async readAsset(ref) {
      return assets.get(ref) ?? null;
    },
    async deleteOutputs(sceneId) {
      let removed = 0;
      for (const [ref, row] of [...outputs]) {
        if (row.sceneId !== sceneId) continue;
        outputs.delete(ref);
        bytes.delete(ref);
        removed++;
      }
      return removed;
    },
    async deleteOutput(ref) {
      const row = outputs.get(ref);
      if (row === undefined) return 0;
      outputs.delete(ref);
      bytes.delete(ref);
      return row.byteLength;
    },
    async listAllOutputs() {
      return [...outputs.values()];
    },
    async assetsByteLength() {
      return [...assets.values()].reduce((s, a) => s + a.bytes.byteLength, 0);
    },
    async clearFlags(sceneId) {
      let removed = 0;
      for (const source of ["capture", "replay"]) {
        if (flags.delete(`${sceneId}:${source}`)) removed++;
      }
      return removed;
    },
  };
}
