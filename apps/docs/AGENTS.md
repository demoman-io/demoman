# Editing Demoman's docs

Mintlify site served at demoman.io/docs. Pages are `.mdx`; the sidebar is
`docs.json`. `apps/docs` is not a pnpm package; `apps/cli/test/docs.test.ts`
is its test.

- **Terms:** Demoman (the product), the studio (the editor), a take (one
  recording). Do not say "plugin" for the npm package or "clip" for a take.
- **No scripts.** The reader asks their agent for a demo. No page tells
  them to write or edit a script, or shows script syntax.
- **Pins.** Every MCP block on the site runs `demoman@latest`, so it
  updates itself; only the License page's links name a version, and that
  one equals `version` in `apps/cli/package.json` (`docs.test` holds both).
  Versions in prose are bare (`0.2.0-rc.7`), never `demoman@...`.
- **Trust** claims nothing `docs/disclosure-cli.md` does not say, and names
  no source paths.
- Root-relative links (`/quickstart`). Palette and font follow
  `apps/site/public/style.css`. The logos are `brand/logomark.svg`'s
  figure, and the favicon is a byte copy of demoman.io's `icon-512.png`
  (see `brand/README.md`).
- Prose: minimal, no helper copy.
- Sidebar: conventional groups (Getting started, Guides, CLI, Studio,
  Security & privacy, Resources), and short noun titles ("Authentication",
  not "Apps behind a login"). A page's title is its sidebar label.

## Sources per page

| Page | Built from |
| --- | --- |
| Introduction | `docs.json` description, the npm README's opening |
| Quickstart | spec §3.4, as approved |
| Agents | what `npx demoman setup` adds per agent (`apps/cli/src/setup.ts`), then one tab per manual agent: its server block and skills folder. Say anything shared by every agent once, outside the tabs |
| Prompts | New writing, no script syntax |
| Authentication | README "For an app behind a login" and "Demo accounts", `signin` from `USAGE`, CI secrets |
| Phone and tablet recording | recipe "Recording a phone demo", as what to ask for |
| Export | MP4 (16:9, 9:16), GIF, stills; `~/Downloads` or `--out-dir` |
| Commands | `USAGE` and the flags `main.ts` parses; the `DEMOMAN_*` variables the package reads |
| Overview, Editing | `npx demoman studio [take]`, `--stop`, the `studio` tool; the studio's own labels |
| Data | `docs/disclosure-cli.md` |
| License | FSL-1.1-ALv2 |
| Troubleshooting | recipe section 7, the human-actionable subset |
| Changelog | the goal file's rc status table, written for users |
