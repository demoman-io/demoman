import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshResult } from "@demoman/runner/package";
import { beforeEach, describe, expect, it } from "vitest";
import { type HandOff, writeHandOff } from "../src/handoff.js";

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
