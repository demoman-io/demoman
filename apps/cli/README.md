# demoman

Polished demo videos of web apps, made by your coding agent.

Ask your coding agent for a demo of a flow — "make a demo of the new
checkout" — and Demoman drives the app in a browser of its own, out of your
way, records it,
and saves the video to `~/Downloads`.

## Install

macOS, Node 20 or later, and Claude Code, Codex, Cursor or OpenCode:

    npx demoman setup

Setup asks which agents to connect, the export quality and whether pull
requests get a demo, then downloads Chromium (about 190 MB) and connects
Demoman, pre-approving its tools so they run without asking. Restart the
agent, then in your app's repo ask for a demo — for example, "make a demo of
the feature we just built".

Another MCP client is expected to work, not yet run: give it this stdio
server.

    {"command": "npx", "args": ["--prefix", "~/", "-y", "demoman@latest", "mcp"]}

## Documentation

Full documentation: https://demoman.io/docs

- [Agents](https://demoman.io/docs/agents)
- [Authentication](https://demoman.io/docs/guides/authentication)
- [Data](https://demoman.io/docs/security/data)

## License

FSL-1.1-ALv2 (`LICENSE`); bundled third-party code and its licenses are in
`THIRD_PARTY_NOTICES`. https://demoman.io
