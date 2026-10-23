import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathFor, type StudioEvent } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHub } from "../../src/events.js";
import { ABSENT_REVISION } from "../../src/kits.js";
import {
  type HomeFeeds,
  isTakesChange,
  type WatchFn,
  watchHome,
} from "../../src/watch.js";
import { type Harness, startStudio } from "./harness.js";
import { seedTake } from "./seed.js";

// Two kinds of case. Every exact count — "one event", "nothing" — runs on an
// injected watch the test drives with chosen filenames, and is judged after
// the feed says its settle's work has finished (`onSettled`), or, where
// nothing should settle at all, by the settle timers it armed. Neither is a
// race with the file system, so neither can flake under load. Only the
// smoke cases at the end use the real `fs.watch`, and they assert facts that
// only grow ("at least one event since"), which a slow machine delays but
// cannot falsify.

/** The feeds' settle, kept short: the injected cases wait for `onSettled`,
 *  never for a duration. */
const SETTLE = 10;
/** How long a real watch may take to report a take that landed. Measured
 *  here (2026-10-17, M-series Mac, FSEvents, settle 250 ms): 277-335 ms
 *  from the write to the event over ten runs, six of them with the
 *  compositor's suite running beside the lane. CI is about 5x slower and
 *  Ubuntu's inotify is a different backend; 25 s is room for both. */
const SMOKE_MS = 25_000;

const count = (sent: readonly StudioEvent[], type: StudioEvent["type"]) =>
  sent.filter((e) => e.type === type).length;

let home: string;
let h: Harness | null = null;
let feeds: HomeFeeds | null = null;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-watch-"));
});
afterEach(async () => {
  vi.useRealTimers();
  feeds?.close();
  feeds = null;
  await h?.close();
  h = null;
  await rm(home, { recursive: true, force: true });
});

/** A WatchFn the test drives: `fire(path, ...names)` is fs.watch reporting
 *  a change to each name under the watched `path`. */
function drivenWatch() {
  const listeners = new Map<
    string,
    (event: string, filename: string | null) => void
  >();
  const watch: WatchFn = (path, _options, listener) => {
    listeners.set(path, listener);
    return { on: () => {}, close: () => {} };
  };
  return {
    watch,
    fire(path: string, ...names: (string | null)[]) {
      const listener = listeners.get(path);
      if (listener === undefined) {
        throw new Error(
          `no watch on ${path}; watched: ${[...listeners.keys()].join(", ")}`,
        );
      }
      for (const name of names) listener("rename", name);
    },
  };
}

/** Counts each feed's finished settles; `settled(feed, n)` resolves at the
 *  n-th, and fails naming what settled and what was sent if it never comes. */
function settles(sent: () => readonly StudioEvent[]) {
  const done: ("takes" | "kits")[] = [];
  const waiters = new Set<() => void>();
  return {
    onSettled: (feed: "takes" | "kits") => {
      done.push(feed);
      for (const w of waiters) w();
    },
    settled: (feed: "takes" | "kits", n: number) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (done.filter((f) => f === feed).length < n) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `${feed} never settled ${n} times; settled: [${done.join(", ")}], sent: ${JSON.stringify(sent())}`,
            ),
          );
        }, 5_000);
        waiters.add(check);
        check();
      }),
  };
}

/** The feeds alone, on a driven watch and a hub that only records. */
async function drivenFeeds() {
  const sent: StudioEvent[] = [];
  const logs: string[] = [];
  const events: EventHub = {
    send: (e) => sent.push(e),
    handler: async () => ({ status: 200, json: {} }),
    size: () => 0,
    close: () => {},
  };
  const driven = drivenWatch();
  const s = settles(() => sent);
  feeds = await watchHome({
    home,
    events,
    log: (line) => logs.push(line),
    watch: driven.watch,
    settleMs: SETTLE,
    onSettled: s.onSettled,
  });
  return {
    sent,
    logs,
    fire: driven.fire,
    settled: s.settled,
    takes: join(home, "takes"),
  };
}

describe("isTakesChange", () => {
  it.each([
    ["t1", true],
    [".trash-1", true],
    ["t1/scene.json", true],
    ["t1/scene.json.tmp-1", true],
    ["t1/thumbs/x.jpg", false],
    ["t1/frames/kf.jpg", false],
    ["t1/outputs.json", false],
    ["t1/.busy/lock", false],
    [null, true],
  ])("%s -> %s", (name, expected) => {
    expect(isTakesChange(name)).toBe(expected);
  });
});

