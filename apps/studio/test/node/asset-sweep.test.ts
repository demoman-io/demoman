import {
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

describe("the upkeep's asset sweep (DEM-136)", () => {
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
});
