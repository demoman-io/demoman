// apps/mcp/src/tools.ts
//
// The six tools of plan 1 (spec §1.1). Each forwards one op over the link and
// turns its Outcome into an MCP result; a failure is `isError` with its
// reason intact. `run` and `export` answer `stillRunning` at the cap, keeping
// the call's promise under its id for `report` (spec §3.2, plan 1's decision).

import { randomUUID } from "node:crypto";
import {
  AGENT_ARG,
  AGENT_NAME_MAX,
  type AgentName,
  type Outcome,
  RUN_TOOL_CAP_MS,
} from "@demoman/agent-bridge";
import { EXPORT_QUALITY_VALUES } from "@demoman/run-core";
import { DEVICE_IDS } from "@demoman/scene-schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "./annotations.js";
import type { Link } from "./local-link.js";
import type { LinksFor } from "./session-links.js";
import type { UpdateAnswer } from "./update-check.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Claude Code shows a result's first three lines and folds the rest
 *  ("… +N lines"), so the sentence a person reads goes where it is seen: a
 *  value's `summary` is written first, ahead of the report it sums up. */
function summaryFirst(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("summary" in value)
  ) {
    return value;
  }
  const { summary, ...rest } = value as Record<string, unknown>;
  return { summary, ...rest };
}

const ok = (value: unknown): ToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(summaryFirst(value), null, 2) },
  ],
});
const refused = (reason: string, detail: string): ToolResult => ({
  content: [
    { type: "text", text: JSON.stringify({ reason, detail }, null, 2) },
  ],
  isError: true,
});
const fromOutcome = (o: Outcome): ToolResult =>
  o.ok ? ok(o.value) : refused(o.reason, o.detail);

/** A progress value as Claude Code 2.1.302 draws it. A collapsed call line
 *  ("Calling demoman…") shows `message`, plus " (NN%)" when `total` is
 *  sent; the expanded view draws a bar from `total` instead. Without a
 *  message it shows "Processing… <n>", so a bare counter is never sent. A
 *  shape this does not know is shown as it came. */
export function progressReading(value: unknown): {
  at: number;
  total?: number;
  message: string;
} {
  const v = value as {
    doing?: string;
    step?: number;
    of?: number;
    phase?: string;
    done?: number;
    total?: number;
    note?: string | null;
    pass?: { render?: unknown; upTo?: unknown };
  };
  // A run sends no total: Claude Code would add "(50%)" to a line that
  // already says "step 2 of 4" (the author's pick, 2026-10-16).
  if (typeof v?.step === "number" && typeof v?.of === "number") {
    // `doing` names the step in flight; the extension's page sends only the
    // count of steps done.
    const where =
      typeof v.doing === "string" && v.doing !== ""
        ? `${v.doing[0]?.toUpperCase()}${v.doing.slice(1)}`
        : `Step ${v.step} of ${v.of} done`;
    return {
      at: v.step,
      message: `${where}${v.note ? ` — ${v.note}` : ""}`,
    };
  }
  // An export's frame count means little to a person: the percent Claude
  // Code adds from `total` says how far it is.
  if (v?.phase === "rendering") {
    const done = v.done ?? 0;
    const total = v.total ?? 0;
    if (total <= 0) return { at: 0, message: "Preparing the render" };
    const render = v.pass?.render;
    const upTo = v.pass?.upTo;
    if (typeof render === "number" && typeof upTo === "number" && upTo > 0) {
      // A capped MP4 renders again from frame 0, and a later render can
      // have fewer frames (60 to 30 fps). Counted in renders, the bar runs
      // over every render the cap may take and never goes back; and the
      // line names the render, so the sender, which drops a line it has
      // already said, sends each one.
      return {
        at: render - 1 + Math.min(done / total, 1),
        total: upTo,
        message: `Rendering — render ${render} of up to ${upTo}`,
      };
    }
    return { at: done, total, message: "Rendering" };
  }
  if (v?.phase === "saving") return { at: 0, message: "Saving the file" };
  // An attach's own phases, either side of its export.
  if (v?.phase === "checking") {
    return { at: 0, message: "Checking gh and the pull request" };
  }
  if (v?.phase === "posting") {
    return { at: 0, message: "Posting the video to the pull request" };
  }
  return { at: 0, message: JSON.stringify(value) };
}