describe("the takes feed", () => {
  it("a take's burst of writes sends one takes event", async () => {
    const f = await drivenFeeds();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.fire(
      f.takes,
      "t1",
      "t1/frames/k0.jpg",
      "t1/scene.json.tmp-1",
      "t1/scene.json",
    );
    // Red: arm a fresh timer per change without clearing the last one in
    // start()'s listener — three timers, three events.
    expect(vi.getTimerCount(), "one settle armed for the burst").toBe(1);
    vi.advanceTimersByTime(SETTLE);
    expect(f.sent).toEqual([{ type: "takes" }]);
  });

  it("writes under thumbs/, frames/, .busy/ and outputs.json arm nothing and send nothing", async () => {
    const f = await drivenFeeds();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.fire(
      f.takes,
      "t1/thumbs/x.jpg",
      "t1/frames/extra.jpg",
      "t1/.busy/lock",
      "t1/outputs.json",
    );
    // Red: isTakesChange = () => true — a settle is armed and a takes
    // event follows.
    expect(vi.getTimerCount(), "a settle was armed").toBe(0);
    vi.advanceTimersByTime(SETTLE * 10);
    expect(f.sent).toEqual([]);
    // The positive control: the same feed, live, arms for a scene.json.
    f.fire(f.takes, "t1/scene.json");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(SETTLE);
    expect(f.sent).toEqual([{ type: "takes" }]);
  });

  it("a run's frames, then its scene.json, are two events: the second is the one the page needs", async () => {
    // Review Focus 2: the runner writes frames first and scene.json last;
    // a page that read on the folder's event alone would not list the take.
    const f = await drivenFeeds();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.fire(f.takes, "t1", "t1/frames", "t1/frames/k0.jpg");
    vi.advanceTimersByTime(SETTLE);
    expect(count(f.sent, "takes")).toBe(1);
    f.fire(f.takes, "t1/frames/k1.jpg", "t1/bundle.json");
    expect(vi.getTimerCount(), "frames and the bundle arm nothing").toBe(0);
    f.fire(f.takes, "t1/scene.json");
    vi.advanceTimersByTime(SETTLE);
    expect(count(f.sent, "takes")).toBe(2);
  });
});

describe("the kits feed", () => {
  it("a kits.json whose bytes change sends kits; the same bytes again sends nothing", async () => {
    const f = await drivenFeeds();
    const body = '{"kits":[],"default":null}';
    await writeFile(join(home, "kits.json"), body);
    f.fire(home, "kits.json");
    await f.settled("kits", 1);
    expect(f.sent).toEqual([{ type: "kits" }]);

    await writeFile(join(home, "kits.json"), body);
    f.fire(home, "kits.json");
    await f.settled("kits", 2);
    // Red: drop kitsMoved's `now === announced` return — the same bytes
    // send a second kits event.
    expect(f.sent, "after the settle that read the same bytes").toEqual([
      { type: "kits" },
    ]);
  });

  it("a reset's .bak- copy and the home's other files arm nothing", async () => {
    const f = await drivenFeeds();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.fire(home, "kits.json.bak-1", "settings.json", "studio.json", "takes");
    // Red: isKitsName = () => true — a settle is armed for them.
    expect(vi.getTimerCount(), "a settle was armed").toBe(0);
    // The positive control: the atomic write's temp file is kits.json's.
    f.fire(home, "kits.json.123.tmp");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a hand edit sends kits; the studio's own PUT sends exactly one", async () => {
    const driven = drivenWatch();
    const s = settles(() => h?.sent ?? []);
    h = await startStudio(home, {
      watch: driven.watch,
      onSettled: s.onSettled,
    });
    await writeFile(join(home, "kits.json"), '{"kits":[],"default":null}');
    driven.fire(home, "kits.json");
    await s.settled("kits", 1);
    expect(count(h.sent, "kits")).toBe(1);

    const read = (await h.call(pathFor("kitsGet"))).json() as {
      revision: string;
    };
    const put = await h.call(pathFor("kitsPut"), {
      method: "PUT",
      headers: { "If-Match": read.revision },
      body: JSON.stringify({
        kits: [{ id: "k1", name: "Acme", branding: {} }],
        default: "k1",
      }),
    });
    expect(put.status, put.text).toBe(200);
    // The route announced its own write before it answered.
    expect(count(h.sent, "kits")).toBe(2);
    // And the file system reports that write too, after the answer.
    driven.fire(home, "kits.json");
    await s.settled("kits", 2);
    // Red: keep a direct events.send({ type: "kits" }) in kitsPut beside
    // the feed's announcement — three; or drop the feed's same-sha check —
    // the reported write is a third.
    expect(count(h.sent, "kits"), JSON.stringify(h.sent)).toBe(2);
  });

  it("an answer carries no unwatched sentence while the watch runs", async () => {
    h = await startStudio(home, { settleMs: SETTLE });
    const r = (await h.call(pathFor("kitsGet"))).json() as {
      unwatched: string | null;
      revision: string;
    };
    expect(r.unwatched).toBeNull();
    expect(r.revision).toBe(ABSENT_REVISION);
  });
});

