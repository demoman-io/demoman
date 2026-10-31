// `attach`: export a take and post its video to a GitHub pull request with
// gh (spec 2026-10-18 §4.4). Every step that can fail has a reason of its
// own, and what landed on the PR is read back rather than assumed: a failed
// upload that left the video behind is `partial`, one the PR cannot be read
// back after is "unknown", and neither is ever retried.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type CapRender,
  type ExportAnswer,
  type FilmedCode,
  fileSize,
  messageOf,
  prVerdict,
  type RunReport,
  sceneLabel,
  sentence,
} from "@demoman/run-core";
import {
  type ExportDeps,
  type Exporting,
  exportTake,
  maxBytesOf,
} from "./export.js";
import type { Gh, GhRefusal, PullRequestText } from "./gh.js";
import { normaliseRemote } from "./repo.js";

export type AttachRefusal =
  | GhRefusal["reason"]
  | "invalidAttach"
  /** `maxMB` refused the way `export` refuses it, before gh is asked. */
  | "invalidMaxMB"
  | "invalidProject"
  /** The PR was found, but its description and comments could not be read,
   *  and without them what an upload left behind could not be told. */
  | "prUnreadable";

type Into = "description" | "comment";

export type AttachAnswer =
  | {
      outcome: "attached";
      pr: { number: number; url: string };
      into: Into;
      /** The video's address on GitHub, read back from the PR. A post the
       *  read-back cannot show is `notAttached/unconfirmed`, never this. */
      assetUrl: string;
      byteLength: number;
      export: ExportAnswer;
      /** The line above the video: what the run did and which code it
       *  filmed. `notWritten` says why the video went up without it. */
      line:
        | { text: string; written: true }
        | { text: string; notWritten: string };
      summary: string;
    }
  | {
      outcome: "refusedBeforeAttach";
      reason: AttachRefusal;
      detail: string;
      summary: string;
    }
  | {
      outcome: "notAttached";
      /** uploadRefused: gh failed and the read-back shows nothing new on the
       *  PR. partial: gh failed and the video is there. unconfirmed: it is
       *  not known what landed: gh said it posted and the PR shows no new
       *  video, or the PR could not be read back (after a gh success or a
       *  gh failure alike). copyFailed: nothing was posted. */
      reason: "uploadRefused" | "partial" | "unconfirmed" | "copyFailed";
      detail: string;
      /** The video's address when the read-back found it on the PR. */
      landed: string | null;
      export: ExportAnswer;
      summary: string;
    }
  // An export that did not save is answered as itself.
  | ExportAnswer;

export type Attaching = {
  outcome: "attaching";
  phase: "checking" | "rendering" | "saving" | "posting";
  done: number;
  total: number;
  /** A capped export's render this is, as the export's own progress says
   *  (`Exporting.pass`): each one counts its frames from 0 again. */
  pass?: CapRender;
  summary: string;
};

