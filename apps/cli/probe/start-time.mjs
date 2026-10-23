#!/usr/bin/env node
// apps/cli/probe/start-time.mjs -- <command…>: how long an MCP server takes
// from spawn to answering `initialize`, five times, and the median. Cursor's
// `agent` CLI drops a server that takes about 2 s or more (spec §4), so this
// times Demoman's real start (`npx -y demoman@<version> mcp`) against the
// limit the probe's --start-delay measures.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const at = process.argv.indexOf("--");
const [command, ...args] = at < 0 ? [] : process.argv.slice(at + 1);
if (command === undefined) {
  process.stderr.write(
    "usage: node probe/start-time.mjs -- <command> [args…]\n",
  );
  process.exit(2);
}

const runs = [];
for (let i = 0; i < 5; i++) {
  const client = new Client({ name: "start-time", version: "1.0.0" });
  const started = performance.now();
  try {
    await client.connect(
      new StdioClientTransport({ command, args, stderr: "ignore" }),
    );
  } catch (error) {
    process.stdout.write(
      `run ${i + 1}: did not start (${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.exit(1);
  }
  const ms = Math.round(performance.now() - started);
  runs.push(ms);
  process.stdout.write(`run ${i + 1}: ${ms} ms\n`);
  await client.close();
}
const sorted = [...runs].sort((a, b) => a - b);
process.stdout.write(`median: ${sorted[2]} ms\n`);
