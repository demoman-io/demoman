import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  AGENT_ARG,
  agentOf,
  failure,
  type Op,
  type Outcome,
} from "@demoman/agent-bridge";
import { authoredTotal, type ReplayProgress } from "@demoman/replay-engine";
import {
  checkScript,
  isHttpUrl,
  lookForRun,
  messageOf,
  type RefilmInfo,
  type RunReport,
  verdictLine,
  withSummary,
} from "@demoman/run-core";
import { chromium } from "playwright";
import { displayUnreadSentence, readDisplay } from "../display.js";
import { installResolver } from "../page-agent.js";
import { RUNNER_VERSION } from "../version.js";
import { signInAccount } from "./account-signin.js";
import {
  type AccountChoice,
  accountDefinition,
  chooseAccount,
  findAccounts,
} from "./accounts.js";
import { attachProjectRefused, attachTake, attachThrew } from "./attach.js";
import { createBrowserSession } from "./browser.js";
import { deriveOp, takesOp } from "./derive.js";
import { expireOld, expiryStatus } from "./expiry.js";
import { type ExportDeps, exportTake } from "./export.js";
import { createGh, defaultGhRun } from "./gh.js";
import { readKits } from "./kits.js";
import { DEFAULT_SIGNIN_COMMAND } from "./landing.js";
import { createLibrary, ownHome } from "./library.js";
import { ensureVideos, startPage } from "./migrate-videos.js";
import { installExecutorEntry } from "./page-ops.js";
import {
  type PullRequestsSetting,
  resolvePullRequests,
} from "./pull-requests.js";
import { refilmFromVideo } from "./refilm.js";
import { readRepo } from "./repo.js";
import { runScript } from "./run.js";
import { runningWords } from "./running.js";
import {
  createSecretSweep,
  readSecretsFile,
  resolveSecrets,
  SecretError,
  sweptSink,
} from "./secrets-env.js";
import { createSessionLoader } from "./session-loader.js";
import { createSessionStore, type SessionChoice } from "./sessions.js";
import { snapshotOp } from "./snapshot.js";
import type { ExecutorOptions, LocalExecutor } from "./types.js";
import { sameName } from "./video-match.js";
import {
  createVideoStore,
  isVideoId,
  type Made,
  VideoError,
  type VideoRecord,
  type VideoRepo,
} from "./videos.js";
import { matchesFor, videosOp } from "./videos-op.js";

/** `run`'s `video`, or null when it is neither `{ id }` nor `{ new }`. */
function videoArg(
  v: unknown,
): { id: string } | { new: string; confirmedNew: boolean } | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  if (text(o.id) !== "" && o.new === undefined) return { id: text(o.id) };
  if (text(o.new) !== "" && o.id === undefined) {
    return { new: text(o.new), confirmedNew: o.confirmedNew === true };
  }
  return null;
}

/** Who made a version (spec §2): the OS user, or why it could not be read. */
function osUserName(): string | { none: string } {
  try {
    return userInfo().username;
  } catch (error) {
    return { none: `the OS user name could not be read (${messageOf(error)})` };
  }
}

const BUSY =
  "a run, snapshot, export or attach is already in progress in this demoman-mcp — call report(id) on it, and try again when it settles";

export interface Job {
  op: "run" | "export" | "attach";
  latest: unknown;
  final: Outcome | null;
}

/** How many runs and exports `report(id)` can still answer. Each keeps its
 *  whole final answer, a run's report included, for as long as it is kept
 *  (review 2026-10-13, #7). */
export const JOBS_KEPT = 50;

/**
 * The calls `report(id)` answers from: the latest `kept`, the oldest settled
 * one let go first. A call still in flight is never let go — its progress is
 * all a polling agent has.
 */
export function createJobTable(kept: number = JOBS_KEPT) {
  const jobs = new Map<string, Job>();
  return {
    set(id: string, job: Job): void {
      jobs.delete(id);
      jobs.set(id, job);
      for (const [old, was] of jobs) {
        if (jobs.size <= kept) break;
        if (was.final !== null) jobs.delete(old);
      }
    },
    get: (id: string): Job | undefined => jobs.get(id),
  };
}

/**
 * The CLI executor: the seven ops the extension answers, answered here, with
 * the same values and refusal reasons (spec 2026-10-12 §3). One slot, as the
 * run page has one: a run, a snapshot or an export holds it. `report` answers
 * from the in-memory job table only — a report.json that failed to write is
 * log-only, so reading it back would answer differently from what the run
 * said.
 */