type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      message?: string;
    };
  }) => Promise<void>;
};

function progressSender(extra: Extra): {
  send: (value: unknown) => void;
  close: () => void;
} {
  const token = extra._meta?.progressToken;
  /** What was last sent: MCP wants `progress` to rise with every
   *  notification, and a repeat of the same line is not news — unless it
   *  draws a bar and the bar moved a whole percent, the step Claude Code
   *  prints. */
  let last: {
    progress: number;
    total?: number;
    message: string;
    percent?: number;
  } | null = null;
  // MCP forbids progress notifications after the response that owns the token;
  // once the call has answered stillRunning, the run's later progress is
  // dropped (report reads the page's state instead).
  let closed = false;
  const send = (value: unknown) => {
    if (token === undefined || closed) return;
    const reading = progressReading(value);
    const percent =
      reading.total === undefined
        ? undefined
        : Math.floor((reading.at / reading.total) * 100);
    if (
      last !== null &&
      reading.message === last.message &&
      reading.total === last.total &&
      percent === last.percent
    ) {
      return;
    }
    // A step that repeats with a new note, or a phase with no count of its
    // own, still has to rise: by a sliver, which the bar's percent hides.
    const progress =
      last === null ? reading.at : Math.max(reading.at, last.progress + 0.001);
    const params = {
      progress,
      ...(reading.total === undefined ? {} : { total: reading.total }),
      message: reading.message,
    };
    last = { ...params, ...(percent === undefined ? {} : { percent }) };
    // Fire-and-forget: a progress line that cannot be sent must not fail the
    // run, and the final answer still says how it ended. Said on stderr.
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, ...params },
      })
      .catch((error) =>
        process.stderr.write(
          `demoman-mcp: a progress notification was not sent: ${String(error)}\n`,
        ),
      );
  };
  return {
    send,
    close: () => {
      closed = true;
    },
  };
}

const STILL_RUNNING = Symbol("stillRunning");

/** A call's latest progress while it is still going, and whoever is waiting
 *  on it now: a `report` with its own progress token, so the bar carries on
 *  past the first call's stillRunning. */
type Watched = {
  latest: unknown;
  settled: boolean;
  watch: ((value: unknown) => void) | null;
};

/** `report` waits on the call for this share of the cap and keeps the rest
 *  (10 s at the shipped 50 s) for asking the page. One deadline covers both
 *  waits: the ask can meet a link still waiting CONNECT_WAIT_MS for a
 *  reconnect, and without the deadline the two waits outlast the MCP client's
 *  own 60 s timeout, so the agent hears no reason at all. */
const REPORT_CALL_SHARE = 0.8;

/** The MCP client's own `clientInfo`, as the extension's prompt shows it
 *  (spec §5.4, amended 2026-10-03). Read per call: it is known only once the
 *  client has initialized. A field the extension would refuse to show is
 *  left out here rather than sent. */
function agentName(server: McpServer): AgentName | null {
  const info = server.server.getClientVersion();
  const fits = (v: unknown): v is string =>
    typeof v === "string" && v.trim() !== "" && v.length <= AGENT_NAME_MAX;
  if (info === undefined || !fits(info.name)) return null;
  return fits(info.title)
    ? { name: info.name, title: info.title }
    : { name: info.name };
}

/** The snapshot description's middle: what the page lists, true of both
 *  executors. */
const SNAPSHOT_TARGETS =
  "list the page's targets: each one a run resolves to exactly that element, checked before it is listed. Copy a target into a step verbatim; never compose one. Answers {url, landedUrl, landedElsewhere, title, settled, settleNote, targets: [{target, kind, text, rect, inFirstViewport}], unresolvable, notExamined, walkMs, size, kits}. size is {width, height, from, error}, the size the page was laid out at and a run with no viewport records; an error means it is the run window's own size instead, so tell the user.";
