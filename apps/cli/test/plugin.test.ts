import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
  readFileSync(new URL(`../plugin-out/${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(read(p));
const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

describe("plugin-out (the demoman-io/plugins repo)", () => {
  it("pins the MCP server to this exact version", () => {
    expect(json(".mcp.json")).toEqual({
      mcpServers: {
        demoman: {
          command: "npx",
          // Red without the prefix: the opened repo chooses what runs.
          args: ["--prefix", "~/", "-y", `demoman@${version}`, "mcp"],
        },
      },
    });
  });

  it("names the plugin demoman, at this version, in the demoman marketplace", () => {
    expect(json(".claude-plugin/plugin.json")).toMatchObject({
      name: "demoman",
      version,
      mcpServers: "./.mcp.json",
      license: "FSL-1.1-ALv2",
    });
    const market = json(".claude-plugin/marketplace.json");
    expect(market.name).toBe("demoman");
    expect(market.plugins).toEqual([
      expect.objectContaining({ name: "demoman", source: "./", version }),
    ]);
  });

  it("carries the user-facing skill, with no repo or extension text", () => {
    const skill = read("skills/record-demo/SKILL.md");
    expect(skill).toContain("name: record-demo");
    expect(skill).toContain("Call the `recipe` tool");
    for (const word of ["pnpm", "extension", "apps/mcp", "claude mcp add"]) {
      expect(skill, word).not.toContain(word);
    }
  });

  it("carries the license", () => {
    expect(read("LICENSE")).toBe(
      readFileSync(
        new URL("../../../packages/compositor/LICENSE", import.meta.url),
        "utf8",
      ),
    );
  });
});
