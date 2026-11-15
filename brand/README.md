# Brand assets

The canonical mark and lockups. This directory belongs to no app, which is
the point: the code is FSL and the docs and the site are all rights
reserved, and when one of them leaves for its own repo the brand has to be
somewhere none of them owns.

| File | What it is |
| --- | --- |
| `logomark.svg` | the mark: two slashes and a slanted D (the author, 2026-11-14), filled `currentColor`, centred on a square. Copied into the Studio (below) |
| `icon.svg` | the same mark, asking for 32px where nothing sizes it. Copied into the Studio (below) |
| `banner_light.svg`, `banner_dark.svg` | the README's header: the mark alone, centred on a wide banner, dark for GitHub's light theme and light for its dark one |
| `logo.svg` | the app tile: the white mark on the near-black `#0a0a0a`, with a hairline ring. demoman.io's icon at 512 |
| `lockup_light.svg`, `lockup_dark.svg` | the lockup (below) centred on a 4:1 banner, for a place that wants the name beside the mark. Copied into the Studio (below) |
| `wordmark.svg` | "Demoman" in Outfit 500 as outlines, filled `currentColor`: demoman.io's header wordmark, for places that cannot load the font. Written by the author's `internal/tools/make-wordmark.py`, which reads the site's copy of Outfit. Set into the lockups |
| `mascot.svg` | the mascot: the figure (a play-button head, a square body, two legs) that was the mark until 2026-11-14, filled `currentColor`, on a square. Still the brand's, as a character rather than the logo |

Every file but `wordmark.svg` is written by the author's
`internal/site/scripts/icons.mjs`, from the same mark that draws
demoman.io's icons, so the README, the site and this folder cannot drift
apart. `node internal/site/scripts/icons.mjs --svgs` rewrites the SVGs alone,
without Chrome.

## The lockup

The mark beside the wordmark, as the author approved it on 2026-11-14:

- **Font**: Outfit Medium (500).
- **Height**: the mark is as tall as the capital D, Outfit's cap height,
  0.7 of the font size.
- **Alignment**: the mark's foot sits on the letters' baseline.
- **Gap**: a quarter of the font size between the mark and the D (18px at
  72px text).

demoman.io's header sets it in live text (`.home` in `site/public/style.css`);
the lockups and the docs' logos set it from `wordmark.svg`.

## The marks have copies, deliberately

Each consumer holds its own copy so it can be extracted without reaching
across the workspace for an asset:

| Copy | Why it exists |
| --- | --- |
| `apps/studio/pages/public/images/logomark.svg`, `icon.svg`, `lockup_light.svg`, `lockup_dark.svg` | served inside the Studio's pages. The page bars still name them, but the Studio draws its own inline mark and hides them (`studio.css`, `.logomark`) |
| `apps/docs/logo/light.svg`, `logo/dark.svg` | the docs site's logos at demoman.io/docs: demoman.io's header lockup at its 19px, filled `#0a0a0a` for light mode and `#f4f4f5` for dark. `icons.mjs` writes them |

Copies drift. Two tests hold them to this directory, each on the side that
owns the copy, so each one keeps working after a split:

- `apps/studio/test/pages/node/brand-copies.test.ts` — every studio copy
- `apps/cli/test/docs.test.ts` — the docs logos

**After re-running `icons.mjs`**, copy the four studio files over
(`brand-copies.test.ts` goes red until they match). After re-running
`make-wordmark.py`, re-run `icons.mjs` (the lockups and the docs' logos set
the wordmark). The Studio's favicon (`pages/public/icon/32.png`, served as
`/favicon.ico`) is a byte copy of the site's 32px tab icon, which
`icons.mjs` writes and `internal/site/test/product-docs.test.mjs` holds.

## demoman.io: the lockup in the header

Since 2026-11-14 demoman.io's header sets the mark inline beside the Outfit
wordmark as live text (19px, 500), by the lockup's rules above; the wordmark
folds away as the page scrolls and leaves the mark. The footer shows the mark
alone. (From 2026-10-25 the figure stood 28px tall, 14px left of the word.)
The site copies no lockup or mark file.

Its icons (`favicon.ico`, the touch and PWA icons) are drawn by
`internal/site/scripts/icons.mjs`: the white mark on the near-black
`#0a0a0a`, on a rounded tile with a hairline ring. demoman.io/docs takes the
same icon: its favicon is a byte copy of the site's `icon-512.png` (the
script makes it), held by `internal/site/test/product-docs.test.mjs`. The
social card (`og.png`) carries the lockup on its left, and the headline over
the agent's terminal and the video it made on its right.

If the mark's geometry changes here, change the site's inline copies by
hand (`internal/site/public/` `index.html`, `privacy.html`, `changelog.html`,
and the page in `src/worker.js`), the Studio's (`apps/studio/pages/entrypoints/`
`library` and `settings`), and the mark at the top of
`internal/site/scripts/icons.mjs`, then re-run it.
