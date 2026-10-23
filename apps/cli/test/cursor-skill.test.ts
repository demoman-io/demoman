import { describe, expect, it } from "vitest";
import {
  type CursorSkillDeps,
  refreshCursorSkill,
} from "../src/cursor-skill.js";

const PATH = "/Users/u/.cursor/skills/record-demo/SKILL.md";
const skill = (v: string) =>
  `---\nname: record-demo\ndescription: x\n---\nDemoman's tools record demos (${v}).\n`;

function server(over: Partial<CursorSkillDeps> = {}) {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const d: CursorSkillDeps = {
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

describe("refreshCursorSkill", () => {
  it("replaces Demoman's older copy with this version's, and says so", () => {
    const m = server();
    m.files.set(PATH, skill("rc.7"));
    expect(refreshCursorSkill(m.d)).toBe(
      `Cursor's record-demo skill was refreshed to this version's (${PATH})`,
    );
    expect(m.files.get(PATH)).toBe(skill("rc.8"));
  });

  it("says nothing and writes nothing when the copy is already this one", () => {
    const m = server();
    m.files.set(PATH, skill("rc.8"));
    expect(refreshCursorSkill(m.d)).toBeNull();
    expect(m.writes).toEqual([]);
  });

  // The pinned servers Claude Code and Codex start may be older than
  // Cursor's @latest: if they wrote too, two versions would take turns.
  it("does nothing in a server Cursor did not start", () => {
    for (const env of [{}, { DEMOMAN_CLIENT: "claude" }]) {
      const m = server({ env });
      m.files.set(PATH, skill("rc.7"));
      expect(refreshCursorSkill(m.d)).toBeNull();
      expect(m.files.get(PATH)).toBe(skill("rc.7"));
    }
  });

  it("leaves a record-demo skill that is not Demoman's, and says so", () => {
    const m = server();
    const theirs = "---\nname: record-demo\ndescription: x\n---\nUse OBS.\n";
    m.files.set(PATH, theirs);
    expect(refreshCursorSkill(m.d)).toBe(
      `Cursor's record-demo skill was not refreshed: ${PATH} is not Demoman's, so it was left alone`,
    );
    expect(m.files.get(PATH)).toBe(theirs);
  });

  it("does not put back a skill that is not there, and says so", () => {
    const m = server();
    expect(refreshCursorSkill(m.d)).toBe(
      `Cursor's record-demo skill was not refreshed: ${PATH} is not there (\`npx demoman setup\` puts it back)`,
    );
    expect(m.writes).toEqual([]);
  });

  it("says why it could not read, write, or find its own copy", () => {
    const unreadable = server({ readText: () => ({ error: "EACCES" }) });
    expect(refreshCursorSkill(unreadable.d)).toBe(
      `Cursor's record-demo skill was not refreshed: ${PATH} could not be read (EACCES)`,
    );
    const unwritable = server({ writeText: () => ({ error: "EROFS" }) });
    unwritable.files.set(PATH, skill("rc.7"));
    expect(refreshCursorSkill(unwritable.d)).toBe(
      `Cursor's record-demo skill was not refreshed: ${PATH} could not be written (EROFS)`,
    );
    const lost = server({
      skill: { error: "dist/skills/record-demo/SKILL.md is missing" },
    });
    lost.files.set(PATH, skill("rc.7"));
    expect(refreshCursorSkill(lost.d)).toBe(
      "Cursor's record-demo skill was not refreshed: this install's copy could not be read (dist/skills/record-demo/SKILL.md is missing)",
    );
    expect(lost.files.get(PATH)).toBe(skill("rc.7"));
  });
});
