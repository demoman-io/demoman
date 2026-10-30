import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { RenderTarget } from "@demoman/compositor";
import type { ExportAnswer, RunReport } from "@demoman/run-core";
import type { Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AttachAnswer,
  type AttachDeps,
  type Attaching,
  capMissed,
  codeClause,
  commentBody,
  copyFailedDetail,
  insertAbove,
  lineFor,
  prLine,
} from "../src/executor/attach.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { defaultGhRun, type GhRun } from "../src/executor/gh.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { makeDiskTake } from "./disk-take.js";
import { WALLPAPERS_DIR } from "./fixture.js";

// Measured locally (2026-10-18, M-series Mac, headless): an attach of the
// disk take at TINY is about 2 s, most of it the render. x5 for CI (fff4505)
// with margin.
const ATTACH_MS = 60_000;

/** A small landscape MP4: these tests read what was posted, not the picture
 *  (executor-export.test.ts samples that), so the render is kept cheap. */
const TINY: RenderTarget = {
  format: "mp4",
  width: 640,
  height: 360,
  fps: 30,
  bitrate: 1_000_000,
  cornerRadius: 6,
  fit: "contain",
};

type Answer = {
  code?: number;
  stdout?: string;
  stderr?: string;
  hang?: true;
};
type Logged = {
  args: string[];
  cwd: string;
  /** For an `--attach` call: the posted file's sha256, read while gh ran. */
  attached?: { path: string; sha: string };
  /** For a `--body-file` call: the file's text, read while gh ran. */
  bodyFile?: string;
};

let dir: string;
let home: string;
let outDir: string;
let project: string;
let bin: string;
let scriptPath: string;
let statePath: string;
let executor: LocalExecutor;
let takeId: string;
let logged: Logged[] = [];
let workPages = 0;
let onWorkPage: ((page: Page) => void) | null = null;
/** A gh call whose argv starts with this throws, as a bug in gh's runner
 *  would. */
let throwOn: string | null = null;
/** A gh call whose argv starts with this answers as a gh that is not on
 *  PATH (a spawn ENOENT), the way the real runner says so. */
let missingOn: string | null = null;
const lines: string[] = [];
let n = 0;

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Runs the fake gh on PATH, and logs each call's cwd and the bytes of any
 *  file it was handed to attach, read before the call returns (attach
 *  removes its copy afterwards). */
const loggingRun: GhRun = async (args, opts) => {
  if (throwOn !== null && args.join(" ").startsWith(throwOn)) {
    throw new Error(`a bug in the gh runner, at ${throwOn}`);
  }
  if (missingOn !== null && args.join(" ").startsWith(missingOn)) {
    logged.push({ args: [...args], cwd: opts.cwd });
    return {
      spawnError: Object.assign(new Error("spawn gh ENOENT"), {
        code: "ENOENT",
      }),
    };
  }
  const entry: Logged = { args: [...args], cwd: opts.cwd };
  const i = args.indexOf("--attach");
  if (i >= 0) {
    const path = args[i + 1] as string;
    entry.attached = { path, sha: sha(await readFile(path)) };
  }
  const b = args.indexOf("--body-file");
  if (b >= 0) entry.bodyFile = await readFile(args[b + 1] as string, "utf8");
  logged.push(entry);
  return defaultGhRun(args, opts);
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "demoman-attach-test-"));
  home = join(dir, "home");
  outDir = join(dir, "out");
  project = join(dir, "project");
  bin = join(dir, "bin");
  scriptPath = join(dir, "script.json");
  statePath = join(dir, "state.json");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(bin, { recursive: true });
  const fake = join(process.cwd(), "test", "fake-gh.mjs");
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,
  );
  await chmod(join(bin, "gh"), 0o755);
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir,
    projectDir: dir,
    log: (l) => void lines.push(l),
    mp4MaxTier: TINY,
    // Only the fake's folder on PATH: real gh is never reachable.
    env: { PATH: bin, FAKE_GH_SCRIPT: scriptPath, FAKE_GH_STATE: statePath },
    ghRun: loggingRun,
    onWorkPage: (page) => {
      workPages += 1;
      onWorkPage?.(page);
    },
  });
  takeId = (await makeDiskTake(home)).takeId;
}, ATTACH_MS);

afterAll(async () => {
  await executor.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  logged = [];
  workPages = 0;
  onWorkPage = null;
  throwOn = null;
  missingOn = null;
  await rm(statePath, { force: true });
  // Each case's export saves under the take's own name, not a numbered one.
  await rm(outDir, { recursive: true, force: true });
});

const signedIn: Record<string, Answer> = {
  "--version": {
    stdout: "gh version 2.102.0 (2026-09-30)\nhttps://github.com/cli/cli\n",
  },
  "auth status --hostname github.com": {
    stderr: "github.com\n  ✓ Logged in to github.com account o\n",
  },
};
const PR_URL = "https://github.com/o/r/pull/12";
const ASSET =
  "https://github.com/user-attachments/assets/0b6f0c51-6a7e-4d1e-9c35-2f7d8e1d3a90";
const OLD_ASSET =
  "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";
const prView: Answer = { stdout: JSON.stringify({ number: 12, url: PR_URL }) };
/** The disk take has no report.json, and its project no git: the line says
 *  both rather than reading clean. */
const NO_REPORT_LINE =
  "Demo: `Orders walkthrough` · no run report on disk, so no verdict · commit not recorded";
const text = (
  body: string,
  comments: { body: string; createdAt: string }[] = [],
) => ({
  stdout: JSON.stringify({ body, comments }),
});
/** The PR before posting: a description that already carries one video, so
 *  "new" has to mean new. */
const BEFORE = text(`Adds the filter.\n\n${OLD_ASSET}`);
const AFTER = text(`Adds the filter.\n\n${OLD_ASSET}\n\n${ASSET}`);
/** The description after the second edit wrote the line above the video. */
const AFTER_LINE = text(
  `Adds the filter.\n\n${OLD_ASSET}\n\n${NO_REPORT_LINE}\n\n${ASSET}`,
);

async function script(answers: Record<string, Answer | Answer[]>) {
  await writeFile(scriptPath, JSON.stringify({ ...signedIn, ...answers }));
}
async function attach(more: Record<string, unknown>): Promise<AttachAnswer> {
  const out = await executor.request("attach", {
    takeId,
    callId: `a-${++n}`,
    ...more,
  });
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value as AttachAnswer;
}
const calls = () => logged.map((l) => l.args.join(" "));

