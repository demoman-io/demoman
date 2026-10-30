import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { madeFromOf } from "@demoman/compositor";
import {
  assertSceneWasLoaded,
  createOcclusionGuard,
  jpegSize,
  type OcclusionGuard,
  type ReplayResult,
  replayPolicy,
  runReplay,
} from "@demoman/replay-engine";
import type { SceneDocument } from "@demoman/scene-schema";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { fixtureScene } from "../../../packages/compositor/scripts/fixture-scene.js";
import { createParkingEncoder } from "../src/encoder.js";
import { createFileFrameStore, type RunnerStore } from "../src/frame-store.js";
import { type Launched, launch } from "../src/launch.js";
import { createHeadlessPageAgent, installResolver } from "../src/page-agent.js";
import { replayPhase } from "../src/replay.js";

/**
 * Timeouts.
 *
 * Each test launches its own Chromium (`launch()`) and closes it in a
 * `finally`, rather than sharing one across tests: `replayPhase` navigates
 * the page and drives a full CDP-level replay of it, and a shared session
 * would carry the previous test's DOM state, cursor position and
 * `Runtime.addBinding` registrations into the next one. Measured on this
 * machine (Apple silicon, 2026-09-08), three runs of this file:
 *
 *   beforeAll (http server for fixture-app.html)                    2 ms
 *   "replays every action..."                                  8.3-8.4 s
 *   "harvests keyframes at the EMULATED metrics..."            8.3-8.4 s
 *   "keeps a motion span for the click that animates"          8.2-8.3 s
 *   "throws the invariant violation..."                        8.3-8.4 s
 *
 * (An earlier version of the fourth test's helper sent `Runtime.addBinding`
 * before `Page.enable`/`Runtime.enable` on its own session, which measured
 * 60-64s: the heartbeat script never actually delivered a beat, so the
 * guard paused and rode out the full `OCCLUSION_TIMEOUT_MS` before giving
 * up — still a pass, since a stalled-but-eventually-reported run still
 * reaches the tripwire, just an order of magnitude slower than intended.
 * Fixed by enabling both domains before installing anything on that
 * session; see the comment on the helper below.)
 *
 * CI is about 5x slower than this machine at browser work (`fff4505`),
 * which puts the slowest of these near 42s there. `120_000` (the value
 * task-10-brief.md specifies verbatim) is a ceiling on a hang, not a
 * budget — roughly 2.9x the 5x-CI estimate — comfortably inside
 * `vitest.config.ts`'s lane-wide 60s/120s test/hook floor (each `it` below
 * overrides the 60s default explicitly, since a real replay of four
 * actions plus an 800ms transition is not survivable at it). Nothing here
 * waits for a fixed duration: every wait inside `runReplay` is on a CDP
 * event or a polled condition.
 */
const HOOK_TIMEOUT_MS = 20_000; // ~2 ms measured, ~10,000x — a server, not a browser.
const TEST_TIMEOUT_MS = 120_000; // ~8.4 s measured worst; the brief's own value.

let server: Server;
let url = "";

