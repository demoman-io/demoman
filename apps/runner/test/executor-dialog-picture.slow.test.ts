// DEM-161: a confirm() the run answers is drawn on a hold of the video, and
// the picture shows it. One take through the real executor (held clock, the
// default), exported, and read from decoded frames: the card's OK pill
// (#1a73e8) appears on the hold only, and under it the page is from before
// the answer (Undo, which OK reveals, is not yet there); Undo is there by the
// end. The hold is found in the picture (blue fill frames), never in the
// take's markers, so a wrong record cannot vouch for itself.
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportAnswer } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { listenOnLoopback } from "../src/loopback.js";
import { ownVideo, WALLPAPERS_DIR } from "./fixture.js";
import { sampleMp4 } from "./mp4-probe.js";

// Measured locally: run ~RUN s, export ~EXPORT s; x5 for CI (fff4505).
const RUN_MS = 120_000;
const EXPORT_MS = 300_000;
const VIEWPORT = { width: 1280, height: 800 };
const BLUE: [number, number, number] = [0x1a, 0x73, 0xe8];
const GREEN: [number, number, number] = [0x16, 0xa3, 0x4a];
/** The card's beat (`DIALOG_BEAT_MS`), and the 0.25 s spacing the probe reads at. */
const BEAT_SEC = 1.5;
const SPACING_SEC = 0.25;
/** Fewest blue pixels that is the OK pill (736 measured; a pressed pill is
 *  darker and reads 20), and fewest green that is Undo (7059 smallest). */
const CARD_BLUE_MIN = 200;
const UNDO_GREEN_MIN = 2000;

// The fixture's own page, with #undo given a fixed box and a fill the page
// has nowhere else, so where it is does not depend on a machine's fonts.
const UNDO_CSS = { left: 40, top: 300, width: 240, height: 80 };
const html = async () =>
  (
    await readFile(
      join(import.meta.dirname, "fixtures", "confirm-dialog-app.html"),
      "utf8",
    )
  ).replace(
    "</style>",
    `#undo { position: absolute; left: ${UNDO_CSS.left}px; top: ${UNDO_CSS.top}px; width: ${UNDO_CSS.width}px; height: ${UNDO_CSS.height}px; background: #16a34a; border: 0; } </style>`,
  );

let server: Server;
let home: string;
let executor: LocalExecutor;
let takeId: string;
let recording: unknown;
let dialogs: unknown;

