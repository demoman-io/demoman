import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEPT_DIR,
  keptFileName,
  RECEIPT_DIR,
  type RunReport,
} from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../src/executor/browser.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { type KeepOutput, keepVideo } from "../src/executor/keep.js";
import { readKeptFlows } from "../src/executor/kept-flows.js";
import { createLibrary } from "../src/executor/library.js";
import { execGit } from "../src/executor/repo.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { createVideoStore } from "../src/executor/videos.js";
import { WALLPAPERS_DIR } from "./fixture.js";
import { readKeptV2 } from "./kept-v2.js";

// Short runs of a one-field page, as executor-refilm.test.ts (x5 for CI).
const RUN_MS = 120_000;

const APP = `<!doctype html><meta charset=utf-8><title>Kept</title>
<input id=q aria-label=Filter>`;

let server: Server;
let url: string;
let home: string;
let repo: string;
let bare: string;
let executor: LocalExecutor;
let bareExecutor: LocalExecutor;

const script = (name: string, steps: unknown[]) => ({
  scriptVersion: 1,
  name,
  target: url,
  viewport: { width: 1280, height: 800 },
  look: {
    branding: {
      background: { kind: "solid", color: "#ffffff" },
      logo: null,
      padding: 0,
    },
  },
  steps,
});
const typing = (pause: number) => [
  { do: "waitForLoad" },
  { do: "type", into: { stableId: "q" }, text: "x" },
  { do: "pause", ms: pause },
];

const run = async (ex: LocalExecutor, args: Record<string, unknown>) => {
  const out = await ex.request("run", args);
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value as RunReport;
};
const keptOf = async (file: string) => readKeptV2(repo, file);

beforeAll(async () => {
  server = createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(APP);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = await mkdtemp(join(tmpdir(), "demoman-kept-rw-home-"));
  repo = await mkdtemp(join(tmpdir(), "demoman-kept-rw-repo-"));
  bare = await mkdtemp(join(tmpdir(), "demoman-kept-rw-bare-"));
  expect((await execGit(["init", "-q"], repo)).code).toBe(0);
  const base = { headless: true, log: () => undefined };
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    ...base,
    home,
    outDir: join(home, "out"),
    projectDir: repo,
  });
  // Same library, a project folder that is no repo.
  bareExecutor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    ...base,
    home,
    outDir: join(home, "out"),
    projectDir: bare,
  });
});

afterAll(async () => {
  await executor?.close();
  await bareExecutor?.close();
  server?.close();
  for (const d of [home, repo, bare])
    if (d) await rm(d, { recursive: true, force: true });
});

describe("a run's answer says whether its kept file was rewritten", () => {
  it(
    "a script run, a refilm and a run that stops, into a kept video",
    async () => {
      const first = await run(executor, {
        callId: "kept-first",
        video: { new: "Kept run" },
        script: script("Kept run", typing(300)),
      });
      expect(first.outcome).toBe("complete");
      // An unkept video: no `kept` key at all.
      expect("kept" in first).toBe(false);
      const videoId = first.videoVersion?.id as string;

      // Keep it by hand-off to keep itself, with no outputs to export.
      const library = createLibrary(home);
      const videos = createVideoStore(home, library, { log: () => undefined });
      const session = createBrowserSession({
        headless: true,
        log: () => undefined,
      });
      const kept = await keepVideo(
        {
          video: "Kept run",
          to: [{ path: "docs/k.gif", fileType: "gif", quality: "share" }],
          repoRoot: repo,
        },
        {
          home,
          library,
          videos,
          git: execGit,
          log: () => undefined,
          export: {
            wallpapersDir: WALLPAPERS_DIR,
            library,
            videos,
            session,
            door: "agent",
            home,
            outDir: join(home, "x"),
            log: () => undefined,
          },
        },
      );
      await session.close();
      if (!kept.ok) throw new Error(JSON.stringify(kept));
      const file = kept.file;
      expect((await keptOf(file)).receipt.video).toBe(first.provenance.takeId);

      // A script run into it: the file follows, and the answer says so.
      const second = await run(executor, {
        callId: "kept-second",
        video: { id: videoId },
        script: script("Kept run", typing(900)),
      });
      expect(second.outcome).toBe("complete");
      expect(second.kept).toEqual({ rewritten: file });
      const afterSecond = await keptOf(file);
      expect(afterSecond.receipt.video).toBe(second.provenance.takeId);
      expect(afterSecond.receipt.video).not.toBe(first.provenance.takeId);

      // A refilm (no script) is a run into it too.
      const third = await run(executor, {
        callId: "kept-third",
        video: { id: videoId },
      });
      expect(third.outcome).toBe("complete");
      expect(third.kept).toEqual({ rewritten: file });
      expect((await keptOf(file)).receipt.video).toBe(third.provenance.takeId);

      // A run that stops: the file stays as it was, and the answer says why.
      const before = await readFile(join(repo, file));
      const stopped = await run(executor, {
        callId: "kept-stopped",
        video: { id: videoId },
        script: script("Kept run", [
          { do: "waitForLoad" },
          { do: "click", on: { stableId: "nothing-here" } },
        ]),
      });
      expect(stopped.outcome, "premise: the run did not complete").not.toBe(
        "complete",
      );
      expect(stopped.videoVersion?.id, "premise: it joined the video").toBe(
        videoId,
      );
      expect(stopped.kept).toEqual({
        refused: expect.stringContaining(`${file} was not rewritten`),
      });
      expect(await readFile(join(repo, file))).toEqual(before);

      // refresh's own run reads the kept file and must not write it.
      const refreshed = await run(executor, {
        callId: "kept-refresh",
        video: { id: videoId },
        leaveKept: true,
      });
      expect(refreshed.outcome, "premise: the run completed").toBe("complete");
      expect(refreshed.videoVersion?.id, "premise: it joined the video").toBe(
        videoId,
      );
      expect(await readFile(join(repo, file), "utf8")).toBe(
        before.toString("utf8"),
      );
      expect("kept" in refreshed).toBe(false);
    },
    RUN_MS * 6,
  );

  it(
    "a run with no repo has no kept key",
    async () => {
      const out = await run(bareExecutor, {
        callId: "kept-bare",
        video: { new: "Bare run" },
        script: script("Bare run", typing(300)),
      });
      expect(out.outcome).toBe("complete");
      expect(out.videoVersion?.id, "premise: it joined a video").toBeTruthy();
      expect("kept" in out).toBe(false);
    },
    RUN_MS,
  );
});

