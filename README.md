<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/banner_dark.svg">
    <img alt="Demoman" width="100%" src="brand/banner_light.svg">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/demoman-io/demoman/actions/workflows/ci-ts.yml"><img src="https://img.shields.io/github/actions/workflow/status/demoman-io/demoman/ci-ts.yml?branch=main&style=flat-square&label=CI" alt="CI status" /></a>
  <a href="https://www.npmjs.com/package/demoman"><img src="https://img.shields.io/npm/v/demoman?style=flat-square&color=cb3837&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue?style=flat-square" alt="License: FSL-1.1-ALv2" /></a>
  <a href="https://demoman.io/docs"><img src="https://img.shields.io/badge/docs-demoman.io-3f3f46?style=flat-square" alt="Docs" /></a>
  <br />
  <a href="#install"><img src="https://img.shields.io/badge/macOS_%7C_Linux-Node_20.12%2B-3f3f46?style=flat-square" alt="macOS or Linux, Node 20.12+" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/Claude_Code-D97757?style=flat-square&logo=claude&logoColor=white" alt="Claude Code" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/Codex-3f3f46?style=flat-square&logo=data:image/svg%2bxml;base64,PHN2ZyBmaWxsPSJ3aGl0ZSIgcm9sZT0iaW1nIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPk9wZW5BSTwvdGl0bGU+PHBhdGggZD0iTTIyLjI4MTkgOS44MjExYTUuOTg0NyA1Ljk4NDcgMCAwIDAtLjUxNTctNC45MTA4IDYuMDQ2MiA2LjA0NjIgMCAwIDAtNi41MDk4LTIuOUE2LjA2NTEgNi4wNjUxIDAgMCAwIDQuOTgwNyA0LjE4MThhNS45ODQ3IDUuOTg0NyAwIDAgMC0zLjk5NzcgMi45IDYuMDQ2MiA2LjA0NjIgMCAwIDAgLjc0MjcgNy4wOTY2IDUuOTggNS45OCAwIDAgMCAuNTExIDQuOTEwNyA2LjA1MSA2LjA1MSAwIDAgMCA2LjUxNDYgMi45MDAxQTUuOTg0NyA1Ljk4NDcgMCAwIDAgMTMuMjU5OSAyNGE2LjA1NTcgNi4wNTU3IDAgMCAwIDUuNzcxOC00LjIwNTggNS45ODk0IDUuOTg5NCAwIDAgMCAzLjk5NzctMi45MDAxIDYuMDU1NyA2LjA1NTcgMCAwIDAtLjc0NzUtNy4wNzI5em0tOS4wMjIgMTIuNjA4MWE0LjQ3NTUgNC40NzU1IDAgMCAxLTIuODc2NC0xLjA0MDhsLjE0MTktLjA4MDQgNC43NzgzLTIuNzU4MmEuNzk0OC43OTQ4IDAgMCAwIC4zOTI3LS42ODEzdi02LjczNjlsMi4wMiAxLjE2ODZhLjA3MS4wNzEgMCAwIDEgLjAzOC4wNTJ2NS41ODI2YTQuNTA0IDQuNTA0IDAgMCAxLTQuNDk0NSA0LjQ5NDR6bS05LjY2MDctNC4xMjU0YTQuNDcwOCA0LjQ3MDggMCAwIDEtLjUzNDYtMy4wMTM3bC4xNDIuMDg1MiA0Ljc4MyAyLjc1ODJhLjc3MTIuNzcxMiAwIDAgMCAuNzgwNiAwbDUuODQyOC0zLjM2ODV2Mi4zMzI0YS4wODA0LjA4MDQgMCAwIDEtLjAzMzIuMDYxNUw5Ljc0IDE5Ljk1MDJhNC40OTkyIDQuNDk5MiAwIDAgMS02LjE0MDgtMS42NDY0ek0yLjM0MDggNy44OTU2YTQuNDg1IDQuNDg1IDAgMCAxIDIuMzY1NS0xLjk3MjhWMTEuNmEuNzY2NC43NjY0IDAgMCAwIC4zODc5LjY3NjVsNS44MTQ0IDMuMzU0My0yLjAyMDEgMS4xNjg1YS4wNzU3LjA3NTcgMCAwIDEtLjA3MSAwbC00LjgzMDMtMi43ODY1QTQuNTA0IDQuNTA0IDAgMCAxIDIuMzQwOCA3Ljg3MnptMTYuNTk2MyAzLjg1NThMMTMuMTAzOCA4LjM2NCAxNS4xMTkyIDcuMmEuMDc1Ny4wNzU3IDAgMCAxIC4wNzEgMGw0LjgzMDMgMi43OTEzYTQuNDk0NCA0LjQ5NDQgMCAwIDEtLjY3NjUgOC4xMDQydi01LjY3NzJhLjc5Ljc5IDAgMCAwLS40MDctLjY2N3ptMi4wMTA3LTMuMDIzMWwtLjE0Mi0uMDg1Mi00Ljc3MzUtMi43ODE4YS43NzU5Ljc3NTkgMCAwIDAtLjc4NTQgMEw5LjQwOSA5LjIyOTdWNi44OTc0YS4wNjYyLjA2NjIgMCAwIDEgLjAyODQtLjA2MTVsNC44MzAzLTIuNzg2NmE0LjQ5OTIgNC40OTkyIDAgMCAxIDYuNjgwMiA0LjY2ek04LjMwNjUgMTIuODYzbC0yLjAyLTEuMTYzOGEuMDgwNC4wODA0IDAgMCAxLS4wMzgtLjA1NjdWNi4wNzQyYTQuNDk5MiA0LjQ5OTIgMCAwIDEgNy4zNzU3LTMuNDUzN2wtLjE0Mi4wODA1TDguNzA0IDUuNDU5YS43OTQ4Ljc5NDggMCAwIDAtLjM5MjcuNjgxM3ptMS4wOTc2LTIuMzY1NGwyLjYwMi0xLjQ5OTggMi42MDY5IDEuNDk5OHYyLjk5OTRsLTIuNTk3NCAxLjQ5OTctMi42MDY3LTEuNDk5N1oiLz48L3N2Zz4=" alt="Codex" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/Cursor-3f3f46?style=flat-square&logo=cursor&logoColor=white" alt="Cursor" /></a>
  <a href="https://demoman.io/docs/get-started/connect"><img src="https://img.shields.io/badge/OpenCode-3f3f46?style=flat-square&logo=opencode&logoColor=white" alt="OpenCode" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/MCP-any_client-6E56CF?style=flat-square&logo=modelcontextprotocol&logoColor=white" alt="MCP: any client" /></a>