describe("a watch that fails", () => {
  it("at start: GET takes and GET kits name it, and the log says it", async () => {
    // Red: catch the throw and drop it.
    const watch: WatchFn = () => {
      throw new Error("EMFILE: too many open files");
    };
    h = await startStudio(home, { watch });
    const takes = (await h.call(pathFor("takes"))).json() as {
      unwatched: string | null;
    };
    const kits = (await h.call(pathFor("kitsGet"))).json() as {
      unwatched: string | null;
    };
    expect(takes.unwatched).toContain("EMFILE");
    expect(takes.unwatched).toContain(join(home, "takes"));
    expect(kits.unwatched).toContain("EMFILE");
    expect(
      h.logs.filter((l) => l.includes("EMFILE")).length,
      h.logs.join("\n"),
    ).toBe(2);
  });

  it("later: watchFailed is sent and the next GET says so", async () => {
    const errorListeners: ((e: Error) => void)[] = [];
    let closed = 0;
    const watch: WatchFn = () => ({
      on: (_event, fn) => {
        errorListeners.push(fn);
      },
      close: () => {
        closed += 1;
      },
    });
    h = await startStudio(home, { watch });
    expect(errorListeners.length, "one listener per feed").toBe(2);
    const before = (await h.call(pathFor("takes"))).json() as {
      unwatched: string | null;
    };
    expect(before.unwatched).toBeNull();
    const events = await h.stream();
    try {
      (errorListeners[0] as (e: Error) => void)(new Error("EIO: gone"));
      const text = await events.waitFor((t) => t.includes("watchFailed"));
      expect(text).toContain('"feed":"takes"');
      expect(text).toContain("EIO: gone");
      expect(closed).toBe(1);
      const after = (await h.call(pathFor("takes"))).json() as {
        unwatched: string | null;
      };
      expect(after.unwatched).toContain("EIO: gone");
      const kits = (await h.call(pathFor("kitsGet"))).json() as {
        unwatched: string | null;
      };
      expect(kits.unwatched, "the other feed still runs").toBeNull();
    } finally {
      events.close();
    }
  });
});

/** Takes events in the stream's text after `from` characters. */
const takesAfter = (text: string, from: number) =>
  text.slice(from).split("event: takes\n").length - 1;

describe("the real fs.watch (smoke: facts that only grow)", () => {
  it(
    "a take that lands sends at least one takes event",
    async () => {
      h = await startStudio(home, { settleMs: 250 });
      const events = await h.stream();
      try {
        const from = events.text().length;
        const started = Date.now();
        await seedTake(home, { id: "t1" });
        await events.waitFor((t) => takesAfter(t, from) >= 1, SMOKE_MS);
        console.info(
          `watch smoke: a landed take's event in ${Date.now() - started} ms`,
        );
      } finally {
        events.close();
      }
    },
    SMOKE_MS * 2,
  );

  it(
    "a folder that already sent one sends another when scene.json lands, and another when it is deleted",
    async () => {
      h = await startStudio(home, { settleMs: 250 });
      const events = await h.stream();
      try {
        // The runner's order: the folder and its frames first.
        const frames = join(home, "takes", "t1", "frames");
        await mkdir(frames, { recursive: true });
        await writeFile(join(frames, "k0.jpg"), "pixels");
        await events.waitFor((t) => takesAfter(t, 0) >= 1, SMOKE_MS);

        // Then the rest of the take, scene.json last.
        const landing = events.text().length;
        await seedTake(home, { id: "t1" });
        await events.waitFor((t) => takesAfter(t, landing) >= 1, SMOKE_MS);
        const listed = (await h.call(pathFor("takes"))).json() as {
          scenes: { meta: { id: string } }[];
        };
        expect(listed.scenes.map((s) => s.meta.id)).toEqual(["t1"]);

        const deleting = events.text().length;
        const r = await h.call(pathFor("takeDelete", { id: "t1" }), {
          method: "DELETE",
        });
        expect(r.status, r.text).toBe(200);
        await events.waitFor((t) => takesAfter(t, deleting) >= 1, SMOKE_MS);
      } finally {
        events.close();
      }
    },
    SMOKE_MS * 4,
  );
});