/** `keep` as the CLI calls it, into `repo`. */
async function keepIt(video: string, to: KeepOutput[]) {
  const library = createLibrary(home);
  const videos = createVideoStore(home, library, { log: () => undefined });
  const session = createBrowserSession({
    headless: true,
    log: () => undefined,
  });
  try {
    return await keepVideo(
      { video, to, repoRoot: repo },
      {
        home,
        library,
        videos,
        git: execGit,
        log: () => undefined,
        export: {
          wallpapersDir: WALLPAPERS_DIR,
          library,
          videos,
          session,
          door: "agent",
          home,
          outDir: join(home, "x"),
          log: () => undefined,
        },
      },
    );
  } finally {
    await session.close();
  }
}

describe("a flow kept before the library marked kept flows", () => {
  it(
    "a studio rename, a run and a keep leave one recipe, and no duplicateFlow",
    async () => {
      const first = await run(executor, {
        callId: "drift-first",
        video: { new: "Drift before" },
        script: script("Drift before", typing(300)),
      });
      expect(first.outcome).toBe("complete");
      const videoId = first.videoVersion?.id as string;
      const kept = await keepIt("Drift before", [
        { path: "docs/drift.gif", fileType: "gif", quality: "share" },
      ]);
      if (!kept.ok) throw new Error(JSON.stringify(kept));
      const file = kept.file;
      const videos = createVideoStore(home, createLibrary(home));
      // As a record kept before this branch: no `kept` mark.
      expect((await videos.setKept(videoId, null)).ok).toBe(true);
      expect((await videos.get(videoId))?.kept).toBeUndefined();
      // The studio renames an unmarked flow through the plain rename.
      expect((await videos.rename(videoId, "Drift after")).ok).toBe(true);

      const second = await run(executor, {
        callId: "drift-second",
        video: { id: videoId },
        script: script("Drift after", typing(900)),
      });
      expect(second.outcome).toBe("complete");
      expect(second.kept).toEqual({ rewritten: file });
      // The run marked the record with the file that keeps it.
      expect((await videos.get(videoId))?.kept?.file).toBe(file);

      // A keep under the new name, with another output, writes no second recipe.
      const again = await keepIt("Drift after", [
        { path: "docs/drift-2.gif", fileType: "gif", quality: "share" },
      ]);
      expect(again).toMatchObject({ ok: false, reason: "outputTaken" });
      expect(!again.ok && again.detail).toContain(
        `${file} already keeps this flow`,
      );
      const recipes = await readdir(join(repo, KEPT_DIR));
      expect(recipes).toContain(file.split("/").at(-1));
      expect(recipes).not.toContain(keptFileName("Drift after"));
      const flows = await readKeptFlows(repo);
      expect(
        flows.entries.filter((e) => "kept" in e && e.kept.flow === videoId),
      ).toHaveLength(1);
      expect(flows.duplicates).toEqual([]);
    },
    RUN_MS * 4,
  );
});

describe("a kept flow whose receipts folder links out of the repo", () => {
  it(
    "the run says so and writes nothing there",
    async () => {
      const first = await run(executor, {
        callId: "linked-first",
        video: { new: "Linked receipts" },
        script: script("Linked receipts", typing(300)),
      });
      expect(first.outcome).toBe("complete");
      const kept = await keepIt("Linked receipts", [
        { path: "docs/linked.gif", fileType: "gif", quality: "share" },
      ]);
      if (!kept.ok) throw new Error(JSON.stringify(kept));
      const name = kept.file.split("/").at(-1) as string;
      const receipts = join(repo, RECEIPT_DIR);
      const outside = await mkdtemp(join(tmpdir(), "demoman-kept-rw-out-"));
      // The link names a folder holding this flow's receipt, so a write
      // through it would land outside the repo.
      const theirs = join(outside, name);
      await writeFile(theirs, await readFile(join(receipts, name)));
      const before = await readFile(theirs, "utf8");
      const recipe = await readFile(join(repo, kept.file), "utf8");
      await rename(receipts, `${receipts}.aside`);
      try {
        await symlink(outside, receipts);
        const second = await run(executor, {
          callId: "linked-second",
          video: { id: first.videoVersion?.id as string },
          script: script("Linked receipts", typing(600)),
        });
        expect(second.outcome).toBe("complete");
        expect(second.kept).toEqual({
          refused: expect.stringContaining("is not inside the repo"),
        });
        expect(await readFile(theirs, "utf8")).toBe(before);
        expect(await readFile(join(repo, kept.file), "utf8")).toBe(recipe);
      } finally {
        await rm(receipts, { force: true });
        await rename(`${receipts}.aside`, receipts);
        await rm(outside, { recursive: true, force: true });
      }
    },
    RUN_MS * 3,
  );
});
