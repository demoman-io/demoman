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
export {
  chooseAccount,
  findAccounts,
  secretNamesIn,
} from "./executor/accounts.js";
export {
  type AppProposal,
  type AppSource,
  detectApp,
} from "./executor/app-detect.js";
export {
  type AppStarted,
  type AppStartRefusal,
  DOCKER_INFO_MS,
  DOCKER_TIMED_OUT,
  startApp,
} from "./executor/app-start.js";
export {
  type Verified,
  type VerifyDeps,
  type VerifyTarget,
  verifySetup,
} from "./executor/app-verify.js";
export { fullChromiumPath, launchFailure } from "./executor/browser.js";
export { createLocalExecutor } from "./executor/executor.js";
export {
  type KeepAnswer,
  type KeepDeps,
  type KeepOutput,
  type KeepRefusal,
  keepVideo,
  type RemoveAnswer,
  removeRepoFlow,
} from "./executor/keep.js";
export { readKeptFlows } from "./executor/kept-flows.js";
export {
  type RefreshDeps,
  type RefreshResult,
  type RefreshVideo,
  refreshKept,
} from "./executor/refresh.js";
export {
  type AppPlan,
  appOriginMismatch,
  appPlanFor,
  withApp,
} from "./executor/refresh-app.js";
export { checkCurrent } from "./executor/refresh-check.js";
export { execGit, type GitRunner, readRepo } from "./executor/repo.js";
export { samePicture } from "./executor/same-picture.js";
export {
  readSecretsFile,
  SECRET_MIN_LENGTH,
  SECRET_ORIGIN_SUFFIX,
  SECRET_PREFIX,
  SecretError,
} from "./executor/secrets-env.js";
export type { ExecutorOptions, LocalExecutor } from "./executor/types.js";
export {
  type Answer,
  type Fetch,
  HostedClient,
  pollLogin,
  startLogin,
} from "./hosted/client.js";
export {
  type Credential,
  type CredentialRead,
  deleteCredential,
  hostedBase,
  readCredential,
  writeCredential,
} from "./hosted/credential.js";
export { chromiumDepsCommand, playwrightCliPath } from "./install-advice.js";
export { type JoinAnswer, joinFlow } from "./join-flow.js";
export { recorderPlatform, visibleWindowRefusal } from "./platform.js";
export {
  type SigninAccountDeps,
  type SigninDeps,
  signin,
  signinAccount,
} from "./signin.js";