export interface AttachDeps {
  /** gh, run in the project folder. */
  gh: Gh;
  /** The export's own deps: the same path `export` takes. */
  export: ExportDeps;
  log: (line: string) => void;
  /** Where the plain-named copy is made; `os.tmpdir()` when absent. */
  tmpDir?: string;
  /** git, run in the project, to read the PR head's tree. Absent: the line
   *  says the code was not checked against the PR. */
  git?: (
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/** What a person can do when gh cannot be used, or the video cannot be
 *  copied to post: a capped export, whose file a drag-in takes. */
const BY_HAND =
  "To attach it by hand, export({ takeId, maxMB: 9.5 }) and give the user that file.path to drag into the PR; the browser refuses video over 10 MB on a free plan.";

/** The hosts of the checkout's remotes when none of them can be GitHub;
 *  null when one may be, there are none, or git cannot say (logged). Any
 *  host naming github, or with no dot, may be: gh resolves ssh aliases
 *  (`github.com-work`) and ssh.github.com, and this cannot. Null keeps gh's
 *  own refusal, which still says why attach cannot go on. */
async function remotesElsewhere(
  git: AttachDeps["git"],
  log: (line: string) => void,
): Promise<string[] | null> {
  if (git === undefined) return null;
  const r = await git(["remote", "-v"]).catch((error: unknown) => ({
    code: -1,
    stdout: "",
    stderr: messageOf(error),
  }));
  if (r.code !== 0) {
    log(
      `attach: could not read the remotes (${r.stderr.trim() || `exit ${r.code}`}); gh's refusal stands`,
    );
    return null;
  }
  const hosts = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const url = line.split(/\s+/)[1];
    if (url === undefined || url === "") continue;
    hosts.add(normaliseRemote(url).split(/[/:]/)[0] ?? "");
  }
  if (hosts.size === 0) return null;
  for (const h of hosts)
    if (h.includes("github") || !h.includes(".")) return null;
  return [...hosts];
}

/** The cap an attach exports at unless told otherwise, and a retry after a
 *  refused upload asks for: under the 10 MB a browser takes on a free plan
 *  (the author, 2026-10-29: "We should adhere to the browser limit even if
 *  `gh` has a higher tolerance"). */
const ATTACH_MAX_MB = 9.5;

/** What to do when GitHub refused the upload. A file this attach saved
 *  uncapped, or under a looser cap, may be over what GitHub takes, so one
 *  capped attach first, then by hand. One already capped at 9.5 MB or less
 *  would only be refused again: the file goes by hand now. */
function afterRefusedUpload(
  maxMB: number | undefined,
  path: string,
  size: string,
): string {
  if (maxMB !== undefined && maxMB <= ATTACH_MAX_MB) {
    return `This attach was already capped at ${maxMB} MB, so do not call attach again: give the user ${path} (${size}) to drag into the PR; a browser refuses video over 10 MB on a free plan.`;
  }
  return `Call attach again with maxMB: ${ATTACH_MAX_MB}, once; if GitHub refuses again, give the user the file to drag into the PR (a browser refuses video over 10 MB on a free plan).`;
}

/** What an attached video's summary adds when its export missed the cap it
 *  was given (posted, but not at the size asked for), or met it only by
 *  going below the share look (spec 2026-10-29 §3.3). Empty when there was
 *  no cap, or the file met it at the share look. */
export function capMissed(exported: ExportAnswer): string {
  if (exported.outcome !== "saved") return "";
  const cap = exported.warnings.videoSize?.cap;
  if (cap === undefined) return "";
  // The cap as it was asked for, as the export's own summary says it.
  const max = `${cap.maxBytes / 1_000_000} MB`;
  if (cap.met && cap.failed === undefined) {
    return cap.belowFloor ? `, softer than usual to fit in ${max}` : "";
  }
  if (cap.failed !== undefined) {
    return `, but it is over the ${max} asked for: lowering it further failed (${cap.failed.error.trim().replace(/[.!?]+$/, "")})`;
  }
  // As the export's own summary says it (`videoCapClause`).
  return cap.belowFloor
    ? `, but it is over the ${max} asked for even after softening it`
    : `, but it is over the ${max} asked for even at the smallest it goes`;
}

/** `copyFailed`'s detail. The saved file can be over 10 MB, so it is not the
 *  one to hand over: the capped export is. */
export const copyFailedDetail = (
  saved: string,
  posted: string,
  why: string,
): string =>
  `the video is saved at ${saved}, but it could not be copied to ${posted} to post (${why}); nothing was posted. ${BY_HAND}`;

const ASSET_URL =
  /https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[A-Za-z0-9._~/-]+/g;

// Named `refuse` so the recipe test's reason scan finds every reason it is
// handed (apps/mcp/test/recipe.test.ts, REASON).
function refuse(reason: AttachRefusal, detail: string): AttachAnswer {
  return {
    outcome: "refusedBeforeAttach",
    reason,
    detail,
    summary: `Not attached: ${sentence(detail)}`,
  };
}

/** What an attach that threw answers: a bug, said as one. It may have
 *  posted before it threw, so the PR is the place to look. */
export function attachThrew(error: string): {
  outcome: "threw";
  error: string;
  summary: string;
} {
  return {
    outcome: "threw",
    error,
    summary: `The attach failed unexpectedly rather than reporting a result: ${sentence(error)} Check the log for its stack, and look at the PR before posting again.`,
  };
}

/** A refusal for a `project` the executor could not use. */
export function attachProjectRefused(detail: string): AttachAnswer {
  return refuse("invalidProject", detail);
}

/** gh's own words, on one line and short enough to quote. */
function quoted(stderr: string, stdout: string, code: number): string {
  const said = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ");
  return said === "" ? `exit ${code}, no message` : said.slice(0, 400);
}

const assetsIn = (text: string): string[] => text.match(ASSET_URL) ?? [];

/** Every video address on the PR now that was not on it before. */
function newAssets(before: PullRequestText, after: PullRequestText): string[] {
  const seen = new Set([
    ...assetsIn(before.body),
    ...before.comments.flatMap((c) => assetsIn(c.body)),
  ]);
  const fresh = [
    ...assetsIn(after.body),
    ...after.comments
      .filter(
        (c) =>
          !before.comments.some(
            (b) => b.body === c.body && b.createdAt === c.createdAt,
          ),
      )
      .flatMap((c) => assetsIn(c.body)),
  ];
  return [...new Set(fresh.filter((u) => !seen.has(u)))];
}

/** `<base>.mp4` with every character outside `[A-Za-z0-9._-]` made `-`. */
export function plainName(path: string): string {
  const base = basename(path).replace(/\.mp4$/i, "");
  const plain = base.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${plain === "" ? "demo" : plain}.mp4`;
}

function args(raw: Record<string, unknown>):
  | {
      takeId: string;
      into: Into;
      pr: number | undefined;
      maxMB: number | undefined;
    }
  | AttachAnswer {
  const bad = (detail: string) => refuse("invalidAttach", detail);
  // An argument the export would ignore reads as one that was followed.
  for (const key of ["fileType", "stills", "quality"]) {
    if (raw[key] !== undefined) {
      return bad(
        `attach exports a share-sized MP4 (maxMB caps it) and takes no ${key}`,
      );
    }
  }
  // Checked the way export checks it, and before gh is asked: a cap the
  // export would refuse must not cost a PR read or a render first.
  const maxBytes = maxBytesOf(raw.maxMB, "mp4");
  if (maxBytes !== null && typeof maxBytes === "object") {
    return refuse("invalidMaxMB", maxBytes.refusal);
  }
  const takeId = typeof raw.takeId === "string" ? raw.takeId.trim() : "";
  if (takeId === "") {
    return bad(
      `takeId must name a take; got ${JSON.stringify(raw.takeId) ?? "nothing"}`,
    );
  }
  if (raw.into !== "description" && raw.into !== "comment") {
    return bad(
      `into must be "description" (a PR you opened) or "comment" (anyone else's); got ${JSON.stringify(raw.into) ?? "nothing"}`,
    );
  }
  const pr = raw.pr;
  if (
    pr !== undefined &&
    !(typeof pr === "number" && Number.isInteger(pr) && pr > 0)
  ) {
    return bad(
      `pr must be a pull request's number, or left out for the current branch's; got ${JSON.stringify(pr)}`,
    );
  }
  return {
    takeId,
    into: raw.into,
    pr: pr as number | undefined,
    maxMB: (raw.maxMB as number | undefined) ?? ATTACH_MAX_MB,
  };
}

