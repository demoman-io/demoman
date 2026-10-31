// packages/run-core/src/served-words.ts
//
// The words an agent is served (spec 2026-10-30 flows-and-bulk-delete §2): a
// flow is what is filmed, a video one recording of it. The library stores
// the older words (a "video" record holding "take" folders) and keeps them;
// this is the one place an answer is put into the new words on its way out.
import type { RunReport } from "./replay/report.js";

/** Refusal reasons in the new words (spec §2.2). Two keep a name that meant
 *  something else before: `videoNotFound` and `videoUnreadable` were a
 *  flow's and are now a video's. */
export const SERVED_REASON: Readonly<Record<string, string>> = {
  videoRequired: "flowRequired",
  videoNotFound: "flowNotFound",
  videoUnreadable: "flowUnreadable",
  videoUnwritable: "flowUnwritable",
  videoNameInvalid: "flowNameInvalid",
  unknownVideo: "unknownFlow",
  versionExpired: "videoExpired",
  takeNotFound: "videoNotFound",
  takeUnreadable: "videoUnreadable",
  takeBusy: "videoBusy",
  noTakeId: "noVideoId",
};

/** A flow's id is a `randomUUID()` (the library's `videos/<id>.json`); a
 *  video's is its folder's name. Anything else names no flow and is never
 *  joined into a path: `../x` would read outside `videos/`. */
export const isFlowId = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** One lookup, never two: `takeNotFound` is `videoNotFound`, not then
 *  `flowNotFound`. A reason not in the table is served as it is. */
export const servedReason = (reason: string): string =>
  SERVED_REASON[reason] ?? reason;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `o` with key `from` renamed `to`, in place in its order; `o` itself
 *  untouched. A key that is absent stays absent. */
function renamed(o: Json, from: string, to: string): Json {
  if (!(from in o)) return o;
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k === from ? to : k, v]),
  );
}

const NOT_STORED: Record<string, string> = { take: "video", video: "flow" };

/** A run report — stored in `report.json` in the old words — as an agent
 *  and a kept repo file read it (spec §2.1). */
export function servedRunReport(r: RunReport): Json {
  let out: Json = { ...(r as unknown as Json) };
  if (isObj(out.provenance)) {
    out.provenance = renamed(out.provenance, "takeId", "videoId");
  }
  if (isObj(out.run) && isObj(out.run.script)) {
    out.run = {
      ...out.run,
      script: renamed(out.run.script, "takeId", "videoId"),
    };
  }
  const v = out.videoVersion;
  out = renamed(out, "videoVersion", "flow");
  if (isObj(v)) {
    const { version, ...rest } = v;
    out.flow = {
      ...rest,
      ...(version === undefined ? {} : { video: version }),
    };
  } else if ("flow" in out && out.flow === undefined) {
    delete out.flow;
  }
  for (const key of ["stopped", "refused"]) {
    const s = out[key];
    if (isObj(s) && typeof s.reason === "string") {
      out[key] = { ...s, reason: servedReason(s.reason) };
    }
  }
  if (Array.isArray(out.notStored)) {
    out.notStored = out.notStored.map((n: Json) => ({
      ...n,
      what: NOT_STORED[n.what as string] ?? n.what,
    }));
  }
  if (isObj(out.recording)) {
    out.recording = renamed(
      out.recording,
      "recordingTakeId",
      "recordingVideoId",
    );
  }
  if (isObj(out.video) && out.video.unavailable === "noTake") {
    out.video = { ...out.video, unavailable: "noVideo" };
  }
  return out;
}

/** An export's or an attach's answer in the new words. */
export function servedExportReport(r: Json): Json {
  let out = renamed(r, "takeId", "videoId");
  if (isObj(out.warnings)) {
    out = { ...out, warnings: renamed(out.warnings, "videoId", "flowId") };
  }
  if (typeof out.reason === "string") {
    out = { ...out, reason: servedReason(out.reason) };
  }
  // An attach answer carries its whole export report.
  if (isObj(out.export)) {
    out = { ...out, export: servedExportReport(out.export) };
  }
  return out;
}

/** One flow's summary — a `flows` answer's row, a duplicate's match. */
export const servedFlowSummary = (f: Json): Json => {
  let out = renamed(f, "versions", "videos");
  if (isObj(out.current)) {
    out = {
      ...out,
      current: renamed(
        renamed(out.current, "version", "number"),
        "takeId",
        "videoId",
      ),
    };
  }
  if (Array.isArray(out.exports)) {
    out = {
      ...out,
      exports: out.exports.map((e: Json) => renamed(e, "takeId", "videoId")),
    };
  }
  return out;
};

/** The `videos` op's answer as the `flows` tool serves it: its list is of
 *  flows, each counting its videos. */
export function servedFlowsAnswer(a: Json): Json {
  let out = renamed(a, "videos", "flows");
  if (Array.isArray(out.flows)) {
    out = {
      ...out,
      flows: out.flows.map((f: unknown) =>
        isObj(f) ? servedFlowSummary(f) : f,
      ),
    };
  }
  if (Array.isArray(out.outsideFlows)) {
    out = {
      ...out,
      outsideFlows: out.outsideFlows.map((t: unknown) =>
        isObj(t) ? renamed(t, "takeId", "videoId") : t,
      ),
    };
  }
  if (isObj(out.file)) {
    out = {
      ...out,
      file: renamed(
        renamed(renamed(out.file, "takeId", "videoId"), "version", "number"),
        "notInVideo",
        "notInFlow",
      ),
    };
  }
  return out;
}

const REFUSED_FIELD: Record<string, string> = {
  video: "flow",
  takeId: "videoId",
};

/** A run or probe refused before it ran (`refusedBeforeRun`): its reason,
 *  the argument it names, and any flows it matched, in the new words. */
export function servedRefusal(r: Json): Json {
  const out: Json = { ...r };
  if (typeof out.reason === "string") out.reason = servedReason(out.reason);
  if (typeof out.field === "string") {
    out.field = REFUSED_FIELD[out.field] ?? out.field;
  }
  if (Array.isArray(out.matches)) {
    out.matches = out.matches.map((m: unknown) =>
      isObj(m) ? servedFlowSummary(m) : m,
    );
  }
  if (isObj(out.holder)) out.holder = servedFlowSummary(out.holder);
  return out;
}
