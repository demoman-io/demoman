// apps/runner/src/studio-entry.ts
//
// What the local studio (`apps/studio`) takes from the runner: the take
// library, the export, and the seams the CLI shares. A subpath of its own so
// the studio never reaches pipeline.ts or the film:compare harness.
export { PAGE_ENTRIES, usePrebuiltPages } from "./bundle-js.js";
export {
  type BrowserFailure,
  classifyLaunchError,
  createBrowserSession,
  fullChromiumPath,
} from "./executor/browser.js";
export { expireOld, expiryStatus } from "./executor/expiry.js";
export {
  type ExportDeps,
  type Exporting,
  exportTake,
} from "./executor/export.js";
export { judgeKitsText, readKits } from "./executor/kits.js";
export {
  createLibrary,
  type Library,
  LibraryError,
  ownHome,
  pidAlive,
  readLeases,
} from "./executor/library.js";
export { readLogo } from "./executor/logo-ref.js";
export { ensureVideos } from "./executor/migrate-videos.js";
export {
  readUserSettings,
  type UserSettings,
} from "./executor/user-settings.js";
export {
  createVideoStore,
  VideoError,
  type VideoStore,
} from "./executor/videos.js";
export { summarise, type VideoSummary } from "./executor/videos-op.js";
export {
  chromiumInstallCommand,
  loadedPlaywrightVersion,
} from "./install-advice.js";
export { listenOnLoopback } from "./loopback.js";
