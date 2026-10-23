import type {
  DetailViolation,
  FrameBundle,
  FrameImage,
  UnavailableSpan,
  UnplacedStill,
} from "@demoman/compositor";
import type { ReplayStatus } from "../core/replay/status";
import type { CaptureStatus } from "../core/storage/types";

/**
 * Injected rather than called, so a command's output is byte-comparable
 * across runs. Production passes `crypto.randomUUID`.
 */
export type IdSource = () => string;

/**
 * SP5's two commands, behind one interface. `active` applies SP5's own rule
 * about which bundle wins — a complete replay bundle supersedes a capture
 * bundle, a partial one is kept but never auto-selected — so the editor
 * neither picks a bundle nor re-derives that rule.
 */
export interface BundleSource {
  /**
   * The bundle AND what the producer reported about the run that made it.
   *
   * `replay: null` means no result is stored — replay never ran. That is a
   * different state from a run that returned no bundle, which can happen
   * both when a run failed early and when a run legitimately completed with
   * nothing to harvest.
   *
   * `capture: null` means either no take's motion recording has anything to
   * report, or nothing is known — the same "nothing to say" `replay` uses,
   * for the same reason: a status field only a healthy take ever fills in
   * would be indistinguishable from one nobody wired up.
   */
  active(sceneId: string): Promise<{
    bundle: FrameBundle | null;
    replay: ReplayStatus | null;
    capture: CaptureStatus | null;
  }>;
  /**
   * What that ref actually is: a decoded image for a `kf:` keyframe, raw
   * container bytes for a `span:` motion span, which the compositor demuxes
   * itself. This is the union `createVideoFrameSource` takes, and both frame
   * sources reject the kind they cannot use.
   */
  load(ref: string): Promise<Uint8Array | FrameImage>;
  // `regenerate` left on 2026-09-28 (plan 2 of the agent door, Task 7): the
  // editor runs no replay of its own any more. A re-shoot runs on the run
  // page, through `src/run/develop.ts` directly.
}

export interface StoredOutput {
  ref: string;
  name: string;
  byteLength: number;
  contentType: string;
  detailViolations: DetailViolation[];
  /** See `RenderedFile.unavailableSpans`. */
  unavailableSpans?: UnavailableSpan[];
  /** Why the logo is missing from this file, when it is. Optional: rows
   *  stored before this field existed carry none. */
  logoWarning?: string;
  /** Steps this take carries a marker for that got NO still, each with its
   *  reason. A stills export is the only thing that sets it.
   *
   *  It has to reach the ROW, not a console: the offscreen document that
   *  computes it is closed in a `finally` the moment its last job settles
   *  (`offscreen-host.ts`), so anything logged there is gone from
   *  chrome://extensions' Inspect views before an author can open it —
   *  measured 2026-09-23, when exactly that was tried and there was no
   *  `offscreen.html` left to inspect. Optional: rows stored before this
   *  field existed carry none. */
  unplacedStills?: UnplacedStill[];
  /** `sceneDigest` of the scene this was rendered from. Optional: rows
   *  stored before this field existed carry none, and the panel then makes
   *  no claim about them either way. */
  sceneDigest?: string;
  renderedAt: string;
}

/** The editor's own persistence: rendered outputs, branding assets, and the
 *  legacy stale-flag rows `clearFlags` still reaps on delete. */
export interface EditorStore {
  putOutput(
    sceneId: string,
    output: StoredOutput,
    bytes: Uint8Array,
  ): Promise<void>;
  listOutputs(sceneId: string): Promise<StoredOutput[]>;
  /** The row for one output, by its own ref — not filtered by scene. Needed
   *  wherever only the ref is known, such as reading back the content type
   *  for an upload. */
  readOutput(ref: string): Promise<StoredOutput | null>;
  readOutputBytes(ref: string): Promise<Uint8Array | null>;
  putAsset(ref: string, bytes: Uint8Array, contentType: string): Promise<void>;
  readAsset(
    ref: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Every output row for the scene and its bytes, in one transaction.
   *  Returns rows removed. */
  deleteOutputs(sceneId: string): Promise<number>;
  /** One output row and its bytes. Returns the row's byteLength, 0 when
   *  there was no row — a reclaim that removed nothing must not count. */
  deleteOutput(ref: string): Promise<number>;
  listAllOutputs(): Promise<Array<StoredOutput & { sceneId: string }>>;
  assetsByteLength(): Promise<number>;
  /** Both stale-flag rows for the scene — `<sceneId>:capture` and
   *  `<sceneId>:replay` — gone. Nothing writes them since 2026-09-24
   *  (`approximations` replaced the flag with a comparison), so this now
   *  reaps rows written by earlier versions and nothing else. Kept rather
   *  than deleted: `delete.ts` counts what each step removed, and a legacy
   *  row silently left behind on every delete is a store that never empties.
   *  Returns how many were actually there. */
  clearFlags(sceneId: string): Promise<number>;
}
