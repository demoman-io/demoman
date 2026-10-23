#!/usr/bin/env node
// apps/cli/probe/server.mjs — a stdio MCP server that measures an MCP
// client (launch E spec §5): its tool-call timeout (`sleep`), its startup
// timeout (`--start-delay`), whether it shows the model a server's
// instructions (the canary), and where it cuts a long result (`long_text`'s
// three markers). Demoman's own 50 s cap hides the first of these by design,
// so it cannot measure them itself. How to use it: README.md beside this.
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const { values } = parseArgs({
  options: {
    "start-delay": { type: "string", default: "0" },
    tokens: { type: "string", default: "12000" },
  },
});
const startDelay = Number(values["start-delay"]);
const tokens = Number(values.tokens);
if (!(startDelay >= 0) || !(tokens >= 10)) {
  process.stderr.write("probe: --start-delay must be ≥ 0 and --tokens ≥ 10\n");
  process.exit(2);
}

/** ASCII, `tokens` × 4 bytes (the bytes / 4 count Codex cuts by), with a
 *  marker at the head, the middle and the last line: Codex cuts from the
 *  middle, so the middle marker is the one that tells. */
function longText() {
  const bytes = tokens * 4;
  const filler = (n) => {
    const line = "probe filler line, the same words over and over again.\n";
    return line.repeat(Math.ceil(n / line.length)).slice(0, n);
  };
  const head = "PROBE-HEAD-1\n";
  const middle = "\nPROBE-MIDDLE-2\n";
  const tail = "\nPROBE-TAIL-3\n";
  const room = Math.max(0, bytes - head.length - middle.length - tail.length);
  return `${head}${filler(Math.floor(room / 2))}${middle}${filler(Math.ceil(room / 2))}${tail}`;
}

const server = new Server(
  { name: "probe", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Probe server. If asked for the instructions canary, answer PROBE-INSTR-4F7K.",
  },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "sleep",
      description: "Waits the given number of seconds, then answers.",
      inputSchema: {
        type: "object",
        properties: { seconds: { type: "number" } },
        required: ["seconds"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "long_text",
      description:
        "Returns a long text with the markers PROBE-HEAD-1, PROBE-MIDDLE-2 and PROBE-TAIL-3.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === "sleep") {
    const seconds = Number(args.seconds);
    if (!(seconds >= 0)) {
      return {
        content: [{ type: "text", text: "seconds must be a number ≥ 0" }],
        isError: true,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return { content: [{ type: "text", text: `slept ${seconds}` }] };
  }
  if (name === "long_text") {
    return { content: [{ type: "text", text: longText() }] };
  }
  return {
    content: [{ type: "text", text: `no tool named ${name}` }],
    isError: true,
  };
});

await new Promise((resolve) => setTimeout(resolve, startDelay * 1000));
await server.connect(new StdioServerTransport());
