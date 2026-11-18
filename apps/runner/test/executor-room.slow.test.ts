import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAMERA_DEFAULTS,
  type FrameBundle,
  motionTimings,
  planScene,
  resolvePlan,
  toOutputMs,
} from "@demoman/compositor";
import { ARRIVE_MS, BASE_REST_MS, type BrandKitsRead } from "@demoman/run-core";
import { MOTION_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../src/executor/browser.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { listenOnLoopback } from "../src/loopback.js";
import { installResolver } from "../src/page-agent.js";
import { lagCdp } from "./lag.js";

// Spec 2026-10-19 (unhurried beats), through the CLI executor in a real
// browser: each acting step's marker records when its act ended. The camera
// needs room before a zoomed click for the settle (400), the push-in (1300
// at the default smoothness) and the lead-in (350); since spec 2026-11-13 a
// scripted run plans that room into its rest instead of waiting it out.
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
#save{position:absolute;left:260px;top:40px;width:120px;height:32px}
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
<button id="save">Save amount</button>
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
    // DEMOMAN_ROOM_LAG_MS=n holds every CDP command n ms (lag.ts): a slow CI
    // runner on this machine, whose stills and lookups between the typing and
    // the click take longer (DEM-183). From about 80 the screencast stalls
    // too, and the report counts long stills.
    const lag = Number(process.env.DEMOMAN_ROOM_LAG_MS ?? 0);
    if (lag > 0) await lagCdp(context, lag);
  },
});
const kits: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
  migrationPending: false,
};

/** Real time (`DEMOMAN_HELD_CLOCK=0`): a held run plays its planned beats while recording, so the scene carries none for the renderer, which is what this file reads. */
const heldWas = process.env.DEMOMAN_HELD_CLOCK;

