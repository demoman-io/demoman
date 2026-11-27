import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASSET_GRACE_MS,
  BACKUP_KEEP_MS,
  sweepAssets,
} from "../../src/assets.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 18);

let home: string;
let takes: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-sweep-"));
  takes = join(home, "takes");
  await mkdir(join(home, "assets"), { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** An asset whose file was last written `ageMs` before NOW. */
async function asset(name: string, ageMs: number): Promise<void> {
  const path = join(home, "assets", name);
  await writeFile(path, "bytes");
  const at = new Date(NOW - ageMs);
  await utimes(path, at, at);
}
const kitsNaming = (ref: string) =>
  JSON.stringify({ kits: [{ id: "k", logo: { ref } }] });
async function take(id: string, file: string, ref: string): Promise<void> {
  await mkdir(join(takes, id), { recursive: true });
  await writeFile(
    join(takes, id, file),
    JSON.stringify({ branding: { background: { kind: "image", ref } } }),
  );
}
const left = async () => (await readdir(join(home, "assets"))).sort();
const backupsLeft = async () =>
  (await readdir(home)).filter((n) => n.startsWith("kits.json.bak-")).sort();

describe("the upkeep's asset sweep", () => {
  // Red if any one source of a name stops being read, or the grace or the
  // backup rule goes: the asset or backup it keeps would be removed.
  it("removes only what nothing kept names and is past its grace, and backups past keeping but the newest", async () => {
    const old = ASSET_GRACE_MS + DAY;
    await asset("kit.png", old);
    await asset("scene.webp", old);
    await asset("script.svg", old);
    await asset("backup.png", old);
    await asset("orphan.webp", old);
    await asset("fresh.webp", ASSET_GRACE_MS - DAY);
    await writeFile(join(home, "kits.json"), kitsNaming("assets/kit.png"));
    await take("t1", "scene.json", "assets/scene.webp");
    await take("t2", "script.json", "assets/script.svg");
    const newestOld = NOW - BACKUP_KEEP_MS - DAY;
    const olderOld = NOW - BACKUP_KEEP_MS - 2 * DAY;
    const young = NOW - DAY;
    await writeFile(
      join(home, `kits.json.bak-${newestOld}`),
      kitsNaming("assets/backup.png"),
    );
    await writeFile(join(home, `kits.json.bak-${olderOld}`), "{}");
    // The newest backup is young, so both old ones are past keeping, and
    // backup.png is named only by a backup that goes.
    await writeFile(join(home, `kits.json.bak-${young}`), "{}");
    expect(await left()).toHaveLength(6);

    const s = await sweepAssets(home, takes, NOW);

    expect(s.failed).toEqual([]);
    expect(s.stopped).toBeUndefined();
    expect([...s.removed].sort()).toEqual(
      [
        join(home, `kits.json.bak-${newestOld}`),
        join(home, `kits.json.bak-${olderOld}`),
        join(home, "assets", "orphan.webp"),
        join(home, "assets", "backup.png"),
      ].sort(),
    );
    expect(await left()).toEqual([
      "fresh.webp",
      "kit.png",
      "scene.webp",
      "script.svg",
    ]);
    expect(await backupsLeft()).toEqual([`kits.json.bak-${young}`]);
  });

  // Red if the newest backup is removed for its age: a reset's only copy.
  it("keeps the newest backup however old, and what it names", async () => {
    const at = NOW - BACKUP_KEEP_MS - DAY;
    await writeFile(
      join(home, `kits.json.bak-${at}`),
      kitsNaming("assets/b.png"),
    );
    await asset("b.png", ASSET_GRACE_MS + DAY);
    const s = await sweepAssets(home, takes, NOW);
    expect(s).toEqual({ removed: [], failed: [] });
    expect(await backupsLeft()).toEqual([`kits.json.bak-${at}`]);
    expect(await left()).toEqual(["b.png"]);
  });

  // Red if an unreadable scene is read as naming nothing: its assets would go.
  it("removes no asset when a take's scene will not read, and says which", async () => {
    await asset("orphan.webp", ASSET_GRACE_MS + DAY);
    // A folder where scene.json should be: reading it fails (EISDIR).
    await mkdir(join(takes, "t1", "scene.json"), { recursive: true });
    const s = await sweepAssets(home, takes, NOW);
    expect(s.removed).toEqual([]);
    expect(s.stopped).toContain(join(takes, "t1", "scene.json"));
    expect(s.stopped).toContain("could not be read");
    expect(await left()).toEqual(["orphan.webp"]);
  });

  // Red if only a reset's own backups are read for names: a backup a person
  // named by hand would come back pointing at deleted files.
  it("reads a hand-named backup for names, and never ages it out", async () => {
    await writeFile(
      join(home, "kits.json.bak-2026-10-18-nylon"),
      kitsNaming("assets/nylon.png"),
    );
    await asset("nylon.png", ASSET_GRACE_MS + DAY);
    const s = await sweepAssets(home, takes, NOW);
    expect(s).toEqual({ removed: [], failed: [] });
    expect(await backupsLeft()).toEqual(["kits.json.bak-2026-10-18-nylon"]);
    expect(await left()).toEqual(["nylon.png"]);
  });

  // Red if a backup that would not go is dropped from the names anyway.
  it("still reads a backup it could not remove, and keeps what it names", async () => {
    const newest = NOW - DAY;
    const old = NOW - BACKUP_KEEP_MS - DAY;
    await writeFile(join(home, `kits.json.bak-${newest}`), "{}");
    await writeFile(
      join(home, `kits.json.bak-${old}`),
      kitsNaming("assets/o.png"),
    );
    await asset("o.png", ASSET_GRACE_MS + DAY);
    // The home refuses removals; assets/ is its own folder and does not.
    await chmod(home, 0o555);
    try {
      const s = await sweepAssets(home, takes, NOW);
      expect(s.failed, "premise: the old backup would not go").toEqual([
        expect.stringContaining(`kits.json.bak-${old}`),
      ]);
      expect(s.removed).toEqual([]);
    } finally {
      await chmod(home, 0o755);
    }
    expect(await left()).toEqual(["o.png"]);
  });

  // Red if the name has to use a forward slash: a Windows path in a scene
  // would not keep its file.
  it("counts a name written with backslashes", async () => {
    await asset("win.webp", ASSET_GRACE_MS + DAY);
    await take("t1", "scene.json", "C:\\Users\\me\\.demoman\\assets\\win.webp");
    const s = await sweepAssets(home, takes, NOW);
    expect(s).toEqual({ removed: [], failed: [] });
    expect(await left()).toEqual(["win.webp"]);
  });

  // Red if a run's own wallpaper copy is swept by age: a run reuses it
  // without rewriting it, before any scene names it.
  it("leaves a run's own wallpaper copy, however old", async () => {
    const owned = `${"a1".repeat(32)}.webp`;
    await asset(owned, ASSET_GRACE_MS + 100 * DAY);
    await asset("orphan.webp", ASSET_GRACE_MS + DAY);
    const s = await sweepAssets(home, takes, NOW);
    expect(s.removed).toEqual([join(home, "assets", "orphan.webp")]);
    expect(await left()).toEqual([owned]);
  });
});
