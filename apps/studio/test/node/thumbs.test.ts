import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrary, type Library } from "@demoman/runner/studio";
import { pathFor } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FRAME_CACHE } from "../../src/routes.js";
import {
  createThumbs,
  type MakeThumb,
  THUMB_CONCURRENCY,
  THUMB_MAX_SIDE,
} from "../../src/thumbs.js";
import { startStudio } from "./harness.js";
import { keyframeBytes, seedTake } from "./seed.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-thumbs-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A make that copies src to out and counts its calls. */
function copyingMake() {
  const calls: string[] = [];
  const make: MakeThumb = async (src, out) => {
    calls.push(src);
    await copyFile(src, out);
  };
  return { make, calls };
}

const thumbsDir = (id: string) => join(home, "takes", id, "thumbs");

/** `work`, or a failure naming `what` if it has not settled by `ms`: a test
 *  of a hang has to end by itself and say what was still waiting. */
async function within<T>(
  ms: number,
  work: Promise<T>,
  what: () => string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`not settled in ${ms} ms: ${what()}`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls `test` until it holds, or fails naming `what` at the deadline. */
async function until(test: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createThumbs", () => {
  it("the first request makes the thumb; the second serves the cache and makes none", async () => {
    const { takeId } = await seedTake(home);
    const { make, calls } = copyingMake();
    const thumbs = createThumbs({ library: createLibrary(home), make });
    const ref = `kf:${takeId}:1`;

    const first = await thumbs.get(takeId, ref);
    const second = await thumbs.get(takeId, ref);

    // Red: skip the cache read in get() — the second request makes again, 2 calls.
    expect(calls.length).toBe(1);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(new Uint8Array(first.bytes)).toEqual(keyframeBytes(1));
    expect(new Uint8Array(second.bytes)).toEqual(keyframeBytes(1));
    const onDisk = await readFile(
      join(thumbsDir(takeId), `${encodeURIComponent(ref)}.jpg`),
    );
    expect(new Uint8Array(onDisk)).toEqual(keyframeBytes(1));
  });

  it("a deleted thumbs/ folder is rebuilt on the next request", async () => {
    const { takeId } = await seedTake(home);
    const { make, calls } = copyingMake();
    const thumbs = createThumbs({ library: createLibrary(home), make });
    const ref = `kf:${takeId}:0`;
    expect((await thumbs.get(takeId, ref)).ok).toBe(true);
    await rm(thumbsDir(takeId), { recursive: true });

    const again = await thumbs.get(takeId, ref);

    expect(again.ok).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("an id that is not a take is takeNotFound", async () => {
    const { make, calls } = copyingMake();
    const thumbs = createThumbs({ library: createLibrary(home), make });
    const r = await thumbs.get("nope", "kf:nope:0");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
    expect(r.refusal.reason).toBe("takeNotFound");
    expect(calls.length).toBe(0);
  });

  it("a span ref is frameNotFound, and nothing is made", async () => {
    const { takeId, bundle } = await seedTake(home, { span: true });
    // The premise: the bundle holds a motion span, and the store holds its bytes.
    const span = bundle.motionSpans[0];
    expect(span?.ref).toBe(`span:${takeId}:0`);
    expect(await createLibrary(home).frameStore(takeId).refs()).toContain(
      span?.ref,
    );
    const { make, calls } = copyingMake();
    const thumbs = createThumbs({ library: createLibrary(home), make });

    const r = await thumbs.get(takeId, span?.ref as string);

    // Red: look the ref up in frameStore.refs() instead of the bundle's
    // keyframes — the span is made into a thumb, 1 call and ok.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
    expect(r.refusal.reason).toBe("frameNotFound");
    expect(calls.length).toBe(0);
  });

  it("a make that fails is 500 thumbFailed with its words, and nothing is cached", async () => {
    const { takeId } = await seedTake(home);
    const calls: string[] = [];
    const failing: MakeThumb = async (src, out) => {
      calls.push(src);
      // A tool that wrote half an output and then died.
      await copyFile(src, out);
      throw new Error("sips: Error 13");
    };
    const thumbs = createThumbs({
      library: createLibrary(home),
      make: failing,
    });
    const ref = `kf:${takeId}:0`;

    const r = await thumbs.get(takeId, ref);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(500);
    expect(r.refusal.reason).toBe("thumbFailed");
    expect(r.refusal.detail).toBe(
      `Couldn't make a preview of ${ref}: sips: Error 13.`,
    );
    // Red: drop the finally's rm of the source — a .src-* file is left.
    expect(await readdir(thumbsDir(takeId))).toEqual([]);
    await thumbs.get(takeId, ref);
    expect(calls.length).toBe(2);
  });

  it("ten cards at once run at most four makes", async () => {
    const { takeId, bundle } = await seedTake(home, { keyframes: 10 });
    expect(bundle.keyframes.length).toBe(10);
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const make: MakeThumb = async (src, out) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      started.push(src);
      await gate;
      await copyFile(src, out);
      inFlight -= 1;
    };
    const thumbs = createThumbs({ library: createLibrary(home), make });

    const all = Promise.all(
      bundle.keyframes.map((k) => thumbs.get(takeId, k.ref)),
    );
    // Wait for the condition: the first four are in, and held at the gate.
    const deadline = Date.now() + 5_000;
    while (started.length < THUMB_CONCURRENCY) {
      if (Date.now() > deadline) {
        throw new Error(`only ${started.length} makes ever started`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    // Let any make beyond the limit show itself before judging.
    await new Promise((r) => setTimeout(r, 50));
    expect(THUMB_CONCURRENCY).toBe(4);
    release();
    const answers = await all;

    // Red: createThumbs({ concurrency: Infinity }) — peak is 10.
    expect(peak).toBe(4);
    expect(answers.every((a) => a.ok)).toBe(true);
  });

  it("a make that never finishes is thumbFailed at the deadline, and the next request gets its slot", async () => {
    const { takeId } = await seedTake(home);
    const hungRef = `kf:${takeId}:0`;
    const nextRef = `kf:${takeId}:1`;
    const hung = new Uint8Array(keyframeBytes(0));
    const started: string[] = [];
    const signals: AbortSignal[] = [];
    const make: MakeThumb = async (src, out, signal) => {
      const bytes = new Uint8Array(await readFile(src));
      const which =
        bytes.length === hung.length && bytes.every((b, i) => b === hung[i])
          ? "hung"
          : "next";
      started.push(which);
      if (signal !== undefined) signals.push(signal);
      // A sips that never exits, and never heeds the abort either.
      if (which === "hung") return new Promise<void>(() => {});
      await copyFile(src, out);
    };
    const thumbs = createThumbs({
      library: createLibrary(home),
      make,
      concurrency: 1,
      deadlineMs: 200,
    });

    const first = thumbs.get(takeId, hungRef);
    // The premise: the hung make holds the one slot before the next asks.
    await until(
      () => started.length === 1,
      () => `makes started: ${started.join(", ")}`,
    );
    const second = thumbs.get(takeId, nextRef);

    // Red: await make(...) alone in makeInTime (no race with the deadline)
    // — the first never answers and the second waits behind it for good.
    const [a, b] = await within(
      5_000,
      Promise.all([first, second]),
      () => `makes started: ${started.join(", ")}`,
    );
    expect(a).toEqual({
      ok: false,
      status: 500,
      refusal: {
        reason: "thumbFailed",
        detail: `Couldn't make a preview of ${hungRef}: sips did not finish within 0.2 s.`,
      },
    });
    expect(b.ok, JSON.stringify(b)).toBe(true);
    expect(started).toEqual(["hung", "next"]);
    // The real sips is killed through this signal.
    expect(signals[0]?.aborted).toBe(true);
    // Nothing of the hung make is left beside the next one's thumb.
    expect(await readdir(thumbsDir(takeId))).toEqual([
      `${encodeURIComponent(nextRef)}.jpg`,
    ]);
  });

  it("a make that writes its output after the deadline leaves no .out- file behind", async () => {
    const { takeId } = await seedTake(home);
    const ref = `kf:${takeId}:0`;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let wrote: string | null = null;
    // A sips that ignores the abort and flushes its output anyway, after
    // the request has already answered and cleaned up.
    const make: MakeThumb = async (src, out) => {
      // Read first: the request removes src when it answers.
      const bytes = await readFile(src);
      await gate;
      await writeFile(out, bytes);
      wrote = out;
    };
    const thumbs = createThumbs({
      library: createLibrary(home),
      make,
      deadlineMs: 50,
    });
    const answer = await thumbs.get(takeId, ref);
    expect(answer.ok).toBe(false);
    release();
    await until(
      () => wrote !== null,
      () => "the late make never wrote",
    );
    // The premise: the late make really did write its output where the
    // request had already cleaned.
    expect(wrote).toMatch(/[/\\]\.out-[^/\\]+\.jpg$/);
    // Red: drop the sweep after a late make settles in makeInTime — the
    // `.out-*` file stays in thumbs/ for good.
    const deadline = Date.now() + 5_000;
    let left = await readdir(thumbsDir(takeId));
    while (left.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
      left = await readdir(thumbsDir(takeId));
    }
    expect(left).toEqual([]);
  });

  it("a take deleted while its thumb waits for a slot is takeNotFound, and its folder is not made again", async () => {
    const holder = await seedTake(home, { id: "holder" });
    const doomed = await seedTake(home, { id: "doomed" });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const make: MakeThumb = async (src, out) => {
      await gate;
      await copyFile(src, out);
    };
    // Counts each take's takeDir calls: the second is the thumbs folder's
    // path, made after every check the request does before the gate.
    const real = createLibrary(home);
    const dirs: string[] = [];
    const library: Library = {
      ...real,
      takeDir: (id) => {
        dirs.push(id);
        return real.takeDir(id);
      },
    };
    const thumbs = createThumbs({ library, make, concurrency: 1 });

    const held = thumbs.get(holder.takeId, `kf:${holder.takeId}:0`);
    await until(
      () => dirs.filter((d) => d === holder.takeId).length >= 2,
      () => `takeDir calls: ${dirs.join(", ")}`,
    );
    const waiting = thumbs
      .get(doomed.takeId, `kf:${doomed.takeId}:0`)
      .catch((error: unknown) => error);
    // The premise: the doomed take's request is past its own existence
    // check, so only what happens inside the gate can answer it.
    await until(
      () => dirs.filter((d) => d === doomed.takeId).length >= 2,
      () => `takeDir calls: ${dirs.join(", ")}`,
    );
    const done = await real.deleteTake(doomed.takeId);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    release();

    expect((await held).ok).toBe(true);
    // Red: mkdir(dir, { recursive: true }) — takes/doomed/thumbs is made
    // again, the frame read then fails, and a ghost folder is left.
    expect(await waiting).toEqual({
      ok: false,
      status: 404,
      refusal: {
        reason: "takeNotFound",
        detail: `There is no video "${doomed.takeId}" in ${real.root}.`,
      },
    });
    expect(await readdir(join(home, "takes"))).not.toContain(doomed.takeId);
  });

  it("a rename that fails after a good make leaves no .out- file behind", async () => {
    const { takeId } = await seedTake(home);
    const ref = `kf:${takeId}:0`;
    const cached = join(thumbsDir(takeId), `${encodeURIComponent(ref)}.jpg`);
    const make: MakeThumb = async (src, out) => {
      await copyFile(src, out);
      // A folder where the cached file goes: the rename over it fails.
      await mkdir(join(cached, "in-the-way"), { recursive: true });
    };
    const thumbs = createThumbs({ library: createLibrary(home), make });

    const failed = await thumbs.get(takeId, ref).catch((e: unknown) => e);

    // The premise: the make succeeded and the rename after it is what threw.
    expect(String(failed)).toMatch(/rename/);
    // Red: move the rm of `out` back into the make's own catch — the
    // finished `.out-*.jpg` stays in thumbs/.
    expect(await readdir(thumbsDir(takeId))).toEqual([
      `${encodeURIComponent(ref)}.jpg`,
    ]);
  });

  it("two requests for one ref at once make it once", async () => {
    const { takeId } = await seedTake(home);
    const { make, calls } = copyingMake();
    const thumbs = createThumbs({ library: createLibrary(home), make });
    const ref = `kf:${takeId}:2`;

    const [a, b] = await Promise.all([
      thumbs.get(takeId, ref),
      thumbs.get(takeId, ref),
    ]);

    // Red: call perPath's work directly (drop the chain) — 2 calls.
    expect(calls.length).toBe(1);
    expect(a.ok && b.ok).toBe(true);
  });

  // The Ubuntu CI runner has no `sips`, so only macOS drives the real tool;
  // every other test here (and the route test) injects the thumbnailer.
  it.runIf(process.platform === "darwin")(
    "real sips: a keyframe from apps/runner/test/fixtures/frame-large.jpg comes back a JPEG whose long side is 640",
    async () => {
      const fixture = await readFile(
        fileURLToPath(
          new URL(
            "../../../runner/test/fixtures/frame-large.jpg",
            import.meta.url,
          ),
        ),
      );
      const size = (path: string) => {
        const out = execFileSync(
          "sips",
          ["-g", "pixelWidth", "-g", "pixelHeight", path],
          { encoding: "utf8" },
        );
        const num = (key: string) =>
          Number(new RegExp(`${key}: (\\d+)`).exec(out)?.[1]);
        return { width: num("pixelWidth"), height: num("pixelHeight") };
      };
      const { takeId } = await seedTake(home, {
        keyframes: 1,
        bytesOf: () => new Uint8Array(fixture),
      });
      const dir = join(home, "premise");
      await mkdir(dir, { recursive: true });
      const premise = join(dir, "frame-large.jpg");
      await writeFile(premise, fixture);
      // The premise: the fixture is larger than a thumb on its long side.
      const before = size(premise);
      expect(Math.max(before.width, before.height)).toBeGreaterThan(
        THUMB_MAX_SIDE,
      );

      const r = await createThumbs({ library: createLibrary(home) }).get(
        takeId,
        `kf:${takeId}:0`,
      );

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect([...r.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      const out = join(dir, "out.jpg");
      await writeFile(out, r.bytes);
      const after = size(out);
      expect(Math.max(after.width, after.height)).toBe(THUMB_MAX_SIDE);
      // The aspect ratio survives the shrink.
      expect(after.width / after.height).toBeCloseTo(
        before.width / before.height,
        1,
      );
    },
    30_000,
  );
});

describe("the thumb route", () => {
  it("answers image/jpeg with the frames' cache header, and a failure as its refusal", async () => {
    const { takeId } = await seedTake(home);
    const { make } = copyingMake();
    let fail = false;
    const h = await startStudio(home, {
      make: async (src, out) => {
        if (fail) throw new Error("sips: Error 13");
        await make(src, out);
      },
    });
    try {
      const ref = `kf:${takeId}:0`;
      const ok = await h.call(pathFor("thumb", { id: takeId, ref }));
      expect(ok.status).toBe(200);
      expect(ok.headers["content-type"]).toBe("image/jpeg");
      expect(ok.headers["cache-control"]).toBe(FRAME_CACHE);
      expect(new Uint8Array(ok.bytes)).toEqual(keyframeBytes(0));

      fail = true;
      const bad = await h.call(
        pathFor("thumb", { id: takeId, ref: `kf:${takeId}:1` }),
      );
      expect(bad.status).toBe(500);
      expect(bad.json()).toEqual({
        reason: "thumbFailed",
        detail: `Couldn't make a preview of kf:${takeId}:1: sips: Error 13.`,
      });
    } finally {
      await h.close();
    }
  });
});