beforeAll(async () => {
  process.env.DEMOMAN_HELD_CLOCK = "0";
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/next" ? NEXT_PAGE : PAGE);
  });
  url = `${await listenOnLoopback(server)}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-room-"));
}, 30_000);
afterAll(async () => {
  await session.close();
  if (heldWas === undefined) delete process.env.DEMOMAN_HELD_CLOCK;
  else process.env.DEMOMAN_HELD_CLOCK = heldWas;
  server.close();
  await rm(home, { recursive: true, force: true });
});

type Step = Record<string, unknown>;
const CREATE = { do: "click", on: { text: "Create invoice" } };

async function run(steps: Step[], scriptVersion = 1) {
  const library = createLibrary(home);
  const report = await runScript(
    {
      scriptVersion,
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
    JSON.stringify({
      markers: bundle.markers,
      camera: scene.camera,
      pacing: scene.pacing,
    });
  // The take as it renders: its output clock, and each zoom's segment.
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const out = (sourceMs: number) => toOutputMs(resolved.timeline, sourceMs);
  /** The planned beat before a step, from `scene.pacing`. */
  const beatOf = (stepIndex: number) => {
    const id = markerOf(stepIndex).actionId;
    const beat = scene.pacing?.beats.find((b) => b.beforeActionId === id);
    if (beat === undefined) throw new Error(`no beat: ${said()}`);
    return beat;
  };
  /** The zoom segment on a step's click, on the rendered timeline. */
  const segmentOf = (stepIndex: number) => {
    const id = markerOf(stepIndex).actionId;
    const zoom = scene.camera.find((c) => c.marker.actionId === id);
    const segment = resolved.cameraSegments.find((g) => g.id === zoom?.id);
    if (segment === undefined) throw new Error(`no zoom segment: ${said()}`);
    return segment;
  };
  return {
    report,
    scene,
    bundle,
    markerOf,
    said,
    out,
    beatOf,
    segmentOf,
    resolved,
  };
}

describe("unhurried beats through the executor", () => {
  // Since spec 2026-11-13 (the beat plan) a scripted run waits no room out
  // live: the room goes into the planned rest the take carries as
  // `scene.pacing`, and the renderer plays it; the walk's own rule is also
  // asserted against the fake browser in
  // `packages/replay-engine/test/node/walk-plan.test.ts`.
  // The click goes back to the field it typed into, so the cursor has no
  // walk to make: the gap from the typing's end to the click is the
  // machine's own time plus the settle, under the room on this machine and
  // on a CI runner (DEMOMAN_ROOM_LAG_MS=80 kept it under before the plan).
  // Red if `play.ts` stops handing the walk `beats`: it waits the room out
  // live again, and the gap is at least NEEDED_MS.
  it("waits no room out live before a zoomed click: a scripted run plans it", async () => {
    const { scene, bundle, markerOf, said } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48004800" },
      { do: "click", on: { stableId: "amount" } },
    ]);
    const typed = markerOf(0);
    const click = markerOf(1);
    const actEnd = typed.actEndSourceTimeMs as number;
    expect(actEnd, said()).toBeGreaterThanOrEqual(typed.sourceTimeMs);
    // Premise: both steps act on the same box, so the cursor already rests
    // where the click lands, and the click is zoomed.
    const rectOf = (actionId: string) =>
      bundle.anchorRects.find((r) => r.actionId === actionId)?.rect;
    const rects = `${JSON.stringify(bundle.anchorRects)} ${said()}`;
    expect(rectOf(click.actionId), rects).toBeDefined();
    expect(rectOf(click.actionId), rects).toEqual(rectOf(typed.actionId));
    expect(
      scene.camera.map((c) => c.marker.actionId),
      said(),
    ).toContain(click.actionId);
    expect(click.roomMs, said()).toBeUndefined();
    expect(click.sourceTimeMs - actEnd, said()).toBeLessThan(NEEDED_MS);
  }, 120_000);
  // Each case below waited the room out live before the plan (spec
  // 2026-10-19); a scripted run now plans it into `scene.pacing` and the
  // renderer plays it, so each reads the plan, or the rendered timeline the
  // plan makes.

  // Red if the planned branch asks the rest without the room (walk.ts
  // `restWith(room.neededMs(...))` to `restWith(0)`): the rest is the base
  // and the rendered gap is the machine's.
  it("plans a zoomed click's room after typing into its rest, and the render plays it", async () => {
    const { markerOf, beatOf, out, said } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48004800" },
      { do: "click", on: { stableId: "amount" } },
    ]);
    const typed = markerOf(0);
    const click = markerOf(1);
    // Premise: the take is planned, and the room raised the click's rest
    // above the base.
    const beat = beatOf(1);
    expect(beat.arriveMs, said()).toBe(ARRIVE_MS);
    expect(beat.restMs, said()).toBeGreaterThan(BASE_REST_MS);
    expect(beat.restMs + beat.arriveMs, said()).toBeGreaterThanOrEqual(
      NEEDED_MS - 1,
    );
    // On the rendered timeline the camera has its room from the typing's end.
    expect(
      out(click.sourceTimeMs) - out(typed.actEndSourceTimeMs as number),
      said(),
    ).toBeGreaterThanOrEqual(NEEDED_MS);
  }, 120_000);

  // Red if a pause stops reaching the rest (authored.ts `paused +=
  // step.ms`): the beat is then the base alone.
  it("plans a pause before a zoomed click as the base rest plus the pause", async () => {
    const { beatOf, scene, markerOf, said } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48" },
      { do: "pause", ms: 3000 },
      CREATE,
    ]);
    // Premise: the click zoomed, and the pause outlasts its room.
    expect(
      scene.camera.map((c) => c.marker.actionId),
      said(),
    ).toContain(markerOf(1).actionId);
    expect(BASE_REST_MS + 3000, said()).toBeGreaterThan(NEEDED_MS);
    expect(beatOf(1).restMs, said()).toBe(BASE_REST_MS + 3000);
  }, 120_000);

  // Red if the camera's push-in stops waiting for the act before it on
  // the rendered timeline (`actEnds` in the compositor's `solveCamera`).
  it("starts a zoomed click's push-in after an earlier click's panel has opened, on the rendered timeline", async () => {
    const { markerOf, segmentOf, out, said } = await run([
      { do: "click", on: { text: "Open panel" } },
      CREATE,
    ]);
    const open = markerOf(0);
    const actEnd = open.actEndSourceTimeMs as number;
    // Premise: the panel's slide outlived the click.
    expect(actEnd - open.sourceTimeMs, said()).toBeGreaterThanOrEqual(500);
    expect(segmentOf(1).departMs, said()).toBeGreaterThanOrEqual(out(actEnd));
  }, 120_000);

  // Red if a click that does not zoom is given room (`zooms` ignored in
  // the walk's planned branch): its rest rises above the base. The second
  // click says `zoom: false`: on the designed clock a click on the same
  // button a base rest and an arrive later is 1000 ms on, which is
  // `MIN_ZOOM_GAP_MS` exactly, so the gap rule alone zooms it.
  it("plans the base rest before a click that will not zoom", async () => {
    const { scene, markerOf, beatOf, said } = await run(
      [
        { do: "click", on: { text: "Open panel" } },
        { do: "click", on: { text: "Open panel" }, zoom: false },
      ],
      8,
    );
    // Premise: the second click gets no zoom.
    expect(
      scene.camera.map((c) => c.marker.actionId),
      said(),
    ).not.toContain(markerOf(1).actionId);
    expect(beatOf(1).restMs, said()).toBe(BASE_REST_MS);
  }, 120_000);

  // Task 7 measured 1510 ms here against 2050: the room sat in the rest,
  // before the scroll, and the camera needs it after the page moved. (This
  // replaced the case that asserted the room from the typing's end alone,
  // which the scroll's own motion and the base rest now cover whatever the
  // plan says; it is the last assertion here.) Red if
  // the walk leaves the room out of `afterScrollMs` (walk.ts's zoomed
  // `beats.afterScroll({ zooms: true, … })` to `zooms: false`), or
  // the compositor drops the scroll's stretch (timeline.ts
  // `share(scrollEnd, approach, pace.afterScrollMs)`).
  it("leaves a zoomed click scrolled to its push-in after the scroll, on the rendered timeline", async () => {
    const { scene, bundle, markerOf, beatOf, out, said, resolved } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48" },
      { do: "click", on: { text: "Below the fold" } },
    ]);
    const typed = markerOf(0);
    const click = markerOf(1);
    // Premise: the walk really scrolled, after the typing's act and before
    // the cursor set off, the beat plans a rest after it, and the click
    // really zooms.
    const scrollEnd = click.scrollEndSourceTimeMs as number;
    expect(scrollEnd, said()).toBeGreaterThanOrEqual(
      typed.actEndSourceTimeMs as number,
    );
    expect(scrollEnd, said()).toBeLessThanOrEqual(
      click.approachSourceTimeMs as number,
    );
    expect(beatOf(1).afterScrollMs, said()).toBeGreaterThan(ARRIVE_MS);
    expect(
      scene.camera.map((c) => c.marker.actionId),
      said(),
    ).toContain(click.actionId);
    const { zoomInMs } = motionTimings(
      (scene.motion ?? MOTION_DEFAULTS).smoothness,
    );
    const pushIn =
      CAMERA_DEFAULTS.actSettleMs +
      zoomInMs +
      Math.abs(CAMERA_DEFAULTS.leadInMs);
    // From the first output instant showing the scroll's end. `out` answers
    // a freeze's LAST instant, and when the cursor set off the moment the
    // scroll ended (`scrollEnd === approach`, seen here) the planned rest
    // after the scroll is a freeze standing on exactly that instant.
    const shown = resolved.timeline.segments.find(
      (g) => g.srcEndMs >= scrollEnd,
    );
    const scrollEndOut =
      shown === undefined
        ? Number.NaN
        : shown.srcEndMs === shown.srcStartMs
          ? shown.outStartMs
          : shown.outStartMs +
            ((scrollEnd - shown.srcStartMs) /
              (shown.srcEndMs - shown.srcStartMs)) *
              (shown.outEndMs - shown.outStartMs);
    const afterScroll = out(click.sourceTimeMs) - scrollEndOut;
    console.info(
      `executor-room scroll: after the scroll ${Math.round(afterScroll)} ms (push-in ${pushIn})`,
    );
    // The journey's eased-out end renders as idle inside the arrive; the
    // rule plans `JOURNEY_TAIL_MS` for it (run-core's `beats.ts`), so the
    // room holds with nothing measured added here. The cursor's samples are
    // in the evidence for when it does not.
    const evidence = JSON.stringify({
      said: JSON.parse(said()),
      segments: resolved.timeline.segments.filter(
        (g) => g.srcEndMs >= scrollEnd && g.srcStartMs <= click.sourceTimeMs,
      ),
      cursor: bundle.cursorSamples.filter(
        (c) =>
          c.sourceTimeMs >= scrollEnd && c.sourceTimeMs <= click.sourceTimeMs,
      ),
    });
    expect(afterScroll, evidence).toBeGreaterThanOrEqual(pushIn);
    expect(
      out(click.sourceTimeMs) - out(typed.actEndSourceTimeMs as number),
      evidence,
    ).toBeGreaterThanOrEqual(NEEDED_MS);
  }, 120_000);

  // Red as the typing case above: the cursor makes no journey to the
  // element it rests on, so the rest alone (and the arrive) is the room.
  it("plans a zoomed click's room on the element the cursor rests on into its rest", async () => {
    const { scene, bundle, markerOf, beatOf, said } = await run([
      { do: "type", into: { stableId: "amount" }, text: "48" },
      { do: "hover", on: { text: "Create invoice" } },
      CREATE,
    ]);
    const hover = markerOf(1);
    const click = markerOf(2);
    // Premise: the click is zoomed, on the box the hover left the cursor on.
    expect(
      scene.camera.map((c) => c.marker.actionId),
      said(),
    ).toContain(click.actionId);
    const rectOf = (id: string) =>
      bundle.anchorRects.find((r) => r.actionId === id)?.rect;
    expect(rectOf(click.actionId), said()).toEqual(rectOf(hover.actionId));
    expect(beatOf(2).restMs, said()).toBeGreaterThanOrEqual(
      NEEDED_MS - ARRIVE_MS - 1,
    );
  }, 120_000);

  // Code review 2026-10-20 (R1), on the plan: the new page's paint is the
  // act the camera waits for. Red if the navigation's act ends when the
  // wait for the load begins (as before R1): the push-in would set off
  // while the page is still fading in.
  it("starts a zoomed click's push-in after a navigation's new page has painted, on the rendered timeline", async () => {
    const { bundle, markerOf, segmentOf, out, said } = await run([
      { do: "click", on: { text: "Go next" } },
      { do: "waitForLoad" },
      CREATE,
    ]);
    const click = markerOf(0);
    const waited = markerOf(1);
    // Premise: the new page went on painting after it loaded, and its
    // screen waited that out.
    const after =
      bundle.markers.findIndex((m) => m.actionId === click.actionId) + 1;
    const screen = bundle.pageScreens?.find((p) => p.after === after);
    expect(screen?.unsettled, said()).toBeUndefined();
    expect(screen?.waitedMs ?? 0, said()).toBeGreaterThanOrEqual(600);
    expect(segmentOf(2).departMs, said()).toBeGreaterThanOrEqual(
      out(waited.actEndSourceTimeMs as number),
    );
  }, 120_000);

  // The quiet wait before a zoomed click is a settle, which a plan keeps:
  // the act's end is measured, up to its ceiling.
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

  // Spec 2026-10-22: inside a run the camera pans from zoom to zoom (the
  // author's pacing "C"), and the take's camera agrees.
  it("pans the camera through a run of zoomed clicks", async () => {
    const { scene, bundle, markerOf, said } = await run([
      { do: "click", on: { text: "Run one" } },
      { do: "click", on: { text: "Run two" } },
      { do: "click", on: { text: "Run three" } },
    ]);
    const marks = [0, 1, 2].map(markerOf);
    // Premise: all three are zoomed.
    const zoomed = new Set(scene.camera.map((c) => c.marker.actionId));
    for (const m of marks) expect(zoomed.has(m.actionId), said()).toBe(true);
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