describe("commentBody", () => {
  // Red if the label goes into the comment as it is: a filmed page's title
  // could then mention people, or span lines, under the user's account.
  it("drops @ and keeps the label on one line", () => {
    const out = commentBody("Hi @octocat\r\nand @org/team\tbye");
    expect(out, JSON.stringify(out)).toBe(
      "Demo: `Hi octocat and org/team bye`",
    );
    expect(out).not.toContain("@");
    expect(out).not.toMatch(/[\r\n]/);
  });

  // Each case below is red against the plain `Demo: ${label}` body: GitHub
  // renders markdown, HTML and entities in a comment, so a page title could
  // post a link, an image beacon or a mention-looking name as the user.
  const cases: Array<[string, string, string]> = [
    [
      "a markdown link",
      "[Click here](https://evil.example)",
      "Demo: `[Click here](https://evil.example)`",
    ],
    [
      "an entity-encoded mention",
      "&#64;someone and @other",
      "Demo: `&#64;someone and other`",
    ],
    ["an html tag", "<img src=x onerror=y>", "Demo: `<img src=x onerror=y>`"],
    [
      "a markdown image",
      "![](https://t.example/p.png)",
      "Demo: `![](https://t.example/p.png)`",
    ],
    ["backticks", "a `b` ``c`` d", "Demo: `a b c d`"],
    [
      "CRLF and tabs",
      "one\r\ntwo\tthree\n\n four",
      "Demo: `one two three four`",
    ],
    ["an empty label", "", "Demo"],
    ["a whitespace-only label", " \r\n\t ", "Demo"],
    ["a label of only backticks", "```", "Demo"],
  ];
  it.each(cases)("answers %s as a literal code span", (_name, label, want) => {
    expect(commentBody(label)).toBe(want);
  });

  it("cuts a 300-character label to 120 plus an ellipsis inside the span", () => {
    const label = "x".repeat(300);
    expect(label.length).toBe(300);
    const out = commentBody(label);
    expect(out).toBe(`Demo: \`${"x".repeat(120)}…\``);
  });
});

