// apps/runner/src/compare/film-compare.ts
/**
 * `pnpm film:compare` (spec 2026-10-12 §4): the go/no-go's evidence. Each
 * script runs through two sides via the MCP tools — snapshot, run, report,
 * export — as an agent would, twice each, sequential on one display, one
 * browser open at a time. The sides are the CLI's visible window and the CLI
 * headless (2026-10-20; until that day's archive the extension was a third,
 * behind a private-port build). Every film is decoded afterwards, headless.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLibrary } from "../executor/library.js";
import { listenOnLoopback } from "../loopback.js";
import { messageOf } from "../report.js";
import {
  type ExportAnswer,
  factsFromRun,
  keepHomeBecause,
  outcomeOf,
  parseAnswer,
  type RunAnswer,
  type SnapshotAnswer,
} from "./facts.js";
import { connectMcp, type Mcp, staleBuild } from "./harness.js";
import { createMeasurer, type Measurer } from "./measure.js";
import {
  judge,
  parseSides,
  type RunFacts,
  type Side,
  table,
  tableRows,
  type Verdict,
} from "./numbers.js";
import { type Loaded, loadScript } from "./scripts.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const MCP_BIN = join(repo, "apps", "mcp", "dist", "index.js");
const SCRIPTS_DIR = join(repo, "apps", "runner", "compare", "scripts");
const TEMPLATE = join(repo, "apps", "runner", "compare", "compare.html");
const RUNS = 2;
const say = (line: string) => console.info(`[demoman] film:compare: ${line}`);

type Failed = { failed: string };
interface BundleFacts {
  degradations: { kind: string }[];
  keyframe: [number, number] | null;
  spans: [number, number, number][];
}
interface SceneFacts {
  skipped: unknown[];
}
const answer = parseAnswer;

/** Polls report(id) until the outcome is none of `busy`: no sleep, the
 *  report call itself waits up to ~40 s (tools.ts REPORT_CALL_SHARE). */
async function settle<T extends { outcome?: string; id?: string }>(
  mcp: Mcp,
  first: T,
  busy: string[],
  deadlineMs: number,
): Promise<T> {
  const started = Date.now();
  let r = first;
  while (r.outcome !== undefined && busy.includes(r.outcome)) {
    if (Date.now() - started > deadlineMs)
      throw new Error(
        `still ${r.outcome} after ${deadlineMs / 1000} s: ${JSON.stringify(r).slice(0, 300)}`,
      );
    r = answer<T>(
      await mcp.callTool({ name: "report", arguments: { id: first.id ?? "" } }),
    );
  }
  return r;
}

/** One run and its export through `mcp`; facts the table reads, and the MP4
 *  moved to `mp4Out` when there is one. */
