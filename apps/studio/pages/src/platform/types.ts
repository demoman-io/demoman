// apps/studio/pages/src/platform/types.ts
import type { LogoLoad } from "@demoman/run-core/render";
import type { SceneAspect, SceneDocument } from "@demoman/scene-schema";
import type {
  ExportQualityChoice,
  PullRequestsChoice,
  TakesAnswer,
} from "@demoman/studio-protocol";
import type { BrandKitStore } from "../adapters/brand-kit-store";
import type { DeleteResult } from "../core/storage/types";
import type { SaveView } from "../editor/export-run";
import type { FileType } from "../editor/jobs";
import type { BundleSource, StoredOutput } from "../editor/ports";

/**
 * Everything outside the page that the pages reach: the studio's stores,
 * its exports and the other pages' URLs (spec 2026-10-15 §5). A page
 * imports it from `#platform` (`http.ts`, the studio's loopback API) and
 * from nowhere else, so a page test can stand a memory platform in its
 * place.
 */
export interface Platform {
  scenes: {
    /** Null when no such take is stored. Rejects with the store's reason
     *  when the read itself failed. The chrome side has no revisions, so
     *  `revision` is always null there. */
    get(id: string): Promise<{
      scene: SceneDocument;
      revision: string | null;
      /** What reading the take took away from it (`migrateToCurrent`'s
       *  notes), said once in the take's notes. */
      notes: string[];
    } | null>;
    /** Rejects with the store's sentence when the write was refused. */
    put(
      doc: SceneDocument,
      revision: string | null,
    ): Promise<{ revision: string | null }>;
    list(): Promise<SceneDocument[]>;
    /** Rejects only when the request itself could not be made; a refusal
     *  resolves `{ ok: false }` with its reason. */
    remove(id: string): Promise<RemoveReply>;
  };
  bundles: BundleSource;
  outputs: { list(takeId: string): Promise<OutputRow[]> };
  logos: {
    put(file: File): Promise<{ ref: string }>;
    load(ref: string): Promise<LogoLoad>;
  };
  /** Uploaded wallpapers. `put` resizes in the page first
   *  (`fitWallpaperImage`) and rejects with its sentence, or the studio's,
   *  naming the file. `load` is the stored bytes, decoded by the caller at
   *  its own size (`decodeWallpaper`), or why they could not be had. */
  wallpapers: {
    put(file: File): Promise<{ ref: string }>;
    load(
      ref: string,
    ): Promise<{ ok: true; blob: Blob } | { ok: false; error: string }>;
  };
  /** `onChange` calls back when another window writes the kits. `reset`
   *  answers where the list it replaced was kept (`backup`), null when
   *  nothing was kept. `unwatched` is why `onChange` will not fire, or null
   *  while it does. */
  kits: Omit<BrandKitStore, "reset"> & {
    reset(): Promise<{ backup: string | null }>;
    onChange(fn: () => void): () => void;
    unwatched(): string | null;
  };
  /**
   * The user's default for attaching a take's video to a pull request.
   * Shows the USER's value only (a repo's file is the
   * repo's, and is not edited here). `value` null is "not set"; with
   * `unreadable` it is "could not be read", and the page then checks
   * nothing.
   */
  pullRequests: {
    read(): Promise<{ value: PullRequestsChoice | null; unreadable?: string }>;
    /** `replaced` is the studio's sentence when the write replaced a file
     *  that was not a JSON object (its other settings are gone). */
    write(value: PullRequestsChoice): Promise<{ replaced?: string }>;
  };
  /**
   * How the studio sizes an MP4: Sharing, High (the default) or Full. With
   * `unreadable` the quality is `high` (what the studio will export at) and
   * the page says why; it checks nothing.
   */
  exportQuality: {
    read(): Promise<{ quality: ExportQualityChoice; unreadable?: string }>;
    /** `replaced` as for `pullRequests.write`. */
    write(quality: ExportQualityChoice): Promise<{ replaced?: string }>;
  };
  exports: {
    /**
     * Starts an export of `takeId`; resolves once it is queued, rejects with
     * the reason it was not. The job's events arrive through `onEvent` and
     * may arrive before this resolves.
     *
     * `aspect` is the one the Export button showed when it was pressed. The
     * extension's renderer needs it on the job (`RenderJob.aspect`); the
     * studio does not send it, because its `revision` pins the scene and the
     * scene pins `canvas.aspect`. `revision` is the reverse: the studio's
     * guard against rendering a scene the page has not saved, which the
     * chrome side has no counterpart for.
     */
    start(
      takeId: string,
      job: {
        fileType: FileType;
        aspect: SceneAspect;
        revision: string | null;
        /** An MP4's quality for this export; absent, the setting's. */
        quality?: ExportQualityChoice;
      },
    ): Promise<{ jobId: string }>;
    /**
     * Every job event is for a job THIS page started — another tab's or
     * window's job never moves this page's button or writes under its
     * outputs. `outputsChanged` is the exception: it is said for any job,
     * because the list it asks the page to re-read is what is stored for the
     * take, whoever made it. Returns a stop.
     */
    onEvent(fn: (e: ExportEvent) => void): () => void;
  };
  files: { reveal(target: RevealTarget): Promise<void> };
  nav: {
    /** Hrefs. `kits` is the Settings page. */
    editor(id: string): string;
    library(): string;
    kits(): string;
    /** The empty library's hint: it names where Record is on this side. */
    firstTakeHint(): string;
    /** The route to film this take again: a link on the extension (Runs),
     *  a line naming the agent call on the studio. */
    rerun(
      id: string,
      authored: boolean,
    ):
      | { kind: "link"; href: string; label: string }
      | { kind: "line"; text: string };
    /** The server asked this window to go elsewhere. */
    onOpen(fn: (path: string) => void): void;
  };
  /** The studio's take folder: the takes, their sizes, the folders that
   *  would not read, and whether the folder is watched. */
  folder: FolderMember;
  /** The studio's videos: a take is a version of one (`FolderListing`). */
  videos: {
    /** Rejects with the studio's sentence when the rename was refused. */
    rename(id: string, name: string): Promise<void>;
    /** Every version and the record. Rejects only when the request itself
     *  could not be made; a refusal resolves `{ ok: false }`. */
    remove(id: string): Promise<RemoveReply>;
  };
  /** Saving stored outputs through the browser's downloads: the extension's
   *  "Download again". The studio has none (its server saves the file).
   *  shortcut: kept with the editor's stored-output rows, which only the
   *  extension produced; remove the member, `OutputRow`'s `stored` kind and
   *  the save outcomes only it produces together. */
  downloads?: { save(rows: StoredOutput[]): Promise<SaveView> };
}

