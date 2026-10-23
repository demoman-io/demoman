// apps/cli/src/agent-skill.ts
//
// An agent with no plugin layer (Cursor, OpenCode) gets the record-demo
// skill copied by setup, and its entry runs `demoman@latest`: the server
// updates itself, the copy would not (/code-review, 2026-10-19). So the
// server that agent starts — its entry sets DEMOMAN_CLIENT — puts its own
// skill there when the copy is Demoman's and differs. Only that agent's
// server writes it: that one is the newest, so two versions never take
// turns. An agent setup connects later is one row of SKILL_FOLDERS.
import { isOurSkill, opencodeDir } from "./configs.js";

export interface AgentSkillDeps {
  env: Record<string, string | undefined>;
  home: string;
  /** The skill shipped beside this server, or why it could not be read. */
  skill: { text: string } | { error: string };
  readText(
    path: string,
  ): { text: string } | { missing: true } | { error: string };
  writeText(path: string, text: string): { ok: true } | { error: string };
}

/** Each DEMOMAN_CLIENT setup writes, its agent's name and skills folder. */
const SKILL_FOLDERS: Record<
  string,
  {
    agent: string;
    folder(home: string, env: Record<string, string | undefined>): string;
  }
> = {
  cursor: { agent: "Cursor", folder: (home) => `${home}/.cursor/skills` },
  opencode: {
    agent: "OpenCode",
    folder: (home, env) => `${opencodeDir(home, env)}/skills`,
  },
};

/** A line for the server's log when there is something to say: the copy
 *  was refreshed, or why it was not. null when there is nothing to do. */
export function refreshAgentSkill(d: AgentSkillDeps): string | null {
  const client = SKILL_FOLDERS[d.env.DEMOMAN_CLIENT ?? ""];
  if (client === undefined) return null;
  const path = `${client.folder(d.home, d.env)}/record-demo/SKILL.md`;
  const not = `${client.agent}'s record-demo skill was not refreshed`;
  if ("error" in d.skill) {
    return `${not}: this install's copy could not be read (${d.skill.error})`;
  }
  const file = d.readText(path);
  if ("error" in file) {
    return `${not}: ${path} could not be read (${file.error})`;
  }
  // Removed by the user, or never written: setup puts it there, not this.
  if ("missing" in file) {
    return `${not}: ${path} is not there (\`npx demoman setup\` puts it back)`;
  }
  if (file.text === d.skill.text) return null;
  if (!isOurSkill(file.text)) {
    return `${not}: ${path} is not Demoman's, so it was left alone`;
  }
  const wrote = d.writeText(path, d.skill.text);
  return "error" in wrote
    ? `${not}: ${path} could not be written (${wrote.error})`
    : `${client.agent}'s record-demo skill was refreshed to this version's (${path})`;
}