describe("attach", () => {
  it(
    "attached into the description",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, AFTER, AFTER_LINE],
        "pr edit 12 --attach": { stdout: `${PR_URL}\n` },
        "pr edit 12 --body-file": { stdout: `${PR_URL}\n` },
      });
      const answer = await attach({ into: "description" });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "attached",
        pr: { number: 12, url: PR_URL },
        into: "description",
        assetUrl: ASSET,
        line: { text: NO_REPORT_LINE, written: true },
      });
      if (answer.outcome !== "attached") return;
      expect(answer.export).toMatchObject({
        outcome: "saved",
        fileType: "mp4",
      });
      const saved = answer.export as { file: { byteLength: number } };
      expect(answer.byteLength).toBe(saved.file.byteLength);
      // Premise: the size the summary names is a real one, and under 1 MB,
      // so it reads in KB (a "0.0 MB" names nothing).
      expect(answer.byteLength).toBeGreaterThan(1000);
      expect(answer.byteLength).toBeLessThan(1_000_000);
      const kb = Math.round(answer.byteLength / 1000);
      expect(answer.summary).toBe(
        `Attached the video (${kb} KB) to the description of ${PR_URL}.`,
      );
      expect(calls()).toEqual([
        "--version",
        "auth status --hostname github.com",
        "pr view --json number,url,headRefOid",
        "pr view 12 --json body,comments",
        expect.stringMatching(/^pr edit 12 --attach \S+\.mp4$/),
        "pr view 12 --json body,comments",
        expect.stringMatching(/^pr edit 12 --body-file \S+$/),
        "pr view 12 --json body,comments",
      ]);
    },
    ATTACH_MS,
  );

  it(
    "a comment names the take, and its video is read from the new comment",
    async () => {
      const at = "2026-10-18T10:00:00Z";
      await script({
        "pr view 7 --json number,url,headRefOid": {
          stdout: JSON.stringify({
            number: 7,
            url: "https://github.com/o/r/pull/7",
          }),
        },
        "pr view 7 --json body,comments": [
          text("theirs", [{ body: `old one ${OLD_ASSET}`, createdAt: at }]),
          text("theirs", [
            { body: `old one ${OLD_ASSET}`, createdAt: at },
            {
              body: `${NO_REPORT_LINE}\n\n${ASSET}`,
              createdAt: "2026-10-18T11:00:00Z",
            },
          ]),
        ],
        "pr comment 7": {
          stdout: "https://github.com/o/r/pull/7#issuecomment-1\n",
        },
      });
      const answer = await attach({ into: "comment", pr: 7 });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "attached",
        into: "comment",
        assetUrl: ASSET,
      });
      const post = logged.find((l) => l.args[1] === "comment");
      expect(post?.args.slice(0, 5)).toEqual([
        "pr",
        "comment",
        "7",
        "--body",
        NO_REPORT_LINE,
      ]);
      expect(post?.args[5]).toBe("--attach");
    },
    ATTACH_MS,
  );

  it("a non-github.com host is refused before the export", async () => {
    await script({
      "pr view --json number,url,headRefOid": {
        stdout: JSON.stringify({
          number: 3,
          url: "https://git.corp.example/o/r/pull/3",
        }),
      },
    });
    const answer = await attach({ into: "description" });
    expect(answer).toMatchObject({
      outcome: "refusedBeforeAttach",
      reason: "notGitHub",
    });
    if (answer.outcome !== "refusedBeforeAttach") return;
    expect(answer.detail).toContain("git.corp.example");
    expect(answer.detail).toContain("export({ takeId, maxMB: 9.5 })");
    expect(answer.detail).toContain("file.path to drag into the PR");
    expect(answer.detail).toContain("10 MB on a free plan");
    expect(answer.summary).toMatch(/^Not attached: /);
    expect(workPages).toBe(0);
    // Premise: gh was asked, and said where the PR lives.
    expect(calls()).toContain("pr view --json number,url,headRefOid");
  });

  it(
    "gh checks run in project",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, AFTER, AFTER_LINE],
        "pr edit 12 --attach": {},
        "pr edit 12 --body-file": {},
      });
      const answer = await attach({ into: "description", project });
      expect(answer.outcome, JSON.stringify(answer)).toBe("attached");
      // Premise: the whole sequence ran, posting and the line included.
      expect(logged.length).toBe(8);
      expect(project).not.toBe(dir);
      expect(new Set(logged.map((l) => l.cwd))).toEqual(new Set([project]));
      // And without project, gh runs where demoman-mcp was started.
      logged = [];
      await rm(statePath, { force: true });
      await attach({ into: "description" });
      expect(new Set(logged.map((l) => l.cwd))).toEqual(new Set([dir]));
    },
    ATTACH_MS * 2,
  );

  it("a project that is not a folder is invalidProject, before gh", async () => {
    await script({});
    const answer = await attach({
      into: "description",
      project: join(dir, "nowhere"),
    });
    expect(answer).toMatchObject({
      outcome: "refusedBeforeAttach",
      reason: "invalidProject",
    });
    expect(logged).toEqual([]);
  });

  it(
    "uploadRefused quotes gh and reads back",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, BEFORE],
        "pr edit 12 --attach": {
          code: 1,
          stderr: "HTTP 422: file too large\n",
        },
      });
      const answer = await attach({ into: "description" });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "notAttached",
        reason: "uploadRefused",
        landed: null,
      });
      if (answer.outcome !== "notAttached") return;
      expect(answer.detail).toContain('"HTTP 422: file too large"');
      expect(answer.detail).toContain("nothing was retried");
      expect(answer.detail).toContain(
        (answer.export as { file: { path: string } }).file.path,
      );
      // No maxMB is a 9.5 MB cap (spec 2026-10-29 §5): a refusal there
      // would only come again, so the file goes by hand now.
      expect(answer.export).toMatchObject({
        warnings: { videoSize: { cap: { maxBytes: 9_500_000 } } },
      });
      expect(answer.detail).toContain(
        "already capped at 9.5 MB, so do not call attach again",
      );
      expect(answer.detail).not.toContain("attach again with maxMB");
      expect(answer.detail).not.toContain("export({ takeId, maxMB: 9.5 })");
      const edit = calls().findIndex((c) => c.startsWith("pr edit"));
      expect(edit).toBeGreaterThan(0);
      expect(calls().slice(edit + 1)).toEqual([
        "pr view 12 --json body,comments",
      ]);
      // Never retried blind: one post.
      expect(calls().filter((c) => c.startsWith("pr edit"))).toHaveLength(1);
      // The copy's folder is removed on a failure path too.
      const posted = logged.find((l) => l.attached !== undefined)?.attached;
      expect(posted).toBeDefined();
      expect(existsSync(dirname(posted?.path ?? ""))).toBe(false);
    },
    ATTACH_MS,
  );

  // Code review finding 1. Red while the retry advice is appended whatever
  // the cap: an attach already capped at 9.5 MB would be told to call
  // attach again with the same cap, and be refused the same way.
  it(
    "uploadRefused under a cap of 9.5 MB or less hands the file over; under a looser cap it retries once",
    async () => {
      const refusedUpload = {
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, BEFORE],
        "pr edit 12 --attach": {
          code: 1,
          stderr: "HTTP 422: file too large\n",
        },
      };
      await script(refusedUpload);
      const capped = await attach({ into: "description", maxMB: 9.5 });
      expect(capped, JSON.stringify(capped)).toMatchObject({
        outcome: "notAttached",
        reason: "uploadRefused",
      });
      if (capped.outcome !== "notAttached") return;
      const saved = capped.export as {
        file: { path: string; byteLength: number };
      };
      // Premise: the export saved, and was capped at what was asked.
      expect(capped.export).toMatchObject({
        warnings: { videoSize: { cap: { maxBytes: 9_500_000 } } },
      });
      expect(capped.detail).toContain("already capped at 9.5 MB");
      expect(capped.detail).toContain("do not call attach again");
      expect(capped.detail).toContain(
        `give the user ${saved.file.path} (${Math.round(saved.file.byteLength / 1000)} KB) to drag into the PR`,
      );
      expect(capped.detail).toContain("over 10 MB on a free plan");
      expect(capped.detail).not.toContain("attach again with maxMB");

      logged = [];
      await rm(statePath, { force: true });
      await rm(outDir, { recursive: true, force: true });
      await script(refusedUpload);
      const looser = await attach({ into: "description", maxMB: 50 });
      expect(looser, JSON.stringify(looser)).toMatchObject({
        outcome: "notAttached",
        reason: "uploadRefused",
      });
      if (looser.outcome !== "notAttached") return;
      // Review Focus 5: a caller's looser cap is kept, not the default.
      expect(looser.export).toMatchObject({
        warnings: { videoSize: { cap: { maxBytes: 50_000_000 } } },
      });
      expect(looser.detail).toContain("attach again with maxMB: 9.5, once");
      expect(looser.detail).not.toContain("do not call attach again");
    },
    ATTACH_MS * 2,
  );

  // Code review findings 2 and 3. Red while an attach whose export missed
  // its cap says a plain "Attached the video", or while its progress drops
  // the export's render count, so a re-render reads as frame 0 again.
  it(
    "a cap the export missed is said in the summary, and each render is named in the progress",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, AFTER, AFTER_LINE],
        "pr edit 12 --attach": {},
        "pr edit 12 --body-file": {},
      });
      const seen: Attaching[] = [];
      const out = await executor.request(
        "attach",
        // 10 KB: no render meets it, so every rung runs. (One byte made the
        // fit rung ask for 1 bps, which the encoder refuses: a failed rung,
        // not the missed cap this case is about.)
        { takeId, callId: `a-${++n}`, into: "description", maxMB: 0.01 },
        (p) => void seen.push(p as Attaching),
      );
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as AttachAnswer;
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "attached",
        assetUrl: ASSET,
      });
      if (answer.outcome !== "attached") return;
      // Premise: the cap was missed, with no step failing.
      expect(answer.export).toMatchObject({
        warnings: { videoSize: { cap: { maxBytes: 10_000, met: false } } },
      });
      expect(
        (answer.export as { warnings: { videoSize: { cap: object } } }).warnings
          .videoSize.cap,
      ).not.toHaveProperty("failed");
      // /code-review #1: the lane's tier is TINY, so the floor is TINY's
      // share frame too. Red while the floor is worked out at 1080p and the
      // ladder steps the video up to it.
      const exported = answer.export as {
        width: number;
        warnings: { videoSize: { cap: { steps: { kind: string }[] } } };
      };
      expect(
        exported.warnings.videoSize.cap.steps.some((s) => s.kind === "frame"),
        JSON.stringify(exported.warnings.videoSize.cap.steps),
      ).toBe(false);
      expect(exported.width).toBeLessThanOrEqual(TINY.width);
      // The premise of the sentence below: the file kept is the fit rung's.
      expect(answer.export).toMatchObject({
        warnings: { videoSize: { cap: { belowFloor: true } } },
      });
      const kb = Math.round(answer.byteLength / 1000);
      expect(answer.summary).toBe(
        `Attached the video (${kb} KB) to the description of ${PR_URL}, but it is over the 0.01 MB asked for even after softening it.`,
      );
      const renders = seen.filter(
        (p) => p.phase === "rendering" && p.total > 0,
      );
      // Premise: the ladder rendered more than once, so a second render's
      // frame count started from 0 again.
      const passes = [...new Set(renders.map((p) => p.pass?.render ?? 0))];
      expect(passes.length, JSON.stringify(passes)).toBeGreaterThan(1);
      expect(renders.every((p) => p.pass !== undefined)).toBe(true);
      const second = renders.find((p) => p.pass?.render === 2);
      expect(second?.summary).toMatch(
        /^Attaching — render 2 of up to \d+ to fit the size asked for: frame \d+ of \d+\.$/,
      );
    },
    ATTACH_MS * 2,
  );

  it(
    "partial when the read-back finds the asset",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, AFTER],
        "pr edit 12 --attach": { code: 1, stderr: "HTTP 502: Bad Gateway\n" },
      });
      const answer = await attach({ into: "description" });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "notAttached",
        reason: "partial",
        landed: ASSET,
      });
      if (answer.outcome !== "notAttached") return;
      expect(answer.detail).toContain("HTTP 502: Bad Gateway");
      expect(answer.detail).toContain("Do not post it again");
    },
    ATTACH_MS,
  );

  // Red if a read-back that failed is read as "nothing attached": the video
  // may be on the PR, and an agent told uploadRefused-and-nothing-landed
  // would post it twice.
  it(
    "a failed upload whose PR cannot be read back says it is unknown what landed",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [
          BEFORE,
          { code: 1, stderr: "HTTP 503: Service Unavailable\n" },
        ],
        "pr edit 12 --attach": { code: 1, stderr: "connection reset\n" },
      });
      const answer = await attach({ into: "description" });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "notAttached",
        reason: "unconfirmed",
        landed: null,
      });
      if (answer.outcome !== "notAttached") return;
      expect(answer.detail).toContain("could not be read back");
      expect(answer.detail).toContain("HTTP 503: Service Unavailable");
      expect(answer.detail).toContain("unknown whether anything was posted");
      expect(answer.detail).toContain(`look at ${PR_URL} before posting again`);
      expect(answer.detail).not.toContain("nothing landed");
    },
    ATTACH_MS,
  );

  // Red while a post the read-back cannot confirm answers attached: the
  // agent would tell the user the video is on the PR.
  it(
    "a post gh reports done whose PR cannot be read back is unconfirmed, not attached",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [
          BEFORE,
          { code: 1, stderr: "HTTP 503\n" },
        ],
        "pr edit 12 --attach": {},
      });
      const answer = await attach({ into: "description" });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "notAttached",
        reason: "unconfirmed",
        landed: null,
      });
      if (answer.outcome !== "notAttached") return;
      expect(answer.detail).toContain("could not be read back");
      expect(answer.detail).toContain("HTTP 503");
      expect(answer.detail).toContain(`look at ${PR_URL} before posting again`);
      expect(answer.summary).not.toMatch(/^Attached/);
    },
    ATTACH_MS,
  );

  it(
    "a post gh reports done whose PR reads back with no new video is unconfirmed",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, BEFORE],
        "pr edit 12 --attach": {},
      });
      const answer = await attach({ into: "description" });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "notAttached",
        reason: "unconfirmed",
        landed: null,
      });
      if (answer.outcome !== "notAttached") return;
      expect(answer.detail).toContain("gh reported success");
      expect(answer.detail).toContain("no new video");
      expect(answer.detail).toContain(`look at ${PR_URL} before posting again`);
      expect(answer.summary).not.toMatch(/^Attached/);
      // Premise: the post did run and exit 0, and the PR was read after it.
      expect(calls().slice(-2)).toEqual([
        expect.stringMatching(/^pr edit 12 --attach /),
        "pr view 12 --json body,comments",
      ]);
    },
    ATTACH_MS,
  );

  it(
    "comment mode: partial when the new comment carries the video, uploadRefused when nothing landed",
    async () => {
      const at = "2026-10-18T10:00:00Z";
      const before = text("theirs", [{ body: "a review", createdAt: at }]);
      await script({
        "pr view 7 --json number,url,headRefOid": {
          stdout: JSON.stringify({
            number: 7,
            url: "https://github.com/o/r/pull/7",
          }),
        },
        "pr view 7 --json body,comments": [
          before,
          text("theirs", [
            { body: "a review", createdAt: at },
            {
              body: `Demo: Orders walkthrough\n\n${ASSET}`,
              createdAt: "2026-10-18T11:00:00Z",
            },
          ]),
        ],
        "pr comment 7": { code: 1, stderr: "HTTP 502: Bad Gateway\n" },
      });
      const partial = await attach({ into: "comment", pr: 7 });
      expect(partial, JSON.stringify(partial)).toMatchObject({
        outcome: "notAttached",
        reason: "partial",
        landed: ASSET,
      });
      expect(partial.summary).not.toMatch(/^Attached/);

      logged = [];
      await rm(statePath, { force: true });
      await rm(outDir, { recursive: true, force: true });
      await script({
        "pr view 7 --json number,url,headRefOid": {
          stdout: JSON.stringify({
            number: 7,
            url: "https://github.com/o/r/pull/7",
          }),
        },
        "pr view 7 --json body,comments": [before, before],
        "pr comment 7": { code: 1, stderr: "HTTP 422: file too large\n" },
      });
      const refused = await attach({ into: "comment", pr: 7 });
      expect(refused, JSON.stringify(refused)).toMatchObject({
        outcome: "notAttached",
        reason: "uploadRefused",
        landed: null,
        detail: expect.stringContaining("gh pr comment 7 --attach exited 1"),
      });
      expect(calls().filter((c) => c.startsWith("pr comment"))).toHaveLength(1);
    },
    ATTACH_MS * 2,
  );

  // Red if an export that did not save is reshaped, or gh posts anyway.
  it(
    "an export that does not save is answered as itself, and nothing is posted",
    async () => {
      const ready = {
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": BEFORE,
        "pr edit 12 --attach": {},
        "pr comment": {},
      };
      await script(ready);
      const unknown = await attach({
        into: "description",
        takeId: "no-such-take",
      });
      expect(unknown).toMatchObject({
        outcome: "refusedBeforeExport",
        reason: "takeNotFound",
        summary: expect.stringMatching(/^Not exported: /),
      });
      // Premise: gh was reached, so "no post" is attach's doing.
      expect(calls()).toContain("pr view 12 --json body,comments");
      expect(calls().some((c) => /^pr (edit|comment)/.test(c))).toBe(false);

      logged = [];
      onWorkPage = (page) => void page.close();
      const failed = await attach({ into: "description" });
      expect(failed, JSON.stringify(failed)).toMatchObject({
        outcome: "renderFailed",
      });
      // This session is headless: nobody closed a window, so the sentence
      // must not ask anyone to leave one open.
      const said = JSON.stringify(failed);
      expect(said).toContain(
        "Demoman's headless browser lost the page it renders in",
      );
      expect(said).not.toContain("leave it open");
      expect(workPages).toBe(1);
      expect(calls().some((c) => /^pr (edit|comment)/.test(c))).toBe(false);
    },
    ATTACH_MS,
  );

  it("a gh runner that throws answers attach's own threw sentence", async () => {
    await script({
      "pr view --json number,url,headRefOid": prView,
      "pr view 12 --json body,comments": BEFORE,
    });
    throwOn = "pr view 12 --json body,comments";
    const answer = (await attach({ into: "description" })) as unknown as {
      outcome: string;
      summary: string;
    };
    expect(answer.outcome).toBe("threw");
    expect(answer.summary).toMatch(/^The attach failed unexpectedly/);
    expect(answer.summary).toContain("a bug in the gh runner");
    expect(answer.summary).toContain("look at the PR before posting again");
    expect(lines.join("\n")).toContain("the attach threw");
  });

  it("a PR that cannot be read before posting costs no render", async () => {
    await script({
      "pr view --json number,url,headRefOid": prView,
      "pr view 12 --json body,comments": { code: 1, stderr: "HTTP 500\n" },
    });
    const answer = await attach({ into: "description" });
    expect(answer).toMatchObject({
      outcome: "refusedBeforeAttach",
      reason: "prUnreadable",
    });
    expect(workPages).toBe(0);
    expect(calls().some((c) => c.startsWith("pr edit"))).toBe(false);
  });

  it(
    "attach holds the export slot",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, AFTER, AFTER_LINE],
        "pr edit 12 --attach": {},
        "pr edit 12 --body-file": {},
      });
      const rendering = new Promise<void>((resolve) => {
        onWorkPage = () => resolve();
      });
      const held = attach({ into: "description", callId: "a-held" });
      await rendering;
      const second = await executor.request("export", {
        takeId,
        callId: "e-held",
      });
      expect(second).toMatchObject({
        ok: true,
        value: { outcome: "refusedBeforeExport", reason: "busy" },
      });
      // And a second attach is refused the same way.
      const again = await attach({ into: "description" });
      expect(again).toMatchObject({
        outcome: "refusedBeforeExport",
        reason: "busy",
      });
      expect((await held).outcome).toBe("attached");
      // report(id) answers the attach's final answer.
      expect(await executor.request("report", { id: "a-held" })).toMatchObject({
        ok: true,
        value: { outcome: "attached" },
      });
    },
    ATTACH_MS,
  );

  it("no pr and no PR for the branch", async () => {
    await script({
      "pr view --json number,url,headRefOid": {
        code: 1,
        stderr: 'no pull requests found for branch "feat/x"\n',
      },
    });
    const answer = await attach({ into: "description" });
    expect(answer).toMatchObject({
      outcome: "refusedBeforeAttach",
      reason: "prNotFound",
    });
    if (answer.outcome !== "refusedBeforeAttach") return;
    expect(answer.detail).toContain(
      'no pull requests found for branch "feat/x"',
    );
    expect(workPages).toBe(0);
  });

  // Red if a gh refusal stops saying how to attach by hand with a file a
  // drag-in takes: a capped export, then its file.path.
  it.each([
    [
      "ghMissing",
      { "--version": { stdout: "" } },
      "--version",
      "gh is not installed",
    ],
    [
      "ghOutdated",
      { "--version": { stdout: "gh version 2.98.0 (2026-06-01)\n" } },
      null,
      "2.98.0",
    ],
    [
      "ghSignedOut",
      {
        ...signedIn,
        "auth status --hostname github.com": {
          code: 1,
          stderr: "You are not logged into any GitHub hosts.\n",
        },
      },
      null,
      "gh auth login",
    ],
  ] as const)(
    "%s is refused before the export, saying how to attach by hand",
    async (reason, answers, missing, names) => {
      await writeFile(scriptPath, JSON.stringify(answers));
      missingOn = missing;
      const answer = await attach({ into: "description" });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "refusedBeforeAttach",
        reason,
      });
      if (answer.outcome !== "refusedBeforeAttach") return;
      expect(answer.detail).toContain(names);
      expect(answer.detail).toContain("export({ takeId, maxMB: 9.5 })");
      expect(answer.detail).toContain("file.path to drag into the PR");
      expect(answer.detail).toContain("10 MB on a free plan");
      expect(workPages).toBe(0);
      // Premise: gh was asked, and nothing past the refusing check.
      expect(calls().length).toBeGreaterThan(0);
      expect(calls().some((c) => c.startsWith("pr "))).toBe(false);
    },
  );

  it("names a bad into, pr or takeId, or an export option attach ignores, as invalidAttach, before gh", async () => {
    await script({});
    for (const [args, field] of [
      [{ into: "body" }, "into"],
      [{ into: "comment", pr: 0 }, "pr"],
      [{ into: "comment", pr: "12" }, "pr"],
      [{ into: "comment", takeId: " " }, "takeId"],
      [{ into: "comment", quality: "full" }, "quality"],
      [{ into: "comment", fileType: "gif" }, "fileType"],
    ] as const) {
      const answer = await attach(args);
      expect(answer, JSON.stringify(args)).toMatchObject({
        outcome: "refusedBeforeAttach",
        reason: "invalidAttach",
        detail: expect.stringContaining(field),
      });
    }
    expect(logged).toEqual([]);
  });

  // Red if attach lets a bad maxMB through to gh or to a render, or names
  // it as anything but the export's own reason.
  it("a bad maxMB is invalidMaxMB, before gh and before a render", async () => {
    await script({});
    for (const maxMB of [0, -1, "9.5", Number.NaN, null]) {
      const answer = await attach({ into: "comment", maxMB });
      expect(answer, String(maxMB)).toMatchObject({
        outcome: "refusedBeforeAttach",
        reason: "invalidMaxMB",
        detail: expect.stringContaining("maxMB"),
        summary: expect.stringMatching(/^Not attached: /),
      });
    }
    expect(logged).toEqual([]);
    expect(workPages).toBe(0);
  });

  // Red if attach drops maxMB on its way to the export, or rounds it.
  it(
    "maxMB passes through to the export: its cap is maxMB × 1,000,000 bytes",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, AFTER, AFTER_LINE],
        "pr edit 12 --attach": {},
        "pr edit 12 --body-file": {},
      });
      const answer = await attach({ into: "description", maxMB: 123.4567 });
      expect(answer.outcome, JSON.stringify(answer)).toBe("attached");
      if (answer.outcome !== "attached") return;
      const exported = answer.export as {
        file: { byteLength: number };
        warnings: {
          videoSize?: {
            quality: string;
            cap?: { maxBytes: number; met: boolean };
          };
        };
      };
      expect(exported.warnings.videoSize?.quality).toBe("share");
      expect(exported.warnings.videoSize?.cap).toMatchObject({
        maxBytes: 123_456_700,
        met: true,
      });
      // Premise: the cap was met by the file that was posted.
      expect(exported.file.byteLength).toBeLessThanOrEqual(123_456_700);
      expect(answer.byteLength).toBe(exported.file.byteLength);
    },
    ATTACH_MS,
  );

  it(
    "the file posted has a plain name",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, AFTER, AFTER_LINE],
        "pr edit 12 --attach": {},
        "pr edit 12 --body-file": {},
      });
      const answer = await attach({ into: "description" });
      expect(answer.outcome, JSON.stringify(answer)).toBe("attached");
      if (answer.outcome !== "attached") return;
      const saved = (answer.export as { file: { path: string } }).file.path;
      // No maxMB: GitHub's size all the same, not the export default, and
      // capped at the 9.5 MB a browser drag-in takes.
      expect(
        (answer.export as { warnings: { videoSize?: { quality: string } } })
          .warnings.videoSize?.quality,
      ).toBe("share");
      expect(answer.export).toMatchObject({
        warnings: { videoSize: { cap: { maxBytes: 9_500_000 } } },
      });
      // Premise: the export's own name is not plain, so the copy is what
      // made it so.
      expect(basename(saved)).toBe("Orders walkthrough.mp4");
      const posted = logged.find((l) => l.attached !== undefined)?.attached;
      expect(posted).toBeDefined();
      expect(basename(posted?.path ?? "")).toMatch(/^[A-Za-z0-9._-]+\.mp4$/);
      expect(basename(posted?.path ?? "")).toBe("Orders-walkthrough.mp4");
      expect(posted?.sha).toBe(sha(await readFile(saved)));
      // The copy's folder is gone afterwards; the export stays.
      expect(existsSync(dirname(posted?.path ?? ""))).toBe(false);
      expect(existsSync(saved)).toBe(true);
    },
    ATTACH_MS,
  );
});

