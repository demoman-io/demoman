// A target the run finds by a weaker tier than its capture had is said in
// the run report, not only in the server's log: the step still passes, so
// the report is the agent's one chance to hear the page changed under it.
//
// The page changes mid-step on purpose. "Later" is captured by its stable
// id while it is still hidden; the wait then finds it shown, with its id
// gone, by a weaker tier (its text, as the ladder stands).
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunReport } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { listenOnLoopback } from "../src/loopback.js";
import { ownVideo, WALLPAPERS_DIR } from "./fixture.js";

// One short headless run; x5 for CI's slower runner, with margin.
const CASE_MS = 90_000;

/** Clicking Show reveals Later 3 s on (page time) and drops its id as it
 *  does: long enough that the wait's capture comes first, well inside the
 *  wait's 10 s. */
const PAGE = `<!doctype html><meta charset=utf-8><title>weaker</title><link rel=icon href="data:,">
<style>button{position:absolute;left:40px;width:160px;height:40px}#show{top:40px}#late{top:200px;visibility:hidden}</style>
<button id=show>Show</button><button id=late>Later</button>
<script>document.getElementById("show").addEventListener("click", () => setTimeout(() => {
  const late = document.getElementById("late");
  late.removeAttribute("id");
  late.style.visibility = "visible";
}, 3000))</script>`;

let server: Server;
let home: string;
let url: string;
let executor: LocalExecutor;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  url = `${await listenOnLoopback(server)}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-found-weaker-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await executor?.close();
  server?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

describe("a run whose target is found by a weaker tier", () => {
  it(
    "says so in the report, naming the step's target",
    async () => {
      const run = await executor.request("run", {
        video: ownVideo(),
        callId: "found-weaker",
        script: {
          scriptVersion: 9,
          name: "Found weaker",
          target: url,
          viewport: { width: 1280, height: 800 },
          steps: [
            { do: "waitForLoad" },
            { do: "click", on: { stableId: "show" }, zoom: false },
            { do: "waitFor", on: { stableId: "late" }, until: "visible" },
          ],
        },
      });
      const report = (run.ok ? run.value : undefined) as RunReport | undefined;
      const evidence = JSON.stringify(run);
      expect(report?.outcome, evidence).toBe("complete");
      // The premise: the wait's target was captured by its stable id, so a
      // find by any other tier is weaker than its capture.
      const wait = report?.steps.find((s) => s.intent.do === "waitFor");
      expect(wait?.strategy, evidence).toBe("stableId");
      expect(wait?.anchorId, evidence).toEqual(expect.any(String));

      expect(report?.foundWeaker, evidence).toHaveLength(1);
      const [note] = report?.foundWeaker ?? [];
      expect(note, evidence).toContain(`anchor "${wait?.anchorId}"`);
      expect(note, evidence).toContain("found by its text");
      expect(note, evidence).toContain("not by its stable id");
      // A report field, not a log line.
      expect(note, evidence).not.toMatch(/^demoman:/);
    },
    CASE_MS,
  );
});
