// apps/runner/src/compare/agent-study.ts
/**
 * `pnpm agent:study --model <alias|id> [--brief <name>]… [--pass <n>]`
 * (spec 2026-10-30 §I): a model, run through `claude -p` as an agent against
 * each checked-in brief and the repo's own demoman MCP build, its export's
 * last frame judged by opus against the brief. By hand, never in CI: it
 * spends model tokens and needs the sample apps running.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { messageOf } from "../report.js";
import { staleBuilds } from "./harness.js";
import {
  type Brief,
  loadBriefs,
  skipLine,
  studyPrompt,
} from "./study-briefs.js";
import { type Tally, tallyStream } from "./study-tally.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const MCP_BIN = join(repo, "apps", "mcp", "dist", "index.js");
const BRIEFS = join(repo, "apps", "runner", "compare", "briefs");
const say = (line: string) => console.info(`[demoman] agent:study: ${line}`);

/** Runs `claude -p` with the prompt on stdin (a variadic flag would swallow
 *  it as an argument); resolves with stdout lines and the exit code. */
function claude(
  args: string[],
  prompt: string,
  timeoutMs: number,
): Promise<{
  lines: string[];
  code: number | null;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((done) => {
    const child = spawn("claude", ["-p", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ lines: [], code: null, stderr: messageOf(error), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({
        lines: out.split("\n").filter((l) => l !== ""),
        code,
        stderr,
        timedOut,
      });
    });
    child.stdin.end(prompt);
  });
}

type Judged = { correct: boolean | null; reason: string };

/** Last 0.3 s of the export as a still, and its length; a failure is said. */
function finalFrame(
  mp4: string,
  png: string,
): { seconds: number | null; error: string | null; probeNote: string } {
  const f = spawnSync(
    "ffmpeg",
    ["-y", "-sseof", "-0.3", "-i", mp4, "-frames:v", "1", "-update", "1", png],
    { encoding: "utf8" },
  );
  if (f.status !== 0)
    return {
      seconds: null,
      error: `ffmpeg exited ${f.status}: ${f.stderr.slice(-200)}`,
      probeNote: "",
    };
  const p = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4],
    { encoding: "utf8" },
  );
  const seconds = Number.parseFloat(p.stdout);
  const ok = Number.isFinite(seconds);
  return {
    seconds: ok ? Math.round(seconds * 10) / 10 : null,
    error: null,
    probeNote: ok
      ? ""
      : `length unknown: ffprobe exited ${p.status} ${(p.stderr || p.stdout).slice(-120)}`,
  };
}

async function judge(brief: Brief, dir: string, png: string): Promise<Judged> {
  const ask = `Read the image ${png}. It is the last frame of a demo video an agent recorded for this request:

${brief.body}

The final frame must show:
${brief.endState.map((l) => `- ${l}`).join("\n")}

Judge only what the image shows. Answer with JSON only: { "correct": boolean, "reason": string }`;
  const r = await claude(
    [
      "--model",
      "opus",
      "--allowedTools",
      "Read",
      "--add-dir",
      dir,
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "json",
    ],
    ask,
    300_000,
  );
  try {
    const outer = JSON.parse(r.lines.join("\n")) as { result?: string };
    const m = /\{[\s\S]*\}/.exec(outer.result ?? "");
    const j = JSON.parse(m?.[0] ?? "") as Judged;
    if (typeof j.correct !== "boolean") throw new Error("no boolean `correct`");
    return j;
  } catch (error) {
    return {
      correct: null,
      reason: `the judge's answer could not be read (${messageOf(error)}; exit ${r.code}; ${r.stderr.slice(0, 200)})`,
    };
  }
}

const cell = (s: string, max = 240) =>
  s.replace(/\s+/g, " ").replaceAll("|", "\\|").slice(0, max);

interface Row {
  brief: Brief;
  skipped: string | null;
  tally: Tally | null;
  judged: Judged | null;
  seconds: number | null;
  note: string;
}

