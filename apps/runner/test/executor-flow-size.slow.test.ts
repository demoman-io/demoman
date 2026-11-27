import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitH264Frame } from "@demoman/compositor";
import type { RunReport } from "@demoman/run-core";
import { DEVICES } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import { createSessionStore } from "../src/executor/sessions.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";
import { serveLoginApp, sessionFor } from "./login-app.js";
import { mp4FirstFrameSize } from "./mp4-probe.js";

// A flow's later runs read the size its latest video was recorded at (spec
// 2026-11-13 part 1). Two executors on one home stand for one library on two
// machines; DEMOMAN_DISPLAY names each one's screen.
let app: { url: string; close(): void };
let home: string;
const executors: LocalExecutor[] = [];

const onDisplay = (display: string) => {
  const executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    standInDisplay: true,
    env: { DEMOMAN_DISPLAY: display },
    outDir: join(home, "out"),
    log: () => undefined,
  });
  executors.push(executor);
  return executor;
};

const script = (more: Record<string, unknown> = {}) => ({
  scriptVersion: 1,
  name: "place an order",
  target: app.url,
  steps: [{ do: "waitForLoad" }, { do: "click", on: { text: "Place order" } }],
  ...more,
});

/** A flow name no earlier run in this file has taken. The home is shared
 *  by every case and every retry of one: under a fixed name the retry was
 *  refused `nameTaken` by its own first attempt's flow. */
let made = 0;
const newFlow = (name: string) => `${name} (${++made})`;

const runOn = async (
  executor: LocalExecutor,
  args: Record<string, unknown>,
): Promise<RunReport & { outcome: string }> => {
  const out = await executor.request("run", args);
  if (!out.ok) throw new Error(JSON.stringify(out));
  const report = out.value as RunReport & { outcome: string };
  if (report.outcome !== "complete") throw new Error(JSON.stringify(report));
  return report;
};

const capturedWidth = async (report: RunReport) => {
  const takeId = report.provenance.takeId as string;
  const doc = await createLibrary(home).getScene(takeId);
  return doc?.meta.capture.viewport.width;
};

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-flow-size-"));
}, 30_000);
afterAll(async () => {
  for (const e of executors) await e.close();
  app.close();
  await rm(home, { recursive: true, force: true });
});

// Timeouts: each case's local time on Apple silicon, 2026-11-13 (one run,
// `--reporter=verbose`), rounded up to the next 5 s, times 10: the ubuntu
// runner has measured up to 7.13x slower (535 s for a file that ran 75-85 s
// here), and x7 on one local measurement left the first case 3% of
// headroom, so the factor carries its own. Each case records several takes
// through real Chromium, so a timeout is a lost case, not a slow one.

