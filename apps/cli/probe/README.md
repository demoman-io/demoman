# The client probe

`server.mjs` is a stdio MCP server that measures an MCP client: what Demoman
cannot measure itself, because its own 50 s cap hides the client's limits by
design (launch E spec §5). Results go in `docs/superpowers/goals/cli-launch.md`
beside each client's version, so the next client release can be measured the
same way.

| Client | Version | Tool-call timeout | Startup timeout | Instructions seen | Long output whole |
| --- | --- | --- | --- | --- | --- |

## Register it

Use the absolute path of this folder (`$P` below).

- Codex: `codex mcp add probe -- node $P/server.mjs`
  (`codex mcp remove probe` afterwards)
- Cursor (app and `agent` CLI): in `~/.cursor/mcp.json`, under
  `mcpServers`, `"probe": {"type": "stdio", "command": "node", "args": ["$P/server.mjs"]}`;
  for the CLI, `agent mcp enable probe`
- Claude Code: `claude mcp add probe -- node $P/server.mjs`

Add `--start-delay <s>` to the args to hold `initialize` that long, and
`--tokens <n>` to size `long_text` (default 12,000, past Codex's 10,000).

## Ask

1. "Call the probe's sleep tool with 45." Then 58, 65, 120, 300. **The first
   that fails is the tool-call timeout.**
2. Re-register with `--start-delay` 1, 2, 5, 10, 20, restarting the client
   each time, and ask for `sleep` with 1. **The first delay whose tools never
   appear is the startup timeout.**
3. "What is the probe's instructions canary?" **`PROBE-INSTR-4F7K` means the
   client shows the model a server's instructions.**
4. "Call long_text and quote the PROBE markers you can see."
   **A missing `PROBE-MIDDLE-2` means the client cut the middle** (Codex
   does, under "Warning: truncated output"); a missing `PROBE-TAIL-3`, the end.

## Demoman's own start

    node start-time.mjs -- "$(dirname "$(command -v node)")/npx" -y demoman@<version> mcp

prints five spawn-to-`initialize` times and their median, to set against the
startup timeout from step 2.
