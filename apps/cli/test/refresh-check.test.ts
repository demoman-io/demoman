import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOWS_DIR,
  type KeptVideo,
  keptFileName,
  RECEIPT_DIR,
  serializeKept,
  serializeReceipt,
} from "@demoman/run-core";
import { beforeAll, describe, expect, it } from "vitest";
import { refreshCheck } from "../src/refresh-check.js";

const NAME = "Place an order";
const kept: KeptVideo = {
  keptVersion: 2,
  flow: "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90",
  deliver: "commit",
  name: NAME,
  script: {
    scriptVersion: 1,
    name: NAME,
    target: "http://localhost:1/app",
    viewport: { width: 1280, height: 800 },
    steps: [{ do: "waitForLoad" }],
  } as KeptVideo["script"],
  scale: 1,
  logo: null,
  wallpaper: null,
  outputs: [
    { path: "docs/o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
  ],
  report: null,
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const check = async (cwd: string) => {
  const said: string[] = [];
  const code = await refreshCheck(cwd, undefined, { say: (l) => said.push(l) });
  return { code, out: said.join("\n") };
};

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "demoman-cli-check-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  mkdirSync(join(repo, FLOWS_DIR), { recursive: true });
  mkdirSync(join(repo, RECEIPT_DIR), { recursive: true });
  writeFileSync(join(repo, FLOWS_DIR, keptFileName(NAME)), serializeKept(kept));
  writeFileSync(join(repo, "app.txt"), "v1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "app");
  const commit = git(repo, "rev-parse", "HEAD");
  // The refresh's own commit: a video and the receipt naming the commit above.
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs/o.mp4"), "video");
  writeFileSync(
    join(repo, RECEIPT_DIR, keptFileName(NAME)),
    serializeReceipt({
      receiptVersion: 1,
      flow: kept.flow,
      video: "t1",
      filmedAt: null,
      filmedCode: {
        commit,
        tree: git(repo, "rev-parse", "HEAD^{tree}"),
        dirty: false,
      },
      screens: { steps: 1, moments: [{ step: null, ms: 500 }] },
      recordedRevision: null,
    }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "Refresh demo videos");
});

describe("demoman refresh --check", () => {
  it("answers 3 when only the refresh's own files changed since the recording", async () => {
    const r = await check(repo);
    expect(r.out).toContain(`${NAME}: current (recorded at`);
    expect(r.code, r.out).toBe(3);
  });

  it("answers 0 once the app changed, and says so", async () => {
    writeFileSync(join(repo, "app.txt"), "v2\n");
    git(repo, "commit", "-q", "-am", "app change");
    const r = await check(repo);
    expect(r.out).toContain("1 other file changed since");
    expect(r.code, r.out).toBe(0);
  });
});
