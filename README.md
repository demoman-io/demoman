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
  <a href="#install"><img src="https://img.shields.io/badge/macOS-Node_20%2B-3f3f46?style=flat-square&logo=apple&logoColor=white" alt="macOS, Node 20+" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/Claude_Code-D97757?style=flat-square&logo=claude&logoColor=white" alt="Claude Code" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/Codex-3f3f46?style=flat-square&logo=data:image/svg%2bxml;base64,PHN2ZyBmaWxsPSJ3aGl0ZSIgcm9sZT0iaW1nIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPk9wZW5BSTwvdGl0bGU+PHBhdGggZD0iTTIyLjI4MTkgOS44MjExYTUuOTg0NyA1Ljk4NDcgMCAwIDAtLjUxNTctNC45MTA4IDYuMDQ2MiA2LjA0NjIgMCAwIDAtNi41MDk4LTIuOUE2LjA2NTEgNi4wNjUxIDAgMCAwIDQuOTgwNyA0LjE4MThhNS45ODQ3IDUuOTg0NyAwIDAgMC0zLjk5NzcgMi45IDYuMDQ2MiA2LjA0NjIgMCAwIDAgLjc0MjcgNy4wOTY2IDUuOTggNS45OCAwIDAgMCAuNTExIDQuOTEwNyA2LjA1MSA2LjA1MSAwIDAgMCA2LjUxNDYgMi45MDAxQTUuOTg0NyA1Ljk4NDcgMCAwIDAgMTMuMjU5OSAyNGE2LjA1NTcgNi4wNTU3IDAgMCAwIDUuNzcxOC00LjIwNTggNS45ODk0IDUuOTg5NCAwIDAgMCAzLjk5NzctMi45MDAxIDYuMDU1NyA2LjA1NTcgMCAwIDAtLjc0NzUtNy4wNzI5em0tOS4wMjIgMTIuNjA4MWE0LjQ3NTUgNC40NzU1IDAgMCAxLTIuODc2NC0xLjA0MDhsLjE0MTktLjA4MDQgNC43NzgzLTIuNzU4MmEuNzk0OC43OTQ4IDAgMCAwIC4zOTI3LS42ODEzdi02LjczNjlsMi4wMiAxLjE2ODZhLjA3MS4wNzEgMCAwIDEgLjAzOC4wNTJ2NS41ODI2YTQuNTA0IDQuNTA0IDAgMCAxLTQuNDk0NSA0LjQ5NDR6bS05LjY2MDctNC4xMjU0YTQuNDcwOCA0LjQ3MDggMCAwIDEtLjUzNDYtMy4wMTM3bC4xNDIuMDg1MiA0Ljc4MyAyLjc1ODJhLjc3MTIuNzcxMiAwIDAgMCAuNzgwNiAwbDUuODQyOC0zLjM2ODV2Mi4zMzI0YS4wODA0LjA4MDQgMCAwIDEtLjAzMzIuMDYxNUw5Ljc0IDE5Ljk1MDJhNC40OTkyIDQuNDk5MiAwIDAgMS02LjE0MDgtMS42NDY0ek0yLjM0MDggNy44OTU2YTQuNDg1IDQuNDg1IDAgMCAxIDIuMzY1NS0xLjk3MjhWMTEuNmEuNzY2NC43NjY0IDAgMCAwIC4zODc5LjY3NjVsNS44MTQ0IDMuMzU0My0yLjAyMDEgMS4xNjg1YS4wNzU3LjA3NTcgMCAwIDEtLjA3MSAwbC00LjgzMDMtMi43ODY1QTQuNTA0IDQuNTA0IDAgMCAxIDIuMzQwOCA3Ljg3MnptMTYuNTk2MyAzLjg1NThMMTMuMTAzOCA4LjM2NCAxNS4xMTkyIDcuMmEuMDc1Ny4wNzU3IDAgMCAxIC4wNzEgMGw0LjgzMDMgMi43OTEzYTQuNDk0NCA0LjQ5NDQgMCAwIDEtLjY3NjUgOC4xMDQydi01LjY3NzJhLjc5Ljc5IDAgMCAwLS40MDctLjY2N3ptMi4wMTA3LTMuMDIzMWwtLjE0Mi0uMDg1Mi00Ljc3MzUtMi43ODE4YS43NzU5Ljc3NTkgMCAwIDAtLjc4NTQgMEw5LjQwOSA5LjIyOTdWNi44OTc0YS4wNjYyLjA2NjIgMCAwIDEgLjAyODQtLjA2MTVsNC44MzAzLTIuNzg2NmE0LjQ5OTIgNC40OTkyIDAgMCAxIDYuNjgwMiA0LjY2ek04LjMwNjUgMTIuODYzbC0yLjAyLTEuMTYzOGEuMDgwNC4wODA0IDAgMCAxLS4wMzgtLjA1NjdWNi4wNzQyYTQuNDk5MiA0LjQ5OTIgMCAwIDEgNy4zNzU3LTMuNDUzN2wtLjE0Mi4wODA1TDguNzA0IDUuNDU5YS43OTQ4Ljc5NDggMCAwIDAtLjM5MjcuNjgxM3ptMS4wOTc2LTIuMzY1NGwyLjYwMi0xLjQ5OTggMi42MDY5IDEuNDk5OHYyLjk5OTRsLTIuNTk3NCAxLjQ5OTctMi42MDY3LTEuNDk5N1oiLz48L3N2Zz4=" alt="Codex" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/Cursor-3f3f46?style=flat-square&logo=cursor&logoColor=white" alt="Cursor" /></a>
  <a href="https://demoman.io/docs/agents"><img src="https://img.shields.io/badge/OpenCode-3f3f46?style=flat-square&logo=opencode&logoColor=white" alt="OpenCode" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/MCP-any_client-6E56CF?style=flat-square&logo=modelcontextprotocol&logoColor=white" alt="MCP: any client" /></a>