/**
 * Validates, checks gh and the PR, reads the PR, exports, copies the file to
 * a plain name, posts it, and reads the PR back to say what landed.
 * Resolves for every outcome; rejects only on a bug.
 */
export async function attachTake(
  raw: Record<string, unknown>,
  deps: AttachDeps,
  onProgress: (progress: Attaching) => void,
): Promise<AttachAnswer> {
  const a = args(raw);
  if ("outcome" in a) return a;
  const { gh, log } = deps;
  onProgress({
    outcome: "attaching",
    phase: "checking",
    done: 0,
    total: 0,
    summary: "Attaching — checking gh and the pull request.",
  });

  const notReady = await gh.ready();
  if (notReady !== null) {
    // A checkout whose remotes are all elsewhere is notGitHub: fixing gh
    // would not make attach work there, so its fix is not the one named.
    const elsewhere = await remotesElsewhere(deps.git, log);
    if (elsewhere !== null) {
      return refuse(
        "notGitHub",
        `this checkout's remotes are on ${elsewhere.join(", ")}, not github.com, and video attachments work only there. ${BY_HAND}`,
      );
    }
    return refuse(notReady.reason, `${notReady.detail} ${BY_HAND}`);
  }
  // A GitHub that does not answer leaves the video to go by hand; a PR that
  // is not there yet is the agent's to open.
  const pr = await gh.pr(a.pr);
  if ("reason" in pr) {
    return refuse(
      pr.reason,
      pr.reason === "prNotFound"
        ? `${pr.detail} If there is no pull request yet, open it and attach again; otherwise: ${BY_HAND}`
        : `${pr.detail} ${BY_HAND}`,
    );
  }
  // The baseline the read-back after posting is compared against. Taken
  // before the export, so a PR that cannot be read costs no render.
  const before = await gh.readBack(pr.number);
  if ("unreadable" in before) {
    return refuse(
      "prUnreadable",
      `pull request ${pr.url} could not be read (${before.unreadable}); attach reads it before posting so it can tell afterwards what landed. Nothing was exported or posted. ${BY_HAND}`,
    );
  }

  const exported = await exportTake(
    {
      takeId: a.takeId,
      // GitHub's own size, whatever the default for other exports is.
      quality: "share",
      ...(a.maxMB === undefined ? {} : { maxMB: a.maxMB }),
    },
    deps.export,
    (p: Exporting) =>
      onProgress({
        outcome: "attaching",
        phase: p.phase,
        done: p.done,
        total: p.total,
        ...(p.pass === undefined ? {} : { pass: p.pass }),
        summary:
          p.phase === "saving"
            ? "Attaching — saving the file."
            : p.total === 0
              ? "Attaching — preparing the render."
              : p.pass !== undefined
                ? `Attaching — render ${p.pass.render} of up to ${p.pass.upTo} to fit the size asked for: frame ${p.done} of ${p.total}.`
                : `Attaching — rendering frame ${p.done} of ${p.total}.`,
      }),
  );
  if (exported.outcome !== "saved") return exported;
  // Unreachable while only takeId and maxMB are passed on, and
  // success-shaped if it ever were: a folder of stills saved and nothing
  // posted.
  if (exported.fileType !== "mp4") {
    return refuse(
      "invalidAttach",
      `attach posts an MP4, and the export made ${exported.fileType === "stills" ? "a folder of stills" : "a GIF"} instead; nothing was posted`,
    );
  }
  const { file } = exported;
  const label = await labelOf(a.takeId, deps, file.path);

  const into = a.into;
  const folder = join(
    deps.tmpDir ?? tmpdir(),
    `demoman-attach-${randomUUID()}`,
  );
  const posted = join(folder, plainName(file.path));
  try {
    try {
      await mkdir(folder, { recursive: true });
      await copyFile(file.path, posted);
    } catch (error) {
      const detail = copyFailedDetail(file.path, posted, messageOf(error));
      return {
        outcome: "notAttached",
        reason: "copyFailed",
        detail,
        landed: null,
        export: exported,
        summary: `Not attached: ${sentence(detail)}`,
      };
    }
    onProgress({
      outcome: "attaching",
      phase: "posting",
      done: 0,
      total: 0,
      summary: `Attaching — posting the video to ${pr.url}.`,
    });
    const command =
      into === "description"
        ? `gh pr edit ${pr.number} --attach`
        : `gh pr comment ${pr.number} --attach`;
    const line = await lineFor(a.takeId, label, pr.head, deps);
    const block =
      line.details === null ? line.line : `${line.line}\n\n${line.details}`;
    const r =
      into === "description"
        ? await gh.attachToDescription(pr.number, posted)
        : await gh.attachToComment(pr.number, posted, block);
    // Read back whatever gh answered: on success it says where the video
    // is, on failure what (if anything) landed.
    const after = await gh.readBack(pr.number);
    const size = fileSize(file.byteLength);
    const where =
      into === "description"
        ? `the description of ${pr.url}`
        : `a comment on ${pr.url}`;
    const fresh = "unreadable" in after ? [] : newAssets(before, after);
    if (r.code === 0) {
      const assetUrl = fresh.at(-1);
      if (assetUrl !== undefined) {
        // Read back, not assumed: the comment holding the video holds the
        // line too, or the description gets it in a second edit.
        let said: Extract<AttachAnswer, { outcome: "attached" }>["line"];
        if (into === "description") {
          said = {
            text: line.line,
            ...(await writeLine(
              pr.number,
              "unreadable" in after ? "" : after.body,
              assetUrl,
              block,
              line.line,
              join(folder, "body.md"),
              gh,
            )),
          };
        } else {
          const holder =
            "unreadable" in after
              ? undefined
              : after.comments.find((c) => c.body.includes(assetUrl));
          said =
            holder?.body.includes(line.line) === true
              ? { text: line.line, written: true }
              : {
                  text: line.line,
                  notWritten:
                    "the comment holding the video read back without its line",
                };
        }
        return {
          outcome: "attached",
          pr: { number: pr.number, url: pr.url },
          into,
          assetUrl,
          byteLength: file.byteLength,
          export: exported,
          line: said,
          summary:
            "written" in said
              ? `Attached the video (${size}) to ${where}${capMissed(exported)}.`
              : `Attached the video (${size}) to ${where}${capMissed(exported)}, but the line above it was not written: ${said.notWritten}.`,
        };
      }
      const why =
        "unreadable" in after
          ? `the PR could not be read back afterwards (${after.unreadable})`
          : "the PR read back with no new video on it";
      const detail = `${command} exited 0 and gh reported success, but ${why}, so look at ${pr.url} before posting again. Nothing was retried.`;
      return {
        outcome: "notAttached",
        reason: "unconfirmed",
        detail,
        landed: null,
        export: exported,
        summary: `Not confirmed: gh says it posted the video (${size}) to ${where}, but ${why}. Look at the PR before posting again.`,
      };
    }
    const ghSaid = `${command} exited ${r.code}: "${quoted(r.stderr, r.stdout, r.code)}"`;
    if ("unreadable" in after) {
      const detail = `${ghSaid}. The PR could not be read back afterwards (${after.unreadable}), so it is unknown whether anything was posted: look at ${pr.url} before posting again. Nothing was retried.`;
      return {
        outcome: "notAttached",
        reason: "unconfirmed",
        detail,
        landed: null,
        export: exported,
        summary: `Not confirmed: ${sentence(detail)}`,
      };
    }
    const landed = fresh.at(-1);
    if (landed !== undefined) {
      const detail = `${ghSaid}, but the PR read back with the video on it: ${landed}. Do not post it again.`;
      return {
        outcome: "notAttached",
        reason: "partial",
        detail,
        landed,
        export: exported,
        summary: `The video is on ${pr.url} (${landed}), but gh reported a failure: check the PR, and do not post it again.`,
      };
    }
    const detail = `${ghSaid}. The PR read back with no new video on it, so nothing landed; nothing was retried. The video is saved at ${file.path}. ${afterRefusedUpload(a.maxMB, file.path, size)}`;
    return {
      outcome: "notAttached",
      reason: "uploadRefused",
      detail,
      landed: null,
      export: exported,
      summary: `Not attached: ${sentence(detail)}`,
    };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(
      (error: unknown) => {
        log(
          `attach: the copy posted from ${folder} would not be removed (${messageOf(error)})`,
        );
      },
    );
  }
}

