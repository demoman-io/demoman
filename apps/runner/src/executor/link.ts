// `link`: a pinned link to a video on Demoman's hosted service
// (docs/superpowers/specs/2026-11-07-hosted-links-design.md). Shaped like
// attach: export, then hand over, and say which step failed and why.
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, parse } from "node:path";
import {
  findMoov,
  type HostedReason,
  type Link,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_SECONDS,
  moovFacts,
} from "@demoman/hosted-protocol";
import type { ExportAnswer } from "@demoman/run-core";
import { HostedClient } from "../hosted/client.js";
import { type Credential, readCredential } from "../hosted/credential.js";
import { type ExportDeps, type Exporting, exportTake } from "./export.js";

export type LinkAnswer =
  | { outcome: "linked"; link: Link; export: ExportAnswer; summary: string }
  | {
      outcome: "refusedBeforeLink";
      reason: "signedOut" | "invalidLink" | "freeLimit" | "unavailable";
      detail: string;
      summary: string;
    }
  | {
      outcome: "notLinked";
      step: "upload" | "poster" | "complete" | "link";
      reason: HostedReason;
      detail: string;
      export: ExportAnswer;
      summary: string;
    }
  // An export that did not save is answered as itself.
  | ExportAnswer;

export type Linking = {
  outcome: "linking";
  phase: "checking" | "rendering" | "saving" | "uploading";
  done: number;
  total: number;
  summary: string;
};

export interface LinkDeps {
  export: ExportDeps;
  home: string;
  client?: (c: Credential) => HostedClient;
  /** Tests only: stands in for `exportTake`. */
  exportTake?: typeof exportTake;
}

const refused = (
  reason: Extract<LinkAnswer, { outcome: "refusedBeforeLink" }>["reason"],
  detail: string,
): LinkAnswer => ({
  outcome: "refusedBeforeLink",
  reason,
  detail,
  summary: `Not linked: ${detail}`,
});