async function filmOnce(args: {
  mcp: Mcp;
  executor: Side;
  run: number;
  script: Loaded & { ok: true };
  mp4Out: string;
  /** Where this run's raw report and export answer are written. */
  evidence: { report: string; export: string };
  bundleFacts: (takeId: string) => Promise<BundleFacts | Failed>;
  sceneFacts: (takeId: string) => Promise<SceneFacts | Failed>;
}): Promise<{ facts: RunFacts; mp4: string | null }> {
  const { mcp, executor, run, script } = args;
  const who = `${script.name} ${executor} ${run}`;
  const snap = await settle(
    mcp,
    answer<SnapshotAnswer>(
      await mcp.callTool({
        name: "snapshot",
        arguments: { url: script.script.target },
      }),
    ),
    ["stillRunning", "queued"],
    600_000,
  );
  if (snap.reason !== undefined)
    say(`${who}: the snapshot was refused — ${outcomeOf(snap)}`);
  if (snap.landedElsewhere === true)
    say(`${who}: the snapshot landed on ${snap.landedUrl}`);
  const t0 = Date.now();
  const report = await settle(
    mcp,
    answer<RunAnswer>(
      await mcp.callTool({
        name: "run",
        arguments: { script: script.script },
      }),
    ),
    ["stillRunning", "running", "queued"],
    600_000,
  );
  const runMs = Date.now() - t0;
  // The raw report, beside the films: the table keeps the reason, this
  // keeps the step, the host's own words and every step record.
  writeFileSync(args.evidence.report, JSON.stringify(report, null, 2));
  if (report.stopped !== undefined) {
    // The verdict quotes the reason; the step and the host's own words are
    // said here, so a stopped run arrives already explaining itself.
    const at = report.stopped.at;
    say(
      `${who}: stopped (${report.stopped.reason}) after ${at?.index ?? "?"} of ${at?.of ?? "?"} steps, at "${at?.label ?? "?"}" — ${report.stopped.detail ?? report.stopped.sentence ?? "no detail"}`,
    );
  }
  const takeId = report.provenance?.takeId ?? null;
  let exportMs: number | null = null;
  let exportOutcome: string | null = null;
  let exp: ExportAnswer | null = null;
  let mp4: string | null = null;
  if (takeId !== null) {
    const t1 = Date.now();
    exp = await settle(
      mcp,
      answer<ExportAnswer>(
        await mcp.callTool({ name: "export", arguments: { takeId } }),
      ),
      ["stillRunning", "exporting", "queued"],
      900_000,
    );
    exportMs = Date.now() - t1;
    writeFileSync(args.evidence.export, JSON.stringify(exp, null, 2));
    exportOutcome = outcomeOf(exp);
    if (exp.outcome === "saved" && exp.fileType === "stills") {
      exportOutcome = "saved stills, not a video";
    } else if (exp.outcome === "saved" && exp.file === undefined) {
      exportOutcome = "saved, but the answer named no file.path";
    } else if (exp.outcome === "saved" && exp.file) {
      // Moved, not copied: the export saves into the side's export folder,
      // and the films belong beside the gate's evidence.
      try {
        renameSync(exp.file.path, args.mp4Out);
      } catch (error) {
        // Only a move across disks falls back to a copy; any other refusal
        // is the gate's to report, not to paper over.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        copyFileSync(exp.file.path, args.mp4Out);
        unlinkSync(exp.file.path);
      }
      mp4 = args.mp4Out;
    }
  } else {
    say(`${who}: the run made no take (${outcomeOf(report)}), so no export`);
  }
  const bundle = takeId === null ? null : await args.bundleFacts(takeId);
  const scene = takeId === null ? null : await args.sceneFacts(takeId);
  if (bundle !== null && "failed" in bundle)
    say(`${who}: the bundle could not be read (${bundle.failed})`);
  if (scene !== null && "failed" in scene)
    say(`${who}: the scene could not be read (${scene.failed})`);
  return {
    mp4,
    facts: factsFromRun({
      executor,
      run,
      report,
      runMs,
      exportMs,
      exportOutcome,
      exportAnswer: exp,
      bundle,
      scene,
      actingSteps: script.script.steps.filter((s) => s.do !== "pause").length,
    }),
  };
}

const removeQuietly = (path: string, what: string) => {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    say(`could not remove ${what} ${path} (${messageOf(error)})`);
  }
};

/** A same-day rerun writes into the same folder: what an earlier pass left
 *  goes first, so a refused pass never sits beside an earlier compare.html
 *  or films that are not its own. */
function clearEvidence(out: string, name: string): void {
  const stale = readdirSync(out).filter(
    (f) =>
      f.endsWith(".mp4") ||
      f.endsWith(".report.json") ||
      f.endsWith(".export.json") ||
      f === "compare.html",
  );
  for (const f of stale) rmSync(join(out, f), { force: true });
  if (stale.length > 0)
    say(`${name}: cleared an earlier pass's ${stale.join(", ")} from ${out}`);
}

interface Filmed {
  facts: RunFacts;
  mp4: string | null;
}

