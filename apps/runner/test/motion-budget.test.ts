// apps/runner/test/motion-budget.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameBundle } from "@demoman/compositor";
import { CAPTURE_MOTION_BUDGET_BYTES } from "@demoman/replay-engine";
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
 * About 10 s a take here; x5 for CI (`fff4505`) with margin.
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
 *  them, its parked JPEGs' bytes read back off disk, and its frame size. */
type Seen = {
  charged: number;
  parked: number;
  frames: number;
  ms: number;
  width: number;
}[];

/** Every span the encoder opened, kept or not: why a premise below failed. */
type Opened = { kept: boolean; frames: number; startMs: number; ms: number }[];

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
            kept: s.kept,
            frames: s.frames,
            startMs: s.startMs,
            ms: s.endMs - s.startMs,
          });
        }
        const kept = input.spans.filter((s) => s.kept);
        for (const [i, span] of kept.entries()) {
          const parked = await input.store.readParked(
            `${input.sceneId}:replay`,
            span.firstFrameIndex,
            span.frames,
          );
          seen.push({
            charged: input.bundle.motionSpans[i]?.byteLength ?? -1,
            parked: parked.reduce((sum, p) => sum + p.bytes.byteLength, 0),
            frames: span.frames,
            ms: span.endMs - span.startMs,
            width: span.width,
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
    "charges each span the bytes it parked, and under the default budget keeps every span",
    async () => {
      const { report, seen, opened } = await take();
      const evidence = JSON.stringify({ seen, opened, report, lines });
      expect(report.outcome, evidence).toBe("complete");
      // The premise the budget test below rests on: two paint runs, each
      // kept, with nothing spent. `opened` says which spans fell under
      // `SPAN_MIN_FRAMES` when it fails.
      expect(
        seen.length,
        `fewer than two spans kept, so "keeps every span" is not tested: ${evidence}`,
      ).toBeGreaterThanOrEqual(2);
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
      // Chrome's 1x: the typing's spans. A loaded machine can also keep a
      // span of a still's echo, at the still's 3x (seen under burners here,
      // after the last step); any other width is red.
      const typed = seen.filter((s) => s.width === 1280 * 2);
      expect(typed.length, evidence).toBeGreaterThanOrEqual(2);
      expect(
        seen.filter((s) => s.width !== 1280 * 2 && s.width !== 1280 * 3),
        evidence,
      ).toEqual([]);
      const bytes = typed.reduce((sum, s) => sum + s.parked, 0);
      const frames = typed.reduce((sum, s) => sum + s.frames, 0);
      const seconds = typed.reduce((sum, s) => sum + s.ms, 0) / 1000;
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
      expect(spent?.[0]?.note).toContain("motion budget spent");
      // From the first span's end to the run's: the second typing run is in
      // the stretch said to be stills.
      const first = bundle?.motionSpans[0];
      expect(spent?.[0]?.startMs, evidence).toBe(first?.endMs);
      expect(spent?.[0]?.endMs ?? 0, evidence).toBeGreaterThan(
        (first?.endMs ?? 0) + 1000,
      );
      expect(report.frames.degradations, evidence).toContain("keyframeOnly");
    },
    TAKE_MS,
  );
});