async function film(brief: Brief, model: string, out: string): Promise<Row> {
  const dir = join(out, brief.name);
  mkdirSync(dir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "agent-study-home-"));
  const mcp = JSON.stringify({
    mcpServers: {
      demoman: {
        command: "node",
        args: [MCP_BIN, "--out-dir", dir],
        env: { DEMOMAN_HOME: home },
      },
    },
  });
  say(`${brief.name}: ${model} is working (this takes minutes)`);
  const r = await claude(
    [
      "--model",
      model,
      "--strict-mcp-config",
      "--mcp-config",
      mcp,
      "--allowedTools",
      "mcp__demoman__*",
      "ToolSearch",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
    ],
    studyPrompt(brief),
    45 * 60_000,
  );
  writeFileSync(join(dir, "transcript.jsonl"), `${r.lines.join("\n")}\n`);
  rmSync(home, { recursive: true, force: true });
  const tally = tallyStream(r.lines);
  const row: Row = {
    brief,
    skipped: null,
    tally,
    judged: null,
    seconds: null,
    note: "",
  };
  if (r.timedOut) row.note = "timed out after 45 min";
  else if (r.code !== 0)
    row.note = `claude exited ${r.code} ${r.stderr.slice(0, 200)}`;
  if (tally.exportPath === null) {
    row.judged = { correct: null, reason: "no export, so no frame to judge" };
  } else {
    const png = join(dir, "final.png");
    const f = finalFrame(tally.exportPath, png);
    row.seconds = f.seconds;
    row.note = `${row.note} ${f.probeNote}`.trim();
    row.judged = f.error
      ? { correct: null, reason: f.error }
      : await judge(brief, dir, png);
  }
  writeFileSync(join(dir, "judge.json"), JSON.stringify(row.judged, null, 2));
  say(`${brief.name}: judge ${row.judged.correct}`);
  return row;
}

const word = (j: Judged | null) =>
  j === null || j.correct === null
    ? "unjudged"
    : j.correct
      ? "correct"
      : "wrong";

function summary(rows: Row[], model: string): string {
  const head = `# agent:study ${model}\n\n| App | Judge | Runs | Probes | Length (s) | Agent's claim | Judge's reason |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
  const body = rows.map((r) =>
    r.skipped !== null
      ? `| ${r.brief.name} | skipped | | | | | ${cell(r.skipped)} |`
      : `| ${r.brief.name} | ${word(r.judged)} | ${r.tally?.runOutcomes.map((o) => `${o.outcome}${o.verdict ? `/${o.verdict}` : ""}`).join(", ") || "0"} | ${r.tally?.probes} | ${r.seconds ?? ""} | ${cell(r.tally?.finalReport ?? "")} | ${cell(`${r.judged?.reason ?? ""} ${r.note}`)} |`,
  );
  return `${head}${body.join("\n")}\n`;
}

async function main(): Promise<number> {
  let values: { model?: string; brief?: string[]; pass?: string };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        model: { type: "string" },
        brief: { type: "string", multiple: true },
        pass: { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    say(
      `${messageOf(error)} — usage: pnpm agent:study --model <alias|id> [--brief <name>]… [--pass <n>]`,
    );
    return 1;
  }
  const model = values.model ?? "haiku";
  const pass = values.pass ?? "0";
  const stale = staleBuilds(repo, "agent-study.js");
  if (stale !== null) {
    say(`refused: ${stale}`);
    return 1;
  }
  const all = loadBriefs(BRIEFS);
  const unknown = (values.brief ?? []).filter(
    (n) => !all.some((b) => b.name === n),
  );
  if (unknown.length > 0) {
    say(
      `refused: no brief named ${unknown.join(", ")} (have ${all.map((b) => b.name).join(", ")})`,
    );
    return 1;
  }
  const chosen = all.filter(
    (b) => !values.brief || values.brief.includes(b.name),
  );
  const date = new Date().toLocaleDateString("en-CA");
  const out = join(repo, "agent-study", date, `${model}-${pass}`);
  mkdirSync(out, { recursive: true });
  const rows: Row[] = [];
  for (const brief of chosen) {
    const skipped = await skipLine(brief);
    if (skipped !== null) {
      say(skipped);
      rows.push({
        brief,
        skipped,
        tally: null,
        judged: null,
        seconds: null,
        note: "",
      });
      continue;
    }
    rows.push(await film(brief, model, out));
  }
  writeFileSync(join(out, "summary.md"), summary(rows, model));
  say(`summary: ${join(out, "summary.md")}`);
  return rows.some((r) => r.skipped === null) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    say(`failed: ${messageOf(error)}`);
    process.exit(1);
  },
);
