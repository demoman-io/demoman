import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type { EventHub } from "./events.js";
import { messageOf, readIfPresent, sha256 } from "./files.js";
import { ABSENT_REVISION } from "./kits.js";

/** How long a feed waits after its last change before it sends: a take that
 *  lands is a burst of writes, and the page should re-read once. */
export const WATCH_SETTLE_MS = 250;

/** fs.watch's shape, injectable. */
export type WatchFn = (
  path: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => { on(event: "error", fn: (e: Error) => void): void; close(): void };

export interface HomeFeeds {
  /** Why each feed is down, or null while it runs. */
  unwatched(): { takes: string | null; kits: string | null };
  /** After the studio's own kits write: announce now if the file's revision moved. */
  kitsWritten(): Promise<void>;
  close(): void;
}

/**
 * Whether a change under `takes/` (the path relative to it) can change the
 * listing: a top-level entry (a take folder made, renamed or removed) or
 * `<id>/scene.json*` (the scene, or its temp file mid-rename). Thumbnails,
 * frames, `outputs.json` and `.busy/` change often and never the listing.
 * A change that cannot be placed counts, because missing one is a stale page.
 */
export function isTakesChange(filename: string | null): boolean {
  if (filename === null) return true;
  const segments = filename.split(/[\\/]/).filter((s) => s !== "");
  if (segments.length <= 1) return true;
  return (segments[1] as string).startsWith("scene.json");
}

/** `kits.json` itself and its temp files; a reset's `.bak-` copy is not it. */
const isKitsName = (filename: string | null): boolean =>
  filename === null ||
  (filename.startsWith("kits.json") && !filename.includes(".bak-"));

// On Linux, Node 24 swallows a recursive watch's start errors other than
// ENOENT, so `unwatched` can stay null there for a feed that hears nothing;
// the launch is macOS, where they throw and are reported.
const nodeWatch: WatchFn = (path, options, listener) =>
  fsWatch(path, { recursive: options.recursive }, (event, filename) =>
    listener(event, filename === null ? null : String(filename)),
  );

/**
 * Two watches on the home, so a library page hears a take land or a kit
 * change without polling. A watch that cannot start, or dies later, is not
 * a crash: the feed's sentence goes to the GET answers (a page opened after
 * the failure never hears the event), the log, and `watchFailed`.
 */
export async function watchHome(o: {
  home: string;
  events: EventHub;
  log: (line: string) => void;
  watch?: WatchFn;
  settleMs?: number;
  /** Test-only: called once a settle's work has finished, whether it sent
   *  an event or found nothing to send (the kits feed's same-bytes check),
   *  so a test can say "nothing was sent" after the work provably ran. */
  onSettled?: (feed: "takes" | "kits") => void;
}): Promise<HomeFeeds> {
  const watch = o.watch ?? nodeWatch;
  const settleMs = o.settleMs ?? WATCH_SETTLE_MS;
  const sentences: { takes: string | null; kits: string | null } = {
    takes: null,
    kits: null,
  };
  const closers: (() => void)[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;

  const kitsPath = join(o.home, "kits.json");
  /** `undefined` when the file would not read, so no later read equals it. */
  const revisionNow = async (): Promise<string | undefined> => {
    try {
      const bytes = await readIfPresent(kitsPath);
      return bytes === null ? ABSENT_REVISION : sha256(bytes);
    } catch (error) {
      o.log(`studio: ${kitsPath} could not be read (${messageOf(error)})`);
      return undefined;
    }
  };
  let announced = await revisionNow();

  const kitsMoved = async (): Promise<void> => {
    if (closed) return;
    const now = await revisionNow();
    if (closed) return;
    if (now !== undefined && now === announced) return;
    announced = now;
    o.events.send({ type: "kits" });
  };

  function start(
    feed: "takes" | "kits",
    path: string,
    recursive: boolean,
    relevant: (filename: string | null) => boolean,
    settled: () => void,
  ): void {
    let timer: NodeJS.Timeout | null = null;
    let watcher: ReturnType<WatchFn> | null = null;
    const fail = (error: unknown): void => {
      const sentence = `${path} could not be watched (${messageOf(error)})`;
      sentences[feed] = sentence;
      o.log(`studio: ${sentence}`);
      o.events.send({ type: "watchFailed", feed, detail: sentence });
      if (timer !== null) {
        clearTimeout(timer);
        timers.delete(timer);
      }
      try {
        watcher?.close();
      } catch (closeError) {
        o.log(
          `studio: the ${feed} watcher would not close (${messageOf(closeError)})`,
        );
      }
    };
    try {
      watcher = watch(path, { recursive }, (_event, filename) => {
        if (closed || !relevant(filename)) return;
        if (timer !== null) {
          clearTimeout(timer);
          timers.delete(timer);
        }
        timer = setTimeout(() => {
          if (timer !== null) timers.delete(timer);
          timer = null;
          settled();
        }, settleMs);
        timers.add(timer);
      });
      watcher.on("error", fail);
    } catch (error) {
      fail(error);
      return;
    }
    const opened = watcher;
    closers.push(() => {
      try {
        opened.close();
      } catch (error) {
        o.log(
          `studio: the ${feed} watcher would not close (${messageOf(error)})`,
        );
      }
    });
  }

  start("takes", join(o.home, "takes"), true, isTakesChange, () => {
    o.events.send({ type: "takes" });
    o.onSettled?.("takes");
  });
  // The folder, not the file: an atomic write renames a new file over
  // `kits.json`, and a watch on the old one would hear nothing after it.
  start("kits", o.home, false, isKitsName, () => {
    void kitsMoved().then(() => o.onSettled?.("kits"));
  });

  return {
    unwatched: () => ({ ...sentences }),
    kitsWritten: kitsMoved,
    close() {
      closed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const c of closers) c();
      closers.length = 0;
    },
  };
}