const POSTER_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function linkTake(
  args: Record<string, unknown>,
  deps: LinkDeps,
  onProgress: (p: Linking) => void,
): Promise<LinkAnswer> {
  const { takeId, title, expiresAt } = args;
  if (typeof takeId !== "string" || takeId === "")
    return refused(
      "invalidLink",
      "link needs the videoId of the video to link.",
    );
  if (title !== undefined && typeof title !== "string")
    return refused("invalidLink", "title is text.");
  let expiry: string | null = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    // Checked here as the service will, so a bad date costs no render or upload.
    const at =
      typeof expiresAt === "string"
        ? new Date(expiresAt)
        : new Date(Number.NaN);
    if (Number.isNaN(at.getTime()))
      return refused(
        "invalidLink",
        `expiresAt ${JSON.stringify(expiresAt)} is not a date and time (ISO 8601, like 2026-12-01T09:00:00Z), or null for a link that does not expire.`,
      );
    if (at.getTime() <= Date.now())
      return refused(
        "invalidLink",
        `expiresAt ${at.toISOString()} has already passed.`,
      );
    expiry = at.toISOString();
  }

  // Signed out, nothing calls the service: the credential is read first.
  const cred = readCredential(deps.home);
  if (!cred.ok)
    return refused(
      "signedOut",
      `${"none" in cred ? cred.none : cred.unreadable}; run \`demoman login\` to sign in, then link again.`,
    );
  const client = (deps.client ?? ((c) => new HostedClient(c)))(cred.credential);

  onProgress({
    outcome: "linking",
    phase: "checking",
    done: 0,
    total: 0,
    summary: "Linking — checking your Demoman sign-in.",
  });
  const me = await client.me();
  if (!me.ok)
    return refused(
      me.reason === "signedOut" ? "signedOut" : "unavailable",
      me.detail,
    );
  const { active, limit } = me.value.links;
  // Checked before rendering, so nothing renders for a link that cannot be made.
  if (limit !== null && active >= limit)
    return refused(
      "freeLimit",
      `This free workspace has ${active} of ${limit} links. Delete one, or let one expire, to make another.`,
    );

  const run = deps.exportTake ?? exportTake;
  const progress = (p: Exporting) =>
    onProgress({
      outcome: "linking",
      phase: p.phase,
      done: p.done,
      total: p.total,
      summary:
        p.phase === "saving"
          ? "Linking — saving the file."
          : `Linking — rendering: frame ${p.done} of ${p.total}.`,
    });
  // The Settings quality, not "share": a link serves the full-quality
  // original, capped at what the service takes so a long take still fits.
  const video = await run(
    { takeId, maxMB: MAX_UPLOAD_BYTES / 1_000_000 },
    deps.export,
    progress,
  );
  if (video.outcome !== "saved" || !("file" in video)) return video;

  const failed = (
    step: Extract<LinkAnswer, { outcome: "notLinked" }>["step"],
    r: { reason: HostedReason; detail: string },
  ): LinkAnswer => ({
    outcome: "notLinked",
    step,
    reason: r.reason,
    detail: r.detail,
    export: video,
    summary: `Not linked: the ${step} step failed (${r.detail}). The video was exported to ${video.file.path}.`,
  });

  // What the service will check, checked here first, so nothing is sent
  // for a video it would refuse.
  const size = video.file.byteLength;
  const local = await checkLocal(video.file.path, size);
  if (local !== null) return failed("upload", local);

  // The poster: one stills render into a folder of its own, removed after,
  // so the person's export folder gains nothing they did not ask for.
  const posterDir = await mkdtemp(join(tmpdir(), "demoman-poster-"));
  let poster: Uint8Array;
  let posterType: string;
  try {
    const stills = await run(
      { takeId, fileType: "stills" },
      { ...deps.export, outDir: posterDir },
      () => {},
    );
    if (stills.outcome !== "saved" || !("folder" in stills)) return stills;
    const first = stills.folder.files?.[0]?.name;
    if (first === undefined)
      return failed("poster", {
        reason: "posterInvalid",
        detail: "the stills render made no image to use as the poster",
      });
    const type = POSTER_TYPES[extname(first).toLowerCase()];
    if (type === undefined)
      return failed("poster", {
        reason: "posterInvalid",
        detail: `the poster ${first} is not a PNG, JPEG or WebP`,
      });
    posterType = type;
    poster = new Uint8Array(await readFile(join(stills.folder.path, first)));
  } finally {
    await rm(posterDir, { recursive: true, force: true });
  }

  const created = await client.createUpload(size, poster.length);
  if (!created.ok) return failed("upload", created);
  const { id, partSize, parts } = created.value;
  const file = await open(video.file.path, "r");
  try {
    for (let n = 1; n <= parts; n++) {
      const length = Math.min(partSize, size - (n - 1) * partSize);
      const bytes = new Uint8Array(length);
      const { bytesRead } = await file.read(
        bytes,
        0,
        length,
        (n - 1) * partSize,
      );
      if (bytesRead !== length)
        return failed("upload", {
          reason: "notUploaded",
          detail: `${video.file.path} changed while it uploaded: part ${n} read ${bytesRead} of ${length} bytes`,
        });
      onProgress({
        outcome: "linking",
        phase: "uploading",
        done: n - 1,
        total: parts,
        summary: `Linking — uploading part ${n} of ${parts}.`,
      });
      const put = await client.putPart(id, n, bytes);
      if (!put.ok) return failed("upload", put);
    }
  } finally {
    await file.close();
  }
  const posted = await client.putPoster(id, poster, posterType);
  if (!posted.ok) return failed("poster", posted);
  const done = await client.complete(id);
  if (!done.ok) return failed("complete", done);
  const made = await client.createLink({
    upload: id,
    title:
      typeof title === "string" && title.trim() !== ""
        ? title
        : parse(video.file.path).name,
    expiresAt: expiry,
  });
  if (!made.ok) return failed("link", made);
  const l = made.value;
  return {
    outcome: "linked",
    link: l,
    export: video,
    summary: `Linked: ${l.pageUrl} plays it for anyone with the link; ${l.fileUrl} embeds it${l.expiresAt === null ? "" : `, until ${l.expiresAt}`}.`,
  };
}

/** The exported file as the service will judge it: its size, Demoman's tag
 *  and its length. Null when it would pass. */
async function checkLocal(
  path: string,
  size: number,
): Promise<{ reason: HostedReason; detail: string } | null> {
  const onDisk = (await stat(path)).size;
  if (onDisk !== size)
    return {
      reason: "notUploaded",
      detail: `${path} is ${onDisk} bytes, but the export said ${size}`,
    };
  if (size > MAX_UPLOAD_BYTES)
    return {
      reason: "tooLarge",
      detail: `the video is ${size} bytes; a link serves at most ${MAX_UPLOAD_BYTES}`,
    };
  const file = await open(path, "r");
  try {
    const read = async (offset: number, length: number) => {
      const bytes = new Uint8Array(
        Math.max(0, Math.min(length, size - offset)),
      );
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      return bytes.subarray(0, bytesRead);
    };
    const moov = await findMoov(read, size);
    if (moov === null)
      return {
        reason: "notMp4",
        detail: `${path} has no moov box Demoman can read`,
      };
    const facts = moovFacts(moov);
    if (!("found" in facts.tag))
      return {
        reason: "notDemoman",
        detail: `only videos Demoman exported can be linked, and ${path} carries no Demoman tag`,
      };
    if (facts.durationS !== null && facts.durationS > MAX_VIDEO_SECONDS)
      return {
        reason: "tooLong",
        detail: `the video is ${Math.round(facts.durationS)} s; a link serves at most ${MAX_VIDEO_SECONDS} s`,
      };
    return null;
  } finally {
    await file.close();
  }
}