export function createLocalExecutor(options: ExecutorOptions): LocalExecutor {
  const { home } = options;
  // Every line this executor writes, and every value it answers, passes the
  // sweep: a secret resolved for a sign-in is replaced by `{secret:NAME}`.
  const sweep = createSecretSweep();
  const log = (line: string) => options.log(sweep.scrub(line));
  // Owner-only, an older home included: takes show signed-in pages. Not
  // awaited: nothing is written before the first call, and a failure says so.
  ownHome(home).catch((error: unknown) => {
    log(
      `${home} could not be made owner-only (${messageOf(error)}), so other users on this machine may read its takes`,
    );
  });
  const env = options.env ?? process.env;
  // The project the client says it opened before the folder it started this
  // server in: Claude Code names it (measured 2026-10-24), and a client that
  // starts servers elsewhere (Cursor: home) would point at the wrong repo.
  const projectDir =
    options.projectDir || env.CLAUDE_PROJECT_DIR || process.cwd();
  const library = createLibrary(
    home,
    options.updateCommand === undefined
      ? {}
      : { updateCommand: options.updateCommand },
  );
  const videos = createVideoStore(home, library, { log });
  const outDir = options.outDir ?? join(homedir(), "Downloads");
  const sessionStore = createSessionStore(home);
  const sessions = createSessionLoader(sessionStore, log);
  const signinCommand = options.signinCommand ?? DEFAULT_SIGNIN_COMMAND;
  type Refused = {
    kind: "refused";
    reason: string;
    detail: string;
    field: string;
  };
  /** Where `project` points: the folder to look in, or the refusal. */
  async function projectFolder(
    project: unknown,
  ): Promise<{ from: string } | Refused> {
    if (project === undefined) return { from: projectDir };
    if (typeof project !== "string" || !isAbsolute(project)) {
      return {
        kind: "refused",
        reason: "invalidProject",
        field: "project",
        detail: `project must be an absolute path to the app's checkout; got ${JSON.stringify(project)}`,
      };
    }
    const isFolder = await stat(project).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isFolder) {
      return {
        kind: "refused",
        reason: "invalidProject",
        field: "project",
        detail: `project ${project} is not a folder`,
      };
    }
    return { from: project };
  }
  /** The account a call films as, read fresh: the agent edits the file
   *  between calls. */
  async function accountFor(
    project: unknown,
    target: string,
    named: string | undefined,
  ): Promise<AccountChoice | Refused> {
    const where = await projectFolder(project);
    if ("kind" in where) return where;
    return chooseAccount(await findAccounts(where.from), target, named);
  }
  type Chosen = Extract<AccountChoice, { kind: "account" }>;
  /**
   * Why the environment's secrets are withheld from this account, or
   * undefined when they are not. They serve only the accounts.json Demoman
   * finds from where it was started: one reached through `project` is a
   * folder the caller chose, and its file names its own origin, so a
   * `DEMOMAN_SECRET_*` typed for it could land on any site (security
   * review, 2026-10-16). Its own secrets.env still answers.
   */
  async function envWithheldFor(c: Chosen): Promise<string | undefined> {
    const real = (p: string) => realpath(p).catch(() => p);
    const own = await findAccounts(projectDir);
    if (
      own.kind === "found" &&
      (await real(own.file.path)) === (await real(c.file.path))
    ) {
      return undefined;
    }
    const ownFile =
      own.kind === "none"
        ? `the accounts.json of the repo Demoman was started in (${projectDir}, which has none)`
        : `${own.kind === "found" ? own.file.path : own.path}, the accounts.json of the repo Demoman was started in`;
    return `environment secrets are used only for ${ownFile}, and ${c.file.path} was reached through \`project\``;
  }
  /** Teaches the sweep every value the chosen account can type, so a
   *  session that needs no sign-in this call is still covered. What cannot
   *  be resolved is left to the sign-in path, which refuses it when needed. */
  async function learnSecrets(c: AccountChoice): Promise<void> {
    if (c.kind !== "account") return;
    const withheld = await envWithheldFor(c);
    let source: Awaited<ReturnType<typeof readSecretsFile>>;
    try {
      source = await readSecretsFile(c.file.dir);
    } catch (error) {
      log(
        `secrets for ${c.account.name} were not preloaded for scrubbing (${messageOf(error)})`,
      );
      return;
    }
    for (const step of c.account.signIn) {
      if (step.do !== "type") continue;
      try {
        const scope = {
          origin: c.site.origin,
          ...(withheld === undefined ? {} : { envWithheld: withheld }),
        };
        for (const u of resolveSecrets(step.text, env, source, scope).used) {
          sweep.add(u.name, u.value);
        }
      } catch (error) {
        log(
          `a secret for ${c.account.name} was not preloaded for scrubbing (${messageOf(error)})`,
        );
      }
    }
  }
  const choiceOf = (c: AccountChoice): SessionChoice | null =>
    c.kind === "account"
      ? { site: c.site.site, origin: c.site.origin, name: c.account.name }
      : null;
  const signInAs = async (c: Chosen, since?: Date) => {
    const envWithheld = await envWithheldFor(c);
    return signInAccount(c, {
      store: sessionStore,
      env,
      ...(envWithheld === undefined ? {} : { envWithheld }),
      sweep,
      log,
      ...(options.executablePath === undefined
        ? {}
        : { executablePath: options.executablePath }),
      ...(options.installCommand === undefined
        ? {}
        : { installCommand: options.installCommand }),
      ...(since === undefined ? {} : { reuseSavedSince: since }),
    });
  };
  /** Whether the account has a saved session of its own, signed in with
   *  the definition accounts.json holds now (`accountDefinition`). */
  const hasSession = (
    files: readonly {
      account?: { origin: string; name: string; definition?: string };
    }[],
    c: Chosen,
  ) =>
    files.some(
      (f) =>
        f.account?.origin === c.site.origin &&
        f.account.name === c.account.name &&
        f.account.definition === accountDefinition(c.account),
    );
  /** A run that stopped on a sign-in page before filming. */
  const stoppedAtStart = (report: RunReport) =>
    report.stopped?.reason === "signedOut" && report.steps.length === 0;
  const stillSignedOut = (c: Chosen, target: string) =>
    `signed in as ${c.account.name} just now, but ${target} still sends this browser to its sign-in page: this account cannot open that page, or the sign-in did not really sign in (checkUrl is public, or the password is wrong) — choose another account, or record a page it can see`;

  async function accountsForStatus() {
    const found = await findAccounts(projectDir);
    if (found.kind === "none") {
      return { file: null, searchedFrom: found.searchedFrom };
    }
    if (found.kind === "invalid") {
      return { file: found.path, invalid: found.detail, field: found.field };
    }
    let saved: Awaited<ReturnType<typeof sessionStore.read>>["files"] = [];
    let unreadable: string | undefined;
    try {
      saved = (await sessionStore.read()).files;
    } catch (error) {
      unreadable = messageOf(error);
    }
    return {
      file: found.file.path,
      ...(unreadable === undefined ? {} : { sessionsUnreadable: unreadable }),
      sites: [...found.file.sites.values()].map((site) => ({
        origin: site.origin,
        default: site.defaultAccount,
        accounts: [...site.accounts.values()].map((a) => ({
          name: a.name,
          about: a.about,
          // "changed": saved for an earlier definition of the account in
          // accounts.json; the next call that uses it signs in again.
          session: ((f) =>
            f === undefined
              ? "none"
              : f.account?.definition === accountDefinition(a)
                ? "saved"
                : "changed")(
            saved.find(
              (f) =>
                f.account?.origin === site.origin && f.account.name === a.name,
            ),
          ),
        })),
      })),
    };
  }
  async function secretsFileForStatus() {
    const found = await findAccounts(projectDir);
    if (found.kind !== "found") return null;
    try {
      const source = await readSecretsFile(found.file.dir);
      return source.status === "absent"
        ? { path: source.path, absent: true }
        : { path: source.path, git: source.status };
    } catch (error) {
      return {
        path: join(found.file.dir, "secrets.env"),
        refused:
          error instanceof SecretError ? error.message : messageOf(error),
      };
    }
  }
  async function sessionsForStatus() {
    try {
      const { files } = await sessionStore.read();
      return files.map((f) => ({
        site: f.site,
        savedAt: f.savedAt,
        refreshedAt: f.refreshedAt,
        signInUrl: f.signInUrl,
        // An account's file is listed with its account, never as the site's
        // own manual session (final review M3).
        ...(f.account === undefined
          ? {}
          : { account: f.account.name, origin: f.account.origin }),
      }));
    } catch (error) {
      return { unreadable: messageOf(error) };
    }
  }
  async function displayForStatus(): Promise<
    { width: number; height: number; scale: number } | { unreadable: string }
  > {
    try {
      const read = await readDisplay(options.env ?? process.env);
      return "failed" in read
        ? { unreadable: displayUnreadSentence(read.failed, "records") }
        : read;
    } catch (error) {
      return { unreadable: displayUnreadSentence(messageOf(error), "records") };
    }
  }
  const session = createBrowserSession({
    headless: options.headless,
    ...(options.standInDisplay === true
      ? { readDisplay: () => readDisplay(options.env ?? process.env) }
      : {}),
    ...(options.executablePath === undefined
      ? {}
      : { executablePath: options.executablePath }),
    log,
    ...(options.installCommand === undefined
      ? {}
      : { installCommand: options.installCommand }),
    ...(options.launchFn === undefined ? {} : { launchFn: options.launchFn }),
    ...(options.workWindow === undefined
      ? {}
      : { workWindow: options.workWindow }),
    // On the context, not a page: each call gets a page of its own
    // (`BrowserSession.stage`), and every one must carry both.
    onLaunched: async ({ context }) => {
      await installResolver(context);
      await installExecutorEntry(context);
    },
  });
  let slot: "run" | "snapshot" | "export" | "attach" | null = null;
  let holePaths: string[] = [];
  const jobs = createJobTable();
  let lastRun: Job | null = null;
  /** What `export` and `attach` export with: one path for both. */
  const exportDeps = (): ExportDeps => ({
    library,
    videos,
    session,
    door: "agent",
    home,
    outDir,
    log,
    ...(options.onWorkPage === undefined
      ? {}
      : { onWorkPage: options.onWorkPage }),
    ...(options.mp4MaxTier === undefined
      ? {}
      : { maxTier: options.mp4MaxTier }),
  });
  /** Claims the slot for an export-shaped call, answering the export's own
   *  busy refusal when it is held (the hub's line reads that shape). */
  function exportSlot(op: "export" | "attach"): Outcome | null {
    if (slot === null) {
      slot = op;
      return null;
    }
    return {
      ok: true,
      value: withSummary({
        outcome: "refusedBeforeExport",
        reason: "busy",
        detail: BUSY,
      }),
    };
  }

  // The slot is claimed before the first await and released in one place,
  // so a second request arriving while the take is read gets alreadyRunning.
  async function run(
    args: Record<string, unknown>,
    onProgress?: (value: unknown) => void,
  ): Promise<Outcome> {
    if (slot !== null) {
      return {
        ok: true,
        value: {
          outcome: "refusedBeforeRun",
          reason: "alreadyRunning",
          detail: BUSY,
          field: null,
        },
      };
    }
    slot = "run";
    try {
      return await runClaimed(args, onProgress);
    } finally {
      slot = null;
    }
  }

  // The job is listed before the first await (finding the video reads git
  // and the library), so a report asked meanwhile reads a run, never
  // noReport; a refusal is the job's answer like any other.
  async function runClaimed(
    args: Record<string, unknown>,
    onProgress?: (value: unknown) => void,
  ): Promise<Outcome> {
    const callId = typeof args.callId === "string" ? args.callId : null;
    const job: Job = {
      op: "run",
      latest: {
        outcome: "running",
        summary: "Running — finding its video.",
        doing: "finding its video",
        step: 0,
        of: 0,
        keyframes: 0,
        note: null,
      },
      final: null,
    };
    if (callId !== null) jobs.set(callId, job);
    lastRun = job;
    let out: Outcome;
    try {
      out = await runJob(args, job, onProgress);
    } catch (error) {
      // Before runJob's own catch (finding the video, checking the script):
      // still the job's answer, or report(id) would say "running" forever.
      log(`the run threw — ${messageOf(error)}`);
      out = { ok: true, value: { outcome: "threw", error: messageOf(error) } };
    }
    job.final = out;
    return out;
  }

  async function runJob(
    args: Record<string, unknown>,
    job: Job,
    onProgress?: (value: unknown) => void,
  ): Promise<Outcome> {
    const refusal = (
      reason: string,
      detail: string,
      field: string | null = null,
      more: Record<string, unknown> = {},
    ): Outcome => ({
      ok: true,
      value: { outcome: "refusedBeforeRun", reason, detail, field, ...more },
    });
    // Every take joins a video (local video library §4): `{ id }` adds a
    // version, `{ new }` starts one. Each refusal here spends no run.
    const asked = videoArg(args.video);
    if (asked === null) {
      return refusal(
        "videoRequired",
        `run needs video: { id } to add a version to a video, or { new: "<name>" } to start one; got ${JSON.stringify(args.video) ?? "none"}${args.takeId === undefined ? "" : " (takeId is gone: re-record a take with video: { id } of its video and no script)"}`,
        "video",
      );
    }
    const hasScript = args.script !== undefined;
    if ("new" in asked && !hasScript) {
      return refusal(
        "invalidScript",
        `a new video needs a script to record its first version`,
        "script",
      );
    }
    const where = await projectFolder(args.project);
    if ("kind" in where)
      return refusal(where.reason, where.detail, where.field);
    const repoRead = await readRepo(where.from);
    const videoRepo: VideoRepo = repoRead.ok
      ? { key: repoRead.repo.key }
      : { none: repoRead.none };
    let into: VideoRecord | null = null;
    let raw: unknown = args.script;
    let refilm: RefilmInfo | undefined;
    let builtFrom: string | null = null;
    try {
      const migrated = await ensureVideos(videos, library);
      for (const s of migrated.skipped) {
        log(`take ${s.takeId}: ${s.reason}`);
      }
      if (migrated.deferred !== null) {
        log(
          `takes waiting to join a video were not joined: ${migrated.deferred}; a later run joins them`,
        );
      }
      // Never refuses the run: a failure is logged here and said by status.
      const expiry = await expireOld(videos, library, new Date());
      if ("failed" in expiry) log(`expiry failed: ${expiry.failed}`);
      if ("id" in asked) {
        into = isVideoId(asked.id) ? await videos.get(asked.id) : null;
        if (into === null) {
          return refusal(
            "videoNotFound",
            `no video has the id ${JSON.stringify(asked.id)}`,
            "video",
          );
        }
        if (!hasScript) {
          const target = into.id;
          const built = await refilmFromVideo(
            videos,
            library,
            into,
            migrated.skipped.filter((s) => s.videoId === target),
          );
          if (!built.ok) return { ok: true, value: built.refusal };
          raw = built.script;
          refilm = built.refilm;
          builtFrom = built.takeId;
        }
      } else {
        const matches = await matchesFor(videos, library, asked.new, videoRepo);
        const holder = matches.find((m) => sameName(m.name, asked.new));
        if (holder !== undefined) {
          return refusal(
            "nameTaken",
            `video "${holder.name}" (${holder.id}) already has that name in this repo — add a version to it with video: { id: "${holder.id}" }, or name the new video differently`,
            "video",
            { holder },
          );
        }
        if (matches.length > 0 && !asked.confirmedNew) {
          return refusal(
            "possibleDuplicate",
            `${matches.length === 1 ? "a video" : `${matches.length} videos`} in this repo may already show this: ${matches.map((m) => `"${m.name}" (${m.id})`).join(", ")} — add a version to one with video: { id }, or call again with video: { new, confirmedNew: true } if this is a different flow`,
            "video",
            { matches },
          );
        }
      }
    } catch (error) {
      // The store says whether it could not read or could not write.
      return refusal(
        error instanceof VideoError ? error.reason : "videoUnreadable",
        messageOf(error),
        "video",
      );
    }
    const checked = checkScript(raw, builtFrom === null ? holePaths : []);
    if (!checked.ok) {
      // A script built from a take is not one the caller wrote: the
      // refusal says where it came from.
      return {
        ok: true,
        value:
          builtFrom !== null
            ? {
                ...checked.refusal,
                detail: `the script built from take ${builtFrom}'s script.json and scene.json is not valid — ${checked.refusal.detail}`,
              }
            : checked.refusal,
      };
    }
    const script = checked.script;
    const who = agentOf(args);
    const made: Made = {
      repo: repoRead.ok ? repoRead.repo : { none: repoRead.none },
      agent: who.ok
        ? who.agent
        : {
            none: who.absent
              ? `the MCP client sent no name (no args.${AGENT_ARG})`
              : who.why,
          },
      by: osUserName(),
      door: "mcp",
    };
    const target = into;
    // A `new` video is created only here, once the run has a take, so a
    // refused or failed run leaves no empty video (ruling 9).
    const joinVideo = async (takeId: string) => {
      let video: VideoRecord;
      let created = false;
      try {
        if (target !== null) {
          video = target;
        } else {
          const name = (asked as { new: string }).new;
          const started = await videos.create({
            name,
            repo: videoRepo,
            startPage: startPage(script.target),
          });
          if (!started.ok) {
            throw new Error(
              `video "${started.holder.name}" (${started.holder.id}) took the name "${name}" while the run played`,
            );
          }
          video = started.video;
          created = true;
        }
      } catch (error) {
        throw new Error(`the take is not in any video: ${messageOf(error)}`);
      }
      try {
        const read = await library.getSceneRead(takeId);
        if (read === null) throw new Error("its scene.json was gone when read");
        await videos.join(takeId, {
          videoId: video.id,
          made,
          recordedRevision: read.revision,
        });
      } catch (error) {
        if (created) {
          await videos.remove(video.id).catch((e: unknown) => {
            log(
              `video ${video.id} has no version and could not be removed (${messageOf(e)})`,
            );
          });
        }
        throw new Error(
          `the take is not in any video: it could not join "${video.name}" (${messageOf(error)})`,
        );
      }
      // The take is in the video either way: a version number that cannot
      // be read back is logged and left out, never a failed join.
      const unread = `the take joined video "${video.name}" (${video.id}), but its version number could not be read back`;
      let version: number | undefined;
      try {
        version = (await videos.versions(video.id)).find(
          (v) => v.takeId === takeId,
        )?.number;
        if (version === undefined) log(`${unread}: no version is that take`);
      } catch (error) {
        log(`${unread} (${messageOf(error)})`);
      }
      return {
        id: video.id,
        name: video.name,
        ...(version === undefined ? {} : { version }),
        created,
      };
    };
    const paint = (value: unknown) => {
      job.latest = value;
      onProgress?.(value);
    };
    // Painted before anything slow (kits, the browser launch), so a polling
    // agent never reads an empty run.
    paint({
      outcome: "running",
      // `doing` is the line a person reads while the run plays, `summary`
      // the sentence a polling report leads with, as an export's does.
      summary: "Running — starting.",
      doing: "starting",
      step: 0,
      of: authoredTotal(script),
      keyframes: 0,
      note: null,
    });
    try {
      const kits = await readKits(home);
      if (script.look?.kit !== undefined) {
        const look = lookForRun(script, kits);
        if (!look.ok) {
          // The run page's own two reasons: a list it could not read, and a
          // name that is not in it (run/view.ts `start`).
          const out =
            look.reason === "kitsUnreadable"
              ? refusal("kitsUnreadable", look.detail, "look.kit")
              : refusal("unknownKit", look.detail, "look.kit");
          job.final = out;
          return out;
        }
      }
      // Read fresh on every call: the agent edits the file between calls.
      const choice = await accountFor(
        args.project,
        script.target,
        script.account,
      );
      if (choice.kind === "refused") {
        const out = refusal(choice.reason, choice.detail, choice.field);
        job.final = out;
        return out;
      }
      await learnSecrets(choice);
      const chosen = choice.kind === "account" ? choice : null;
      const browser = await session.ensure();
      if (!browser.ok) {
        const out = refusal(browser.reason, browser.detail);
        job.final = out;
        return out;
      }
      // No page of an earlier call may run while this one's sessions load.
      await session.retire();
      let loaded = await sessions.load(
        browser.launched.context,
        choiceOf(choice),
      );
      if (!loaded.ok) {
        const out = refusal(loaded.reason, loaded.detail);
        job.final = out;
        return out;
      }
      // Signing in is the repo's steps in a browser of their own; this
      // call's context then loads what they saved.
      let signedIn: RunReport["signedIn"];
      const signInNow = async (since?: Date): Promise<Outcome | null> => {
        if (chosen === null) return null;
        const r = await signInAs(chosen, since);
        if (!r.ok) return refusal(r.reason, r.detail, "account");
        if (!r.reused) {
          signedIn = { account: chosen.account.name, steps: r.steps, ms: r.ms };
        }
        sessions.forget();
        await session.retire();
        loaded = await sessions.load(
          browser.launched.context,
          choiceOf(choice),
        );
        return loaded.ok ? null : refusal(loaded.reason, loaded.detail);
      };
      if (chosen !== null && !hasSession(loaded.files, chosen)) {
        const refused = await signInNow(new Date());
        if (refused !== null) {
          job.final = refused;
          return refused;
        }
      }
      // Whatever the run did to the context's cookies, the next call starts
      // from the saved sessions again (final review 2).
      const film = async () => {
        if (!loaded.ok) throw new Error("sessions were not loaded");
        return runScript(
          script,
          {
            session,
            library,
            kits,
            log,
            refilm,
            joinVideo,
            ...(repoRead.ok && repoRead.repo.commit !== null
              ? { buildSha: repoRead.repo.commit }
              : {}),
            sessions: loaded.files,
            sessionsContext: browser.launched.context,
            loadSessions: (context) => sessions.load(context, choiceOf(choice)),
            sessionStore,
            signinCommand,
            scrub: sweep.scrubValue,
            ...(chosen === null
              ? {}
              : {
                  account: {
                    name: chosen.account.name,
                    signInAgain: async () => {
                      const r = await signInAs(chosen);
                      return r.ok
                        ? ({ ok: true } as const)
                        : ({ ok: false, detail: r.detail } as const);
                    },
                  },
                }),
          },
          (p: ReplayProgress) => {
            if (job.final !== null) return;
            paint({
              outcome: "running",
              summary: `Running — ${runningWords(script, p.step, p.total)}.`,
              doing: runningWords(script, p.step, p.total),
              step: p.step,
              of: p.total,
              keyframes: p.keyframes,
              note: p.note,
            });
          },
        ).finally(() => sessions.forget());
      };
      let report = await film();
      if (chosen !== null && stoppedAtStart(report)) {
        // The saved session had lapsed (or the page wants another sign-in):
        // sign in once more and film again. A second stop at the sign-in
        // page is the account's, not the session's.
        if (signedIn !== undefined) {
          const out = refusal(
            "signInFailed",
            stillSignedOut(chosen, script.target),
            "account",
          );
          job.final = out;
          return out;
        }
        const refused = await signInNow();
        if (refused !== null) {
          job.final = refused;
          return refused;
        }
        report = await film();
        if (stoppedAtStart(report)) {
          const out = refusal(
            "signInFailed",
            stillSignedOut(chosen, script.target),
            "account",
          );
          job.final = out;
          return out;
        }
      }
      const out: Outcome = {
        ok: true,
        value: {
          // The run page's own line, so a person reading the agent's
          // terminal reads what the run page would have said.
          summary: verdictLine(report),
          ...report,
          ...(chosen === null ? {} : { account: chosen.account.name }),
          ...(signedIn === undefined ? {} : { signedIn }),
        },
      };
      job.final = out;
      return out;
    } catch (error) {
      log(`the run threw — ${messageOf(error)}`);
      const out: Outcome = {
        ok: true,
        value: { outcome: "threw", error: messageOf(error) },
      };
      job.final = out;
      return out;
    }
  }

  /** A snapshot as the account a call names, signing in on demand: before
   *  it when the account has no session, once after when the page is the
   *  sign-in page (the saved session lapsed). */
  async function snapshotAs(args: Record<string, unknown>): Promise<Outcome> {
    const url = typeof args.url === "string" ? args.url : "";
    let choice: AccountChoice = { kind: "manual" };
    // A url that is not http(s) is snapshotOp's own refusal.
    if (isHttpUrl(url)) {
      const c = await accountFor(
        args.project,
        url,
        typeof args.account === "string" ? args.account : undefined,
      );
      if (c.kind === "refused") return failure(c.reason, c.detail);
      choice = c;
    }
    await learnSecrets(choice);
    const chosen = choice.kind === "account" ? choice : null;
    let signedIn: RunReport["signedIn"];
    const signInNow = async (since?: Date): Promise<Outcome | null> => {
      if (chosen === null) return null;
      const r = await signInAs(chosen, since);
      if (!r.ok) return failure(r.reason, r.detail);
      if (!r.reused) {
        signedIn = { account: chosen.account.name, steps: r.steps, ms: r.ms };
      }
      sessions.forget();
      return null;
    };
    if (chosen !== null) {
      let files: Awaited<ReturnType<typeof sessionStore.read>>["files"];
      try {
        files = (await sessionStore.read()).files;
      } catch (error) {
        return failure("sessionUnreadable", messageOf(error));
      }
      if (!hasSession(files, chosen)) {
        const refused = await signInNow(new Date());
        if (refused !== null) return refused;
      }
    }
    const take = async () => {
      // Before its stage: no page of an earlier call may run while this
      // one's sessions load.
      await session.retire();
      return snapshotOp(args, {
        session,
        home,
        log,
        loadSessions: (context) => sessions.load(context, choiceOf(choice)),
        signinCommand,
      });
    };
    let answer = await take();
    if (
      chosen !== null &&
      answer.ok &&
      (answer.value as { session?: unknown }).session === "signedOut"
    ) {
      if (signedIn !== undefined) {
        return failure("signInFailed", stillSignedOut(chosen, url));
      }
      const refused = await signInNow();
      if (refused !== null) return refused;
      answer = await take();
      if (
        answer.ok &&
        (answer.value as { session?: unknown }).session === "signedOut"
      ) {
        return failure("signInFailed", stillSignedOut(chosen, url));
      }
    }
    if (!answer.ok) return answer;
    return {
      ok: true,
      value: {
        ...(answer.value as Record<string, unknown>),
        account: chosen === null ? null : chosen.account.name,
        ...(signedIn === undefined ? {} : { signedIn }),
      },
    };
  }

  return {
    async request(op: Op, args, rawProgress) {
      // Progress goes to the agent and to hub peers: it passes the sweep too.
      const onProgress = sweptSink(sweep, rawProgress);
      const out = await (async (): Promise<Outcome> => {
        switch (op) {
          case "status": {
            // A project that cannot be used costs only the setting read
            // from it: the browser, sessions, accounts and update are still
            // answered, and the setting says why it could not be read.
            const where = await projectFolder(args.project);
            const pullRequests: PullRequestsSetting =
              "kind" in where
                ? { unreadable: where.detail, file: null }
                : await resolvePullRequests(where.from, home);
            return {
              ok: true,
              value: {
                executor: "cli",
                runnerVersion: RUNNER_VERSION,
                allowAgentRuns: true,
                browserRunning: session.running(),
                // Read without launching: tells "not started yet" from "not
                // installed", which browserRunning: false cannot.
                browserInstalled: existsSync(
                  options.executablePath ?? chromium.executablePath(),
                ),
                exportsTo: outDir,
                sessions: await sessionsForStatus(),
                accounts: await accountsForStatus(),
                secretsFile: await secretsFileForStatus(),
                // Headless standing in for a display only: the screen it
                // films as, read now (a laptop may have docked since), or
                // why it cannot be read — before anything is filmed at 1x.
                ...(options.headless && options.standInDisplay === true
                  ? { display: await displayForStatus() }
                  : {}),
                pullRequests,
                expiry: await expiryStatus(library),
                runPage:
                  lastRun === null
                    ? null
                    : lastRun.final?.ok
                      ? lastRun.final.value
                      : lastRun.latest,
              },
            };
          }
          case "snapshot": {
            if (slot !== null) return failure("alreadyRunning", BUSY);
            slot = "snapshot";
            try {
              return await snapshotAs(args);
            } catch (error) {
              return failure("snapshotThrew", messageOf(error));
            } finally {
              slot = null;
            }
          }
          case "run":
            return run(args, onProgress);
          case "report": {
            const id = typeof args.id === "string" ? args.id : null;
            const job = id === null ? undefined : jobs.get(id);
            if (job === undefined) {
              // Not "never ran": it may have, and been let go (`JOBS_KEPT`).
              return failure(
                "noReport",
                `no call ${id ?? "(no id)"} among the last ${JOBS_KEPT} runs, exports and attaches in this demoman-mcp`,
              );
            }
            if (job.final !== null) return job.final;
            if (job.latest === null) {
              return failure(
                "noReport",
                `call ${id} has neither a result nor progress to report`,
              );
            }
            return { ok: true, value: job.latest };
          }
          case "takes":
            return takesOp(library);
          case "videos": {
            const where = await projectFolder(args.project);
            if ("kind" in where) return failure(where.reason, where.detail);
            return videosOp({ store: videos, library, dir: where.from }, args);
          }
          case "derive": {
            if (slot !== null) {
              return {
                ok: true,
                value: {
                  report: {
                    outcome: "refusedBeforeRun",
                    reason: "alreadyRunning",
                    detail: BUSY,
                  },
                  script: null,
                },
              };
            }
            const derived = await deriveOp(library, args);
            if (derived.holePaths !== null) holePaths = derived.holePaths;
            return derived.outcome;
          }
          case "export": {
            const busy = exportSlot("export");
            if (busy !== null) return busy;
            const callId = typeof args.callId === "string" ? args.callId : null;
            // Seeded, so a report(id) sent before the export's first progress
            // answers that it is under way rather than noReport. With its
            // sentence, as every progress after it: an agent reads `summary`
            // off every export answer, in flight or settled.
            const job: Job = {
              op: "export",
              latest: withSummary({
                outcome: "exporting",
                phase: "rendering",
                done: 0,
                total: 0,
              }),
              final: null,
            };
            if (callId !== null) jobs.set(callId, job);
            try {
              const answer = await exportTake(
                args,
                exportDeps(),
                (progress) => {
                  const said = withSummary(progress);
                  job.latest = said;
                  onProgress?.(said);
                },
              );
              job.final = { ok: true, value: answer };
              return job.final;
            } catch (error) {
              log(`the export threw — ${messageOf(error)}`);
              job.final = {
                ok: true,
                value: withSummary({
                  outcome: "threw",
                  error: messageOf(error),
                }),
              };
              return job.final;
            } finally {
              slot = null;
            }
          }
          case "attach": {
            // The export's slot: an attach renders, and posts what it rendered.
            const busy = exportSlot("attach");
            if (busy !== null) return busy;
            const callId = typeof args.callId === "string" ? args.callId : null;
            const job: Job = {
              op: "attach",
              latest: {
                outcome: "attaching",
                phase: "checking",
                done: 0,
                total: 0,
                summary: "Attaching — checking gh and the pull request.",
              },
              final: null,
            };
            if (callId !== null) jobs.set(callId, job);
            try {
              const where = await projectFolder(args.project);
              if ("kind" in where) {
                job.final = {
                  ok: true,
                  value: attachProjectRefused(where.detail),
                };
                return job.final;
              }
              const answer = await attachTake(
                args,
                {
                  // Every gh call runs in the project, so a worktree attaches
                  // to its own branch's PR.
                  gh: createGh(
                    options.ghRun ?? defaultGhRun,
                    where.from,
                    env,
                    ...(options.ghCheckTimeoutMs === undefined
                      ? []
                      : [options.ghCheckTimeoutMs]),
                  ),
                  export: exportDeps(),
                  log,
                },
                (progress) => {
                  job.latest = progress;
                  onProgress?.(progress);
                },
              );
              job.final = { ok: true, value: answer };
              return job.final;
            } catch (error) {
              log(`the attach threw — ${messageOf(error)}`);
              job.final = { ok: true, value: attachThrew(messageOf(error)) };
              return job.final;
            } finally {
              slot = null;
            }
          }
        }
      })();
      return sweep.scrubValue(out);
    },
    browser: () => session.version(),
    close: () => session.close(),
  };
}
