import type { FrameBundle, FrameImage } from "@demoman/compositor";
import type { ReplayStatus } from "@demoman/replay-engine";
import { decodeLogo } from "@demoman/run-core/logo";
import type { SceneDocument } from "@demoman/scene-schema";
import { createBrandKitStore } from "../../../pages/src/adapters/brand-kit-store";
import { refilmLine } from "../../../pages/src/platform/http";
import type {
  ExportEvent,
  FolderListing,
  OutputRow,
  Platform,
} from "../../../pages/src/platform/types";
import { fakeStorageArea } from "./fake-storage-area";

/**
 * The editor's, library's and Settings' outside world held in memory: the
 * members `pages/src/platform/http.ts` fills, answering in its shapes, with
 * every call recorded.
 *
 * The page tests boot the real entry points against it with
 *
 *     vi.mock("#platform", () => ({ createPlatform: () => memory }));
 *
 * Until 2026-10-20 they booted them in apps/extension against a faked
 * `chrome.runtime` and asserted on the extension's message names
 * (`scene:put`, `bundle:active`, `render:start`); the studio has no such
 * messages, so they assert on `calls` (or the helpers below) instead.
 *
 * Typed against `Platform`, so a member added there and not here fails
 * typecheck rather than a page test reading `undefined`.
 */

export interface PlatformCall {
  member: string;
  method: string;
  args: unknown[];
}

export interface MemorySeed {
  scenes?: SceneDocument[];
  /** The active bundle per take id; a take not named answers no bundle. */
  bundles?: Record<string, FrameBundle | null>;
  /** Frame bytes by ref, for `bundles.load`. */
  frames?: Record<string, Uint8Array | FrameImage>;
  outputs?: Record<string, OutputRow[]>;
  /** The brand kits' storage as the kit store reads it (`brandKits`,
   *  `defaultKitId`), raw. */
  kits?: Record<string, unknown>;
}

type Impl = (...args: never[]) => unknown;

export interface MemoryPlatform extends Platform {
  readonly calls: PlatformCall[];
  /** Replaces one member's behaviour, `"<member>.<method>"`; the call is
   *  still recorded. For the failure paths: a read that rejects, an export
   *  the studio refuses. */
  answer(key: string, fn: Impl): void;
  /** Every scene the page wrote, in order. */
  puts(): SceneDocument[];
  /** Every write, with the revision the page named. */
  putCalls(): { scene: SceneDocument; revision: string | null }[];
  /** Every take id opens what `scene` returns (null: no such take),
   *  whatever the URL names — the editor tests mount one take and do not
   *  set `?scene=`. Called on every read, so a test can change it between
   *  two opens. */
  serveScene(
    scene: () => SceneDocument | null,
    revision?: string,
    notes?: string[],
  ): void;
  /** Every take answers this active bundle. */
  serveBundle(bundle: FrameBundle | null, replay?: ReplayStatus | null): void;
  /** Sends `e` to every export listener the page registered — if it is for
   *  a job this page started, or names no job (`outputsChanged`). */
  emitExport(e: ExportEvent): void;
  /** Rings the folder's change listeners, as the studio's `takes` event. */
  emitTakes(): void;
  /** The kits' storage: what is held (`data`), the next read or write to
   *  refuse (`refuse`), and its recorded `get`/`set` (`area`). */
  readonly kitStorage: ReturnType<typeof fakeStorageArea>;
  /** Rings the kits' change listeners, as the studio's `kits` event (another
   *  window's write). */
  emitKits(): void;
}

