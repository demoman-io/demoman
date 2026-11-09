// Copies the Studio stills the docs show from the studio shots lane.
//   pnpm --filter @demoman/studio exec vitest run test/browser/studio-shots.test.ts
//   node scripts/docs-studio-stills.mjs
// The lane draws the real Studio from a seeded library and asserts each shot
// on its paint (macOS only: its thumbnails come from sips). Run both before
// a release (internal/RELEASING.md) so the docs show the Studio as it ships.
// Exits 1, copying nothing, when a shot is missing: a stale still must not
// pass for a fresh one.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";

const shots = new URL("../apps/studio/test/browser/__screenshots__/studio/", import.meta.url);
const media = new URL("../apps/docs/media/studio/", import.meta.url);

/** docs still → the lane's shot it is copied from */
export const STILLS = {
  "library.png": "library-projects-acme-all-1440x900-dark.png",
  "editor.png": "editor-1440x900-dark.png",
  "split.png": "editor-split-1280x720-dark.png",
  "export.png": "editor-export-files-1440x900-dark.png",
  "add-to-repo.png": "add-sheet-1280x720-dark.png",
  "add-to-repo-ci.png": "add-sheet-ci-plan-dark.png",
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = Object.values(STILLS).filter((s) => !existsSync(new URL(s, shots)));
  if (missing.length > 0) {
    console.log(`docs:stills: the shots lane has not drawn ${missing.join(", ")}; run it first (nothing copied)`);
    process.exit(1);
  }
  mkdirSync(media, { recursive: true });
  for (const [still, shot] of Object.entries(STILLS)) {
    const from = new URL(shot, shots);
    copyFileSync(from, new URL(still, media));
    console.log(`copied ${shot} → apps/docs/media/studio/${still} (${Math.round(statSync(from).size / 1024)} KB)`);
  }
  console.log(`docs:stills: ${Object.keys(STILLS).length} copied`);
}
