import { describe, expect, it } from "vitest";
import {
  type AgentSkillDeps,
  refreshAgentSkill,
  refreshCursorRules,
} from "../src/agent-skill.js";

const PATH = "/Users/u/.cursor/skills/record-demo/SKILL.md";
const skill = (v: string) =>
  `---\nname: record-demo\ndescription: x\n---\nDemoman's tools record demos (${v}).\n`;

function server(over: Partial<AgentSkillDeps> = {}) {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const d: AgentSkillDeps = {
    env: { DEMOMAN_CLIENT: "cursor" },
    home: "/Users/u",
    skill: { text: skill("rc.8") },
    readText: (p) => {
      const text = files.get(p);
      return text === undefined ? { missing: true } : { text };
    },
    writeText: (p, text) => {
      writes.push(p);
      files.set(p, text);
      return { ok: true };
    },
    ...over,
  };
  return { d, files, writes };
}

describe("refreshAgentSkill, for Cursor", () => {
  it("replaces Demoman's older copy with this version's, and says so", () => {
    const m = server();
    m.files.set(PATH, skill("rc.7"));
    expect(refreshAgentSkill(m.d)).toBe(
      `Cursor's record-demo skill was refreshed to this version's (${PATH})`,
    );
    expect(m.files.get(PATH)).toBe(skill("rc.8"));
  });

  it("says nothing and writes nothing when the copy is already this one", () => {
    const m = server();
    m.files.set(PATH, skill("rc.8"));
    expect(refreshAgentSkill(m.d)).toBeNull();
    expect(m.writes).toEqual([]);
  });

  // The pinned servers Claude Code and Codex start may be older than
  // Cursor's @latest: if they wrote too, two versions would take turns.
  it("does nothing in a server Cursor did not start", () => {
    for (const env of [{}, { DEMOMAN_CLIENT: "claude" }]) {
      const m = server({ env });
      m.files.set(PATH, skill("rc.7"));
      expect(refreshAgentSkill(m.d)).toBeNull();
      expect(m.files.get(PATH)).toBe(skill("rc.7"));
    }
  });

  it("leaves a record-demo skill that is not Demoman's, and says so", () => {
    const m = server();
    const theirs = "---\nname: record-demo\ndescription: x\n---\nUse OBS.\n";
    m.files.set(PATH, theirs);
    expect(refreshAgentSkill(m.d)).toBe(
      `Cursor's record-demo skill was not refreshed: ${PATH} is not Demoman's, so it was left alone`,
    );
    expect(m.files.get(PATH)).toBe(theirs);
  });

  it("does not put back a skill that is not there, and says so", () => {
    const m = server();
    expect(refreshAgentSkill(m.d)).toBe(
      `Cursor's record-demo skill was not refreshed: ${PATH} is not there (\`npx demoman setup\` puts it back)`,
    );
    expect(m.writes).toEqual([]);
  });

  it("says why it could not read, write, or find its own copy", () => {
    const unreadable = server({ readText: () => ({ error: "EACCES" }) });
    expect(refreshAgentSkill(unreadable.d)).toBe(
      `Cursor's record-demo skill was not refreshed: ${PATH} could not be read (EACCES)`,
    );
    const unwritable = server({ writeText: () => ({ error: "EROFS" }) });
    unwritable.files.set(PATH, skill("rc.7"));
    expect(refreshAgentSkill(unwritable.d)).toBe(
      `Cursor's record-demo skill was not refreshed: ${PATH} could not be written (EROFS)`,
    );
    const lost = server({
      skill: { error: "dist/skills/record-demo/SKILL.md is missing" },
    });
    lost.files.set(PATH, skill("rc.7"));
    expect(refreshAgentSkill(lost.d)).toBe(
      "Cursor's record-demo skill was not refreshed: this install's copy could not be read (dist/skills/record-demo/SKILL.md is missing)",
    );
    expect(lost.files.get(PATH)).toBe(skill("rc.7"));
  });
});

describe("refreshAgentSkill, for OpenCode", () => {
  const OPENCODE = "/Users/u/.config/opencode/skills/record-demo/SKILL.md";
  it("keeps OpenCode's copy current when OpenCode started the server", () => {
    const m = server({ env: { DEMOMAN_CLIENT: "opencode" } });
    m.files.set(OPENCODE, skill("rc.7"));
    expect(refreshAgentSkill(m.d)).toBe(
      `OpenCode's record-demo skill was refreshed to this version's (${OPENCODE})`,
    );
    expect(m.files.get(OPENCODE)).toBe(skill("rc.8"));
    expect(m.writes).toEqual([OPENCODE]);
  });

  it("finds OpenCode's folder under XDG_CONFIG_HOME, as OpenCode does", () => {
    const moved = "/Users/u/xdg/opencode/skills/record-demo/SKILL.md";
    const m = server({
      env: { DEMOMAN_CLIENT: "opencode", XDG_CONFIG_HOME: "/Users/u/xdg" },
    });
    m.files.set(moved, skill("rc.7"));
    expect(refreshAgentSkill(m.d)).toContain(moved);
    expect(m.writes).toEqual([moved]);
  });

  it("does nothing for a client it keeps no copy for", () => {
    for (const client of [undefined, "claude", "pi"]) {
      const m = server({ env: { DEMOMAN_CLIENT: client } });
      expect(refreshAgentSkill(m.d), String(client)).toBeNull();
      expect(m.writes).toEqual([]);
    }
  });
});

describe("refreshCursorRules", () => {
  const CLI = "/Users/u/.cursor/cli-config.json";
  const allow = (m: ReturnType<typeof server>) =>
    JSON.parse(m.files.get(CLI) ?? "").permissions.allow as string[];

  // Setup wrote these for an older version, which had no `report`.
  it("adds a tool this version has that the file lacks, never attach or ci", () => {
    const m = server();
    m.files.set(
      CLI,
      JSON.stringify({
        permissions: { allow: ["Shell(ls)", "Mcp(demoman:run)"] },
      }),
    );
    // The premise: the file approved Demoman before, without report.
    expect(allow(m)).not.toContain("Mcp(demoman:report)");
    expect(refreshCursorRules(m.d)).toBe(
      `Cursor's agent CLI now allows this version's new tools (${CLI})`,
    );
    expect(allow(m)).toContain("Mcp(demoman:report)");
    expect(allow(m)[0]).toBe("Shell(ls)");
    expect(allow(m)).not.toContain("Mcp(demoman:attach)");
    expect(allow(m)).not.toContain("Mcp(demoman:ci)");
    expect(refreshCursorRules(m.d)).toBeNull();
  });

  it("leaves a file with no Demoman rule alone: being asked is the person's choice", () => {
    const m = server();
    const mine = JSON.stringify({ permissions: { allow: ["Shell(ls)"] } });
    m.files.set(CLI, mine);
    expect(refreshCursorRules(m.d)).toBeNull();
    expect(m.files.get(CLI)).toBe(mine);
    expect(m.writes).toEqual([]);
  });

  it("does nothing for another agent's server, and says a file it cannot read", () => {
    const other = server({ env: { DEMOMAN_CLIENT: "opencode" } });
    other.files.set(CLI, '{"permissions":{"allow":["Mcp(demoman:run)"]}}');
    expect(refreshCursorRules(other.d)).toBeNull();
    expect(other.writes).toEqual([]);
    const broken = server();
    broken.files.set(CLI, "{ nope");
    expect(refreshCursorRules(broken.d)).toMatch(
      /^Cursor's agent CLI allow rules were not refreshed: .* is not JSON/,
    );
  });
});