describe("a flow's later runs read its size", () => {
  // Turns red when `chooseRunSize` ignores `flow` (run-size.ts): the second
  // run asks the 1600-wide screen and records 1600, not the flow's 1280.
  it("records a later run of the flow at the size its first run was recorded at", async () => {
    const small = onDisplay("1280x800@2");
    const large = onDisplay("1600x1000@2");
    const first = await runOn(small, {
      callId: "flow-size-1",
      video: { new: newFlow("Sized flow") },
      script: script(),
    });
    expect(first.size, JSON.stringify(first.size)).toMatchObject({
      width: 1280,
      from: "screen",
    });
    expect(await capturedWidth(first)).toBe(1280);

    // Premise: a NEW flow recorded under the second display is 1600 wide,
    // so 1280 below can only have come from the flow.
    const elsewhere = await runOn(large, {
      callId: "flow-size-premise",
      video: { new: newFlow("Sized elsewhere") },
      script: script(),
    });
    expect(await capturedWidth(elsewhere)).toBe(1600);

    const again = await runOn(large, {
      callId: "flow-size-2",
      video: { id: first.videoVersion?.id },
      script: script(),
    });
    expect(again.size, JSON.stringify(again.size)).toMatchObject({
      width: 1280,
      height: 800,
      from: "flow",
      error: null,
    });
    expect(await capturedWidth(again)).toBe(1280);

    // A script that names its own viewport wins, and is what the next run
    // reads (it is the latest video's size now).
    const named = await runOn(large, {
      callId: "flow-size-3",
      video: { id: first.videoVersion?.id },
      script: script({ viewport: { width: 1000, height: 700 } }),
    });
    expect(named.size).toMatchObject({ width: 1000, from: "script" });
    const after = await runOn(large, {
      callId: "flow-size-4",
      video: { id: first.videoVersion?.id },
      script: script(),
    });
    expect(after.size).toMatchObject({ width: 1000, from: "flow" });
  }, 300_000); // measured 28.5 s: 30 s x 10

  // Turns red when `prepareStage` stops carrying `deps.flowSizeUnread` onto
  // `size.error` (play.ts `said`), or `runJob` stops passing it: the run
  // would read as a first run at the screen's size, `error: null`.
  it("says on size.error that the flow's recorded size could not be read", async () => {
    const small = onDisplay("1280x800@2");
    const large = onDisplay("1600x1000@2");
    const first = await runOn(small, {
      callId: "flow-unread-1",
      video: { new: newFlow("Unread flow") },
      script: script(),
    });
    const flowId = first.videoVersion?.id;
    // Premise: with a readable report the same flow records at its size.
    const readable = await runOn(large, {
      callId: "flow-unread-2",
      video: { id: flowId },
      script: script(),
    });
    expect(readable.size, JSON.stringify(readable.size)).toMatchObject({
      width: 1280,
      from: "flow",
      error: null,
    });
    // Premise: the screen is 1600 wide, so a size of 1600 came from it.
    const latest = readable.provenance.takeId as string;
    await createLibrary(home).putJson(latest, "report.json", {
      size: { width: "wide", height: 800, from: "screen" },
    });
    const unread = await runOn(large, {
      callId: "flow-unread-3",
      video: { id: flowId },
      script: script(),
    });
    expect(unread.size, JSON.stringify(unread.size)).toMatchObject({
      width: 1600,
      from: "screen",
    });
    expect(unread.size?.error).toBe(
      `The flow's recorded size could not be read (video ${latest}'s run report names a size that is not one ({"width":"wide","height":800,"from":"screen"})), so this run used this screen's.`,
    );
  }, 200_000); // measured 17.8 s: 20 s x 10
});

