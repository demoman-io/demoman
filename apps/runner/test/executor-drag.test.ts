// apps/runner/test/executor-drag.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrandKitsRead } from "@demoman/run-core";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBrowserSession } from "../src/executor/browser.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { installResolver } from "../src/page-agent.js";

/**
 * A drag, performed end to end by the CLI executor against a page that does
 * something with it: a canvas that draws while a button is held, a list a
 * pointer drag reorders, a native range. Each case asserts what the PAGE did
 * (it posts its own results to `/result`), not what the bundle says.
 */
const lines: string[] = [];
const log = (line: string) => void lines.push(line);
let results: { kind: string; value: unknown }[] = [];
/** Every path the page asked the server for, in order. */
let requested: string[] = [];
let server: Server;
let url: string;
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
  const html = await readFile(
    new URL("./fixtures/drag-app.html", import.meta.url),
    "utf8",
  );
  server = createServer((req, res) => {
    if (req.method === "GET") requested.push(req.url ?? "");
    if (req.method === "POST" && req.url === "/result") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        results.push(JSON.parse(body));
        res.end();
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/left" ? "<p>Left</p>" : html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-drag-"));
}, 30_000);
afterAll(async () => {
  await session.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  results = [];
  requested = [];
  lines.length = 0;
});

const library = () => createLibrary(home);
const run = (steps: unknown[], lib = library(), query = "") =>
  runScript(
    {
      scriptVersion: 6,
      name: "drag",
      target: url + query,
      viewport: { width: 1280, height: 800 },
      steps: [{ do: "waitForLoad" }, ...steps],
    } as never,
    {
      session,
      library: lib,
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
/** The page's own report of `kind`, waited for: it is posted, not awaited. */
const result = async (kind: string): Promise<unknown> => {
  for (let i = 0; i < 100; i++) {
    const found = results.find((r) => r.kind === kind);
    if (found !== undefined) return found.value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `the page never reported ${kind}: ${JSON.stringify(results)}`,
  );
};

describe("a drag, performed", () => {
  it("draws a line on a canvas between two spots", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "pad" }, at: { x: 0.1, y: 0.5 } },
        to: { on: { stableId: "pad" }, at: { x: 0.9, y: 0.5 } },
      },
    ]);
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    const pad = (await result("pad")) as { mid: number[]; corner: number[] };
    // The premise: the canvas starts white, so a dark middle was drawn.
    expect(pad.corner).toEqual([255, 255, 255]);
    expect(Math.max(...pad.mid), JSON.stringify(pad)).toBeLessThan(80);
    // The control for the ignored-drag case below: a drag the page took is
    // not said to have done nothing.
    expect(report.frames.degradations).not.toContain("notDragged");
  }, 180_000);

  it("reorders a list", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "item-a" } },
        to: { on: { stableId: "item-b" }, at: { x: 0.5, y: 0.9 } },
      },
    ]);
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    // The fixture opens as A, B, C (its own markup), and only a drag that
    // travelled past its 5px threshold reorders it.
    expect(await result("list")).toEqual(["B", "A", "C"]);
    // The control for the ignored-drag case below: a drag the page took is
    // not said to have done nothing.
    expect(report.frames.degradations).not.toContain("notDragged");
  }, 180_000);

  it("drags a native range from its thumb, never jumping to its centre", async () => {
    const lib = library();
    const report = await run(
      [
        {
          do: "drag",
          from: { on: { stableId: "range" } },
          to: { by: { x: 120, y: 0 } },
        },
      ],
      lib,
    );
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    const passed = (await result("range")) as number[];
    // 30 at 300px wide; +120px is +40.
    expect(passed.at(-1), JSON.stringify(passed)).toBeGreaterThanOrEqual(66);
    expect(passed.at(-1), JSON.stringify(passed)).toBeLessThanOrEqual(74);
    // A press at the track's centre would have passed through 50 first.
    expect(passed[0], JSON.stringify(passed)).toBeLessThan(40);
    // The control for the ignored-drag case below: a drag the page took is
    // not said to have done nothing.
    expect(report.frames.degradations).not.toContain("notDragged");
    // Review of 2026-10-21: the take keeps where it pressed, or the film
    // check and zoom measure a drag from the track's centre.
    const takeId = report.provenance.takeId as string;
    const drag = (await lib.getScene(takeId))?.actions.find(
      (a) => a.kind === "drag",
    );
    const pressedAt = drag?.kind === "drag" ? drag.pressedAt : undefined;
    expect(pressedAt?.x, JSON.stringify(drag)).toBeCloseTo(0.3, 2);
    expect(pressedAt?.y, JSON.stringify(drag)).toBeCloseTo(0.5, 2);
  }, 180_000);

  // Review of 2026-10-21, measured in Chromium: a vertical range runs top to
  // bottom and an rtl one right to left. Pressed on the wrong side of the
  // track, each jumps to 70 before the drag begins.
  for (const [id, by] of [
    ["range-rtl", { x: -120, y: 0 }],
    ["range-tall", { x: 0, y: 120 }],
  ] as const) {
    it(`drags a ${id} from its thumb`, async () => {
      const report = await run([
        { do: "drag", from: { on: { stableId: id } }, to: { by } },
      ]);
      expect(report.outcome, JSON.stringify({ report, lines })).toBe(
        "complete",
      );
      const passed = (await result(id)) as number[];
      expect(passed[0], JSON.stringify(passed)).toBeLessThan(40);
      expect(passed.at(-1), JSON.stringify(passed)).toBeGreaterThanOrEqual(66);
      expect(passed.at(-1), JSON.stringify(passed)).toBeLessThanOrEqual(74);
    }, 180_000);
  }

  it("records the held press from press to release", async () => {
    const lib = library();
    const report = await run(
      [
        {
          do: "drag",
          from: { on: { stableId: "pad" }, at: { x: 0.1, y: 0.2 } },
          to: { on: { stableId: "pad" }, at: { x: 0.9, y: 0.8 } },
        },
      ],
      lib,
    );
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    const takeId = report.provenance.takeId as string;
    const bundle = await lib.frameStore(takeId).getBundle(takeId);
    const held = bundle?.heldPresses ?? [];
    expect(held, JSON.stringify(bundle?.heldPresses)).toHaveLength(1);
    const [h] = held;
    expect((h?.releaseMs ?? 0) - (h?.pressMs ?? 0)).toBeGreaterThan(200);
    const doc = await lib.getScene(takeId);
    const drag = doc?.actions.find((a) => a.kind === "drag");
    expect(
      drag?.kind === "drag" && drag.toRect,
      JSON.stringify(drag),
    ).toBeTruthy();
  }, 180_000);

  // Final review, finding 2: two spellings of a point the door cannot tell
  // apart land on the same pixel once measured, and a drag that goes nowhere
  // is a click the page would report as done.
  it("stops with dragNoDistance when the ends land on the same point", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "blank-a" } },
        to: { on: { stableId: "blank-a" }, at: { x: 0.501, y: 0.5 } },
      },
    ]);
    expect(report.stopped?.reason, JSON.stringify({ report, lines })).toBe(
      "dragNoDistance",
    );
  }, 180_000);

  it("stops with dragEndOutOfView when the end is off screen", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "pad" } },
        to: { on: { stableId: "far" } },
      },
    ]);
    expect(report.stopped?.reason, JSON.stringify({ report, lines })).toBe(
      "dragEndOutOfView",
    );
  }, 180_000);

  // A script names only what the top document holds, so an end inside an
  // iframe is a target the run could not find, and it stops there by name
  // rather than dragging to wherever the frame happens to be.
  it("stops, naming the step, when the end is inside an iframe", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "blank-a" } },
        to: { on: { stableId: "inside" } },
      },
    ]);
    expect(report.stopped?.reason, JSON.stringify({ report, lines })).toBe(
      "unresolvedAnchor",
    );
    expect(report.stopped?.at?.label).toBe("script step 2: drag");
  }, 180_000);

  // Final review, finding 7: this asserted only that nothing failed, which a
  // drop that did not navigate satisfies too.
  it("completes, claiming nothing it could not see, when the drop navigates", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "blank-a" } },
        to: { on: { stableId: "leave" } },
      },
    ]);
    // The premise: the drop left the page.
    expect(requested, JSON.stringify(requested)).toContain("/left");
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    // The page that would say what changed is gone: no "did nothing" claim.
    // Without the navigation this drag changes nothing and reads notDragged.
    expect(report.frames.degradations).not.toContain("notDragged");
  }, 180_000);

  // On a live page: a clock far from the drag ticks throughout (?clock),
  // which read the ignored drag as done until only nearby changes counted
  // (final review, finding 5).
  it("says a drag the page ignored did nothing, and does not read as matching", async () => {
    const report = await run(
      [
        {
          do: "drag",
          from: { on: { stableId: "blank-a" } },
          to: { on: { stableId: "blank-b" } },
        },
      ],
      library(),
      "?clock",
    );
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    // The premise: the page went on changing on <body> and in a scroller
    // while the drag was held (review of 2026-10-21).
    const live = results.filter((r) => r.kind === "live");
    expect(live.length, JSON.stringify(live)).toBeGreaterThan(5);
    expect(
      live.some((r) => (r.value as { toast: boolean }).toast),
      JSON.stringify(live),
    ).toBe(true);
    expect(
      live.some((r) => (r.value as { scrolled: number }).scrolled > 0),
      JSON.stringify(live),
    ).toBe(true);
    expect(report.frames.degradations).toContain("notDragged");
    expect(report.verdict.kind).toBe("diverged");
  }, 180_000);
});

