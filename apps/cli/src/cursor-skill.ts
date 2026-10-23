// apps/cli/src/cursor-skill.ts
//
// Cursor has no plugin layer, so setup copies the record-demo skill to
// ~/.cursor/skills, and Cursor's entry runs `demoman@latest`: the server
// updates itself, the copy would not (/code-review, 2026-10-19). So the
// server Cursor starts — its entry sets DEMOMAN_CLIENT=cursor — puts its own
// skill there when the copy is Demoman's and differs. Only Cursor's server
// writes it: that one is the newest, so two versions never take turns.
import { isOurSkill } from "./configs.js";

export interface CursorSkillDeps {
  env: Record<string, string | undefined>;
  home: string;
  /** The skill shipped beside this server, or why it could not be read. */
  skill: { text: string } | { error: string };
  readText(
    path: string,
  ): { text: string } | { missing: true } | { error: string };
  writeText(path: string, text: string): { ok: true } | { error: string };
}

/** A line for the server's log when there is something to say: the copy
 *  was refreshed, or why it was not. null when there is nothing to do. */
export function refreshCursorSkill(d: CursorSkillDeps): string | null {
  if (d.env.DEMOMAN_CLIENT !== "cursor") return null;
  const path = `${d.home}/.cursor/skills/record-demo/SKILL.md`;
  if ("error" in d.skill) {
    return `Cursor's record-demo skill was not refreshed: this install's copy could not be read (${d.skill.error})`;
  }
  const file = d.readText(path);
  if ("error" in file) {
    return `Cursor's record-demo skill was not refreshed: ${path} could not be read (${file.error})`;
  }
  // Removed by the user, or never written: setup puts it there, not this.
  if ("missing" in file) {
    return `Cursor's record-demo skill was not refreshed: ${path} is not there (\`npx demoman setup\` puts it back)`;
  }
  if (file.text === d.skill.text) return null;
  if (!isOurSkill(file.text)) {
    return `Cursor's record-demo skill was not refreshed: ${path} is not Demoman's, so it was left alone`;
  }
  const wrote = d.writeText(path, d.skill.text);
  return "error" in wrote
    ? `Cursor's record-demo skill was not refreshed: ${path} could not be written (${wrote.error})`
    : `Cursor's record-demo skill was refreshed to this version's (${path})`;
}
