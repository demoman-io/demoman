import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit, type RefreshResult } from "@demoman/runner/package";
import { beforeEach, describe, expect, it } from "vitest";
import { type HandOff, readHandOff, writeHandOff } from "../src/handoff.js";

type Video = RefreshResult["videos"][number];
const base = {
  flow: null,
  deliver: "commit",
  video: null,
  filmedCode: null,
  sameAs: null,
  files: [] as Video["files"],
  screens: null,
  report: null,
  name: "x",
  file: ".demoman/videos/x.json",
  detail: "",
  line: null,
  notes: [],
} as const;

let root: string;
let out: string;
const put = (p: string, body: string) => {
  mkdirSync(join(root, p, ".."), { recursive: true });
  writeFileSync(join(root, p), body);
};
const RECEIPT = ".demoman/receipts/x.json";
const mk = (videos: Partial<Video>[]): RefreshResult =>
  ({ videos: videos.map((v) => ({ ...base, ...v })) }) as RefreshResult;
const args = (result: RefreshResult) => ({
  repoRoot: root,
  result,
  named: true,
  commit: "abc",
  version: "1.2.3",
});
const read = (): HandOff =>
  JSON.parse(readFileSync(join(out, "handoff.json"), "utf8"));
const names = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? [e.name, ...names(join(d, e.name))] : [e.name],
  );

beforeEach(() => {
  const t = mkdtempSync(join(tmpdir(), "handoff-"));
  root = join(t, "repo");
  out = join(t, "demoman-handoff");
  mkdirSync(root);
  put("docs/x.mp4", "VIDEO");
  put("docs/x.json", "REPORT");
  put(RECEIPT, "RECEIPT");
  put("docs/x-screens/a.png", "A");
  put("docs/x-screens/b.png", "B");
  put("docs/same.mp4", "SAME");
});

const changed = (): Partial<Video> => ({
  outcome: "changed",
  outputs: ["docs/x.mp4", "docs/x.json", RECEIPT, "docs/x-screens"],
});