// Spec 2026-11-13 part 2: a headless run's scale is DEMOMAN_DISPLAY's, else
// the flow's recorded one, else CAPTURE_SCALE for its device; never the
// screen's. One executor with no DEMOMAN_DISPLAY records the cases after
// the first, so a run that wants another scale than the one before it
// launches the browser again (ruling 4): asserted on the session's own log
// line for each change.
describe("a flow's later runs read its scale", () => {
  const recordedScale = async (report: RunReport, at = home) => {
    const takeId = report.provenance.takeId as string;
    const doc = await createLibrary(at).getScene(takeId);
    return doc?.meta.capture.displayScale;
  };
  const relaunched = (from: number, to: number) =>
    `the headless browser records at ${from}x and this call records at ${to}x; starting a new one`;
  const unsetOn = (at: string, lines: string[]) => {
    const executor = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
      home: at,
      headless: true,
      standInDisplay: true,
      env: {},
      outDir: join(at, "out"),
      log: (line) => void lines.push(line),
    });
    executors.push(executor);
    return executor;
  };

  // Turns red when `runJob` stops passing `flowScaleOf`'s scale to
  // `captureScale` (executor.ts): the flow's second run records at 2.
  it("records a flow first recorded at 1x at 1x, a new flow at 2, and a phone at 3", async () => {
    const at1 = onDisplay("1280x800@1");
    const first = await runOn(at1, {
      callId: "flow-scale-1",
      video: { new: newFlow("Flow at 1x") },
      script: script(),
    });
    // DEMOMAN_DISPLAY's scale wins, and is what the take records.
    expect(await recordedScale(first)).toBe(1);
    const lines: string[] = [];
    const unset = unsetOn(home, lines);
    // Premise: a new flow on this executor records at the constant.
    const fresh = await runOn(unset, {
      callId: "flow-scale-premise",
      video: { new: newFlow("Flow at the constant") },
      script: script(),
    });
    expect(await recordedScale(fresh)).toBe(2);

    const phone = await runOn(unset, {
      callId: "flow-scale-phone",
      video: { new: newFlow("Phone flow") },
      script: script({ device: "phone" }),
    });
    expect(await recordedScale(phone)).toBe(3);
    // The picture, not the record: the phone's motion decodes at its width
    // times 3, evened for H.264 (`fitH264Frame`: 393 x 3 = 1179 is cropped
    // to 1178). Turns red when the phone run is not launched again
    // at 3 (browser.ts `rescale`): the span decodes at 786 (393 x 2).
    const phoneTake = phone.provenance.takeId as string;
    const store = createLibrary(home).frameStore(phoneTake);
    const spans = (await store.getBundle(phoneTake))?.motionSpans ?? [];
    // Premise: the phone run has motion to decode (the click's response).
    expect(spans.length, JSON.stringify(spans)).toBeGreaterThan(0);
    const widest = spans.reduce((a, b) => (b.width > a.width ? b : a));
    const decoded = await mp4FirstFrameSize(await store.load(widest.ref));
    const wanted = fitH264Frame(
      DEVICES.phone.width * 3,
      DEVICES.phone.height * 3,
    );
    expect(decoded, JSON.stringify({ widest, decoded, wanted })).toMatchObject({
      width: wanted.width,
      height: wanted.height,
    });

    const again = await runOn(unset, {
      callId: "flow-scale-2",
      video: { id: first.videoVersion?.id },
      script: script(),
    });
    expect(await recordedScale(again)).toBe(1);
    expect(again.size?.error ?? null).toBeNull();
    // Each change of scale between consecutive runs (2, 3, 1: asserted
    // above) launched the browser again, and said so. Turns red when
    // `ensure` drops `rescale`: no such line, and the scales above go too.
    expect(lines, JSON.stringify(lines)).toEqual(
      expect.arrayContaining([relaunched(2, 3), relaunched(3, 1)]),
    );
  }, 300_000); // measured 25.6 s: 30 s x 10

  // The relaunch for scale happens at the door, before the run's saved
  // sessions load, so the new browser has them (and a relaunch after the
  // door is `prepareStage`'s reload). Turns red when the saved sessions do
  // not reach the browser launched for this scale: measured by relaunching
  // after `sessions.load` with that reload switched off, when the desk run
  // (relaunched from the premise's 3x to 2x) stops as signedOut.
  it("is still signed in after a relaunch for scale", async () => {
    const app = await serveLoginApp();
    const at = await mkdtemp(join(tmpdir(), "demoman-flow-scale-signin-"));
    const lines: string[] = [];
    const unset = unsetOn(at, lines);
    const behind = (callId: string, name: string, device?: "phone") =>
      unset.request("run", {
        callId,
        video: { new: name },
        script: {
          scriptVersion: device === undefined ? 1 : 4,
          name,
          target: `${app.url}/app`,
          ...(device === undefined
            ? { viewport: { width: 1024, height: 640 } }
            : { device }),
          steps: [{ do: "waitForLoad" }, { do: "click", on: { text: "Next" } }],
        },
      }) as Promise<{ ok: boolean; value: RunReport & { outcome: string } }>;
    try {
      // Premise: the same phone run with no saved session is signed out.
      const out = await behind("signin-premise", "Phone signed out", "phone");
      expect(out.value.stopped?.reason, JSON.stringify(out)).toBe("signedOut");

      await createSessionStore(at).save(sessionFor(app, app.validCookie()));
      const desk = await behind("signin-desk", "Desk signed in");
      expect(desk.value.outcome, JSON.stringify(desk)).toBe("complete");
      expect(await recordedScale(desk.value, at)).toBe(2);
      const phone = await behind("signin-phone", "Phone signed in", "phone");
      expect(phone.value.outcome, JSON.stringify(phone)).toBe("complete");
      expect(await recordedScale(phone.value, at)).toBe(3);
      // Premise: both signed-in runs came after a relaunch for their scale
      // (the premise run left the browser at 3).
      expect(lines, JSON.stringify(lines)).toEqual(
        expect.arrayContaining([relaunched(3, 2), relaunched(2, 3)]),
      );
    } finally {
      await app.close();
      await rm(at, { recursive: true, force: true });
    }
  }, 150_000); // measured 11.2 s: 15 s x 10
});