// Code review finding 2, the branch the render above cannot reach: a step
// of the ladder that threw. Red if the summary drops why the cap was missed.
describe("codeClause", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const T = "1".repeat(40);
  const U = "2".repeat(40);
  it.each([
    ["no filmedCode", undefined, B, T, "commit not recorded"],
    ["none", { none: "git is not installed" }, B, T, "commit unknown"],
    [
      "the PR head's tree",
      { commit: A, tree: T, dirty: true },
      B,
      T,
      `filmed at \`bbbbbbb\``,
    ],
    [
      "head unknown",
      { commit: A, tree: T, dirty: false },
      null,
      null,
      "filmed at `aaaaaaa`, not checked against the PR",
    ],
    [
      "head tree unknown, dirty",
      { commit: A, tree: T, dirty: true },
      B,
      null,
      "filmed at `aaaaaaa` with uncommitted changes, not checked against the PR",
    ],
    [
      "another tree, dirty",
      { commit: A, tree: T, dirty: true },
      B,
      U,
      "filmed from uncommitted changes on `aaaaaaa`",
    ],
    [
      "another tree, clean",
      { commit: A, tree: T, dirty: false },
      B,
      U,
      "filmed at `aaaaaaa`, not the PR's head `bbbbbbb`",
    ],
    [
      "no commit yet",
      { commit: null, tree: T, dirty: true },
      B,
      U,
      "filmed from uncommitted changes before the first commit",
    ],
  ] as const)("%s", (_name, filmed, head, headTree, want) => {
    expect(codeClause(filmed, head, headTree)).toBe(want);
  });
});

