// apps/runner/test/motion-budget.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameBundle } from "@demoman/compositor";
import { CAPTURE_MOTION_BUDGET_BYTES, jpegSize } from "@demoman/replay-engine";
import type { BrandKitsRead, RunReport } from "@demoman/run-core";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDisplay } from "../src/display.js";
import { createBrowserSession } from "../src/executor/browser.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { muxSpans } from "../src/mux.js";
import { installResolver } from "../src/page-agent.js";
import { serveFixtureApp } from "./fixture.js";

/**
 * A real-time take's motion budget, through the runner's own encoder.
 *
 * The budget is charged the bytes each span parked. Until 2026-11-27 the
 * runner's encoder reported every span as 0 bytes (the real size waited for
 * the mux), so the budget added up zeros and never tripped, and the unit
 * tests' fake encoder, which reports real sizes, could not see it.
 *
 * Real time (`DEMOMAN_HELD_CLOCK=0`): the held clock has no byte budget.
 * About 12 s a take here, 30 s under CI-like load; x5 for CI (`fff4505`)
 * with margin.
 */
const TAKE_MS = 120_000;

const lines: string[] = [];
const log = (line: string) => void lines.push(line);
const kits: BrandKitsRead = { state: "ready", kits: [], defaultId: null };
const heldWas = process.env.DEMOMAN_HELD_CLOCK;
let app: { url: string; close(): void };
let home: string;
let session: ReturnType<typeof createBrowserSession>;

beforeAll(async () => {
  // Before the session: it reads the clock it launches for when created.
  process.env.DEMOMAN_HELD_CLOCK = "0";
  session = createBrowserSession({
    headless: true,
    log,
    // A display, as the CLI's session reads one: without it the stand-in
    // launches at Chrome's 1x, not `CAPTURE_SCALE.desktop`.
    readDisplay: () => readDisplay({ DEMOMAN_DISPLAY: "1440x900@2" }),
    onLaunched: async ({ context }) => {
      await installResolver(context);
      await installExecutorEntry(context);
    },
  });
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-motion-budget-"));
}, 30_000);

afterAll(async () => {
  if (heldWas === undefined) delete process.env.DEMOMAN_HELD_CLOCK;
  else process.env.DEMOMAN_HELD_CLOCK = heldWas;
  await session.close();
  app.close();
  await rm(home, { recursive: true, force: true });
});

/**
 * Two paint runs, both typing: each key paints, for two seconds or more.
 * Not the panel's 800 ms slide, which was the first run until 2026-11-28:
 * its ease-out lands 1 to 4 screencast frames on a loaded machine, either
 * side of `SPAN_MIN_FRAMES`, so it was kept on some runs and not on others
 * (lost in 5 of 6 takes under CI-like load here, and on a CI runner). A
 * typing run held a span of 5 frames or more in every one of those takes,
 * and two typing runs kept two spans or more in 16 of 16.
 */
const script = () => ({
  scriptVersion: 1,
  name: "two paint runs",
  target: app.url,
  viewport: { width: 1280, height: 800 },
  steps: [
    { do: "waitForLoad" as const },
    {
      do: "type" as const,
      into: { stableId: "search" },
      text: "Northwind invoices for the third quarter",
    },
    { do: "pause" as const, ms: 1500 },
    {
      do: "type" as const,
      into: { stableId: "search" },
      text: "Overdue invoices, oldest first",
    },
  ],
});

/** What the mux was handed: each kept span's bytes as the encoder charged
 *  them, its parked JPEGs' bytes read back off disk, its frame size, and
 *  the width each parked frame decodes at. */
type Seen = {
  ref: string;
  charged: number;
  parked: number;
  frames: number;
  startMs: number;
  endMs: number;
  width: number;
  frameWidths: number[];
}[];

/** Every span the encoder opened, kept or not: why a premise below failed. */
type Opened = {
  ref: string;
  kept: boolean;
  frames: number;
  startMs: number;
  ms: number;
  width: number;
}[];

/** When the second typing run began: where the walk set off for the take's
 *  last step, after the pause. Not the marker's own time, which is stamped
 *  once the pointer has arrived and settled: the run's span opens on the
 *  approach's paints, before it. */
const secondRunAt = (bundle: FrameBundle | null): number => {
  const last = (bundle?.markers ?? []).reduce<
    FrameBundle["markers"][number] | null
  >((a, m) => (a === null || m.sourceTimeMs > a.sourceTimeMs ? m : a), null);
  return last?.approachSourceTimeMs ?? Number.NaN;
};

