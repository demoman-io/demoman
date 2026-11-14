import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunReport } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";

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

describe("a flow's later runs read its size", () => {
  // Turns red when `chooseRunSize` ignores `flow` (run-size.ts): the second
  // run asks the 1600-wide screen and records 1600, not the flow's 1280.
  it("records a later run of the flow at the size its first run was recorded at", async () => {
    const small = onDisplay("1280x800@2");
    const large = onDisplay("1600x1000@2");
    const first = await runOn(small, {
      callId: "flow-size-1",
      video: { new: "Sized flow" },
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
      video: { new: "Sized elsewhere" },
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
  }, 400_000);

  // Turns red when `prepareStage` stops carrying `deps.flowSizeUnread` onto
  // `size.error` (play.ts `said`), or `runJob` stops passing it: the run
  // would read as a first run at the screen's size, `error: null`.
  it("says on size.error that the flow's recorded size could not be read", async () => {
    const small = onDisplay("1280x800@2");
    const large = onDisplay("1600x1000@2");
    const first = await runOn(small, {
      callId: "flow-unread-1",
      video: { new: "Unread flow" },
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
  }, 400_000);
});