describe("prLine", () => {
  it("joins the label, the verdict and the code on one line, with no details for a clean run", () => {
    expect(
      prLine(
        "Create an invoice",
        { clause: "matches all 3 steps", details: null },
        "filmed at `abc1234`",
      ),
    ).toEqual({
      line: "Demo: `Create an invoice` · matches all 3 steps · filmed at `abc1234`",
      details: null,
    });
  });

  it("puts the run's notes in a collapsed block, without backticks or mentions", () => {
    const out = prLine(
      "x",
      {
        clause: "stopped after step 1 of 3",
        details: "Stopped: saw `y` from @octocat",
      },
      "commit unknown",
    );
    expect(out.details).toBe(
      "<details><summary>Run notes</summary>\n\n```\nStopped: saw y from octocat\n```\n</details>",
    );
  });

  it("caps the notes at 1,000 characters", () => {
    const out = prLine(
      "x",
      { clause: "c", details: "n".repeat(5000) },
      "commit unknown",
    );
    expect(out.details).toContain(`${"n".repeat(1000)}…`);
    expect(out.details).not.toContain("n".repeat(1001));
  });
});

// code-review high: one catch around both the read and prVerdict named
// every throw "not a run report". Red if a library that throws is logged as
// a report of the wrong shape, or the other way round.
describe("lineFor", () => {
  const deps = (getJson: () => Promise<unknown>, lines: string[]) =>
    ({
      export: { library: { getJson } },
      log: (l: string) => void lines.push(l),
    }) as unknown as AttachDeps;

  it("a library that throws is said as a read that failed", async () => {
    const lines: string[] = [];
    const out = await lineFor(
      "t1",
      "x",
      null,
      deps(async () => {
        throw new Error("disk gone");
      }, lines),
    );
    expect(out.line).toContain("run report unreadable");
    expect(lines.join("\n")).toContain("could not be read (disk gone)");
    expect(lines.join("\n")).not.toContain("not a run report");
  });

  it("a report.json that is not a run report is said as one", async () => {
    const lines: string[] = [];
    const out = await lineFor(
      "t1",
      "x",
      null,
      deps(async () => ({ value: {} }), lines),
    );
    expect(out.line).toContain("run report unreadable");
    expect(lines.join("\n")).toContain("is not a run report");
  });
});