export interface FolderListing {
  videos: TakesAnswer["videos"];
  videoOf: TakesAnswer["videoOf"];
  scenes: SceneDocument[];
  sizes: Record<string, number>;
  unreadable: TakesAnswer["unreadable"];
  unwatched: string | null;
}

/** The studio's take folder. */
export interface FolderMember {
  read(): Promise<FolderListing>;
  /** A take landed, changed or went, or the feed failed (the next read says why). Returns a stop. */
  onChange(fn: () => void): () => void;
  /** The card's preview frame, made small by the studio. Rejects with the studio's detail. */
  thumb(ref: string): Promise<ImageBitmap>;
}

export type RemoveReply =
  /** `partly`: a video's delete stopped part-way, and this says what was
   *  left. */
  | { ok: true; result?: DeleteResult; note?: string; partly?: string }
  | { ok: false; error: string; detail?: string };

export type RevealTarget =
  | { kind: "download"; id: number }
  | { kind: "path"; path: string };

export type OutputRow =
  | { kind: "stored"; output: StoredOutput }
  | {
      kind: "file";
      key: string;
      name: string;
      byteLength: number;
      path: string;
      exists: boolean;
      sceneDigest: string;
      /** ISO: when it was made. */
      renderedAt: string;
      /** The frame and rate, "1920×1318 · 30 fps" (stills: the frame
       *  alone); null for a record that is not a saved export. */
      detail: string | null;
      /** What its summary said "but" about (`exportCaveats`), one clause
       *  each; empty when nothing was. The row's warnings chip unfolds them. */
      caveats: string[];
    };

export type ExportEvent =
  | { kind: "queued"; jobId: string; position: number }
  | { kind: "rendering"; jobId: string; done: number; total: number }
  /** One output failed and the job goes on (the extension's per-output
   *  failure). `line` is the sentence to show. */
  | { kind: "fileFailed"; jobId: string; line: string }
  | { kind: "saving"; jobId: string }
  | { kind: "saved"; jobId: string; save: SaveView; summary: string | null }
  /** The job ended with nothing saved. `detail` is why; null when a
   *  `fileFailed` has already said it. */
  | { kind: "failed"; jobId: string; detail: string | null }
  | { kind: "outputsChanged" };