const SNAPSHOT_TAIL =
  "rect is in page coordinates and null for an element that is not shown (a closed FAQ answer). It sees only the page as it loads: content a click creates is not listed. Elements inside iframes and shadow roots are not listed. At most 250 targets: notExamined above 0 means elements were left unexamined. Without contains, pass one (case-insensitive, matched against text and name) to ask for one part of the page; with contains, notExamined counts only elements that match it, so narrow contains further. Pass device (phone or tablet) to see the page as a phone or a tablet; a run records that device only if its script names the same device.";

/**
 * What each tool says it does (final review 2026-10-12, Important 3): this
 * server's own browser, signed in only where the user ran `demoman signin`.
 * An agent reads these before it reads anything else. (Until 2026-10-20 the
 * extension executor had words of its own beside these.)
 */
const DESCRIPTIONS: Record<
  "status" | "snapshot" | "probe" | "takes" | "videos" | "run" | "export",
  string
> = {
  status:
    "Is this demoman-mcp's own browser up? executor \"cli\": this server runs scripts in a browser of its own, with no extension to connect or approve. Answers version, browserInstalled (false: the first snapshot or run answers browserMissing with the command that installs it), browserRunning (the window opens on the first snapshot, run or export and stays open between calls), runnerVersion, runPage (the latest run's report or its progress), and update (newer: true means a newer Demoman is out; tell the user once). expiry is the last cleanup of old recordings: {ranAt, expired, freedBytes, skippedLeased}, {ranAt, failed}, {never: true} or {unreadable}. sessions lists the sessions saved (site, savedAt, refreshedAt, signInUrl; an account's carries account and origin too, a plain entry is the site's manual session), or {unreadable} saying why it could not be read. accounts is the demo accounts in .demoman/accounts.json: {file, sites: [{origin, default, accounts: [{name, about, session}]}]}, {file: null, searchedFrom} when there is none, or {file, invalid, field} when it cannot be used; secretsFile is null, {path, absent}, {path, git: ignored or notGit} or {path, refused}. Never a value. pullRequests is the pull-request video setting: {value: off, ask or attach, from: repo, user or default, file?}, or {unreadable, file} when its file cannot be used (never read that as off; file null: project is not a usable folder); pass project (absolute path) to read another checkout's.",
  snapshot: `Open url in this server's own browser — signed in where the user ran npx demoman signin, or as a demo account (account; project: absolute path) — and ${SNAPSHOT_TARGETS} kits is {ok: true, kits: [{name, default, valid}]}: the user's brand kits; name one in a script's look.kit only when the user asked for that look; {ok: false, reason} means unreadable: name none. landedElsewhere true means the app redirected: session "signedOut" (or a plain sign-in landedUrl with "none"/"unchecked") means a sign-in page: spend no run; set up a demo account (recipe) or give the user sessionDetail's command (npx demoman signin <the page>). signedIn means Demoman signed in first. If landedUrl is not a sign-in page, use it as the target. ${SNAPSHOT_TAIL} Past about 50 s it answers {outcome: "stillRunning", id}; then call report with that id.`,
  takes:
    "The takes this demoman-mcp's own browser made, newest first: id, name, createdAt, mode, actions. A folder that is not a readable take comes last as {id, unreadable}, saying why. Not the user's Demoman library in their browser.",
  videos:
    "The videos in this repo (project: absolute path of another checkout; videos of unknown repo are listed everywhere), newest first: id, name, repo, startPage, versions, current {version, takeId, recordedAt, expired}, pages, steps (the first 12), exports {takeId, path, fileType, exists} of every version. Pass query to find the ones about a phrase (best match first, over every step; no match is an empty list), or file (absolute path of an exported MP4, GIF or PNG) to find the video it was exported from, and file {takeId, version, current, expired} saying which version it is ({takeId, notInVideo} when that take is no longer one). unreadable lists takes and video records that could not be read, each {id, unreadable}. deferred is null, or why takes not yet in a video were left out this time (another Demoman process holds the library; ask again). Refused: noTag (the file carries no Demoman tag), unknownVideo (its video is not in this library; detail names the id), fileNotFound, videoUnreadable, invalidProject, invalidArgs (file with query).",
  probe: `Play a draft script's steps in this server's own browser, unfilmed, and list the targets on the page they end on: the way to see what a click, hover or typing creates (a menu, dialog, panel, results), which snapshot cannot list. script is the script you mean to run, with its steps cut off after the one that opens what you need; it is refused exactly as run would refuse it. The steps really act on the app, every time: "Add item" adds one on each probe and again in the run, and a delete deletes. Prefer demo data and steps that look rather than change. No take is made and it is not a run. Answers snapshot's fields: url, landedUrl, landedElsewhere and session describe the arrival at script.target, before any step; title, settled, targets, unresolvable, notExamined and size describe the page the steps ended on (endedUrl). Plus steps {played, of}, counted as a run counts them (pauses are not steps), and stopped: null, or {at, reason, detail} with a run's reason when a step could not play; targets then list the page where it stopped (empty, with settleNote saying why, when it cannot be listed), and detail is worded for a run: where it says run again, probe again. Copy targets verbatim; never compose one. account, project and contains as for snapshot. Past about 50 s it answers {outcome: "stillRunning", id}; then call report with that id.`,
  run: 'Run a DemoScript in this demoman-mcp\'s own browser (signed in where the user ran npx demoman signin, or as the account the script names; project is the absolute path of another checkout) and answer its report, which carries account and signedIn; the take is saved on disk. Every run names its video: video {id} adds a version to that video, {new: name} starts one (refused as possibleDuplicate, listing matches, when a similar name exists in this repo; pass confirmedNew: true if it is a different flow). video {id} with no script re-records the current version of that video, studio edits included: a new version, counted as a run. A second run, snapshot or probe while one is in progress is refused (alreadyRunning). Answers {outcome: "stillRunning", id} if it takes longer than about 50 s; then call report with that id.',
  export:
    'Render a take this server made to an MP4, a GIF (fileType "gif") or a folder of PNG stills, one per step (fileType "stills"; stills.width in px or "native", stills.zoom "none" or "step"; MP4 quality: absent, the user\'s Export quality setting, "high" unless they changed it (60 fps, about 30 MB for 30 s); "share" as small as stays crisp, the default with maxMB; "full" the largest file; maxMB caps an MP4\'s size: it lowers fps, then size, then sharpness to fit, and says what it cost), and save it on this machine — in ~/Downloads, or the folder demoman-mcp was started with --out-dir — in the take\'s frame (Auto, 16:9 or 9:16) and branding, logo included. Refused versionExpired when the take\'s frames were removed after 30 days: run with video {id} again. A saved export may carry warnings.untagged (the file could not be tagged with its video). Answers the export report; on "saved", file.path is the file\'s absolute path, or folder.path the stills folder\'s, summary is the sentence to give the user, and links holds one-click links for them (studio, file, copy; linksError says why there are none). A second export, run, snapshot or probe while one is in progress is refused (busy, alreadyRunning). Past about 50 s it answers {outcome: "stillRunning", id}; then call report with that id.',
};

