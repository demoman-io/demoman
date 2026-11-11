# Editing Demoman's docs

Mintlify site served at demoman.io/docs. Pages are `.mdx`; the sidebar is
`docs.json`. `apps/docs` is not a pnpm package; `apps/cli/test/docs.test.ts`
and `scripts/docs-demoscript.test.mjs` are its tests. The design is
`internal/docs/superpowers/specs/2026-11-08-docs-rework-design.md`.

- **Reader.** A developer who has chosen Demoman and wants it working. No
  selling: no example video except where the output is the subject (Export,
  Phone and tablet). When clarity and consistency pull apart, clarity wins.
- **Terms:** Demoman (the product), the Studio (the editor), a flow (what is
  recorded), a video (what one run of a flow records), an export (a file), a
  DemoScript (a flow's file in `.demoman/flows/`, and the script inside it).
  Record, never film. Do not say "plugin" for the npm package, "clip" for a
  video, or the retired words `scripts/old-words.test.mjs` lists. The MCP tool
  is still called `recipe`; the file is never a recipe.
- **DemoScripts are shown, never assigned.** Pages show and explain them;
  no page asks the reader to write or edit one, which is the agent's job.
  Script syntax appears only on Flows and DemoScripts, DemoScript and
  accounts.json (`docs.test` holds it).
- **The DemoScript Reference is generated.** Edit the descriptions in
  `packages/scene-schema/src/script.ts`, build, and run
  `node scripts/docs-demoscript.mjs`. Only the text outside the
  `generated:start`/`generated:end` markers is hand-written.
- **The setup path.** Get started is six steps in order, each starting with
  `<SetupPath step={n} />` and ending on a `<Card>` to the next. Reference
  material lives in Reference, linked from the step that needs it.
- **Media.** Terminal work is drawn with `<Terminal>` from real output,
  never invented. The Studio is shown in stills from the studio shots lane,
  copied by `scripts/docs-studio-stills.mjs` and redrawn each release (a run
  cannot open the Studio: its entry link is single-use). A video is an
  example of output only where output is the subject, and its DemoScript
  sits in `media/scripts/` under the same name so it can be recorded again.
- **Pins.** Every MCP block on the site runs `demoman@latest`, so it
  updates itself; only the License page's links name a version, and that
  one equals `version` in `apps/cli/package.json` (`docs.test` holds both).
  Versions in prose are bare (`0.2.0-rc.7`), never `demoman@...`.
- **Trust** claims nothing `internal/docs/disclosure-cli.md` does not say,
  and names no source paths.
- **Links** are root-relative (`/get-started/install`) and must name a page
  in `docs.json`. A moved page gets a redirect in `docs.json`.
- **Look.** Tokens come from `internal/site/public/style.css` into
  `apps/docs/style.css`; dark values are derived there. The logos are
  `brand/logomark.svg`'s figure, and the favicon is a byte copy of
  demoman.io's `icon-512.png` (see `brand/README.md`).
- **Prose:** minimal, no helper copy. Titles are at most four words and are
  the sidebar labels.

## Sources per page

| Page | Built from |
| --- | --- |
| Introduction | The site's Premise and System sections |
| Install, Connect your agent | `apps/cli/src/setup.ts` and its questions; one tab per manual agent |
| Your first video, The run report | The recipe's sections 4 and 5, as what the reader sees |
| Sign in, accounts.json | The recipe's "Behind a login", `signin` from `USAGE`, CI secrets |
| Add to your repo, Keep videos current, Refresh | `apps/runner/src/executor/keep.ts`, `refresh.ts`, `setup --ci` |
| Commands (Reference) | `USAGE` and the flags `main.ts` and `setup.ts` parse |
| app.json, Environment | `.demoman/app.json`'s parser; the `DEMOMAN_*` variables the package reads |
| DemoScript | Generated from `DemoScriptSchema` |
| Refusals | The human-facing reasons of the recipe's section 7 and setup's stops |
| Studio pages | `npx demoman studio`, the Studio's own labels |
| Data | `internal/docs/disclosure-cli.md` |
| License | FSL-1.1-ALv2 |
| Changelog | User-facing changes per release: three to five bullets, 130 words at most. Past entries keep the words they shipped with: `pnpm release` pins each in `apps/cli/test/changelog-shipped.json` |
