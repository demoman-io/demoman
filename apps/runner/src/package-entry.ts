// apps/runner/src/package-entry.ts
//
// What the published `demoman` package takes from the runner (launch B):
// the executor and the prebuilt-page seam. A subpath of its own so the
// package's bundle never reaches pipeline.ts or the film:compare harness.
export {
  PAGE_ENTRIES,
  type PageEntry,
  pageBuildOptions,
  pageEntryPath,
  usePrebuiltPages,
} from "./bundle-js.js";
export { fullChromiumPath, launchFailure } from "./executor/browser.js";
export { createLocalExecutor } from "./executor/executor.js";
export {
  type KeepAnswer,
  type KeepDeps,
  type KeepOutput,
  type KeepRefusal,
  keepVideo,
} from "./executor/keep.js";
export {
  type RefreshDeps,
  type RefreshResult,
  type RefreshVideo,
  refreshKept,
} from "./executor/refresh.js";
export { execGit, type GitRunner, readRepo } from "./executor/repo.js";
export { samePicture } from "./executor/same-picture.js";
export type { ExecutorOptions, LocalExecutor } from "./executor/types.js";
export { chromiumDepsCommand, playwrightCliPath } from "./install-advice.js";
export { recorderPlatform, visibleWindowRefusal } from "./platform.js";
export {
  type SigninAccountDeps,
  type SigninDeps,
  signin,
  signinAccount,
} from "./signin.js";