describe("the line on an attached comment", () => {
  let head: string;
  let tree: string;
  const reportPath = () => join(home, "takes", takeId, "report.json");
  beforeAll(() => {
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    head = git("rev-parse", "HEAD");
    tree = git("rev-parse", "HEAD^{tree}");
  });
  afterAll(async () => {
    await rm(join(dir, ".git"), { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(reportPath(), { force: true });
  });

  /** A report with only what the line reads; `extra` overrides. */
  const report = (extra: Partial<RunReport> = {}) =>
    ({
      run: { script: { name: "s", scriptVersion: 1, steps: 3 } },
      outcome: "complete",
      steps: [{}, {}, {}],
      frames: { degradations: [], storageRefused: false },
      look: null,
      verdict: { kind: "matches", diverged: [] },
      ...extra,
    }) as unknown as RunReport;
  const writeReport = (r: RunReport) =>
    writeFile(reportPath(), JSON.stringify(r));

  /** Scripts gh for a comment on PR 7 whose head is `head`, read back with
   *  a new comment holding `posted` and the video. */
  async function commentOn(posted: string) {
    await script({
      "pr view 7 --json number,url,headRefOid": {
        stdout: JSON.stringify({
          number: 7,
          url: "https://github.com/o/r/pull/7",
          headRefOid: head,
        }),
      },
      "pr view 7 --json body,comments": [
        text("theirs"),
        text("theirs", [
          { body: `${posted}\n\n${ASSET}`, createdAt: "2026-10-25T11:00:00Z" },
        ]),
      ],
      "pr comment 7": {
        stdout: "https://github.com/o/r/pull/7#issuecomment-1\n",
      },
    });
  }
  const postedBody = () =>
    logged.find((l) => l.args[1] === "comment")?.args[4] ?? "";

  it(
    "a clean run filmed at the PR's head says so, and the line is written",
    async () => {
      await writeReport(
        report({ filmedCode: { commit: head, tree, dirty: false } }),
      );
      // Premise: the report on disk is the clean one, filmed at this tree.
      expect(
        JSON.parse(await readFile(reportPath(), "utf8")).filmedCode.tree,
      ).toBe(tree);
      const want = `Demo: \`Orders walkthrough\` · matches all 3 steps · filmed at \`${head.slice(0, 7)}\``;
      await commentOn(want);
      const answer = await attach({ into: "comment", pr: 7 });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "attached",
        line: { text: want, written: true },
      });
      expect(postedBody()).toBe(want);
    },
    ATTACH_MS,
  );

  it(
    "a stopped run says where, with its notes in a block, and no backticks or mentions from the page",
    async () => {
      await writeReport(
        report({
          outcome: "stopped",
          stopped: {
            reason: "anchorNotRendered",
            at: { index: 1, of: 3, label: "x" },
            sentence: "s",
            detail: "the page showed `Sign in` to @octocat",
          },
          filmedCode: { commit: head, tree, dirty: false },
        }),
      );
      expect(JSON.parse(await readFile(reportPath(), "utf8")).outcome).toBe(
        "stopped",
      );
      const line = `Demo: \`Orders walkthrough\` · stopped after step 1 of 3 · filmed at \`${head.slice(0, 7)}\``;
      await commentOn(line);
      const answer = await attach({ into: "comment", pr: 7 });
      expect(answer).toMatchObject({
        outcome: "attached",
        line: { written: true },
      });
      const body = postedBody();
      expect(
        body.startsWith(`${line}\n\n<details><summary>Run notes</summary>`),
      ).toBe(true);
      const notes = body.slice(body.indexOf("<details>"));
      expect(notes).toContain("the page showed Sign in to octocat");
      expect(notes.replace(/```/g, "")).not.toMatch(/[`@]/);
    },
    ATTACH_MS,
  );

  it(
    "a report written before filmedCode existed says the commit was not recorded",
    async () => {
      await writeReport(report());
      expect(
        JSON.parse(await readFile(reportPath(), "utf8")),
      ).not.toHaveProperty("filmedCode");
      const line =
        "Demo: `Orders walkthrough` · matches all 3 steps · commit not recorded";
      await commentOn(line);
      const answer = await attach({ into: "comment", pr: 7 });
      expect(answer).toMatchObject({
        outcome: "attached",
        line: { text: line, written: true },
      });
    },
    ATTACH_MS,
  );

  it(
    "no report on disk says there is no verdict",
    async () => {
      expect(existsSync(reportPath())).toBe(false);
      await commentOn(NO_REPORT_LINE);
      const answer = await attach({ into: "comment", pr: 7 });
      expect(answer).toMatchObject({
        outcome: "attached",
        line: { text: NO_REPORT_LINE, written: true },
      });
    },
    ATTACH_MS,
  );

  // Final review M-4: the comment is posted under the user's account, so
  // why the report would not read (its local path, a parser's quote of it)
  // goes to the log, not the PR.
  it(
    "an unreadable report says so on the line, and its path only in the log",
    async () => {
      await writeFile(reportPath(), "{ not json <img src=x>");
      const line =
        "Demo: `Orders walkthrough` · run report unreadable, so no verdict · commit not recorded";
      await commentOn(line);
      const answer = await attach({ into: "comment", pr: 7 });
      expect(answer).toMatchObject({
        outcome: "attached",
        line: { text: line, written: true },
      });
      expect(postedBody()).not.toContain(home);
      expect(postedBody()).not.toContain("<img");
      expect(lines.some((l) => l.includes(reportPath()))).toBe(true);
    },
    ATTACH_MS,
  );

  it(
    "a comment that reads back without its line says so",
    async () => {
      await commentOn("something else");
      const answer = await attach({ into: "comment", pr: 7 });
      expect(answer).toMatchObject({
        outcome: "attached",
        line: {
          text: NO_REPORT_LINE,
          notWritten: expect.stringContaining("without its line"),
        },
      });
      if (answer.outcome !== "attached") return;
      expect(answer.summary).toContain("was not written");
    },
    ATTACH_MS,
  );
});