beforeAll(async () => {
  const html = await fs.readFile(
    new URL(
      "../../../packages/compositor/scripts/fixture-app.html",
      import.meta.url,
    ),
    "utf8",
  );

  // Served over http, not opened as file://: the render phase needs an
  // origin and the policy gate reads the scheme (see `validateTargetUrl`).
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, HOOK_TIMEOUT_MS);

afterAll(() => {
  server?.close();
});

/** A fresh, empty filesystem store per test — `replayPhase` parks frames
 *  under `${sceneId}:replay`, and reusing one store across tests would let
 *  a later run's frames collide with an earlier run's still-unread ones.
 *
 *  Removed when the test that asked for it finishes (round 2's finding 8):
 *  these hold a real replay's parked frames, five of them per run of this
 *  file, and every one of them used to outlive the process. */
function freshStore(): RunnerStore {
  const root = mkdtempSync(join(tmpdir(), "demoman-replay-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return createFileFrameStore(root);
}

/**
 * `occlusion.ts`'s own private binding name (not exported — it has no
 * production consumer outside that module). Hardcoded here for the same
 * reason `apps/extension/test/node/replay-window.test.ts` already hardcodes
 * this identical literal: asserting against the guard's real wire protocol,
 * not a stand-in for it.
 */
const HEARTBEAT_BINDING = "__demomanHeartbeat";

/**
 * Pins the `Page.enable`/`Runtime.enable`-before-`guard.install()` ordering
 * `replayPhaseWithoutNavigation` depends on, explicitly and fast, rather
 * than leaving a regression there to be caught only by the run getting
 * slower.
 *
 * Without this, a regression in that ordering does not fail: it changes
 * shape. `createOcclusionGuard.ensureVisible()`'s grace period
 * (`HEARTBEAT_STALL_MS`, 2s from guard construction) hides a dead heartbeat
 * for the run's first couple of seconds regardless, and once that grace
 * expires a truly-dead heartbeat pays `OCCLUSION_TIMEOUT_MS`'s full 60s
 * before `runReplay` gives up — which is still comfortably under this
 * file's 120s per-test budget (task-10-brief.md's own value), so the test
 * stays green *locally* the whole time this was broken (see the report:
 * that is exactly what happened before this function existed). On CI,
 * ~5x slower (`fff4505`), the same regression would push toward the 120s
 * ceiling and could time out there without ever failing here — a mystery
 * on a machine nobody reproducing it locally can watch.
 *
 * So: wait for a real beat with its own short, explanatory bound instead of
 * borrowing `ensureVisible()`'s 60s one. Measured on this machine
 * (2026-09-08) with the ordering correct: the first beat arrives 60-260ms
 * after this function starts polling (rAF's own ~16ms cadence plus one CDP
 * round trip). `WAIT_TIMEOUT_MS` below is ~15-60x that, generous even at a
 * simulated 5x-CI slowdown, and two orders of magnitude short of the 60s a
 * regression would otherwise cost.
 */
async function assertHeartbeatBeats(
  cdp: Launched["cdp"],
  clock: Launched["clock"],
): Promise<void> {
  const WAIT_TIMEOUT_MS = 4_000;
  const POLL_MS = 50;
  let beat = false;
  const off = cdp.on("Runtime.bindingCalled", (params) => {
    if (params.name === HEARTBEAT_BINDING) beat = true;
  });
  try {
    const deadline = clock.now() + WAIT_TIMEOUT_MS;
    while (!beat && clock.now() < deadline) {
      await clock.sleep(POLL_MS);
    }
    if (!beat) {
      throw new Error(
        `the occlusion guard's heartbeat never fired within ${WAIT_TIMEOUT_MS}ms of navigating — ` +
          "Page.enable and Runtime.enable must be sent on this CDP session " +
          "before guard.install(): a Runtime.addBinding sent while Runtime " +
          "is still disabled never delivers Runtime.bindingCalled, even " +
          "once Runtime is enabled afterward. Without this check the same " +
          "regression would not fail here at all — it would make " +
          "replayPhaseWithoutNavigation's own test 12-15x slower (up to " +
          "OCCLUSION_TIMEOUT_MS's 60s) while staying under this file's 120s " +
          "budget, and only risk timing out on CI's ~5x-slower machines.",
      );
    }
  } finally {
    off();
  }
}

/**
 * Reaches `assertSceneWasLoaded`'s tripwire through the real `runReplay`
 * rather than mocking it out — but the state it guards is not reachable by
 * naively swapping in a bare `createOcclusionGuard` and leaving the page
 * wherever `launch()` put it (`about:blank`): with no real app there for
 * the resolver to find, the very first action's `locate()` throws before a
 * single cursor sample is recorded, `runReplay`'s own `harvested` gate
 * (`keyframes.length > 0 && cursorSamples.length > 0`) stays false, and
 * `bundle` comes back null — so there is nothing for the tripwire to trip
 * on, and `outcome: "partial"` / `reason: "portFailure"` is what reports
 * the break instead of a throw. This is exactly the state
 * `apps/extension/test/node/replay-window.test.ts` calls "unreachable with
 * the real engine on a healthy session" and mocks `runReplay` to reach.
 *
 * This reaches it a different way, staying inside the real engine: the
 * page is navigated to the real app directly with `page.goto` — NOT
 * through `Page.navigate` inside a guard's `install()` — so resolution
 * succeeds and a real, complete bundle gets built. The occlusion guard's
 * heartbeat script is installed *before* that navigation too (the same
 * "before the first navigation" requirement `installResolver` documents),
 * so the run does not spend up to a minute concluding the page went
 * unresponsive before HEARTBEAT_STALL_MS's grace period would have hidden
 * that anyway on a shorter run.
 *
 * What the guard genuinely never does — here exactly as in the real bug —
 * is navigate anything. `navigated` is hardcoded `false` below because a
 * bare `OcclusionGuard` has no such method to ask; that omission is the
 * whole reason `NavigatingGuard` exists. The composition under proof is
 * `replayPhase`'s own: given a page that happens to already show the real
 * app, wired through a guard that never confirmed loading it, does the
 * assembly still refuse to report a result over it? It does.
 */
async function replayPhaseWithoutNavigation(input: {
  scene: SceneDocument;
  targetUrl: string;
  store: RunnerStore;
  launched: Launched;
}): Promise<ReplayResult> {
  const { scene, targetUrl, store, launched } = input;
  const { page, cdp, clock } = launched;

  await installResolver(page);

  // `Page.enable` and `Runtime.enable`, before `guard.install()` sends
  // `Page.addScriptToEvaluateOnNewDocument` and `Runtime.addBinding`:
  // measured directly against a real session — with `Page` still disabled
  // on this session, the heartbeat script registers (no error) but never
  // actually runs on the next navigation, and a binding added while
  // `Runtime` is still disabled never delivers `Runtime.bindingCalled`,
  // even once `Runtime` is enabled afterward (a later disable/enable cycle
  // is fine; it is only the first enable that has to come first).
  // `runReplay`'s own setup sends both enables before it reaches
  // `occlusion.install()`, which is what makes this ordering invisible in
  // the correctly-wrapped path — there, the guard installs after the
  // engine's own enables, not before them.
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const guard = createOcclusionGuard({ cdp, clock });
  // Installed before the navigation below, same as the real
  // `NavigatingGuard` — but note what does not follow it: a `Page.navigate`.
  // That absence is the entire bug this function exists to reproduce.
  await guard.install();
  await page.goto(targetUrl, { waitUntil: "load" });

  // See `assertHeartbeatBeats`'s own docblock: this is what turns a
  // regression in the enable-before-install ordering above into a fast,
  // explanatory failure instead of a run that quietly gets 12-15x slower.
  await assertHeartbeatBeats(cdp, clock);

  const occlusion: OcclusionGuard = {
    // A no-op: the guard above is already installed, and re-sending its CDP
    // setup a second time (which `runReplay` would otherwise trigger by
    // calling this) is not what this proves. `ensureVisible`/`pauses`/
    // `pausedMs` still delegate to the real, already-beating guard, so
    // occlusion handling behaves exactly as production's would — the only
    // difference from a correctly-wrapped run is that nothing here ever
    // navigates.
    install: async () => undefined,
    ensureVisible: () => guard.ensureVisible(),
    pauses: () => guard.pauses(),
    pausedMs: () => guard.pausedMs(),
    stalledSince: () => guard.stalledSince(),
  };

  const result = await runReplay(scene, {
    cdp,
    page: createHeadlessPageAgent(page, () => undefined),
    encoder: createParkingEncoder(store, scene.meta.id),
    store,
    clock,
    mayReplay: replayPolicy(scene, { attended: false, targetUrl }).mayReplay,
    occlusion,
    madeFrom: madeFromOf(scene),
  });

  assertSceneWasLoaded(result, false);
  return result;
}

describe("replayPhase", () => {
  it(
    "replays every action of the fixture scene against the real page",
    async () => {
      const launched = await launch();
      try {
        const { result } = await replayPhase({
          scene: fixtureScene(),
          targetUrl: url,
          store: freshStore(),
          launched,
          report: () => undefined,
        });
        expect(result.outcome).toBe("complete");
        expect(result.completed).toBe(4);
        expect(result.reason).toBeNull();
        expect(result.bundle).not.toBeNull();
      } finally {
        await launched.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "harvests keyframes at the EMULATED metrics, not the context's",
    async () => {
      // The lane's headline claim, and it can only be proved because
      // CONTEXT_VIEWPORT/CONTEXT_DPR (launch.ts) deliberately differ from
      // the scene's: 1280x800 at REPLAY_DPR 3 is 3840x2400, and only the
      // engine's own Emulation.setDeviceMetricsOverride can produce that —
      // the context alone is 1024x640 at DPR 1. Decoded from the real
      // bytes on disk, not read off the bundle's own metadata: the bundle
      // is written by the same code this test exists to check.
      const launched = await launch();
      try {
        const store = freshStore();
        const { result } = await replayPhase({
          scene: fixtureScene(),
          targetUrl: url,
          store,
          launched,
          report: () => undefined,
        });
        const first = result.bundle?.keyframes[0];
        expect(
          first,
          "no keyframe to decode — the run harvested none",
        ).not.toBeUndefined();
        const bytes = await store.load((first as { ref: string }).ref);
        expect(jpegSize(bytes)).toEqual({ width: 3840, height: 2400 });
      } finally {
        await launched.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a motion span for the click that animates",
    async () => {
      // fixture-app.html's panel is its only transition; without a kept
      // span here, the acceptance test's eventual motion assertion has
      // nothing to see.
      const launched = await launch();
      try {
        const { spans } = await replayPhase({
          scene: fixtureScene(),
          targetUrl: url,
          store: freshStore(),
          launched,
          report: () => undefined,
        });
        expect(spans.filter((s) => s.kept).length).toBeGreaterThanOrEqual(1);
      } finally {
        await launched.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "throws the invariant violation when the navigating guard is not wrapped",
    async () => {
      const launched = await launch();
      try {
        await expect(
          replayPhaseWithoutNavigation({
            scene: fixtureScene(),
            targetUrl: url,
            store: freshStore(),
            launched,
          }),
        ).rejects.toThrow(/without ever loading the scene's app/);
      } finally {
        await launched.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "hands back the browser's own net error when the target URL does not load",
    async () => {
      // Whole-branch review finding 3. `Page.navigate` RESOLVES on a target
      // that could not be loaded, carrying `errorText`; nothing read it, so
      // replay ran on against `about:blank`, failed to resolve its first
      // anchor and the CLI told the author to re-record a step that was
      // never broken (measured: exit 4, "an element this demo depends on is
      // no longer on the page").
      //
      // A port that was bound long enough to learn its number and then
      // closed: the connection is refused immediately, so this costs a
      // round trip rather than a network timeout. NOT the reviewer's
      // `127.0.0.1:1` — Chromium refuses port 1 as unsafe before it ever
      // opens a socket (`net::ERR_UNSAFE_PORT`, measured), which would test
      // the port blocklist rather than an unreachable server.
      const closed = createServer();
      await new Promise<void>((resolve) =>
        closed.listen(0, "127.0.0.1", resolve),
      );
      const deadPort = (closed.address() as AddressInfo).port;
      await new Promise<void>((resolve) => closed.close(() => resolve()));

      const launched = await launch();
      try {
        const phase = await replayPhase({
          scene: fixtureScene(),
          targetUrl: `http://127.0.0.1:${deadPort}/`,
          store: freshStore(),
          launched,
          report: () => undefined,
        });
        // Chromium's own string, carried verbatim rather than paraphrased —
        // the whole point is that the reason survives to the user.
        expect(phase.navigationError).toMatch(/^net::ERR_/);
        expect(phase.navigationError).toContain("CONNECTION_REFUSED");
        // And the run really did fail the way it always did — this is the
        // signal that was being reported INSTEAD of the one above, so if it
        // stopped happening this test would be proving the wrong thing.
        expect(phase.result.outcome).toBe("partial");
      } finally {
        await launched.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "routes the page agent's reasons to the caller's reporter, not the console",
    async () => {
      // Runner audit 2026-09-14, finding 1. The page agent's "this anchor
      // has an unparseable tree path" line went to `console.error`, where an
      // in-process consumer of `main(argv, io, run)` never saw it. This is
      // the one seam that proves `replayPhase` actually hands the pipeline's
      // reporter down: a malformed path on an anchor that still resolves by
      // `stableId` keeps the replay complete and produces exactly one line.
      // (The encoder has no reporter of its own — see the test below.)
      const scene = fixtureScene();
      const first = scene.anchors[0];
      if (first === undefined) throw new Error("fixture scene has no anchors");
      first.fingerprint.treePath = "#frame(origin=,name=,ordinal=1";

      const reported: string[] = [];
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const launched = await launch();
      try {
        const { result } = await replayPhase({
          scene,
          targetUrl: url,
          store: freshStore(),
          launched,
          report: (line) => reported.push(line),
        });
        expect(result.outcome).toBe("complete");
        expect(reported.some((l) => l.includes(`anchor "${first.id}"`))).toBe(
          true,
        );
        expect(error).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
        await launched.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a park the store refuses reaches the bundle's degradations through the engine, with the reason",
    async () => {
      // Review of the runner audit, finding 6. The parking encoder used to
      // catch its own `putParked` failure and count it on the side; the
      // engine's motion recorder already forgives a rejected `push` and
      // reports it — once per span, with the reason — into the bundle's
      // degradations, which `runPipeline` prints. This is the seam that
      // proves the runner's encoder lets that path fire: a store that
      // refuses every park still replays to completion, and the bundle
      // says why its motion is thin.
      const base = freshStore();
      const refusing: RunnerStore = {
        ...base,
        putParked: async () => {
          throw new Error("disk full");
        },
      };
      const launched = await launch();
      try {
        const { result } = await replayPhase({
          scene: fixtureScene(),
          targetUrl: url,
          store: refusing,
          launched,
          report: () => undefined,
        });
        expect(result.outcome).toBe("complete");
        const notes = (result.bundle?.degradations ?? []).map((d) => d.note);
        expect(
          notes.some((n) => n?.includes("disk full")),
          notes.join("\n"),
        ).toBe(true);
        expect(result.counters.encodeRefusedFrames).toBeGreaterThan(0);
      } finally {
        await launched.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "films a type's text appearing a key at a time, not in one frame",
    async () => {
      // The fixture's first step types "northwind" into #search. Replay
      // records the page while the verb runs, so the frames of the spans
      // between that step's marker and the next one are what the viewer
      // sees of the typing. Read back and decoded, the field's ink has to
      // change on many frames — a key's worth each — where one insert of
      // the whole value changed it on one.
      const scene = fixtureScene();
      const typeStep = scene.actions[0];
      const nextStep = scene.actions[1];
      if (typeStep?.kind !== "type" || nextStep === undefined) {
        throw new Error("the fixture scene no longer opens on a type step");
      }
      const store = freshStore();
      const launched = await launch();
      try {
        const { result, spans } = await replayPhase({
          scene,
          targetUrl: url,
          store,
          launched,
          report: () => undefined,
        });
        expect(result.outcome).toBe("complete");
        const bundle = result.bundle;
        if (bundle === null) throw new Error("no bundle");
        const markerOf = (id: string) =>
          bundle.markers.find((m) => m.actionId === id)?.sourceTimeMs;
        const from = markerOf(typeStep.id);
        const to = markerOf(nextStep.id);
        const field = bundle.anchorRects.find(
          (r) => r.actionId === typeStep.id,
        )?.rect;
        if (from === undefined || to === undefined || field === undefined) {
          throw new Error(
            `markers or rect missing: ${JSON.stringify({ from, to, field })}`,
          );
        }
        const during = spans.filter(
          (s) => s.endMs > from && s.startMs < to && s.frames > 0,
        );
        const frames: { bytes: Uint8Array; width: number }[] = [];
        for (const span of during) {
          for (const f of await store.readParked(
            `${scene.meta.id}:replay`,
            span.firstFrameIndex,
            span.frames,
          )) {
            frames.push({ bytes: f.bytes, width: span.width });
          }
        }
        const evidence = `spans ${JSON.stringify(
          during.map((s) => [s.startMs, s.endMs, s.frames]),
        )}`;
        // The premise: the typing was filmed at all.
        expect(frames.length, evidence).toBeGreaterThan(1);

        // Dark pixels inside the field, per frame, decoded in the page the
        // run already has. The screencast frame is the viewport at its own
        // scale, so the CSS rect is scaled by frame width over viewport.
        //
        // Only frames at their span's scale are counted (null otherwise). A
        // span can hold one at another: a 3x frame arrives while a step's
        // full still is taken (measured 2026-10-29, 19 ms after its
        // neighbour). Counted at 3x it read 4433 against ~750 and stood in
        // for the typing; drawn down to 1x, 46, as smoothing lightens the
        // placeholder. Neither is a count the 1x frames can be compared to.
        const counted = await launched.page.evaluate(
          async ({ frames, field, viewportWidth }) => {
            const out: (number | null)[] = [];
            for (const f of frames) {
              const blob = new Blob([
                Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)),
              ]);
              const bitmap = await createImageBitmap(blob);
              if (bitmap.width !== f.width) {
                out.push(null);
                continue;
              }
              const k = bitmap.width / viewportWidth;
              const x = Math.round(field.x * k);
              const y = Math.round(field.y * k);
              const w = Math.round(field.width * k);
              const h = Math.round(field.height * k);
              const canvas = new OffscreenCanvas(w, h);
              const ctx = canvas.getContext("2d");
              if (ctx === null) throw new Error("no 2d context");
              ctx.drawImage(bitmap, -x, -y);
              const data = ctx.getImageData(0, 0, w, h).data;
              let dark = 0;
              for (let i = 0; i < data.length; i += 4) {
                const lum =
                  0.299 * (data[i] ?? 0) +
                  0.587 * (data[i + 1] ?? 0) +
                  0.114 * (data[i + 2] ?? 0);
                if (lum < 96) dark++;
              }
              out.push(dark);
            }
            return out;
          },
          {
            frames: frames.map((f) => ({
              data: Buffer.from(f.bytes).toString("base64"),
              width: f.width,
            })),
            field,
            viewportWidth: bundle.viewport.width,
          },
        );
        const ink = counted.filter((n) => n !== null);
        const said = `${evidence}; ink per frame ${JSON.stringify(counted)}`;
        // The premise: setting the other scale aside left the typing.
        expect(ink.length, said).toBeGreaterThan(frames.length / 2);
        // The field gains ink inside the window rather than holding the
        // whole value from its first frame — what one insert filmed
        // (measured: [901, 884] against [721 … 901] typed a key at a time).
        // The field sits in the dark header, so the count includes the
        // header showing at its rounded corners: constant, so only the
        // change says anything.
        expect(Math.max(...ink), said).toBeGreaterThan(ink[0] ?? 0);
        // A key's worth of ink at a time: at least half of "northwind"'s
        // nine keys each arrive on a frame of their own.
        const levels = new Set(ink).size;
        expect(levels, said).toBeGreaterThanOrEqual(5);
      } finally {
        await launched.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
