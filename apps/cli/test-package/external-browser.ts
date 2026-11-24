import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What hands a URL or file to the person's own browser or desktop. */
const OPENERS = [
  "open",
  "xdg-open",
  "gnome-open",
  "sensible-browser",
  "x-www-browser",
];

/**
 * Stands in for every way a flow could reach the person's own browser:
 * the system openers first on the PATH, and `$BROWSER`, each logging what
 * it was asked instead of opening it. DEM-218: an export once opened a tab
 * in the author's everyday Chrome; Demoman's windows are Playwright's
 * Chromium and nothing else. `calls()` is every line one was asked.
 */
export async function watchExternalBrowser(): Promise<{
  env: { PATH: string; BROWSER: string };
  calls(): Promise<string[]>;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "demoman-openers-"));
  const log = join(dir, "opened.log");
  for (const name of OPENERS) {
    await writeFile(
      join(dir, name),
      `#!/bin/sh\necho "${name} $*" >> "${log}"\n`,
      { mode: 0o755 },
    );
  }
  const env = {
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    BROWSER: join(dir, "x-www-browser"),
  };
  // Premise: an opener asked through this env is the stand-in, and logs.
  // Without it, a watch that caught nothing would read as a flow that
  // opened nothing.
  const probe = process.platform === "darwin" ? "open" : "xdg-open";
  spawnSync(probe, ["self-check"], { env: { ...process.env, ...env } });
  const seen = await readFile(log, "utf8").catch(() => "");
  if (!seen.includes(`${probe} self-check`)) {
    throw new Error(
      `watchExternalBrowser: \`${probe}\` on its PATH was not the stand-in (log: ${JSON.stringify(seen)})`,
    );
  }
  await rm(log);
  return {
    env,
    // No log is no call (the first call makes it); any other read error is
    // said, not taken for none.
    calls: async () =>
      (
        await readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        })
      )
        .split("\n")
        .filter((l) => l !== ""),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