export function createMemoryPlatform(seed: MemorySeed = {}): MemoryPlatform {
  const calls: PlatformCall[] = [];
  const answers = new Map<string, Impl>();
  const scenes = new Map<string, { scene: SceneDocument; revision: string }>();
  let revisions = 0;
  const nextRevision = (): string => {
    revisions += 1;
    return `r${revisions}`;
  };
  for (const scene of seed.scenes ?? []) {
    scenes.set(scene.meta.id, { scene, revision: nextRevision() });
  }
  const exportListeners = new Set<(e: ExportEvent) => void>();
  const takesListeners = new Set<() => void>();
  const kitListeners = new Set<() => void>();
  let jobs = 0;
  const logos = new Map<string, File>();
  const ownJobs = new Set<string>();
  let logoCount = 0;

  /** Records the call, then runs the override if the test set one. */
  function member<A extends unknown[], R>(
    name: string,
    method: string,
    fn: (...args: A) => R,
  ): (...args: A) => R {
    return (...args: A): R => {
      calls.push({ member: name, method, args });
      const override = answers.get(`${name}.${method}`);
      return override === undefined
        ? fn(...args)
        : (override as unknown as (...a: A) => R)(...args);
    };
  }

  const kitStorage = fakeStorageArea(seed.kits ?? {});
  // The store's own lock, as `http.ts` gives it: two quick kit changes
  // queue, the second built on the first's write.
  const kitStore = createBrandKitStore(() => kitStorage.area);

  const startExport = member(
    "exports",
    "start",
    async (
      ..._args: Parameters<Platform["exports"]["start"]>
    ): Promise<{ jobId: string }> => {
      jobs += 1;
      return { jobId: `job-${jobs}` };
    },
  );

  const listing = (): FolderListing => ({
    scenes: [...scenes.values()].map((s) => s.scene),
    sizes: {},
    unreadable: [],
    unwatched: null,
  });

  const platform: Platform = {
    scenes: {
      get: member("scenes", "get", async (id: string) => {
        const held = scenes.get(id);
        return held === undefined
          ? null
          : {
              scene: structuredClone(held.scene),
              revision: held.revision,
              notes: [],
            };
      }),
      put: member(
        "scenes",
        "put",
        async (doc: SceneDocument, _revision: string | null) => {
          const revision = nextRevision();
          scenes.set(doc.meta.id, { scene: structuredClone(doc), revision });
          return { revision };
        },
      ),
      list: member("scenes", "list", async () => listing().scenes),
      remove: member("scenes", "remove", async (id: string) => {
        scenes.delete(id);
        return { ok: true as const };
      }),
    },
    folder: {
      read: member("folder", "read", async () => listing()),
      onChange: member("folder", "onChange", (fn: () => void) => {
        takesListeners.add(fn);
        return () => takesListeners.delete(fn);
      }),
      thumb: member("folder", "thumb", async (ref: string) => {
        throw new Error(`no thumbnail for "${ref}" in the memory platform`);
      }),
    },
    bundles: {
      active: member("bundles", "active", async (sceneId: string) => ({
        bundle: seed.bundles?.[sceneId] ?? null,
        replay: null,
        capture: null,
      })),
      load: member("bundles", "load", async (ref: string) => {
        const bytes = seed.frames?.[ref];
        if (bytes === undefined) throw new Error(`no frame at ref ${ref}`);
        return bytes;
      }),
    },
    outputs: {
      list: member(
        "outputs",
        "list",
        async (takeId: string) => seed.outputs?.[takeId] ?? [],
      ),
    },
    logos: {
      put: member("logos", "put", async (file: File) => {
        logoCount += 1;
        const ref = `logo:${logoCount}-${file.name}`;
        logos.set(ref, file);
        return { ref };
      }),
      // What was put reads back, decoded as `http.ts` decodes what the
      // studio serves. A ref never put answers a reason, so "the logo is
      // gone" stays testable.
      load: member("logos", "load", async (ref: string) => {
        const file = logos.get(ref);
        if (file === undefined) {
          return {
            ok: false as const,
            error: `no logo at ${ref} in the memory platform`,
          };
        }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          return {
            ok: true as const,
            source: await decodeLogo(bytes, file.type),
          };
        } catch (error) {
          return {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    },
    kits: {
      read: member("kits", "read", () => kitStore.read()),
      readStored: member("kits", "readStored", () => kitStore.readStored()),
      update: member(
        "kits",
        "update",
        (change: Parameters<typeof kitStore.update>[0]) =>
          kitStore.update(change),
      ),
      // The studio's reset: the list starts empty (it also moves the file
      // aside, which a store in memory has no file for).
      reset: member("kits", "reset", async () => {
        kitStorage.data.brandKits = [];
        delete kitStorage.data.defaultKitId;
        return { backup: null };
      }),
      onChange: member("kits", "onChange", (fn: () => void) => {
        kitListeners.add(fn);
        return () => kitListeners.delete(fn);
      }),
      unwatched: member("kits", "unwatched", () => null),
    },
    pullRequests: {
      read: member("pullRequests", "read", async () => ({ value: null })),
      write: member("pullRequests", "write", async () => ({})),
    },
    exportQuality: {
      read: member("exportQuality", "read", async () => ({
        quality: "share" as const,
      })),
      write: member("exportQuality", "write", async () => ({})),
    },
    exports: {
      // Every job this page started is its own: events for any other (another
      // window's) never reach it, as `http.ts` holds them back
      // (`Platform.exports.onEvent`'s contract).
      start: async (...args) => {
        const started = await startExport(...args);
        ownJobs.add(started.jobId);
        return started;
      },
      onEvent: member("exports", "onEvent", (fn: (e: ExportEvent) => void) => {
        exportListeners.add(fn);
        return () => exportListeners.delete(fn);
      }),
    },
    files: {
      reveal: member("files", "reveal", async () => undefined),
    },
    nav: {
      editor: (id) => `/editor.html?scene=${encodeURIComponent(id)}`,
      library: () => "/",
      kits: () => "/settings.html",
      firstTakeHint: () => "Ask your agent to film a take.",
      // The studio's own line, so a page test reads what an author would.
      rerun: (id) => ({ kind: "line", text: refilmLine(id) }),
      onOpen: () => undefined,
    },
  };

  return Object.assign(platform, {
    calls,
    answer(key: string, fn: Impl) {
      answers.set(key, fn);
    },
    puts: () =>
      calls
        .filter((c) => c.member === "scenes" && c.method === "put")
        .map((c) => c.args[0] as SceneDocument),
    putCalls: () =>
      calls
        .filter((c) => c.member === "scenes" && c.method === "put")
        .map((c) => ({
          scene: c.args[0] as SceneDocument,
          revision: c.args[1] as string | null,
        })),
    serveScene(
      scene: () => SceneDocument | null,
      revision = "r0",
      notes: string[] = [],
    ) {
      answers.set("scenes.get", (async () => {
        const doc = scene();
        return doc === null
          ? null
          : { scene: structuredClone(doc), revision, notes };
      }) as Impl);
    },
    serveBundle(
      bundle: FrameBundle | null,
      replay: ReplayStatus | null = null,
    ) {
      answers.set("bundles.active", (async () => ({
        bundle,
        replay,
        capture: null,
      })) as Impl);
    },
    emitExport(e: ExportEvent) {
      if ("jobId" in e && !ownJobs.has(e.jobId)) return;
      for (const fn of exportListeners) fn(e);
    },
    emitTakes() {
      for (const fn of takesListeners) fn();
    },
    kitStorage,
    emitKits() {
      for (const fn of kitListeners) fn();
    },
  });
}
