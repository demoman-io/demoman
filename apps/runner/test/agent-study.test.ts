import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  loadBriefs,
  skipLine,
  studyPrompt,
} from "../src/compare/study-briefs.js";
import { tallyStream } from "../src/compare/study-tally.js";

const here = dirname(fileURLToPath(import.meta.url));
const BRIEFS = join(here, "..", "compare", "briefs");

it("loads all five briefs, each with a url, reach, video and at least one endState line", () => {
  const briefs = loadBriefs(BRIEFS);
  expect(briefs.map((b) => b.name)).toEqual([
    "actual",
    "chatbot",
    "excalidraw",
    "nylon",
    "tremor",
  ]);
  for (const b of briefs) {
    for (const f of ["url", "reach", "video", "body"] as const)
      expect(b[f], `${b.name}.${f}`).not.toBe("");
    expect(b.endState.length, b.name).toBeGreaterThan(0);
    expect(b.endState.every((l) => l !== "")).toBe(true);
  }
});

it("puts the study's rules after the brief", () => {
  const b = loadBriefs(BRIEFS)[0];
  const p = studyPrompt(b);
  const at = (s: string) => p.indexOf(s);
  expect(at(b.body)).toBe(0);
  expect(at("Do NOT call `derive`")).toBeGreaterThan(b.body.length);
  expect(at("At most three `run` calls")).toBeGreaterThan(b.body.length);
  expect(p).toContain(`named exactly "${b.video}"`);
});

it("tallies probes, runs, outcomes and the export path from a stream", () => {
  const lines = readFileSync(
    join(here, "fixtures", "agent-study", "stream.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter((l) => l !== "");
  // the fixture must supply what the expectations count
  expect(
    lines.filter((l) => l.includes('"name":"mcp__demoman__probe"')),
  ).toHaveLength(2);
  expect(
    lines.filter((l) => l.includes('"name":"mcp__demoman__run"')),
  ).toHaveLength(2);
  expect(tallyStream(lines)).toEqual({
    probes: 2,
    runs: 2,
    runOutcomes: [
      { outcome: "stopped", verdict: null },
      { outcome: "complete", verdict: "matches" },
    ],
    exportPath: "/tmp/x.mp4",
    finalReport: "Done. The video is at /tmp/x.mp4.",
  });
});

it("names an unreachable app and how to start it", async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  const brief = {
    ...loadBriefs(BRIEFS)[0],
    reach: `http://127.0.0.1:${port}/`,
  };
  expect(await skipLine(brief)).toBe(
    `skipped ${brief.name}: http://127.0.0.1:${port}/ did not answer (start it with scripts/samples.sh start ${brief.name})`,
  );
});