/** Longest label the comment carries, in characters, before the ellipsis. */
const LABEL_MAX = 120;

/** The comment's text. The label comes from a filmed page's title, which a
 *  third-party site controls, and the comment is posted under the user's
 *  account. GitHub renders markdown, HTML and entities in a comment, so a
 *  bare title could post a link, an image beacon, formatting, or `&#64;name`
 *  (which reads as a mention). Inside an inline code span all of that is
 *  shown literally, so the label goes in one: backticks are removed (they
 *  would close the span), whitespace collapses to one line, the length is
 *  capped, and `@` is still stripped as defence in depth. */
export function commentBody(label: string): string {
  const one = label.replace(/[`@]/g, "").replace(/\s+/g, " ").trim();
  if (one === "") return "Demo";
  const chars = Array.from(one);
  const cut =
    chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX).join("")}…` : one;
  return `Demo: \`${cut}\``;
}

/** Paragraph breaks: a blank line, CRLF or not, kept as written. */
const PARAGRAPHS = /(\r?\n[ \t]*\r?\n)/;

/**
 * `body` with `block` as its own paragraph directly above the paragraph
 * that is the asset alone: its URL bare, or in the image or video markup
 * GitHub writes around one. Null when no paragraph is, so a body whose video
 * sits inside other text is never rewritten around it.
 */
export function insertAbove(
  body: string,
  assetUrl: string,
  block: string,
): string | null {
  const parts = body.split(PARAGRAPHS);
  const url = assetUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alone = new RegExp(
    `^(?:${url}|!\\[[^\\]\\n]*\\]\\(${url}\\)|<(?:video|img)\\b[^>]*\\bsrc="${url}"[^>]*>(?:\\s*</video>)?)$`,
  );
  // Paragraphs are the even entries; the odd ones are their separators.
  const at = parts.findIndex((p, i) => i % 2 === 0 && alone.test(p.trim()));
  if (at < 0) return null;
  const sep = body.includes("\r\n") ? "\r\n\r\n" : "\n\n";
  return `${parts.slice(0, at).join("")}${block}${sep}${parts.slice(at).join("")}`;
}

/**
 * The description's line, written with a second `gh pr edit --body-file`
 * over the body as just read back. A PR author editing the description in
 * the seconds between that read and this write loses their edit; accepted
 * (spec 2026-10-25, "Posting it"). Written only when the read-back holds
 * both the line and the video.
 */
async function writeLine(
  n: number,
  body: string,
  assetUrl: string,
  block: string,
  line: string,
  bodyFile: string,
  gh: Gh,
): Promise<{ written: true } | { notWritten: string }> {
  const next = insertAbove(body, assetUrl, block);
  if (next === null) {
    return {
      notWritten:
        "the video is not in a paragraph of its own in the description, so nothing was put above it",
    };
  }
  try {
    await writeFile(bodyFile, next);
  } catch (error) {
    return {
      notWritten: `the description could not be written to ${bodyFile} (${messageOf(error)})`,
    };
  }
  const r = await gh.setBody(n, bodyFile);
  if (r.code !== 0) {
    return {
      notWritten: `gh pr edit ${n} --body-file exited ${r.code}: "${quoted(r.stderr, r.stdout, r.code)}"`,
    };
  }
  const back = await gh.readBack(n);
  if ("unreadable" in back) {
    return {
      notWritten: `the description could not be read back after the line was written (${back.unreadable}): look at the PR`,
    };
  }
  if (!back.body.includes(assetUrl)) {
    return {
      notWritten: "the video is no longer in the description: look at the PR",
    };
  }
  // Counted, not found: a re-attach of the same take writes the same line,
  // and the first one's copy must not stand in for it.
  const copies = (text: string) => text.split(line).length - 1;
  if (copies(back.body) <= copies(body)) {
    return { notWritten: "the description read back without the line" };
  }
  return { written: true };
}

/** Longest run notes the collapsed block carries, in characters. */
const DETAILS_MAX = 1000;

/** `short` as the line shows a sha: seven characters, in code. */
const short = (sha: string) => `\`${sha.slice(0, 7)}\``;

/**
 * Which code the video shows, against the PR's head. The tree was recorded
 * at run time (`readFilmedCode`); comparing trees can wrongly say
 * "differs" (an ignored file changed) and never wrongly "same".
 */
export function codeClause(
  filmed: FilmedCode | undefined,
  head: string | null,
  headTree: string | null,
): string {
  if (filmed === undefined) return "commit not recorded";
  if ("none" in filmed) return "commit unknown";
  if (head !== null && headTree !== null && filmed.tree === headTree)
    return `filmed at ${short(head)}`;
  if (filmed.commit === null)
    return "filmed from uncommitted changes before the first commit";
  if (head === null || headTree === null)
    return `filmed at ${short(filmed.commit)}${filmed.dirty ? " with uncommitted changes" : ""}, not checked against the PR`;
  if (filmed.dirty)
    return `filmed from uncommitted changes on ${short(filmed.commit)}`;
  return `filmed at ${short(filmed.commit)}, not the PR's head ${short(head)}`;
}

/**
 * The line above the video, and the run's notes in a collapsed block when
 * it has any. The label is neutralised as `commentBody` does; the notes come
 * from a filmed page too, so they lose backticks (which would close the
 * fence) and `@`, and are capped.
 */
export function prLine(
  label: string,
  verdict: { clause: string; details: string | null } | { none: string },
  code: string,
): { line: string; details: string | null } {
  const clause = "none" in verdict ? verdict.none : verdict.clause;
  const line = `${commentBody(label)} · ${clause} · ${code}`;
  if ("none" in verdict || verdict.details === null)
    return { line, details: null };
  const chars = Array.from(verdict.details.replace(/[`@]/g, ""));
  const text =
    chars.length > DETAILS_MAX
      ? `${chars.slice(0, DETAILS_MAX).join("")}…`
      : chars.join("");
  return {
    line,
    details: `<details><summary>Run notes</summary>\n\n\`\`\`\n${text}\n\`\`\`\n</details>`,
  };
}

const UNREADABLE_REPORT = "run report unreadable, so no verdict";

/** The line for this take on this PR, from the stored report (never
 *  recomputed) and the PR head's tree. Every read that fails is said on the
 *  line rather than reading clean. */
export async function lineFor(
  takeId: string,
  label: string,
  head: string | null,
  deps: AttachDeps,
): Promise<{ line: string; details: string | null }> {
  const one = (text: string) =>
    text.replace(/[`@]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  let verdict: Parameters<typeof prLine>[1] = { none: UNREADABLE_REPORT };
  let filmed: FilmedCode | undefined;
  // Each failure keeps its own reason in the log; the line, posted under the
  // user's account, says only that the report could not be used.
  const read = await deps.export.library
    .getJson(takeId, "report.json")
    .catch((error: unknown) => ({ threw: messageOf(error) }));
  if ("threw" in read) {
    deps.log(
      `attach: take ${takeId}'s report.json could not be read (${read.threw})`,
    );
  } else if ("missing" in read) {
    verdict = { none: "no run report on disk, so no verdict" };
  } else if ("unreadable" in read) {
    // It names a local path.
    deps.log(`attach: take ${takeId}'s ${read.unreadable}`);
  } else {
    try {
      const report = read.value as RunReport;
      verdict = prVerdict(report);
      filmed = report.filmedCode;
    } catch (error) {
      // JSON, but not the shape prVerdict reads (an older or damaged report).
      deps.log(
        `attach: take ${takeId}'s report.json is not a run report (${messageOf(error)})`,
      );
    }
  }
  let headTree: string | null = null;
  if (head !== null && deps.git !== undefined) {
    try {
      const r = await deps.git(["rev-parse", `${head}^{tree}`]);
      if (r.code === 0) headTree = r.stdout.trim();
      else
        deps.log(
          `attach: the PR head ${head} is not in this checkout (${one(r.stderr)}); the line says the code was not checked`,
        );
    } catch (error) {
      deps.log(
        `attach: git could not read the PR head's tree (${messageOf(error)})`,
      );
    }
  }
  return prLine(label, verdict, codeClause(filmed, head, headTree));
}

/** The take's label for the comment's one line. The export just read the
 *  scene, so a failure here is rare; it is logged, and the file's own name
 *  stands in. */
async function labelOf(
  takeId: string,
  deps: AttachDeps,
  path: string,
): Promise<string> {
  try {
    const scene = await deps.export.library.getScene(takeId);
    if (scene !== null) return sceneLabel(scene.meta);
    deps.log(`attach: take ${takeId}'s scene is gone; labelled by its file`);
  } catch (error) {
    deps.log(
      `attach: take ${takeId}'s scene could not be read for its label (${messageOf(error)}); labelled by its file`,
    );
  }
  return basename(path).replace(/\.mp4$/i, "");
}
