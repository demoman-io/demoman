import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportAnswer, RunReport } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { WALLPAPERS_DIR } from "./fixture.js";
import { sampleMp4 } from "./mp4-probe.js";

// Two runs and three exports of a short take, measured as
// executor-export-zooms.test.ts's (x5 for CI). The test's own timeout is one
// run and three exports: the untouched take's, the hand-edited one's (what
// export says before any re-film), and the re-film's.
const RUN_MS = 60_000;
const EXPORT_MS = 120_000;

const RED: [number, number, number] = [220, 0, 0];
const BLUE: [number, number, number] = [0, 0, 220];

const APP = `<!doctype html><meta charset=utf-8><title>Refilm</title>
<style>
  body { margin: 0; background: #fff; }
  #q { position: absolute; left: 40px; top: 40px; width: 300px; height: 32px; }
  .row { position: absolute; left: 40px; width: 600px; height: 120px; }
  #red { top: 200px; background: rgb(220,0,0); }
  #blue { top: 360px; background: rgb(0,0,220); }
  [hidden] { display: none; }
</style>
<input id=q aria-label=Filter>
<div class=row id=red data-name=red></div>
<div class=row id=blue data-name=blue></div>
<script>
  q.addEventListener("input", () => {
    for (const r of document.querySelectorAll(".row"))
      r.hidden = q.value !== "" && !r.dataset.name.includes(q.value);
  });
</script>`;

let server: Server;
let home: string;
let executor: LocalExecutor;
let firstTake: string;
let videoId: string;

const runOf = async (args: Record<string, unknown>) => {
  const out = await executor.request("run", args);
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value as RunReport & { outcome: string };
};

const exportOf = async (takeId: string, callId: string) => {
  const out = await executor.request("export", { takeId, callId });
  if (!out.ok) throw new Error(JSON.stringify(out));
  const answer = out.value as ExportAnswer;
  if (answer.outcome !== "saved" || answer.fileType === "stills")
    throw new Error(JSON.stringify(answer));
  return answer;
};

/** Red and blue at the video's last reading, with the export's answer. */
async function lastColours(takeId: string, callId: string) {
  const answer = await exportOf(takeId, callId);
  const read = await sampleMp4(await readFile(answer.file.path), {
    colors: [RED, BLUE],
  });
  const last = read.readings[read.readings.length - 1];
  if (last === undefined) throw new Error("the video has no readings");
  return {
    red: last.colorCounts[0] ?? 0,
    blue: last.colorCounts[1] ?? 0,
    answer,
  };
}

beforeAll(async () => {
  server = createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(APP);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = await mkdtemp(join(tmpdir(), "demoman-refilm-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  const first = await runOf({
    callId: "refilm-first",
    video: { new: "Refilm" },
    script: {
      scriptVersion: 1,
      name: "Refilm",
      target: url,
      viewport: { width: 1280, height: 800 },
      look: {
        branding: {
          background: { kind: "solid", color: "#ffffff" },
          logo: null,
          padding: 0,
        },
      },
      steps: [
        { do: "waitForLoad" },
        { do: "pause", ms: 700 },
        { do: "type", into: { stableId: "q" }, text: "red" },
        // On the field, not on a row: a wait on a row bakes the old answer
        // into the script, and the edited re-film would stop at it.
        { do: "waitFor", on: { stableId: "q" }, until: "visible" },
        { do: "pause", ms: 1200 },
      ],
    },
  });
  const id = first.provenance.takeId;
  if (first.outcome !== "complete" || id === null)
    throw new Error(JSON.stringify(first));
  firstTake = id;
  if (first.videoVersion === undefined) throw new Error(JSON.stringify(first));
  videoId = first.videoVersion.id;
}, RUN_MS);

afterAll(async () => {
  await executor.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});

describe("re-filming a take whose typed text was edited", () => {
  it(
    "films the page's response to the new text, and keeps the pauses",
    async () => {
      // The fixture: the original take shows the red row and no blue one.
      const before = await lastColours(firstTake, "refilm-export-1");
      const said = JSON.stringify({ ...before, answer: undefined });
      expect(before.red, said).toBeGreaterThan(1000);
      expect(before.blue, said).toBe(0);
      // An untouched CLI take reads as untouched: nothing edited, and its
      // script.json's digests were compared (not skipped for want of one).
      if (before.answer.outcome !== "saved") throw new Error(said);
      expect(before.answer.warnings.editedSinceRecorded).toEqual([]);
      expect(before.answer.warnings.targetCheck).toBe("checked");

      // The author's edit, by hand: red -> blue.
      const library = createLibrary(home);
      const scene = await library.getScene(firstTake);
      if (scene === null) throw new Error("the first take is gone");
      const typed = scene.actions.find((a) => a.kind === "type");
      expect(typed).toMatchObject({ text: "red" });
      await library.putScene({
        ...scene,
        actions: scene.actions.map((a) =>
          a.kind === "type" ? { ...a, text: "blue" } : a,
        ),
      });
      if (typed === undefined) throw new Error("the first take typed nothing");

      // Before any re-film, export says exactly that one edit.
      const edited = await exportOf(firstTake, "refilm-export-edited");
      if (edited.outcome !== "saved") throw new Error(JSON.stringify(edited));
      expect(edited.warnings.editedSinceRecorded).toEqual([
        { actionId: typed.id, what: "text", was: "red", now: "blue" },
      ]);
      expect(edited.warnings.targetCheck).toBe("checked");
      // Red (final review 2): leave the video out of the report — the
      // summary cannot name the call that re-records it.
      expect(edited.warnings.videoId).toBe(videoId);
      expect(edited.summary).toContain(
        `run({ video: { id: "${videoId}" } }) re-records it`,
      );

      const refilm = await runOf({
        callId: "refilm-second",
        video: { id: videoId },
      });
      expect(refilm.outcome, JSON.stringify(refilm.stopped)).toBe("complete");
      expect(refilm.rerecord?.from).toBe(firstTake);
      expect(refilm.rerecord?.notes).toEqual([]);
      const second = refilm.provenance.takeId;
      if (second === null) throw new Error(JSON.stringify(refilm));
      expect(second).not.toBe(firstTake);
      // The re-record is the video's next version, not a video of its own.
      expect(refilm.videoVersion).toEqual({
        id: videoId,
        name: "Refilm",
        version: 2,
        created: false,
      });

      const after = await lastColours(second, "refilm-export-2");
      const colours = JSON.stringify({
        before: { red: before.red, blue: before.blue },
        after: { red: after.red, blue: after.blue },
      });
      expect(after.blue, colours).toBeGreaterThan(1000);
      expect(after.red, colours).toBe(0);

      // Review Focus 5: the re-film's own skeleton keeps the pauses, so a
      // re-film of the re-film would too.
      const sk = await library.getSkeleton(second);
      if (sk.kind !== "ok") throw new Error(JSON.stringify(sk));
      expect(
        sk.skeleton.steps
          .filter((s) => s.do === "pause")
          .map((s) => (s as { ms: number }).ms),
      ).toEqual([700, 1200]);
    },
    RUN_MS + 3 * EXPORT_MS,
  );
});