</p>

# Demoman

**Self-recording, self-updating product demos.**

Record demos with your agent. Each flow is saved, and CI keeps it current.

<p align="center">
  <img alt="A demo Demoman recorded: adding a card to a kanban board, with the camera following each click" width="100%" src="brand/readme/kanban.gif">
</p>

## Install

macOS or x86_64 Linux, and Node 20.12 or later:

    npx demoman setup

Setup downloads Chromium and connects Demoman to Claude Code, Codex, Cursor
and OpenCode, whichever it finds. Restart the agent, then ask it for a demo.
For another MCP client, see
[Connect your agent](https://demoman.io/docs/get-started/connect). On Linux,
setup names the one `sudo` command that installs Chromium's system libraries.
Demoman is in public beta.

## Agent-native recorder

**Ask for a demo. Get a video.** Your coding agent drives Demoman through its
MCP server. It handles sign-in, runs the flow in a headless browser and hands
back a demo video, with the camera, cursor and framing already done.

```text
> record a demo of creating an invoice

⏺ demoman.run  "a new invoice"  10 steps
  ⎿ complete · 5 inside · 0 cut off · 0 detours
⏺ demoman.export
  ⎿ saved ~/Downloads/Nylon — New Invoice (Desktop).mp4
```

<p align="center">
  <img alt="The video that run hands back: a new invoice for Hollis &amp; Grant created in a billing app" width="100%" src="brand/readme/new-invoice.gif">
</p>

| | |
| --- | --- |
| Interface | CLI · MCP server |
| Browser | Headless Chromium |
| Devices | Desktop · Tablet · Phone |
| Sign-in | [Demo accounts · Seed scripts](https://demoman.io/docs/get-started/sign-in) |

## CI pipeline

**Video as Code.** One command adds Demoman to GitHub Actions. From then on,
every merge records each DemoScript again against your real app, and a video
changes only when the product did.

```bash
npx demoman add "Export report" --to docs/export-report.mp4
npx demoman setup --ci
```

`add` saves the flow's DemoScript in `.demoman/flows/` beside its export.
`setup --ci` records your flows once from a clean checkout, shows one plan
and opens the pull request that sets it up. After that, each refresh opens a
pull request with the videos that changed.

```json
{
  "name": "Export report",
  "target": "http://localhost:3000/reports",
  "steps": [
    { "do": "waitForLoad" },
    { "do": "click", "on": { "stableId": "range-12m" } },
    { "do": "click", "on": { "stableId": "export-report" } },
    { "do": "waitFor", "until": "visible", "on": { "text": "Report exported" } }
  ]
}
```

| | |
| --- | --- |
| Source | DemoScripts in `.demoman/flows/` |
| Format | JSON, schema-validated |
| CI | GitHub Actions |
| Trigger | Every merge, a deployment, a release, or daily |
| Review | A video on the pull request |

[Keep videos current](https://demoman.io/docs/get-started/ci) covers the
triggers, committing to the branch instead, and keeping videos out of git.

## Principles

- **Runs on your machines.** Your laptop or your CI runner. Capture and
  export happen there, and Demoman sends nothing to us.
- **Your screen stays yours.** Demoman records in a browser of its own.
- **No account.** Install it and ask your agent.

## Specifications

| | |
| --- | --- |
| Agents | Claude Code, Codex, Cursor, OpenCode |
| Platforms | macOS, Linux (x86_64). Node 20.12+ |
| Output | MP4 at 60 fps, up to 2560 px wide. GIF. A PNG still of every step |
| Editor | [Studio](https://demoman.io/docs/studio/overview), optional: trim, cut, zoom, background |

Documentation: [demoman.io/docs](https://demoman.io/docs)

## Contributing

Demoman is not accepting pull requests from outside.
Bug reports and ideas are welcome as issues.