describe("insertAbove", () => {
  const U = "https://github.com/user-attachments/assets/abc";
  it("puts the block as its own paragraph above the asset's", () => {
    expect(insertAbove(`Text.\n\n${U}`, U, "LINE")).toBe(
      `Text.\n\nLINE\n\n${U}`,
    );
  });
  it("takes the asset in image or video markup", () => {
    expect(insertAbove(`T\n\n<video src="${U}"></video>`, U, "L")).toBe(
      `T\n\nL\n\n<video src="${U}"></video>`,
    );
    expect(insertAbove(`T\n\n![demo](${U})`, U, "L")).toBe(
      `T\n\nL\n\n![demo](${U})`,
    );
  });
  it("keeps CRLF paragraphs CRLF", () => {
    expect(insertAbove(`Text.\r\n\r\n${U}\r\n`, U, "L")).toBe(
      `Text.\r\n\r\nL\r\n\r\n${U}\r\n`,
    );
  });
  it("answers null for an asset inside a list item, or not there", () => {
    expect(insertAbove(`Text.\n\n- see ${U}`, U, "L")).toBeNull();
    expect(insertAbove("Text.", U, "L")).toBeNull();
  });
});

describe("the line in an attached description", () => {
  const LINE = NO_REPORT_LINE;
  const WITH_LINE = text(
    `Adds the filter.\n\n${OLD_ASSET}\n\n${LINE}\n\n${ASSET}`,
  );
  const bodyWrite = () => logged.find((l) => l.args.includes("--body-file"));

  it(
    "writes the line above the video, keeping the author's text",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, AFTER, WITH_LINE],
        "pr edit 12 --attach": { stdout: `${PR_URL}\n` },
        "pr edit 12 --body-file": { stdout: `${PR_URL}\n` },
      });
      const answer = await attach({ into: "description" });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "attached",
        line: { text: LINE, written: true },
      });
      expect(bodyWrite()?.bodyFile).toBe(
        `Adds the filter.\n\n${OLD_ASSET}\n\n${LINE}\n\n${ASSET}`,
      );
      expect(calls().slice(-4)).toEqual([
        expect.stringMatching(/^pr edit 12 --attach \S+\.mp4$/),
        "pr view 12 --json body,comments",
        expect.stringMatching(/^pr edit 12 --body-file \S+$/),
        "pr view 12 --json body,comments",
      ]);
    },
    ATTACH_MS,
  );

  it(
    "a body write gh refuses is still attached, saying the line was not written",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [BEFORE, AFTER],
        "pr edit 12 --attach": { stdout: `${PR_URL}\n` },
        "pr edit 12 --body-file": {
          code: 1,
          stderr: "HTTP 502: Bad Gateway\n",
        },
      });
      const answer = await attach({ into: "description" });
      expect(answer).toMatchObject({
        outcome: "attached",
        assetUrl: ASSET,
        line: { text: LINE, notWritten: expect.stringContaining("HTTP 502") },
      });
      if (answer.outcome !== "attached") return;
      expect(answer.summary).toContain("was not written");
    },
    ATTACH_MS,
  );

  it(
    "a body that reads back without the video says so first",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [
          BEFORE,
          AFTER,
          text(`Adds the filter.\n\n${LINE}`),
        ],
        "pr edit 12 --attach": { stdout: `${PR_URL}\n` },
        "pr edit 12 --body-file": { stdout: `${PR_URL}\n` },
      });
      const answer = await attach({ into: "description" });
      expect(answer).toMatchObject({
        outcome: "attached",
        line: {
          notWritten: expect.stringContaining("no longer in the description"),
        },
      });
    },
    ATTACH_MS,
  );

  // Final review I-3: a second attach of the same take writes the same line,
  // so finding the line in the read-back proved nothing.
  it(
    "a re-attach whose body write changed nothing is not called written",
    async () => {
      const once = `Adds the filter.\n\n${LINE}\n\n${OLD_ASSET}`;
      const posted = text(`${once}\n\n${ASSET}`);
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [text(once), posted, posted],
        "pr edit 12 --attach": { stdout: `${PR_URL}\n` },
        "pr edit 12 --body-file": { stdout: `${PR_URL}\n` },
      });
      const answer = await attach({ into: "description" });
      // Premise: the edit was asked for, and the read-back holds the line
      // (the first attach's) and the new video.
      expect(bodyWrite()?.bodyFile).toBe(
        `Adds the filter.\n\n${LINE}\n\n${OLD_ASSET}\n\n${LINE}\n\n${ASSET}`,
      );
      expect(answer).toMatchObject({
        outcome: "attached",
        line: { notWritten: expect.stringContaining("without the line") },
      });
    },
    ATTACH_MS,
  );

  it(
    "a video gh put inside other text gets no line, saying why, and no body write",
    async () => {
      await script({
        "pr view --json number,url,headRefOid": prView,
        "pr view 12 --json body,comments": [
          BEFORE,
          text(`Adds the filter.\n\n${OLD_ASSET}\n- ${ASSET}`),
        ],
        "pr edit 12 --attach": { stdout: `${PR_URL}\n` },
      });
      const answer = await attach({ into: "description" });
      expect(answer).toMatchObject({
        outcome: "attached",
        line: { notWritten: expect.stringContaining("paragraph of its own") },
      });
      expect(bodyWrite()).toBeUndefined();
    },
    ATTACH_MS,
  );
});