/** What the `studio` tool answers: the studio opened, or a refusal. Declared
 *  here so apps/mcp does not depend on the studio; the CLI injects it. */
export type StudioToolAnswer =
  | { outcome: "opened"; takeId?: string; note?: string }
  | { reason: string; detail: string };

export function registerTools(
  server: McpServer,
  bare: Link,
  options: {
    recipe: string;
    /** This server's version: the package's, for an npm install. */
    version: string;
    /** The CLI's daily npm check (launch B); absent, status says that no
     *  check was set up rather than inventing an answer. */
    updateCheck?: () => Promise<UpdateAnswer>;
    /** Opens the studio window (launch D2). Given only by the CLI bin, so
     *  `demoman-mcp` lists no `studio` tool. */
    studio?: (args: { takeId?: string }) => Promise<StudioToolAnswer>;
    /** The links a saved export ends on (`session-links.ts`). Given only
     *  by the CLI path; absent, an export answers without them. */
    links?: LinksFor;
    capMs?: number;
    newId?: () => string;
  },
): void {
  // Every op carries the agent's name, which the take records.
  const link: Link = {
    connected: () => bare.connected(),
    request: (op, args, onProgress) => {
      const agent = agentName(server);
      return bare.request(
        op,
        agent === null ? args : { ...args, [AGENT_ARG]: agent },
        onProgress,
      );
    },
  };
  const capMs = options.capMs ?? RUN_TOOL_CAP_MS;
  const newId = options.newId ?? randomUUID;
  const said = DESCRIPTIONS;
  /** Every run and export this server started, by the id it handed out, with
   *  which it was: the page keeps one report per kind, and `report` must read
   *  the right one after a lost call. */
  const calls = new Map<
    string,
    {
      op: "run" | "export" | "snapshot" | "probe" | "attach";
      call: Promise<Outcome>;
      watched: Watched;
    }
  >();

  const capped = async (
    p: Promise<Outcome>,
    ms = capMs,
  ): Promise<Outcome | typeof STILL_RUNNING> => {
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<typeof STILL_RUNNING>((r) => {
      timer = setTimeout(() => r(STILL_RUNNING), Math.max(0, ms));
    });
    try {
      return await Promise.race([p, cap]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** What a request that got no answer within `ms` says: its executor runs
   *  in this process, so an answer that did not come is its own browser's
   *  silence. `context` says why the tool was asking, for `report`. */
  const unanswered = (op: string, ms: number, context = ""): ToolResult => {
    const s = Math.round(Math.max(0, ms) / 1000);
    return refused(
      "browserSilent",
      `demoman-mcp's own browser did not answer ${op} within ${s} s — it may be frozen, or still starting.${context}`,
    );
  };

  /** What a call that has not answered by the cap says. */
  const notYet = (id: string): ToolResult =>
    ok({ outcome: "stillRunning", id });

  /** `op`'s answer within `ms`, or the reason it has none. Every tool that
   *  forwards a request goes through this or `capped`, so none can outlast
   *  the MCP client's own timeout. */
  const answered = async (
    op: string,
    request: Promise<Outcome>,
    ms = capMs,
    context = "",
  ): Promise<ToolResult> => {
    const outcome = await capped(request, ms);
    return outcome === STILL_RUNNING
      ? unanswered(op, ms, context)
      : fromOutcome(outcome);
  };

  /** A saved export's answer with its `links`, or `linksError` saying why
   *  it has none; any other answer as it came. */
  const withLinks = async (o: Outcome): Promise<Outcome> => {
    const v = o.ok ? (o.value as Record<string, unknown>) : null;
    if (options.links === undefined || v?.outcome !== "saved") return o;
    const where = (v.file ?? v.folder) as { path?: unknown } | undefined;
    if (typeof v.takeId !== "string" || typeof where?.path !== "string") {
      return o;
    }
    const links = await options.links({
      takeId: v.takeId,
      path: where.path,
      isFile: v.file !== undefined,
    });
    return {
      ok: true,
      value:
        "error" in links ? { ...v, linksError: links.error } : { ...v, links },
    };
  };

  const longCall = async (
    op: "run" | "export" | "snapshot" | "probe" | "attach",
    args: Record<string, unknown>,
    extra: Extra,
  ): Promise<ToolResult> => {
    const id = newId();
    const progress = progressSender(extra);
    const watched: Watched = { latest: undefined, settled: false, watch: null };
    // The id rides with the call, so the page that takes it can answer
    // `report` for THIS call and refuse an id it never ran.
    const call = link.request(op, { ...args, callId: id }, (value) => {
      watched.latest = value;
      progress.send(value);
      watched.watch?.(value);
    });
    const settle = () => {
      watched.settled = true;
    };
    call.then(settle, settle);
    calls.set(id, { op, call, watched });
    const outcome = await capped(call);
    if (outcome === STILL_RUNNING) {
      progress.close();
      return notYet(id);
    }
    return fromOutcome(op === "export" ? await withLinks(outcome) : outcome);
  };

  server.registerTool(
    "recipe",
    {
      annotations: TOOL_ANNOTATIONS.recipe,
      description:
        "How to record a demo with Demoman: the procedure, the DemoScript format with examples, how to read run and export reports, and what every refusal reason means. Read it before writing a script. Needs no browser.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: options.recipe }],
    }),
  );

  server.registerTool(
    "status",
    {
      annotations: TOOL_ANNOTATIONS.status,
      description: said.status,
      inputSchema: {
        // The repo whose .demoman/config.json `pullRequests` is read from:
        // a worktree names its own. CLI executor only.
        project: z.string().min(1).optional(),
      },
    },
    async ({ project }) => {
      const outcome = await capped(
        link.request("status", project === undefined ? {} : { project }),
      );
      if (outcome === STILL_RUNNING) return unanswered("status", capMs);
      if (!outcome.ok) return fromOutcome(outcome);
      // The browser is the link's to state, not the answer's: read after
      // the answer, so it describes the browser that gave it.
      const said = {
        browser: link.connected()?.browser ?? null,
        executor: "cli" as const,
        // The CLI has no extension, port or key: its version and the npm
        // check (launch B).
        version: options.version,
        update:
          options.updateCheck === undefined
            ? {
                current: options.version,
                check: "off: no update check was set up for this server",
              }
            : // An optional field: its failure is said in it, and never
              // costs the agent the browser and run fields.
              await options.updateCheck().catch((error: unknown) => ({
                current: options.version,
                check: `failed: ${error instanceof Error ? error.message : String(error)}`,
              })),
      };
      const value = outcome.value;
      return ok(
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? { ...value, ...said }
          : { extension: value, ...said },
      );
    },
  );

  server.registerTool(
    "snapshot",
    {
      annotations: TOOL_ANNOTATIONS.snapshot,
      description: said.snapshot,
      inputSchema: {
        url: z.string().min(1),
        contains: z.string().min(1).optional(),
        // Spec 2026-10-10 §3: the page as that phone or tablet sees it.
        device: z.enum(DEVICE_IDS).optional(),
        // Launch C2: the saved account to see the page as, and the project
        // folder whose .demoman/accounts.json names it.
        account: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
      },
    },
    async ({ url, contains, device, account, project }, extra) => {
      return longCall(
        "snapshot",
        {
          url,
          ...(contains === undefined ? {} : { contains }),
          ...(device === undefined ? {} : { device }),
          ...(account === undefined ? {} : { account }),
          ...(project === undefined ? {} : { project }),
        },
        extra as unknown as Extra,
      );
    },
  );

  server.registerTool(
    "probe",
    {
      annotations: TOOL_ANNOTATIONS.probe,
      description: said.probe,
      inputSchema: {
        script: z.record(z.string(), z.unknown()),
        contains: z.string().min(1).optional(),
        account: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
      },
    },
    async ({ script, contains, account, project }, extra) => {
      return longCall(
        "probe",
        {
          script,
          ...(contains === undefined ? {} : { contains }),
          ...(account === undefined ? {} : { account }),
          ...(project === undefined ? {} : { project }),
        },
        extra as unknown as Extra,
      );
    },
  );

  server.registerTool(
    "takes",
    {
      annotations: TOOL_ANNOTATIONS.takes,
      description: said.takes,
      inputSchema: {},
    },
    async () => answered("takes", link.request("takes", {})),
  );

  server.registerTool(
    "videos",
    {
      annotations: TOOL_ANNOTATIONS.videos,
      description: said.videos,
      inputSchema: {
        file: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
      },
    },
    async ({ file, query, project }) =>
      answered(
        "videos",
        link.request("videos", {
          ...(file === undefined ? {} : { file }),
          ...(query === undefined ? {} : { query }),
          ...(project === undefined ? {} : { project }),
        }),
      ),
  );

  server.registerTool(
    "derive",
    {
      annotations: TOOL_ANNOTATIONS.derive,
      description:
        "Derive a DemoScript from a recorded take. Answers the draft script and any holes to fill before it runs.",
      inputSchema: { takeId: z.string().min(1) },
    },
    async ({ takeId }) =>
      answered("derive", link.request("derive", { takeId })),
  );

  server.registerTool(
    "run",
    {
      annotations: TOOL_ANNOTATIONS.run,
      description: said.run,
      // Strict: a takeId (run's old re-record) is refused here, not dropped.
      // `video` is optional so its absence reaches the runner, which answers
      // videoRequired saying how to name one.
      inputSchema: z
        .object({
          script: z.record(z.string(), z.unknown()).optional(),
          video: z
            .union([
              z.object({ id: z.string().min(1) }).strict(),
              z
                .object({
                  new: z.string().min(1),
                  confirmedNew: z.boolean().optional(),
                })
                .strict(),
            ])
            .optional(),
          project: z.string().min(1).optional(),
        })
        .strict(),
    },
    async ({ script, video, project }, extra) => {
      return longCall(
        "run",
        {
          ...(script === undefined ? {} : { script }),
          ...(video === undefined ? {} : { video }),
          ...(project === undefined ? {} : { project }),
        },
        extra as unknown as Extra,
      );
    },
  );

  server.registerTool(
    "export",
    {
      annotations: TOOL_ANNOTATIONS.export,
      description: said.export,
      inputSchema: {
        takeId: z.string().min(1),
        fileType: z.enum(["mp4", "gif", "stills"]).optional(),
        quality: z.enum(EXPORT_QUALITY_VALUES).optional(),
        maxMB: z.number().positive().optional(),
        // The shape is advertised, not enforced: the runner validates the
        // whole object and refuses a bad width, zoom or misspelt key as
        // invalidStillsOptions, saying what it takes. A strict schema here
        // answered with a bare validation error instead, and the default
        // (stripping unknown keys) exported defaults for `widht` and
        // reported them as followed.
        stills: z
          .looseObject({
            width: z.union([z.number(), z.string()]).optional(),
            zoom: z.string().optional(),
          })
          .optional(),
      },
    },
    async ({ takeId, fileType, stills, quality, maxMB }, extra) => {
      return longCall(
        "export",
        {
          takeId,
          ...(fileType === undefined ? {} : { fileType }),
          ...(quality === undefined ? {} : { quality }),
          ...(maxMB === undefined ? {} : { maxMB }),
          ...(stills === undefined ? {} : { stills }),
        },
        extra as unknown as Extra,
      );
    },
  );

  server.registerTool(
    "attach",
    {
      annotations: TOOL_ANNOTATIONS.attach,
      description:
        'Post a take\'s video to a GitHub pull request with gh — into "description" for a PR you opened, "comment" for anyone else\'s. Exports the take first, capped at 9.5 MB, or at maxMB if given. Answers attached, or a reason; attached carries line ({text, written} or {text, notWritten}); past about 50 s {outcome: "stillRunning", id}, then call report.',
      inputSchema: {
        takeId: z.string().min(1),
        // Absent: the PR for the project's current branch.
        pr: z.number().int().positive().optional(),
        into: z.enum(["description", "comment"]),
        // Passed through to the export it runs, as export's own maxMB.
        maxMB: z.number().positive().optional(),
        // The checkout whose branch and remote gh reads: a worktree names
        // its own, so it attaches to its own branch's PR.
        project: z.string().min(1).optional(),
      },
    },
    async ({ takeId, pr, into, maxMB, project }, extra) => {
      return longCall(
        "attach",
        {
          takeId,
          into,
          ...(pr === undefined ? {} : { pr }),
          ...(maxMB === undefined ? {} : { maxMB }),
          ...(project === undefined ? {} : { project }),
        },
        extra as unknown as Extra,
      );
    },
  );

  const openStudio = options.studio;
  if (openStudio !== undefined) {
    server.registerTool(
      "studio",
      {
        annotations: TOOL_ANNOTATIONS.studio,
        description:
          'Open Demoman\'s studio, a window on this machine where the person can browse and edit the takes and export them. Offer it to the person after a run or an export; never open it unasked. Pass takeId to open that take in the editor, else the library opens. Answers {outcome: "opened", takeId?, note?}: the window is open already. A refusal carries reason and detail.',
        inputSchema: { takeId: z.string().optional() },
      },
      async ({ takeId }) => {
        const answer = await openStudio(takeId === undefined ? {} : { takeId });
        return "reason" in answer
          ? refused(answer.reason, answer.detail)
          : ok(answer);
      },
    );
  }

  server.registerTool(
    "report",
    {
      annotations: TOOL_ANNOTATIONS.report,
      description:
        'The report of a run, export, attach or snapshot this server started, by the id stillRunning or queued gave. Waits up to about 40 s; if it has not finished, answers {outcome: "queued", …} while it waits in line, then its progress so far: {outcome: "running", …} for a run, {outcome: "exporting", …} for an export, {outcome: "attaching", …} for an attach, {outcome: "stillRunning", id} for a snapshot or probe.',
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }, extra) => {
      const entry = calls.get(id);
      if (entry === undefined) {
        return refused(
          "unknownRun",
          `no run, export, attach, snapshot or probe with id ${id} was started by this demoman-mcp — ids do not survive a restart of the server`,
        );
      }
      // One deadline over both waits below (REPORT_CALL_SHARE).
      const deadline = Date.now() + capMs;
      const callMs = capMs * REPORT_CALL_SHARE;
      // The call's progress goes on reaching the person while this waits,
      // and stops before this answers (MCP forbids it after).
      const { watched } = entry;
      const watching = progressSender(extra as unknown as Extra);
      if (!watched.settled && watched.latest !== undefined) {
        watching.send(watched.latest);
      }
      watched.watch = watching.send;
      const outcome = await capped(entry.call, callMs).finally(() => {
        watched.watch = null;
        watching.close();
      });
      // A call lost with its hub (bridgeLost) or left on a silent one
      // (hubSilent) may still be going in the browser: the page knows.
      const lostCall =
        outcome !== STILL_RUNNING &&
        !outcome.ok &&
        (outcome.reason === "bridgeLost" || outcome.reason === "hubSilent");
      if (
        outcome !== STILL_RUNNING &&
        (!lostCall || entry.op === "snapshot" || entry.op === "probe")
      ) {
        return fromOutcome(
          entry.op === "export" ? await withLinks(outcome) : outcome,
        );
      }
      if (outcome === STILL_RUNNING) {
        // The page keeps no snapshot by id: this server's call is the only
        // place its answer will land.
        if (entry.op === "snapshot" || entry.op === "probe")
          return ok({ outcome: "stillRunning", id });
      }
      // Still going, or its call was lost with the socket while it carried
      // on in the page: the page that took THIS call is the one that knows.
      // The id lets it say so, and lets every other page say it does not.
      const asked =
        outcome === STILL_RUNNING
          ? `had not finished in ${Math.round(callMs / 1000)} s`
          : `lost its call (${outcome.detail})`;
      const context = ` Its page was asked because the ${entry.op} ${id} ${asked}; it may still be going in the browser — call report with this id again.`;
      const left = deadline - Date.now();
      const said = await capped(
        link.request("report", { id, of: entry.op }),
        left,
      );
      if (said === STILL_RUNNING) return unanswered("report", left, context);
      // This server's call has not answered, so the call is alive: a page
      // that never took it has not been sent it yet (a busy re-check reads
      // "started" for a moment, final review finding 2), or is between hubs.
      // reportLost would read as a lost run, and invite a second one.
      if (
        outcome === STILL_RUNNING &&
        !said.ok &&
        said.reason === "reportLost"
      ) {
        return notYet(id);
      }
      return fromOutcome(entry.op === "export" ? await withLinks(said) : said);
    },
  );
}
