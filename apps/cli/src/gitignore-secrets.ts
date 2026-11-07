// The setup PR carries the line that ignores .demoman/secrets.env, so a
// teammate's clone ignores it too (DEM-62). Whether a .gitignore already
// ignores it is git's call, not a line match (review of #35, finding 7).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit } from "@demoman/runner/package";

export const SECRETS_FILE = ".demoman/secrets.env";
export const SECRETS_IGNORE =
  "# Demoman: demo account passwords\n.demoman/secrets.env\n";

// No global or system git config: only the given text decides.
const ISOLATED = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Whether this .gitignore text ignores .demoman/secrets.env, as git reads
 *  its patterns (`.demoman/`, `*.env`, a leading slash). */
export async function ignoresSecrets(text: string): Promise<boolean> {
  if (text.trim() === "") return false;
  const dir = await mkdtemp(join(tmpdir(), "demoman-ignore-"));
  try {
    await execGit(["init", "-q"], dir, ISOLATED);
    await writeFile(join(dir, ".gitignore"), text);
    const r = await execGit(
      ["check-ignore", "--no-index", "-q", "--", SECRETS_FILE],
      dir,
      ISOLATED,
    );
    return r.code === 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `lines` added to a file's text after a blank line, its last line ended
 *  first; just `lines` for an empty file. */
export function withLines(text: string, lines: string): string {
  if (text === "") return lines;
  return `${text}${text.endsWith("\n") ? "" : "\n"}\n${lines}`;
}
