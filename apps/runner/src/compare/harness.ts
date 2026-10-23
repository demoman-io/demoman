// apps/runner/src/compare/harness.ts
//
// What `pnpm film:compare` needs from outside the runner: an MCP client on a
// spawned `demoman-mcp`, and the check that a build is newer than its
// source. Both lived in the extension's scripts (extension-side.mjs,
// browser-launcher.mjs) until it was archived on 2026-10-20.
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface Mcp {
  callTool(req: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content?: { text: string }[]; isError?: boolean }>;
  close(): Promise<void>;
}

/**
 * An MCP client on `node <serverBin> …args`, as an MCP host starts it, with
 * `home` as its DEMOMAN_HOME. The SDK is resolved from the server's own
 * package (apps/mcp), which depends on it; the runner does not.
 */
export async function connectMcp(o: {
  serverBin: string;
  home: string;
  name: string;
  args?: string[];
  stderr?: "inherit" | "ignore";
}): Promise<Mcp> {
  const req = createRequire(o.serverBin);
  const sdk = async (p: string) =>
    (await import(pathToFileURL(req.resolve(p)).href)) as Record<
      string,
      unknown
    >;
  const { Client } = (await sdk(
    "@modelcontextprotocol/sdk/client/index.js",
  )) as {
    Client: new (info: {
      name: string;
      version: string;
    }) => Mcp & {
      connect(t: unknown): Promise<void>;
    };
  };
  const { StdioClientTransport } = (await sdk(
    "@modelcontextprotocol/sdk/client/stdio.js",
  )) as { StdioClientTransport: new (o: unknown) => unknown };
  const client = new Client({ name: o.name, version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [o.serverBin, ...(o.args ?? [])],
      env: { ...process.env, DEMOMAN_HOME: o.home },
      stderr: o.stderr ?? "inherit",
    }),
  );
  return client;
}

/** Skipped inside a source dir: output, dependencies and tests. */
const SKIPPED = new Set(["node_modules", "dist", ".output", ".wxt", "test"]);

function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    latest = Math.max(
      latest,
      entry.isDirectory() ? newest(path) : statSync(path).mtimeMs,
    );
  }
  return latest;
}

/**
 * Refuses `output` when it is missing or older than the newest file under
 * `sources` — the same rule as apps/studio's `staleBuild`, which the runner
 * cannot import (the studio depends on the runner).
 */
export function staleBuild(o: {
  output: string;
  sources: readonly string[];
}): { ok: true } | { ok: false; reason: string } {
  let built: number;
  try {
    built = statSync(o.output).mtimeMs;
  } catch {
    return {
      ok: false,
      reason: `no build at ${o.output} — run \`pnpm -r build\` first.`,
    };
  }
  let edited = 0;
  for (const dir of o.sources) {
    try {
      edited = Math.max(edited, newest(dir));
    } catch (error) {
      return {
        ok: false,
        reason: `${dir} could not be read to check the build against it (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
  }
  if (edited > built) {
    return {
      ok: false,
      reason: `${o.output} is older than the source — run \`pnpm -r build\` first.`,
    };
  }
  return { ok: true };
}