async function take(motionBudgetBytes?: number): Promise<{
  report: RunReport;
  seen: Seen;
  opened: Opened;
  bundle: FrameBundle | null;
}> {
  const library = createLibrary(home);
  const seen: Seen = [];
  const opened: Opened = [];
  const report = await runScript(
    script() as never,
    {
      session,
      library,
      kits,
      log,
      sessions: [],
      sessionStore: createSessionStore(home),
      signinCommand: "npx demoman signin",
      recordingFrameRate: { value: 30, from: "default" } as const,
      loadSessions: async () => ({ ok: true as const, files: [] }),
      sessionsContext: {} as BrowserContext,
      ...(motionBudgetBytes === undefined ? {} : { motionBudgetBytes }),
      muxSpans: async (input) => {
        for (const s of input.spans) {
          opened.push({
            ref: s.ref,
            kept: s.kept,
            frames: s.frames,
            startMs: s.startMs,
            ms: s.endMs - s.startMs,
            width: s.width,
          });
        }
        const kept = input.spans.filter((s) => s.kept);
        for (const span of kept) {
          const parked = await input.store.readParked(
            `${input.sceneId}:replay`,
            span.firstFrameIndex,
            span.frames,
          );
          seen.push({
            ref: span.ref,
            charged:
              input.bundle.motionSpans.find((m) => m.ref === span.ref)
                ?.byteLength ?? -1,
            parked: parked.reduce((sum, p) => sum + p.bytes.byteLength, 0),
            frames: span.frames,
            startMs: span.startMs,
            endMs: span.endMs,
            width: span.width,
            frameWidths: parked.map((p) => jpegSize(p.bytes).width),
          });
        }
        return muxSpans(input);
      },
    },
    () => undefined,
  );
  const takeId = report.provenance.takeId;
  const bundle =
    takeId === null ? null : await library.frameStore(takeId).getBundle(takeId);
  return { report, seen, opened, bundle };
}

describe("a real-time take's motion budget", () => {
  it(
    "charges each span the bytes it parked, and under the default budget spends nothing",
    async () => {
      const { report, seen, opened, bundle } = await take();
      const evidence = JSON.stringify({ seen, opened, report, bundle, lines });
      expect(report.outcome, evidence).toBe("complete");
      // The premise the budget test below rests on: each typing run kept a
      // span at the screencast's 2x, with nothing spent. `opened` says which
      // spans fell under `SPAN_MIN_FRAMES` when it fails.
      const second = secondRunAt(bundle);
      const typed = seen.filter((s) => s.width === 1280 * 2);
      expect(
        typed.some((s) => s.endMs <= second),
        `no span kept from the first typing run: ${evidence}`,
      ).toBe(true);
      expect(
        typed.some((s) => s.startMs >= second),
        `no span kept from the second typing run: ${evidence}`,
      ).toBe(true);
      expect(report.frames.degradations, evidence).not.toContain(
        "keyframeOnly",
      );
      // Red if a span is charged anything but what it wrote: 0 was the
      // number the budget used to add up.
      for (const span of seen) {
        expect(span.parked, evidence).toBeGreaterThan(0);
        expect(span.charged, evidence).toBe(span.parked);
      }
      // The scale the budget is sized at (`CAPTURE_SCALE.desktop`), not
      // Chrome's 1x, nor a full still's 3x: every frame each kept span
      // parked, decoded. Before the walk dropped a still's echo
      // (`stillEcho`), one at 3x sat inside a kept span in 4 of 5 takes here
      // (2026-11-28), and under CI-like load two echoes and one frame of the
      // page made a span of their own. The premise: the stills are at 3x, so an echo would
      // show here by its width.
      expect(
        (bundle?.keyframes ?? []).some((k) => k.width === 1280 * 3),
        evidence,
      ).toBe(true);
      expect(
        seen.filter((s) => s.frameWidths.some((w) => w !== 1280 * 2)),
        evidence,
      ).toEqual([]);
      const bytes = typed.reduce((sum, s) => sum + s.parked, 0);
      const frames = typed.reduce((sum, s) => sum + s.frames, 0);
      const seconds =
        typed.reduce((sum, s) => sum + s.endMs - s.startMs, 0) / 1000;
      console.log(
        `[motion-budget] ${frames} frames at ${typed[0]?.width} px wide, ` +
          `mean ${(bytes / frames / 1024).toFixed(1)} KB/frame, ` +
          `${(bytes / seconds / 1024).toFixed(0)} KB per second of motion: ` +
          `${(CAPTURE_MOTION_BUDGET_BYTES / (bytes / seconds) / 60).toFixed(1)} min ` +
          `in ${CAPTURE_MOTION_BUDGET_BYTES / 1024 / 1024} MB; ` +
          `degradations [${report.frames.degradations.join(", ")}]`,
      );
    },
    TAKE_MS,
  );

  it(
    "keeps the rest of the run as stills once the budget is spent, and says so",
    async () => {
      // One byte: the first kept span spends it.
      const { report, seen, opened, bundle } = await take(1);
      const evidence = JSON.stringify({ seen, opened, report, bundle, lines });
      expect(report.outcome, evidence).toBe("complete");
      expect(seen, evidence).toHaveLength(1);
      expect(bundle?.motionSpans, evidence).toHaveLength(1);
      const spent = bundle?.degradations.filter(
        (d) => d.kind === "keyframeOnly",
      );
      expect(spent, evidence).toHaveLength(1);
      expect(spent?.[0]?.note, evidence).toContain("motion budget spent");
      // From the first span's end to the run's. The first span is the first
      // typing run's, so the second typing run is in the stretch said to be
      // stills.
      const first = bundle?.motionSpans[0];
      const second = secondRunAt(bundle);
      expect(first?.width, evidence).toBe(1280 * 2);
      expect(
        first?.endMs ?? Number.POSITIVE_INFINITY,
        evidence,
      ).toBeLessThanOrEqual(second);
      expect(spent?.[0]?.startMs, evidence).toBe(first?.endMs);
      expect(spent?.[0]?.endMs ?? 0, evidence).toBeGreaterThan(second + 1000);
      expect(report.frames.degradations, evidence).toContain("keyframeOnly");
    },
    TAKE_MS,
  );
});
