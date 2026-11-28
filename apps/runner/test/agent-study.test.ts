import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  type Brief,
  loadBriefs,
  skipLine,
  studyPrompt,
} from "../src/compare/study-briefs.js";
import { answerOf, tallyStream } from "../src/compare/study-tally.js";

const here = dirname(fileURLToPath(import.meta.url));
const BRIEFS = join(here, "..", "compare", "briefs");
const named = (name: string): Brief => {
  const b = loadBriefs(BRIEFS).find((x) => x.name === name);
  if (b === undefined) throw new Error(`no brief named ${name}`);
  return b;
};

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
  const b = named("actual");
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

// Red if an answer Claude Code delivered as an error is skipped: a stopped
// or refused run would tally as "unanswered", a call that never came back.
it("reads a run's answer that Claude Code wrapped as an error, whole or cut", () => {
  const report = {
    summary: "Stopped at step 2.",
    outcome: "stopped",
    steps: ["a long middle".repeat(20)],
  };
  const text = JSON.stringify(report, null, 2);
  expect(answerOf(`<tool_use_error>${text}</tool_use_error>`)).toEqual(report);
  // Cut in the middle, as a long error is: the object no longer parses.
  const middle = text.indexOf('"steps"') + 20;
  const cut = `<tool_use_error>${text.slice(0, middle)} ... [200 characters truncated] ... ${text.slice(-5)}</tool_use_error>`;
  expect(() =>
    JSON.parse(cut.slice(cut.indexOf("{"), cut.lastIndexOf("}") + 1)),
  ).toThrow();
  expect(answerOf(cut)).toEqual({ outcome: "stopped" });
  expect(answerOf("No such tool")).toBeNull();
  const lines = [
    {
      message: {
        content: [{ type: "tool_use", id: "t1", name: "mcp__demoman__run" }],
      },
    },
    {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: `<tool_use_error>${text}</tool_use_error>`,
          },
        ],
      },
    },
  ].map((l) => JSON.stringify(l));
  expect(tallyStream(lines).runOutcomes).toEqual([
    { outcome: "stopped", verdict: null },
  ]);
});

it("names an unreachable app and how to start it", async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  const brief = {
    ...named("actual"),
    reach: `http://127.0.0.1:${port}/`,
  };
  expect(await skipLine(brief)).toBe(
    `skipped ${brief.name}: http://127.0.0.1:${port}/ did not answer (fetch failed: ECONNREFUSED) (start it with scripts/samples.sh start ${brief.name})`,
  );
});

it("names samples.sh only for the apps it starts", async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  const reach = `http://127.0.0.1:${port}/`;
  const nylon = { ...named("nylon"), reach };
  expect(await skipLine(nylon)).toBe(
    `skipped nylon: ${reach} did not answer (fetch failed: ECONNREFUSED)`,
  );
  const tremor = { ...named("tremor"), reach };
  expect(await skipLine(tremor)).toContain("scripts/samples.sh start tremor");
});

it("points Nylon at the public sample page", () => {
  const n = named("nylon");
  expect([n.url, n.reach]).toEqual([
    "https://demoman.io/sample/",
    "https://demoman.io/sample/",
  ]);
  expect(n.body).toContain("https://demoman.io/sample/");
  expect(n.body).not.toContain("{sample}");
});

it("refuses a front matter line with no colon, naming file and line", () => {
  const dir = mkdtempSync(join(tmpdir(), "briefs-"));
  writeFileSync(join(dir, "x.md"), "---\nurl: u\nreach r\n---\nbody\n");
  expect(() => loadBriefs(dir)).toThrow(/x\.md.*reach r/);
});

it("counts any HTTP answer, a redirect included, as reachable", async () => {
  const s = createServer((_req, res) => {
    res.writeHead(307, { location: "/loop" }).end();
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  try {
    const brief = { ...named("chatbot"), reach: `http://127.0.0.1:${port}/` };
    expect(await skipLine(brief)).toBeNull();
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
});
