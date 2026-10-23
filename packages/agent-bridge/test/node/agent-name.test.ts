import { describe, expect, it } from "vitest";
import { AGENT_NAME_MAX, agentOf } from "../../src/index.js";

describe("the agent's name in a request's args", () => {
  // Red if the name or title is dropped, or not trimmed.
  it("reads the name and title Claude Code sends", () => {
    expect(
      agentOf({ agent: { name: " claude-code ", title: "Claude Code" } }),
    ).toEqual({
      ok: true,
      agent: { name: "claude-code", title: "Claude Code" },
    });
    expect(agentOf({ agent: { name: "cursor-vscode" } })).toEqual({
      ok: true,
      agent: { name: "cursor-vscode" },
    });
  });

  // Red if a character a person cannot see survives into the name: a bidi
  // override turns "edoc-edualc" around on screen, and a zero-width space
  // makes two names look alike that are not.
  it("strips what a person cannot see, and keeps the words apart", () => {
    expect(
      agentOf({
        agent: {
          name: "\u202Eedoc-edualc\u202C",
          title: "Claude\u200B Code\uFEFF",
        },
      }),
    ).toEqual({
      ok: true,
      agent: { name: "edoc-edualc", title: "Claude Code" },
    });
    // A newline or tab is a gap between words, not a reason to join them.
    expect(agentOf({ agent: { name: "my\n\tagent" } })).toEqual({
      ok: true,
      agent: { name: "my agent" },
    });
  });

  // Red if a name made only of invisible characters is shown as an empty
  // name rather than refused (the page would read " wants to control…").
  it("refuses a name with nothing visible in it", () => {
    for (const name of ["\u200B\u200D", "\u202E\u2066", "\u2028"]) {
      const read = agentOf({ agent: { name } });
      expect(read.ok, JSON.stringify(name)).toBe(false);
      expect(read.ok === false && read.absent).toBe(false);
    }
  });

  // Red if a request from an older demoman-mcp (no agent) is reported as
  // malformed, or a malformed one as absent: the worker logs only the second.
  it("tells a missing name apart from one it cannot show", () => {
    expect(agentOf({ callId: "c" })).toEqual({ ok: false, absent: true });
    for (const agent of [
      "claude-code",
      null,
      { name: "" },
      { name: "  " },
      { name: "x".repeat(AGENT_NAME_MAX + 1) },
      { name: "ok", title: 7 },
      { name: "ok", title: "y".repeat(AGENT_NAME_MAX + 1) },
    ]) {
      const read = agentOf({ agent });
      expect(read.ok, JSON.stringify(agent)).toBe(false);
      expect(read.ok === false && read.absent, JSON.stringify(agent)).toBe(
        false,
      );
    }
  });
});