</p>

# Demoman

**Perfect demos. Just ask your agent.**

Demoman records demo videos of web apps for your coding agent. Ask it for
"a demo of the new checkout": the agent writes the steps, Demoman plays them
in a browser you never see, and the video lands in `~/Downloads`, zoomed in
on every click, with a smooth cursor and your brand.

## Install

macOS and Node 20 or later:

    npx demoman setup

Setup downloads Chromium and connects Demoman to Claude Code, Codex and
Cursor, whichever it finds. Restart the agent, then ask it to make a demo.
For OpenCode or another MCP client, see
[Connect your agent](https://demoman.io/docs/agents). Demoman is in public
beta.

## Features

- **Headless.** It records in a browser you never see, so your screen stays
  yours while it works.
- **Cinematic by default.** The camera eases in on every click and holds
  while you read, and the cursor takes a smooth path from step to step, at
  desktop, tablet or phone size.
- **Self-reviewing, self-correcting.** Every run reports what was in frame,
  what was cut off and any detours. When a step misses, your agent fixes the
  script and runs it again.
- **[Authenticated apps](https://demoman.io/docs/guides/authentication).**
  For an app you run locally, your agent creates a demo account and Demoman
  signs in with it, in development and in CI. For a real account, sign in
  once with `npx demoman signin <url>`. Your agent never asks for your own
  password.
- **Edit in Studio.** `npx demoman studio` opens a timeline editor: trim the
  waiting, split the clip and remove what you don't want, hide what shouldn't
  be seen, tune each zoom, and apply a brand kit.
- **Ready for delivery.** An MP4, a GIF, or a still of every step, 16:9 or
  9:16 from one take. Your agent can attach the video to a pull request.
- **Runs locally.** Capture, editing and export happen on your machine, and
  Demoman sends nothing to us. Your agent passes what Demoman reports to the
  AI service it runs on.

Documentation: [demoman.io/docs](https://demoman.io/docs)

## Building from source

    pnpm install
    pnpm -r build

The repo is a pnpm workspace: `apps/cli` is the published `demoman` package,
`apps/mcp` the MCP server agents drive it through, `apps/runner` the executor
that drives Chromium and records, `apps/studio` the studio, `apps/docs` the
documentation at demoman.io/docs, and `packages/` the capture, replay and
rendering pipeline they share.

## Contributing

Demoman is not accepting pull requests from outside.
Bug reports and ideas are welcome as issues.