async function main(): Promise<number> {
  // 1. Arguments.
  let values: {
    script?: string[];
    sides?: string;
  };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        script: { type: "string", multiple: true },
        sides: { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    say(
      `${messageOf(error)} — usage: pnpm film:compare [--script <file>…] [--sides cli,headless]`,
    );
    return 1;
  }
  const sides = parseSides(values.sides);
  if (!sides.ok) {
    say(`refused: ${sides.reason}`);
    return 1;
  }
  // Filmed, shown and tabled in one order: compare.html's left video is the
  // table's first column group whichever way --sides named them.
  const [sideA, sideB] = sides.sides;
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const scriptPaths =
    values.script?.map((p) => resolve(cwd, p)) ??
    readdirSync(SCRIPTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(SCRIPTS_DIR, f));

  // 2. Preconditions.
  const packages = readdirSync(join(repo, "packages"));
  for (const [output, sources] of [
    [MCP_BIN, [join(repo, "apps", "mcp", "src")]],
    [
      join(repo, "apps", "runner", "dist", "compare", "film-compare.js"),
      [join(repo, "apps", "runner", "src")],
    ],
  ] as const) {
    const fresh = staleBuild({ output, sources: [...sources] });
    if (!fresh.ok) {
      say(`refused: ${fresh.reason}`);
      return 1;
    }
  }
  // The CLI sides load the packages' dist through @demoman/runner.
  for (const p of packages) {
    const output = join(repo, "packages", p, "dist", "index.js");
    if (!existsSync(join(repo, "packages", p, "src"))) continue;
    const fresh = staleBuild({
      output,
      sources: [join(repo, "packages", p, "src")],
    });
    if (!fresh.ok) {
      say(`refused: ${fresh.reason}`);
      return 1;
    }
  }

  // 3. Serve the sample app: its page and nothing else.
  const sampleHtml = join(
    repo,
    "docs",
    "store-assets",
    "sample-app",
    "index.html",
  );
  const sampleServer = createServer((req, res) => {
    if (req.url !== "/index.html") {
      res.writeHead(404).end();
      return;
    }
    try {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(readFileSync(sampleHtml));
    } catch (error) {
      say(`the sample app could not be read (${messageOf(error)})`);
      res.writeHead(500).end(messageOf(error));
    }
  });
  const sample = (await listenOnLoopback(sampleServer)).replace(/\/$/, "");

  try {
    // 4. Load the scripts; refuse what cannot run before any browser opens.
    const loaded: (Loaded & { ok: true })[] = [];
    const refused: string[] = [];
    for (const path of scriptPaths) {
      let got: Loaded;
      try {
        got = loadScript(path, { sample });
      } catch (error) {
        got = { ok: false, name: path, cause: messageOf(error) };
      }
      if (!got.ok) {
        say(`refused ${got.name}: ${got.cause}`);
        refused.push(got.name);
        continue;
      }
      loaded.push(got);
    }

    // 5–6. Film, per script, visible first.
    const date = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
    const filmed: {
      name: string;
      out: string;
      runs: Filmed[];
      threw: Verdict | null;
      keptHomes: string[];
    }[] = [];
    for (const script of loaded) {
      const out = join(repo, "film-compare", date, script.name);
      mkdirSync(out, { recursive: true });
      clearEvidence(out, script.name);
      const entry = {
        name: script.name,
        out,
        runs: [] as Filmed[],
        threw: null as Verdict | null,
        keptHomes: [] as string[],
      };
      const evidence = (executor: Side, run: number) => ({
        report: join(out, `${executor}-${run}.report.json`),
        export: join(out, `${executor}-${run}.export.json`),
      });
      /** A side's home goes only when nothing on it is a cause the judge
       *  refuses for (`keepHomeBecause`); otherwise it is the evidence, kept
       *  and named, with why, in the refusal. */
      const settleHome = (executor: Side, home: string, runs: Filmed[]) => {
        // A side that threw is the only one with a verdict yet: the other
        // never ran (the first side's throw skips the second).
        const why =
          entry.threw !== null ? "it threw" : keepHomeBecause(runs, RUNS);
        if (why === null) {
          removeQuietly(home, `the ${executor} side's home`);
        } else {
          entry.keptHomes.push(`${executor}: ${home} (${why})`);
          say(`${script.name} ${executor}: kept its home ${home} — ${why}`);
        }
      };
      filmed.push(entry);
      const mp4Name = (side: Side, run: number) =>
        run === 1 ? `${side}.mp4` : `${side}-${run}.mp4`;

      const filmCli = async (side: "cli" | "headless") => {
        const cliHome = mkdtempSync(
          join(tmpdir(), `film-compare-${side}-home-`),
        );
        const exports = join(out, `.${side}-exports`);
        let client: Mcp | null = null;
        try {
          // `demoman-mcp`, through the harness's own door.
          client = await connectMcp({
            serverBin: MCP_BIN,
            home: cliHome,
            name: "film-compare",
            // Headless is the server's default; the visible side asks.
            args: [
              "--out-dir",
              exports,
              ...(side === "cli" ? ["--headed"] : []),
            ],
            // Its log is where the executor's swallows speak (a window that
            // will not close, a logo it could not read): heard, not dropped.
            stderr: "inherit",
          });
          const library = createLibrary(cliHome);
          const bundleFacts = async (
            id: string,
          ): Promise<BundleFacts | Failed> => {
            try {
              const b = await library.frameStore(id).getBundle(id);
              if (b === null)
                return { failed: `no bundle under ${library.takeDir(id)}` };
              const k = b.keyframes[0];
              return {
                degradations: b.degradations.map((d) => ({ kind: d.kind })),
                keyframe: k ? [k.width, k.height] : null,
                spans: b.motionSpans.map((s) => [
                  s.width,
                  s.height,
                  Math.round(s.endMs - s.startMs),
                ]),
              };
            } catch (error) {
              return { failed: messageOf(error) };
            }
          };
          const sceneFacts = async (
            id: string,
          ): Promise<SceneFacts | Failed> => {
            try {
              const s = await library.getScene(id);
              if (s === null)
                return { failed: `no scene under ${library.takeDir(id)}` };
              return { skipped: s.zoomsSkipped ?? [] };
            } catch (error) {
              return { failed: messageOf(error) };
            }
          };
          for (let run = 1; run <= RUNS; run++) {
            const got = await filmOnce({
              mcp: client,
              executor: side,
              run,
              script,
              mp4Out: join(out, mp4Name(side, run)),
              evidence: evidence(side, run),
              bundleFacts,
              sceneFacts,
            });
            entry.runs.push(got);
            say(
              `${script.name} ${side} ${run}: ${got.facts.outcome}, export ${got.facts.exportOutcome ?? "none"}`,
            );
          }
        } catch (error) {
          say(`refused ${script.name}: ${side} threw — ${messageOf(error)}`);
          entry.threw = {
            kind: "refused",
            executor: side,
            cause: `${side} threw — ${messageOf(error)}`,
          };
        } finally {
          if (client !== null) {
            try {
              await client.close(); // closes the server, which closes its browser
            } catch (error) {
              say(
                `${script.name} ${side}: the client did not close (${messageOf(error)})`,
              );
            }
          }
          settleHome(
            side,
            cliHome,
            entry.runs.filter((r) => r.facts.executor === side),
          );
          removeQuietly(exports, `the ${side} side's export folder`);
        }
      };

      for (const side of [sideA, sideB]) {
        if (entry.threw !== null) break;
        await filmCli(side);
      }
    }

    // 7. Measure, after every browser has closed.
    const toMeasure = filmed
      .flatMap((e) => e.runs)
      .filter((r) => r.mp4 !== null);
    if (toMeasure.length > 0) {
      let measurer: Measurer | null = null;
      try {
        measurer = await createMeasurer();
      } catch (error) {
        for (const r of toMeasure)
          r.facts.exportOutcome = `decodeFailed: the measurer did not start (${messageOf(error)})`;
      }
      if (measurer !== null) {
        try {
          for (const r of toMeasure) {
            try {
              r.facts.film = await measurer.measure(r.mp4 as string);
            } catch (error) {
              r.facts.exportOutcome = `decodeFailed: ${messageOf(error)}`;
            }
          }
        } finally {
          await measurer
            .close()
            .catch((error: unknown) =>
              say(`the measurer did not close (${messageOf(error)})`),
            );
        }
      }
    }

    // 8. Judge and print.
    const template = readFileSync(TEMPLATE, "utf8");
    const pages: string[] = [];
    let allCompared = refused.length === 0;
    for (const e of filmed) {
      const facts = e.runs.map((r) => r.facts);
      const v = e.threw ?? judge(facts);
      const rows = tableRows(facts);
      writeFileSync(
        join(e.out, "numbers.json"),
        JSON.stringify({ script: e.name, verdict: v, facts, ...rows }, null, 2),
      );
      if (v.kind === "refused") {
        allCompared = false;
        say(`refused ${e.name} (${v.executor}): ${v.cause}`);
        for (const h of e.keptHomes) say(`  kept for the evidence — ${h}`);
        say(
          `  raw reports and export answers: ${e.out}/*.report.json, *.export.json`,
        );
        continue;
      }
      console.info(table(e.name, facts));
      const page = join(e.out, "compare.html");
      writeFileSync(
        page,
        // A function, not a string: a replacement string reads `$&` and `$'`
        // as patterns. `<` escaped, so no cell can close the <script>.
        template.replace("/*NUMBERS*/null", () =>
          JSON.stringify({
            script: e.name,
            sides: [sideA, sideB],
            ...rows,
          }).replaceAll("<", "\\u003c"),
        ),
      );
      pages.push(page);
    }

    // 9. Exit.
    for (const p of pages) say(`open ${p}`);
    for (const e of filmed) say(`numbers: ${join(e.out, "numbers.json")}`);
    return allCompared && filmed.length > 0 ? 0 : 1;
  } finally {
    await new Promise<void>((r) => sampleServer.close(() => r()));
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    say(
      `threw — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  },
);