describe("capMissed", () => {
  const saved = (cap: object | undefined): ExportAnswer =>
    ({
      outcome: "saved",
      warnings: {
        ...(cap === undefined
          ? {}
          : { videoSize: { quality: "share", byteLength: 2, cap } }),
      },
    }) as unknown as ExportAnswer;
  it("says nothing without a cap, or for one that was met", () => {
    expect(capMissed(saved(undefined))).toBe("");
    expect(
      capMissed(
        saved({ maxBytes: 9_500_000, met: true, steps: [], keptQuality: null }),
      ),
    ).toBe("");
  });
  // Final review, Important 1: attach is the default way into the fit
  // rung, and its summary is the sentence the agent relays. Red if a file
  // softened to fit reads as one that simply fit.
  it("says a met cap that softened the video", () => {
    expect(
      capMissed(
        saved({
          maxBytes: 9_500_000,
          met: true,
          steps: [{ kind: "fit", bitrate: 1_600_000, durationMs: 45_000 }],
          keptQuality: null,
          belowFloor: true,
        }),
      ),
    ).toBe(", softer than usual to fit in 9.5 MB");
  });
  // /code-review #2 and #6: the fit rung is retried once, so a miss there
  // is not "the smallest it goes"; the export's own summary says the same.
  it("says a missed cap was softened, not that it is the smallest", () => {
    expect(
      capMissed(
        saved({
          maxBytes: 9_500_000,
          met: false,
          steps: [{ kind: "fit", bitrate: 1_600_000, durationMs: 45_000 }],
          keptQuality: null,
          belowFloor: true,
        }),
      ),
    ).toBe(", but it is over the 9.5 MB asked for even after softening it");
  });
  it("names the cap and the failure when a step threw", () => {
    expect(
      capMissed(
        saved({
          maxBytes: 9_500_000,
          met: false,
          steps: [],
          keptQuality: null,
          failed: {
            step: { kind: "quality", from: 0.6, to: 0.35 },
            error: "the encoder closed.",
          },
        }),
      ),
    ).toBe(
      ", but it is over the 9.5 MB asked for: lowering it further failed (the encoder closed)",
    );
  });
});

describe("copyFailedDetail", () => {
  it("hands over a capped export, not the saved file that can be over 10 MB", () => {
    const detail = copyFailedDetail("/out/a.mp4", "/tmp/x/a.mp4", "EACCES");
    expect(detail).toContain("saved at /out/a.mp4");
    expect(detail).toContain("nothing was posted");
    expect(detail).toContain("export({ takeId, maxMB: 9.5 })");
    expect(detail).toContain("file.path to drag into the PR");
    expect(detail).not.toContain("Give the user that file");
  });
});
