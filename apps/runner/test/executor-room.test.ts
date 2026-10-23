import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FrameBundle, planScene, resolvePlan } from "@demoman/compositor";
import type { BrandKitsRead } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../src/executor/browser.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { listenOnLoopback } from "../src/loopback.js";
import { installResolver } from "../src/page-agent.js";

// Spec 2026-10-19 (unhurried beats), through the CLI executor in a real
// browser: each acting step's marker records when its act ended, and the
// replay waits before a zoomed click until the camera has room for the
// settle (400), the push-in (1300 at the default smoothness) and the
// lead-in (350).
const NEEDED_MS = 400 + 1300 + 350;

// The page: a field at the top left, a button at the bottom right (far
// enough to be its own zoom), a button that slides a panel in over 700 ms,
// one that starts a spinner that never stops, a button below the fold, and
// a row of three plain buttons for a quick run of clicks.
const PAGE = `<!doctype html><meta charset=utf-8><title>room</title>
<style>
body{margin:0;font:16px sans-serif;background:#fff;min-height:2400px}
#amount{position:absolute;left:40px;top:40px;width:200px;height:32px;font:16px monospace}
#open{position:absolute;left:40px;top:120px;width:160px;height:40px}
#panel{position:absolute;left:300px;top:120px;width:400px;height:300px;background:#246;transform:translateX(1000px);transition:transform 700ms linear}
#panel.on{transform:none}
#spin{position:absolute;left:40px;top:200px;width:160px;height:40px}
#spinner{position:absolute;left:300px;top:520px;width:40px;height:40px;background:#c33}
#spinner.on{animation:r 400ms linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
#create{position:absolute;left:1060px;top:720px;width:160px;height:40px}
#below{position:absolute;left:1060px;top:1900px;width:160px;height:40px}
#r1{position:absolute;left:300px;top:400px;width:120px;height:40px}
#r2{position:absolute;left:650px;top:430px;width:120px;height:40px}
#r3{position:absolute;left:1000px;top:460px;width:120px;height:40px}
</style>
<input id="amount" aria-label="Amount">
<button id="open" onclick="document.getElementById('panel').classList.add('on')">Open panel</button>
<div id="panel"></div>
<button id="spin" onclick="document.getElementById('spinner').classList.add('on')">Spin</button>
<div id="spinner"></div>
<button id="create">Create invoice</button>
<button id="below">Below the fold</button>
<button id="r1">Run one</button>
<button id="r2">Run two</button>
<button id="r3">Run three</button>
<a id="go" href="/next" style="position:absolute;left:40px;top:280px">Go next</a>`;

// A second page that keeps painting after it has loaded: a panel fading in
// over 800 ms. A zoomed click on it must wait for that, not for the load.
const NEXT_PAGE = `<!doctype html><meta charset=utf-8><title>next</title>
<style>
body{margin:0;font:16px sans-serif;background:#fff}
#fade{position:absolute;left:300px;top:120px;width:500px;height:400px;background:#246;animation:f 800ms linear}
@keyframes f{from{opacity:0}to{opacity:1}}
#create{position:absolute;left:1060px;top:720px;width:160px;height:40px}
</style>
<div id="fade"></div>
<button id="create">Create invoice</button>`;