describe("a native drag", () => {
  it("moves a draggable card into the drop zone, its picture under the pointer", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "card-1" } },
        to: { on: { stableId: "drop" } },
      },
    ]);
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    // The premise: the card starts outside the zone, in the fixture's markup.
    expect(await result("dropped")).toEqual({ card: "card-1", into: "drop" });
    const floating = (await result("floating")) as {
      underPointer: boolean;
      text: string;
    };
    expect(floating, JSON.stringify(floating)).toMatchObject({
      underPointer: true,
      text: "One",
    });
    // Final review, finding 6: the copy keeps the card's look, its font
    // (inherited from the body) and its colour.
    const { look, card } = floating as unknown as {
      look: string[];
      card: string[];
    };
    expect(look, JSON.stringify(floating)).toEqual(card);
    expect(await result("after")).toEqual({ pictures: 0 });
    expect(report.frames.degradations).not.toContain("dragPictureMissing");
  }, 180_000);

  it("shows the page's setDragImage picture, not the card", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "card-2" } },
        to: { on: { stableId: "drop" } },
      },
    ]);
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    const floating = (await result("floating")) as {
      underPointer: boolean;
      background: string | null;
      text: string;
    };
    expect(floating, JSON.stringify(floating)).toMatchObject({
      underPointer: true,
      background: "rgb(255, 0, 0)",
      text: "",
    });
  }, 180_000);

  it("removes the picture after the drop, even when the app's drop throws", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "card-4" } },
        to: { on: { stableId: "drop-throws" } },
      },
    ]);
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    expect(await result("dropped")).toEqual({
      card: "card-4",
      into: "drop-throws",
    });
    expect(await result("after")).toEqual({ pictures: 0 });
  }, 180_000);

  // Final review, finding 3: the commonest native failure, a drop on
  // something that is not a drop zone. Chrome fires no drop, and the run read
  // "the browser cancelled the pointer" and a matching verdict.
  it("says a native drop nothing accepted did nothing, and does not read as matching", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "card-1" } },
        to: { on: { stableId: "blank-b" } },
      },
    ]);
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    // The premise: the card never reached a zone.
    expect(results.find((r) => r.kind === "dropped")).toBeUndefined();
    expect(report.frames.degradations).toContain("notDragged");
    expect(report.verdict.kind).toBe("diverged");
  }, 180_000);

  it("stays on mouse events when dragstart is prevented, and says the drag did nothing", async () => {
    const report = await run([
      {
        do: "drag",
        from: { on: { stableId: "card-3" } },
        to: { on: { stableId: "drop" } },
      },
    ]);
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    expect(report.frames.degradations).toContain("notDragged");
  }, 180_000);
});
