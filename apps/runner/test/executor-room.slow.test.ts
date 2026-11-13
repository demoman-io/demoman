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
  // Since spec 2026-11-13 (the beat plan) a scripted run waits no room out
  // live: the room goes into the planned rest the walk returns as `pacing`,
  // and the renderer plays it. Nothing at this level carries `pacing` until
  // the take writes it into `scene.pacing`, so the live-wait cases below
  // are todos for that task; the walk's own rule is asserted against the
  // fake browser in `packages/replay-engine/test/node/walk-plan.test.ts`
  // (a zoomed click's rest covers its room and nothing is slept, a pause is
  // added to the rest, a click that does not zoom or pans gets the base).
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
  it.todo(
    "Task 7: a zoomed click after typing has a planned rest of at least its room less the journey and the arrive, read from scene.pacing",
  );
  it.todo(
    "Task 7: a zoomed click after a 3000 ms pause has the base rest plus the pause, read from scene.pacing",
  );
  it.todo(
    "Task 7: a zoomed click after a click that opens a sliding panel starts its push-in after the slide, on the rendered timeline",
  );
  it.todo(
    "Task 7: a second click that does not zoom has the base rest, read from scene.pacing",
  );
  it.todo(
    "Task 7: a zoomed click scrolled into view has its planned room after the scroll, on the rendered timeline",
  );
  it.todo(
    "Task 7: a zoomed click on the element the cursor rests on (no journey) has a rest of at least its room less the arrive, read from scene.pacing",
  );
  it.todo(
    "Task 7: a zoomed click after a navigation starts its push-in after the new page has painted, on the rendered timeline",
  );

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