const lines: string[] = [];
const log = (line: string) => void lines.push(line);
let url: string;
let server: ReturnType<typeof createServer>;
let home: string;
const session = createBrowserSession({
  headless: true,
  log,
  onLaunched: async ({ context }) => {
    await installResolver(context);
    await installExecutorEntry(context);
  },
});
const kits: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
  migrationPending: false,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/next" ? NEXT_PAGE : PAGE);
  });
  url = `${await listenOnLoopback(server)}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-room-"));
}, 30_000);
afterAll(async () => {
  await session.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});

type Step = Record<string, unknown>;
const CREATE = { do: "click", on: { text: "Create invoice" } };

async function run(steps: Step[]) {
  const library = createLibrary(home);
  const report = await runScript(
    {
      scriptVersion: 1,
      name: "room",
      target: url,
      viewport: { width: 1280, height: 800 },
      steps: [{ do: "waitForLoad" }, ...steps],
    } as never,
    {
      session,
      library,
      kits,
      log,
      sessions: [],
      sessionStore: createSessionStore(home),
      signinCommand: "npx demoman signin",
      loadSessions: async () => ({ ok: true as const, files: [] }),
      sessionsContext: {} as BrowserContext,
    },
    () => undefined,
  );
  const evidence = () => JSON.stringify({ report, lines: lines.slice(-20) });
  expect(report.outcome, evidence()).toBe("complete");
  const takeId = report.provenance.takeId as string;
  const scene = (await library.getScene(takeId)) as SceneDocument;
  const bundle = (await library
    .frameStore(takeId)
    .getBundle(takeId)) as FrameBundle;
  // Marker i+1 is script step i (the opening waitForLoad is marker 0).
  const markerOf = (stepIndex: number) => {
    const id = scene.actions[stepIndex + 1]?.id;
    const marker = bundle.markers.find((m) => m.actionId === id);
    if (marker === undefined) throw new Error(`no marker: ${evidence()}`);
    return marker;
  };
  const said = () =>
    JSON.stringify({ markers: bundle.markers, camera: scene.camera });
  return { report, scene, bundle, markerOf, said };
}

describe("unhurried beats through the executor", () => {
  it("waits before a zoomed click until the camera has room, and says how long", async () => {
    const { report, scene, markerOf, said } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48004800" },
      CREATE,
    ]);
    const typed = markerOf(0);
    const click = markerOf(1);
    const actEnd = typed.actEndSourceTimeMs as number;
    expect(actEnd, said()).toBeGreaterThanOrEqual(typed.sourceTimeMs);
    // Premise: the click is zoomed, and without the wait there was no room.
    expect(
      scene.camera.map((c) => c.marker.actionId),
      said(),
    ).toContain(click.actionId);
    expect(click.roomMs, said()).toBeGreaterThan(0);
    expect(
      click.sourceTimeMs - (click.roomMs as number) - actEnd,
      said(),
    ).toBeLessThan(NEEDED_MS);
    expect(click.sourceTimeMs - actEnd, said()).toBeGreaterThanOrEqual(
      NEEDED_MS,
    );
    // The report carries it, and does not call it a stall.
    const film = report.video as {
      summary: { longStill: number };
      steps: { actionId: string; roomMs: number | null }[];
    };
    expect(
      film.steps.find((s) => s.actionId === click.actionId)?.roomMs,
      said(),
    ).toBe(click.roomMs);
    expect(film.summary.longStill, said()).toBe(0);
  }, 120_000);

  it("waits nothing when there is already room", async () => {
    const { markerOf, said } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48" },
      { do: "pause", ms: 3000 },
      CREATE,
    ]);
    const typed = markerOf(0);
    // The pause yields no marker, so the click is script step 2, marker 2.
    const click = markerOf(1);
    expect(
      click.sourceTimeMs - (typed.actEndSourceTimeMs as number),
      `premise: ${said()}`,
    ).toBeGreaterThanOrEqual(NEEDED_MS);
    expect(click.roomMs, said()).toBeUndefined();
  }, 120_000);

  it("holds a zoomed click until an earlier click's panel has finished opening", async () => {
    const { markerOf, said } = await run([
      { do: "click", on: { text: "Open panel" } },
      CREATE,
    ]);
    const open = markerOf(0);
    const create = markerOf(1);
    const actEnd = open.actEndSourceTimeMs as number;
    // Premise: the panel's slide outlived the click.
    expect(actEnd - open.sourceTimeMs, said()).toBeGreaterThanOrEqual(500);
    expect(create.sourceTimeMs - actEnd, said()).toBeGreaterThanOrEqual(
      NEEDED_MS,
    );
  }, 120_000);

  it("stops waiting for a page that never goes quiet", async () => {
    const { markerOf, said } = await run([
      { do: "click", on: { text: "Spin" } },
      CREATE,
    ]);
    const spin = markerOf(0);
    const actEnd = spin.actEndSourceTimeMs as number;
    // Premise: the spinner was still painting at the ceiling.
    expect(actEnd - spin.sourceTimeMs, said()).toBeGreaterThanOrEqual(900);
    // The click's verb is short; its act ends at most 1000 ms after it.
    expect(actEnd - spin.sourceTimeMs, said()).toBeLessThan(2000);
  }, 120_000);

  it("waits nothing before a click that will not zoom", async () => {
    const { scene, markerOf, said } = await run([
      { do: "click", on: { text: "Open panel" } },
      { do: "click", on: { text: "Open panel" } },
    ]);
    const second = markerOf(1);
    // Premise: the second click on the same button gets no zoom.
    expect(
      scene.camera.map((c) => c.marker.actionId),
      said(),
    ).not.toContain(second.actionId);
    expect(second.roomMs, said()).toBeUndefined();
  }, 120_000);

  // The cursor's journey the walk counts toward the room is the one it will
  // make: from where the cursor is to the target as measured after the
  // approach scroll (final review C1, 2026-10-19). The plan the source made
  // before the scroll is longer for a target below the fold, and nothing at
  // all for a target the cursor already rests on.
  it("leaves room for a click whose target is scrolled to", async () => {
    const { scene, markerOf, bundle, said } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48" },
      { do: "click", on: { text: "Below the fold" } },
    ]);
    const typed = markerOf(0);
    const click = markerOf(1);
    // Premise: the click is zoomed, and its target was scrolled into view.
    expect(
      scene.camera.map((c) => c.marker.actionId),
      said(),
    ).toContain(click.actionId);
    const rect = bundle.anchorRects.find((r) => r.actionId === click.actionId);
    expect(rect?.rect.y ?? 0, said()).toBeLessThan(800);
    expect(
      click.sourceTimeMs - (typed.actEndSourceTimeMs as number),
      said(),
    ).toBeGreaterThanOrEqual(NEEDED_MS);
  }, 120_000);

  it("leaves room for a click on the element the cursor already rests on", async () => {
    const { scene, markerOf, said } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48" },
      { do: "hover", on: { text: "Create invoice" } },
      CREATE,
    ]);
    const hover = markerOf(1);
    const click = markerOf(2);
    expect(
      scene.camera.map((c) => c.marker.actionId),
      said(),
    ).toContain(click.actionId);
    expect(
      click.sourceTimeMs - (hover.actEndSourceTimeMs as number),
      said(),
    ).toBeGreaterThanOrEqual(NEEDED_MS);
  }, 120_000);

  // Code review 2026-10-20 (R1): a navigation's act went on until the next
  // page had painted, but the act was settled when the wait for the load
  // began, so a zoomed click after it got no room and the camera pushed in
  // while the new page was still coming in.
  it("holds a zoomed click after a navigation until the new page has settled", async () => {
    const { markerOf, said } = await run([
      { do: "click", on: { text: "Go next" } },
      { do: "waitForLoad" },
      CREATE,
    ]);
    const waited = markerOf(1);
    const create = markerOf(2);
    const actEnd = waited.actEndSourceTimeMs as number;
    // Premise: the new page went on painting after the load was met.
    expect(actEnd - waited.sourceTimeMs, said()).toBeGreaterThanOrEqual(100);
    expect(create.sourceTimeMs - actEnd, said()).toBeGreaterThanOrEqual(
      NEEDED_MS,
    );
  }, 120_000);

  // R7: the approach scroll moves the page under the camera too, so the
  // camera's room is measured from its end.
  it("leaves the camera its room after the approach scroll", async () => {
    const { bundle, markerOf, said } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48" },
      { do: "click", on: { text: "Below the fold" } },
    ]);
    const typed = markerOf(0);
    const click = markerOf(1);
    const scroll = bundle.motionSpans
      .filter(
        (m) =>
          m.startMs > (typed.actEndSourceTimeMs as number) &&
          m.endMs <= click.sourceTimeMs,
      )
      .at(-1);
    // Premise: the scroll was filmed between the typing and the click.
    expect(scroll, said()).toBeDefined();
    const scrolledAt = (scroll?.endMs ?? 0) - 250; // its last paint
    expect(click.sourceTimeMs - scrolledAt, said()).toBeGreaterThanOrEqual(
      NEEDED_MS,
    );
  }, 120_000);

  // Spec 2026-10-22: inside a run the camera pans from zoom to zoom, so the
  // walk adds no room there (the author's pacing "C"), and the camera agrees.
  it("moves on from each click of a run as soon as it is done, and the camera pans the run", async () => {
    const { scene, bundle, markerOf, said } = await run([
      { do: "click", on: { text: "Run one" } },
      { do: "click", on: { text: "Run two" } },
      { do: "click", on: { text: "Run three" } },
    ]);
    const marks = [0, 1, 2].map(markerOf);
    // Premise: all three are zoomed.
    const zoomed = new Set(scene.camera.map((c) => c.marker.actionId));
    for (const m of marks) expect(zoomed.has(m.actionId), said()).toBe(true);
    expect(marks[1]?.roomHeldMs, said()).toBeUndefined();
    expect(marks[2]?.roomHeldMs, said()).toBeUndefined();
    const segments = resolvePlan(
      planScene(scene),
      bundle,
      scene,
    ).cameraSegments;
    expect(segments, said()).toHaveLength(3);
    for (let i = 0; i + 1 < segments.length; i++) {
      expect(segments[i]?.endMs, `${JSON.stringify(segments)} ${said()}`).toBe(
        segments[i + 1]?.startMs,
      );
    }
  }, 120_000);
});
