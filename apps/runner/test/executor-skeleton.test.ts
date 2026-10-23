// apps/runner/test/executor-skeleton.test.ts
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import { writeSkeleton } from "../src/executor/run.js";
import type { LocalExecutor } from "../src/executor/types.js";

// Measured as executor-export-zooms.test.ts measures its run (x5 for CI).
const RUN_MS = 60_000;

const APP = `<!doctype html><meta charset=utf-8><title>Skeleton</title>
<input id=q aria-label=Query style="position:absolute;left:40px;top:40px;width:300px;height:32px">`;

let server: Server;
let url: string;
let home: string;
let executor: LocalExecutor;
let takeId: string;
let report: {
  notStored?: { what: string }[];
  steps: { index: number; actionId: string | null }[];
};

beforeAll(async () => {
  server = createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(APP);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = await mkdtemp(join(tmpdir(), "demoman-skeleton-"));
  executor = createLocalExecutor({
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  const run = await executor.request("run", {
    callId: "skeleton-run",
    script: {
      scriptVersion: 1,
      name: "Skeleton",
      target: `${url}/?token=s3cret`,
      viewport: { width: 1280, height: 800 },
      steps: [
        { do: "waitForLoad" },
        { do: "pause", ms: 600 },
        { do: "type", into: { stableId: "q" }, text: "hunter2-typed" },
        { do: "pause", ms: 900 },
      ],
    },
  });
  if (!run.ok) throw new Error(JSON.stringify(run));
  report = run.value as typeof report;
  const id = (run.value as { provenance?: { takeId?: unknown } }).provenance
    ?.takeId;
  if (typeof id !== "string")
    throw new Error(`no take: ${JSON.stringify(run.value)}`);
  takeId = id;
}, RUN_MS);

afterAll(async () => {
  await executor.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});

describe("a run's script.json", () => {
  it("keeps the pauses and each acting step's action id from the report", async () => {
    const sk = JSON.parse(
      await readFile(join(home, "takes", takeId, "script.json"), "utf8"),
    );
    expect(sk.steps.map((s: { do: string }) => s.do)).toEqual([
      "waitForLoad",
      "pause",
      "type",
      "pause",
    ]);
    expect(sk.steps[1]).toEqual({ do: "pause", ms: 600 });
    const typed = report.steps.find((s) => s.index === 2);
    // Premise: the run performed the type step.
    expect(typed?.actionId).toEqual(expect.any(String));
    expect(sk.steps[2].actionId).toBe(typed?.actionId);
    expect(sk.viewport).toEqual({ width: 1280, height: 800 });
  });

  it("holds neither the typed text nor the start URL's query", async () => {
    const text = await readFile(
      join(home, "takes", takeId, "script.json"),
      "utf8",
    );
    expect(text).not.toContain("hunter2-typed");
    expect(text).not.toContain("s3cret");
  });

  it("reads back through the library", async () => {
    const read = await createLibrary(home).getSkeleton(takeId);
    expect(read.kind).toBe("ok");
  });

  it("reads a broken file as unreadable, naming why, and a missing one as none", async () => {
    const lib = createLibrary(home);
    const path = join(home, "takes", takeId, "script.json");
    const kept = await readFile(path, "utf8");
    try {
      await writeFile(path, "{ not json");
      const broken = await lib.getSkeleton(takeId);
      expect(broken.kind).toBe("unreadable");
      if (broken.kind === "unreadable")
        expect(broken.error).toContain("script.json");
      await rm(path);
      expect(await lib.getSkeleton(takeId)).toEqual({ kind: "none" });
    } finally {
      await writeFile(path, kept);
    }
  });

  it("left nothing in notStored on a run whose write landed", () => {
    expect(report.notStored ?? []).toEqual([]);
  });
});

describe("writeSkeleton, when the library refuses the write", () => {
  // The run's own call site, driven with a library that throws: what the
  // report says is what this pushes.
  it("names the script in notStored with the library's sentence", async () => {
    const notStored: { what: "script"; error: string }[] = [];
    const library = createLibrary(home);
    const dir = join(home, "takes", takeId);
    await chmod(dir, 0o500);
    try {
      await writeSkeleton(
        library,
        takeId,
        { skeletonVersion: 1 } as never,
        notStored as never,
      );
    } finally {
      await chmod(dir, 0o700);
    }
    expect(notStored).toEqual([
      { what: "script", error: expect.stringContaining("could not write") },
    ]);
  });
});