describe("writeHandOff", () => {
  it("carries a changed commit video's files and screens folder, not an unchanged one", async () => {
    const result = mk([
      changed(),
      { outcome: "unchanged", outputs: ["docs/same.mp4"] },
    ]);
    expect(RECEIPT.startsWith(".demoman/")).toBe(true);
    expect(await writeHandOff(out, args(result))).toEqual({ written: 5 });
    const h = read();
    expect(h.files.map((f) => f.path)).toEqual([
      "docs/x.mp4",
      "docs/x.json",
      RECEIPT,
      "docs/x-screens/a.png",
      "docs/x-screens/b.png",
    ]);
    expect(h.folders).toEqual(["docs/x-screens"]);
    for (const f of h.files)
      expect(readFileSync(join(out, f.stored))).toEqual(
        readFileSync(join(root, f.path)),
      );
    expect([h.commit, h.demoman, h.named]).toEqual(["abc", "1.2.3", true]);
  });

  it("stores under plain numbered names, none starting with a dot", async () => {
    await writeHandOff(out, args(mk([changed()])));
    const h = read();
    expect(h.files.some((f) => f.path.startsWith(".demoman/"))).toBe(true);
    for (const f of h.files) expect(f.stored).toMatch(/^files\/\d+$/);
    expect(names(out).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("does not carry a failed video's outputs, and the result round-trips", async () => {
    const result = mk([
      changed(),
      { outcome: "failed", outputs: ["docs/same.mp4"] },
    ]);
    await writeHandOff(out, args(result));
    expect(read().files.map((f) => f.path)).not.toContain("docs/same.mp4");
    expect(read().result).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it("names a missing output and leaves no folder", async () => {
    const r = await writeHandOff(
      out,
      args(mk([{ outcome: "changed", outputs: ["docs/gone.mp4"] }])),
    );
    expect(r).toEqual({
      failed:
        "docs/gone.mp4, which refresh says it wrote, is not in the checkout",
    });
    expect(existsSync(out)).toBe(false);
    expect(
      readdirSync(join(out, "..")).filter((n) =>
        n.startsWith(".demoman-handoff-"),
      ),
    ).toEqual([]);
  });

  it("refuses an existing folder and leaves it alone", async () => {
    mkdirSync(out);
    writeFileSync(join(out, "keep"), "K");
    const r = await writeHandOff(out, args(mk([changed()])));
    expect(r).toEqual({ failed: `${out} already exists` });
    expect(names(out)).toEqual(["keep"]);
  });

  it("writes an empty hand-off when nothing is to be committed", async () => {
    expect(await writeHandOff(out, args(mk([])))).toEqual({ written: 0 });
    expect(read().files).toEqual([]);
  });

  it("names a subfolder inside a screens folder instead of dropping it", async () => {
    mkdirSync(join(root, "docs/x-screens/sub"));
    const r = await writeHandOff(out, args(mk([changed()])));
    expect(r).toEqual({
      failed: "docs/x-screens/sub in a screens folder is not a plain file",
    });
    expect(existsSync(out)).toBe(false);
  });

  it("carries a path two videos both output once", async () => {
    await writeHandOff(out, args(mk([changed(), changed()])));
    const h = read();
    expect(h.files).toHaveLength(5);
    expect(h.folders).toEqual(["docs/x-screens"]);
  });

  it("names the step when a copy fails and leaves nothing behind", async () => {
    // chmod 000 refuses the read for a non-root user; root would read it anyway.
    chmodSync(join(root, "docs/x.mp4"), 0o000);
    const r = await writeHandOff(out, args(mk([changed()])));
    chmodSync(join(root, "docs/x.mp4"), 0o644);
    expect(r).toMatchObject({
      failed: expect.stringMatching(/^copying docs\/x\.mp4: .*EACCES/),
    });
    expect(existsSync(out)).toBe(false);
    expect(
      readdirSync(join(out, "..")).filter((n) =>
        n.startsWith(".demoman-handoff-"),
      ),
    ).toEqual([]);
  });
});

describe("readHandOff", () => {
  // `src` is the refresh job's checkout, `repo` the deliver job's: the same
  // commit, with the kept flows committed and an old screen in the checkout.
  let src: string;
  let repo: string;
  let dir: string;
  let sha: string;
  const git = async (...a: string[]) => {
    const r = await execGit(a, repo);
    if (r.code !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const flow = (name: string, deliver: string, outputs: string[]) =>
    JSON.stringify({
      keptVersion: 2,
      flow: crypto.randomUUID(),
      deliver,
      name,
      script: {
        scriptVersion: 1,
        name,
        target: "http://localhost/app",
        viewport: { width: 1280, height: 800 },
        steps: [{ do: "waitForLoad" }],
      },
      scale: 1,
      logo: null,
      wallpaper: null,
      outputs: outputs.map((path) => ({
        path,
        fileType: "mp4",
        aspect: "auto",
        quality: "share",
      })),
      report: deliver === "commit" ? "docs/x.json" : null,
    });
  const SCREENS = ".demoman/receipts/x.screens";
  const OUTPUTS = ["docs/x.mp4", "docs/x.json", RECEIPT, SCREENS];
  const at = (r: string, p: string, body: string) => {
    mkdirSync(join(r, p, ".."), { recursive: true });
    writeFileSync(join(r, p), body);
  };
  const read2 = () =>
    readHandOff(dir, { repoRoot: repo, version: "1.2.3", git: execGit });
  const read2Stored = (): string[] =>
    JSON.parse(readFileSync(join(dir, "handoff.json"), "utf8")).files.map(
      (f: { stored: string }) => f.stored,
    );
  const edit = (fn: (h: HandOff) => void) => {
    const h = JSON.parse(readFileSync(join(dir, "handoff.json"), "utf8"));
    fn(h);
    writeFileSync(join(dir, "handoff.json"), JSON.stringify(h));
  };
  const refused = async (why: string | RegExp) => {
    expect(await read2()).toEqual({
      refused: typeof why === "string" ? why : expect.stringMatching(why),
    });
    // The premise of every refusal: nothing in the checkout moved.
    expect(await git("status", "--porcelain")).toBe("");
  };

  beforeEach(async () => {
    const t = mkdtempSync(join(tmpdir(), "handoff-read-"));
    src = join(t, "src");
    repo = join(t, "repo");
    dir = join(t, "demoman-handoff");
    mkdirSync(repo);
    at(repo, ".demoman/flows/x.json", flow("x", "commit", ["docs/x.mp4"]));
    at(repo, ".demoman/flows/f.json", flow("f", "files", ["f.mp4"]));
    at(repo, `${SCREENS}/old.png`, "OLD");
    await git("init", "-q");
    await git("add", ".");
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "kept",
    );
    sha = await git("rev-parse", "HEAD");
    at(src, "docs/x.mp4", "NEW VIDEO");
    at(src, "docs/x.json", "NEW REPORT");
    at(src, RECEIPT, "NEW RECEIPT");
    at(src, `${SCREENS}/a.png`, "A");
    const result = mk([
      { outcome: "changed", outputs: OUTPUTS, file: ".demoman/flows/x.json" },
    ]);
    const w = await writeHandOff(dir, {
      repoRoot: src,
      result,
      named: false,
      commit: sha,
      version: "1.2.3",
    });
    // The premise: a hand-off of four files whose first is the video.
    expect(w).toEqual({ written: 4 });
    expect(
      JSON.parse(readFileSync(join(dir, "handoff.json"), "utf8")).files[0],
    ).toEqual({
      path: "docs/x.mp4",
      stored: "files/0",
    });
  });

  it("accepts a hand-off its flows declare and places it", async () => {
    const r = await read2();
    if (!("handOff" in r)) throw new Error(JSON.stringify(r));
    expect(r.handOff.commit).toBe(sha);
    expect(await git("status", "--porcelain")).toBe("");
    expect(await r.place()).toEqual({ ok: true });
    for (const p of ["docs/x.mp4", "docs/x.json", RECEIPT, `${SCREENS}/a.png`])
      expect(readFileSync(join(repo, p), "utf8")).toBe(
        readFileSync(join(src, p), "utf8"),
      );
    expect(readdirSync(join(repo, SCREENS))).toEqual(["a.png"]);
  });

  it("refuses a missing or unparsable handoff.json", async () => {
    rmSync(join(dir, "handoff.json"));
    await refused(
      new RegExp(
        `^the hand-off at ${dir} has no readable handoff\\.json \\(.*ENOENT`,
      ),
    );
    writeFileSync(join(dir, "handoff.json"), "{");
    await refused(
      `the hand-off at ${dir} has no readable handoff.json (${(() => {
        try {
          JSON.parse("{");
        } catch (e) {
          return (e as Error).message;
        }
      })()})`,
    );
  });

  it("refuses another hand-off format, naming both", async () => {
    edit((h) => {
      (h as { handoffVersion: number }).handoffVersion = 2;
    });
    await refused(
      "the hand-off was written by a hand-off format this Demoman does not read (format 2; this Demoman reads 1)",
    );
  });

  it("refuses another demoman, naming both versions", async () => {
    edit((h) => {
      h.demoman = "0.0.0";
    });
    await refused(
      "the hand-off was written by demoman 0.0.0, delivered by 1.2.3; the workflow must install one release",
    );
  });

  it("refuses a hand-off recorded at another commit, naming both", async () => {
    const other = "0".repeat(40);
    edit((h) => {
      h.commit = other;
    });
    await refused(
      `refresh recorded at ${other} and this checkout is at ${sha}`,
    );
  });

  for (const path of [
    "../x.mp4",
    "/etc/x",
    ".github/workflows/x.yml",
    "a/.git/hooks/pre-push",
  ])
    it(`refuses ${path}, which no flow may write`, async () => {
      edit((h) => {
        (h.files[0] as { path: string }).path = path;
      });
      await refused(`the hand-off names ${path}, which no flow may write`);
    });

  it("refuses a folder no flow may write", async () => {
    edit((h) => {
      h.folders = [".git"];
    });
    await refused("the hand-off names .git, which no flow may write");
  });

  it("refuses a path no commit flow declares", async () => {
    edit((h) => {
      (h.files[0] as { path: string }).path = "src/index.ts";
    });
    await refused(
      `the hand-off names src/index.ts, which no commit flow at ${sha} declares`,
    );
  });

  it("refuses a video to commit that is a files flow", async () => {
    edit((h) => {
      (h.result.videos[0] as { file: string }).file = ".demoman/flows/f.json";
    });
    await refused(
      "the hand-off delivers x (.demoman/flows/f.json), which is not a commit flow here",
    );
  });

  it("refuses a video to commit whose kept file does not read, with the reader's words", async () => {
    at(repo, ".demoman/flows/x.json", "{");
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qam",
      "broken",
    );
    const head = await git("rev-parse", "HEAD");
    edit((h) => {
      h.commit = head;
    });
    // Its paths are no flow's now: the declared set has nothing in it.
    await refused(
      `the hand-off names docs/x.mp4, which no commit flow at ${head} declares`,
    );
    edit((h) => {
      h.files = [];
      h.folders = [];
    });
    rmSync(join(dir, "files"), { recursive: true });
    mkdirSync(join(dir, "files"));
    await refused(
      /^the hand-off delivers x \(\.demoman\/flows\/x\.json\), which is not a commit flow here \(\.demoman\/flows\/x\.json: is not valid JSON/,
    );
  });

  it("refuses an output with no files entry", async () => {
    edit((h) => {
      h.files = h.files.slice(1);
    });
    await refused("the hand-off and its result disagree on docs/x.mp4");
  });

  it("refuses a files entry that is no output", async () => {
    edit((h) => {
      const v = h.result.videos[0] as { outputs: string[] };
      v.outputs = v.outputs.filter((o) => o !== "docs/x.mp4");
    });
    await refused("the hand-off and its result disagree on docs/x.mp4");
  });

  it("refuses a stored file that is a symlink", async () => {
    rmSync(join(dir, "files/0"));
    symlinkSync("/etc/hosts", join(dir, "files/0"));
    await refused(
      "files/0 for docs/x.mp4 is missing or not a plain file (a symlink)",
    );
  });

  it("refuses a stored file outside files/, though it is there", async () => {
    const stored = "../repo/.demoman/flows/x.json";
    // The premise: the target is a plain file, so only the files/ rule refuses it.
    expect(statSync(join(dir, stored)).isFile()).toBe(true);
    edit((h) => {
      (h.files[0] as { stored: string }).stored = stored;
    });
    await refused(
      `${stored} for docs/x.mp4 is missing or not a plain file (outside files/)`,
    );
  });

  it("names a stored file that is missing", async () => {
    rmSync(join(dir, "files/0"));
    await refused(
      "files/0 for docs/x.mp4 is missing or not a plain file (ENOENT)",
    );
  });

  it("refuses a linked files folder whose entries are all listed", async () => {
    // A folder elsewhere holding exactly what handoff.json lists, plain files.
    const elsewhere = join(dir, "..", "elsewhere");
    cpSync(join(dir, "files"), elsewhere, { recursive: true });
    rmSync(join(dir, "files"), { recursive: true });
    symlinkSync(elsewhere, join(dir, "files"));
    expect(readdirSync(elsewhere).sort()).toEqual(
      read2Stored()
        .map((n) => n.slice("files/".length))
        .sort(),
    );
    await refused(
      "the hand-off's files is a symlink, which a hand-off never holds",
    );
  });

  it("refuses files linked to the checkout's .git", async () => {
    rmSync(join(dir, "files"), { recursive: true });
    symlinkSync(join(repo, ".git"), join(dir, "files"));
    edit((h) => {
      h.files = [{ path: "docs/x.mp4", stored: "files/config" }];
      h.folders = [];
      (h.result.videos[0] as { outputs: string[] }).outputs = ["docs/x.mp4"];
    });
    expect(statSync(join(dir, "files/config")).isFile()).toBe(true);
    await refused(
      "the hand-off's files is a symlink, which a hand-off never holds",
    );
  });

  it("refuses a folder no commit flow declares", async () => {
    edit((h) => {
      h.folders.push("src");
      (h.result.videos[0] as { outputs: string[] }).outputs.push("src");
    });
    await refused(
      `the hand-off names src, which no commit flow at ${sha} declares`,
    );
  });

  for (const [field, value, want] of [
    ["line", 5, "a string or null"],
    ["notes", [1], "a list of strings"],
    ["detail", null, "a string"],
    ["outcome", "won", "one of changed, added, uncompared, unchanged, failed"],
    ["evidence", { folder: 1 }, "absent or { folder, noStill }"],
  ] as const)
    it(`refuses a video whose ${field} is not ${want}`, async () => {
      edit((h) => {
        (h.result.videos[0] as unknown as Record<string, unknown>)[field] =
          value;
      });
      await refused(
        `the hand-off at ${dir} has no readable handoff.json (result.videos[0] (x): ${field} is not ${want})`,
      );
    });

  it("refuses an entry its handoff.json does not list", async () => {
    writeFileSync(join(dir, "files/extra"), "X");
    await refused(
      "the hand-off holds files/extra, which its handoff.json does not list",
    );
  });
});