beforeAll(async () => {
  const page = await html();
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  });
  const url = `${await listenOnLoopback(server)}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-dialog-picture-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    standInDisplay: true,
    env: { ...process.env, DEMOMAN_DISPLAY: "1440x900@2" },
    outDir: join(home, "out"),
    log: () => undefined,
  });
  const run = await executor.request("run", {
    video: ownVideo(),
    callId: "dialog-picture-take",
    script: {
      scriptVersion: 9,
      name: "Dialog picture",
      target: url,
      viewport: VIEWPORT,
      look: {
        branding: {
          background: { kind: "solid", color: "#ffffff" },
          logo: null,
        },
      },
      steps: [
        { do: "waitForLoad" },
        { do: "click", on: { stableId: "delete" } },
        { do: "click", on: { stableId: "undo" } },
      ],
    },
  });
  const report = run.ok
    ? (run.value as {
        provenance?: { takeId?: unknown };
        run?: { recording?: unknown };
        dialogs?: unknown;
      })
    : undefined;
  const id = report?.provenance?.takeId;
  if (typeof id !== "string") {
    throw new Error(`the take was not made: ${JSON.stringify(run)}`);
  }
  takeId = id;
  recording = report?.run?.recording;
  dialogs = report?.dialogs;
}, RUN_MS);

afterAll(async () => {
  await executor?.close();
  server?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

describe("a confirm() answered in a held take", () => {
  it(
    "draws the card on a hold, over the page as it was before the answer",
    async () => {
      expect(recording, JSON.stringify(recording)).toEqual({ clock: "held" });
      expect(dialogs, JSON.stringify(dialogs)).toMatchObject([
        { kind: "confirm", answer: "accept", drawn: true },
      ]);
      const out = await executor.request("export", {
        takeId,
        callId: "dialog-picture-export",
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      if (answer.outcome !== "saved" || answer.fileType === "stills") {
        throw new Error(JSON.stringify(answer));
      }
      const win = answer.screens?.moments[0]?.window;
      expect(win, JSON.stringify(answer.screens)).toBeDefined();
      const w = win as { x: number; y: number; width: number; height: number };
      const bytes = new Uint8Array(await readFile(answer.file.path));
      const read = await sampleMp4(bytes, { colors: [BLUE, GREEN] });
      const rows = read.readings.map((r) => ({
        t: r.tSec,
        blue: r.colorCounts[0] as number,
        green: r.colorCounts[1] as number,
      }));
      const said = JSON.stringify({
        window: w,
        frame: [answer.width, answer.height],
        file: answer.file.path,
        rows,
      });
      // Counts of fill pixels, not a point: the camera zooms to the Undo
      // click, so where Undo sits in the frame moves; what is on screen does
      // not. The OK pill alone is the blue fill (736 px at the read's scale
      // while the card is up), Undo alone the green (10229 at its largest).
      const onOk = (r: (typeof rows)[number]) => r.blue > CARD_BLUE_MIN;
      const onUndo = (r: (typeof rows)[number]) => r.green > UNDO_GREEN_MIN;

      // Premise: Undo is in the picture by the end.
      const last = rows.at(-1) as (typeof rows)[number];
      expect(onUndo(last), `Undo (green) at the last frame; ${said}`).toBe(
        true,
      );
      // Premise: no card before the first click (the frame is the page).
      const first = rows[0] as (typeof rows)[number];
      expect(
        [first.blue, first.green],
        `the first frame has no card and no Undo; ${said}`,
      ).toEqual([0, 0]);

      // The hold: the frames showing the OK pill, found in the picture.
      const held = rows.filter(onOk);
      expect(held.length, `frames with the OK pill; ${said}`).toBeGreaterThan(
        0,
      );
      const hStart = (held[0] as (typeof rows)[number]).t;
      const hEnd = (held.at(-1) as (typeof rows)[number]).t;
      // One run of frames, as long as the beat to within the read spacing.
      expect(
        held.length,
        `OK-blue frames are contiguous from ${hStart} to ${hEnd}; ${said}`,
      ).toBe(Math.round((hEnd - hStart) / SPACING_SEC) + 1);
      expect(
        hEnd - hStart + SPACING_SEC,
        `hold length (s) ~ the 1.5 s beat less the pressed tail; ${said}`,
      ).toBeGreaterThanOrEqual(BEAT_SEC - 2 * SPACING_SEC); // the last 300 ms are pressed, darker, unread as blue
      expect(
        hEnd - hStart + SPACING_SEC,
        `hold length (s); ${said}`,
      ).toBeLessThanOrEqual(BEAT_SEC + SPACING_SEC);
      // The card is the only big blue fill: outside the hold, none.
      for (const r of rows.filter((x) => x.t < hStart || x.t > hEnd)) {
        expect(
          r.blue,
          `no card-blue outside the hold at t=${r.t}; ${said}`,
        ).toBeLessThan(50);
      }
      // Under the card, the page is from before the answer.
      for (const r of held) {
        expect(
          onUndo(r),
          `Undo (green) must not show under the card at t=${r.t}; ${said}`,
        ).toBe(false);
      }
      // And Undo appears after the hold.
      const after = rows.filter((r) => r.t > hEnd);
      expect(
        after.some(onUndo),
        `Undo shows after the hold (t > ${hEnd}); ${said}`,
      ).toBe(true);
      // A copy of the export beside the report, for the author's eye.
      if (process.env.DEM161_KEEP_MP4) {
        await copyFile(answer.file.path, process.env.DEM161_KEEP_MP4);
      }
    },
    RUN_MS + EXPORT_MS,
  );
});
