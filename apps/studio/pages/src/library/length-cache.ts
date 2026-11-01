// apps/studio/pages/src/library/length-cache.ts
import { sceneDigest } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { type EditedLength, formatLength } from "./length";

export interface LengthCache {
  /** The settled result for this scene as it is now, if measured. */
  get(scene: SceneDocument): EditedLength | undefined;
  /** Measures once per scene digest; concurrent calls share one promise. */
  measure(
    scene: SceneDocument,
    run: () => Promise<EditedLength>,
  ): Promise<EditedLength>;
}

/**
 * Keyed by the scene's digest, which any edit changes and a rename does
 * not: a length is kept until the video is edited (list spec §2.1). A run
 * that throws is not kept — the caller says it, and the next paint after
 * a redraw measures again, so a one-off failure does not stick.
 */
export function createLengthCache(): LengthCache {
  const settled = new Map<string, EditedLength>();
  const inflight = new Map<string, Promise<EditedLength>>();
  // A listing replaces every document, so an edit still meets a new object.
  const digests = new WeakMap<SceneDocument, string>();
  const keyOf = (s: SceneDocument): string => {
    let digest = digests.get(s);
    if (digest === undefined) {
      digest = sceneDigest(s);
      digests.set(s, digest);
    }
    return `${s.meta.id}:${digest}`;
  };
  return {
    get: (scene) => settled.get(keyOf(scene)),
    measure(scene, run) {
      const key = keyOf(scene);
      const known = settled.get(key);
      if (known !== undefined) return Promise.resolve(known);
      let p = inflight.get(key);
      if (p === undefined) {
        p = run().then(
          (got) => {
            settled.set(key, got);
            inflight.delete(key);
            return got;
          },
          (err: unknown) => {
            inflight.delete(key);
            throw err;
          },
        );
        inflight.set(key, p);
      }
      return p;
    },
  };
}

/** `—` is an unknown or absent length, never `0:00`; undefined leaves the
 *  cell as it is. */
export function paintLength(
  cell: HTMLElement,
  got: EditedLength | Error | undefined,
): void {
  if (got === undefined) return;
  if (got instanceof Error) {
    cell.textContent = "—";
    cell.title = got.message;
  } else if (got.kind === "nothing") {
    cell.textContent = "—";
    cell.title = got.reason;
  } else {
    cell.textContent = formatLength(got.ms);
    cell.removeAttribute("title");
  }
}
