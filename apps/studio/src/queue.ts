import { randomUUID } from "node:crypto";
import type { ExportAnswer, ExportQuality, FileType } from "@demoman/run-core";
import {
  type Exporting,
  type Library,
  LibraryError,
  type PinnedScene,
} from "@demoman/runner/studio";
import type {
  ExportStartAnswer,
  ExportStartBody,
  Refusal,
  StudioEvent,
} from "@demoman/studio-protocol";
import type { EventHub } from "./events.js";
import { messageOf } from "./files.js";

/** The spec's sentence for an export of a scene the editor has not saved. */
export const SCENE_NOT_SAVED = "The editor has changes that are not saved yet.";

/** What `start` refuses, so the route can give each its status. */
export type QueueRefusal = Refusal & {
  reason: "takeNotFound" | "sceneNotSaved" | "libraryUnreadable";
};

export interface ExportQueue {
  start(
    takeId: string,
    body: ExportStartBody,
  ): Promise<ExportStartAnswer | QueueRefusal>;
  /** Queued + running + still being admitted. */
  size(): number;
  /** Resolves once `size()` is 0 (at once when it already is). */
  drained(): Promise<void>;
  /** Runs `fn` in its turn, FIFO with exports: it waits for a running or
   *  queued export, and one queued after it waits for it. */
  serial<T>(
    fn: () => Promise<T>,
    /** Told the position the turn took, as an export's `queued` says it. */
    onQueued?: (position: number) => void,
  ): Promise<T>;
}

export type RunExport = (
  takeId: string,
  fileType: FileType,
  jobId: string,
  onProgress: (p: Exporting) => void,
  job: {
    /** Rendered in place of `scene.json`, so a later edit cannot reach it. */
    pinned: PinnedScene;
    /** The editor's pick for this export; absent, the Export quality setting. */
    quality?: ExportQuality;
  },
) => Promise<ExportAnswer>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
/** An export event's own fields: its phase and what that phase carries. */
type ExportPhase = DistributiveOmit<
  Extract<StudioEvent, { type: "export" }>,
  "type" | "takeId" | "jobId"
>;

interface Job {
  takeId: string;
  fileType: FileType;
  quality?: ExportQuality;
  jobId: string;
  pinned: PinnedScene;
}

/** A turn on the queue that is not an export (`serial`). */
interface Turn {
  turn: () => Promise<void>;
}

/** `failed`'s reason: the refusal's own, else the outcome that ended it. */
function failureOf(
  answer: Exclude<ExportAnswer, { outcome: "saved" | "exporting" }>,
): { reason: string; detail: string } {
  return {
    reason:
      answer.outcome === "refusedBeforeExport" ? answer.reason : answer.outcome,
    // The summary is the sentence the extension's and the agent's exports
    // say for this outcome, built from the refusal's detail or the error.
    detail: answer.summary,
  };
}

/**
 * The studio's exports: FIFO, one at a time in the studio's headless browser
 * (spec §6.3). `start` checks the take and its revision and queues the
 * scene it read, which is what renders however the take is edited while it
 * waits; the lease and the `outputs.json` row are `run`'s (`exportTake`),
 * so the agent door and the studio take them the same way.
 */
export function createExportQueue(o: {
  library: Library;
  events: Pick<EventHub, "send">;
  run: RunExport;
  log: (line: string) => void;
}): ExportQueue {
  const { library, events, log } = o;
  const waiting: (Job | Turn)[] = [];
  let running: Job | Turn | null = null;
  let admitting = 0;
  // Admissions run one after another, so positions follow the order the
  // requests arrived in, not the order their scene reads finished.
  let admissions: Promise<unknown> = Promise.resolve();
  const drainWaiters: (() => void)[] = [];

  const size = () => waiting.length + (running === null ? 0 : 1) + admitting;

  const settleDrain = () => {
    if (size() !== 0) return;
    for (const resolve of drainWaiters.splice(0)) resolve();
  };

  const send = (job: Job, e: ExportPhase) =>
    events.send({ ...e, type: "export", takeId: job.takeId, jobId: job.jobId });

  async function runOne(job: Job): Promise<void> {
    // A take deleted while it waited is `exportTake`'s `takeNotFound`.
    let answer: ExportAnswer;
    try {
      answer = await o.run(
        job.takeId,
        job.fileType,
        job.jobId,
        (p) => {
          send(
            job,
            p.phase === "saving"
              ? { phase: "saving" }
              : { phase: "rendering", done: p.done, total: p.total },
          );
        },
        {
          pinned: job.pinned,
          ...(job.quality === undefined ? {} : { quality: job.quality }),
        },
      );
    } catch (error) {
      // exportTake resolves for every outcome; a throw is a bug, and the
      // page still hears that this job is over.
      log(
        `studio: export ${job.jobId} of ${job.takeId} threw: ${messageOf(error)}`,
      );
      send(job, {
        phase: "failed",
        reason: "internalError",
        detail: `The export stopped with an error: ${messageOf(error)}.`,
      });
      return;
    }
    if (answer.outcome === "saved") {
      send(job, { phase: "saved", report: answer });
      return;
    }
    if (answer.outcome === "exporting") {
      // Not an end: a run that resolves with a progress report has not said
      // how it ended, and the page must not wait on it for ever.
      send(job, {
        phase: "failed",
        reason: "internalError",
        detail: "The export ended without saying how.",
      });
      return;
    }
    send(job, { phase: "failed", ...failureOf(answer) });
  }

  function pump(): void {
    if (running !== null) return;
    const next = waiting.shift();
    if (next === undefined) {
      settleDrain();
      return;
    }
    running = next;
    if ("turn" in next) {
      // A turn settles its own caller's promise and never rejects.
      void next.turn().finally(() => {
        running = null;
        pump();
      });
      return;
    }
    void runOne(next)
      .catch((error: unknown) => {
        // runOne catches everything it awaits; this is the event hub itself
        // failing, which no page can be told about.
        log(
          `studio: export ${next.jobId} could not be reported: ${messageOf(error)}`,
        );
      })
      .finally(() => {
        running = null;
        pump();
      });
  }

  async function admit(
    takeId: string,
    body: ExportStartBody,
  ): Promise<ExportStartAnswer | QueueRefusal> {
    let read: Awaited<ReturnType<Library["getSceneRead"]>>;
    try {
      read = library.isTakeId(takeId)
        ? await library.getSceneRead(takeId)
        : null;
    } catch (error) {
      if (error instanceof LibraryError) {
        return { reason: "libraryUnreadable", detail: `${error.message}.` };
      }
      throw error;
    }
    if (read === null) {
      return {
        reason: "takeNotFound",
        detail: `There is no video "${takeId}" in ${library.root}.`,
      };
    }
    if (read.revision !== body.revision) {
      return { reason: "sceneNotSaved", detail: SCENE_NOT_SAVED };
    }
    const job: Job = {
      takeId,
      fileType: body.fileType,
      ...(body.quality === undefined ? {} : { quality: body.quality }),
      jobId: randomUUID(),
      // The revision checked above is the scene rendered (DEM-100).
      pinned: { scene: read.scene, notes: read.notes },
    };
    const position = waiting.length + (running === null ? 0 : 1);
    waiting.push(job);
    send(job, { phase: "queued", position });
    return { jobId: job.jobId, position };
  }

  return {
    start(takeId, body) {
      admitting += 1;
      const answer = admissions.then(() => admit(takeId, body));
      // The chain only orders admissions: a rejected one reaches its own
      // caller through `answer`, and must not stop the next from running.
      admissions = answer.catch(() => undefined);
      return answer.finally(() => {
        admitting -= 1;
        pump();
        settleDrain();
      });
    },
    size,
    serial(fn, onQueued) {
      return new Promise((resolve, reject) => {
        onQueued?.(waiting.length + (running === null ? 0 : 1));
        // Through a promise, so a synchronous throw rejects the caller
        // and does not leave the queue's running slot held.
        waiting.push({
          turn: () => Promise.resolve().then(fn).then(resolve, reject),
        });
        pump();
      });
    },
    drained() {
      if (size() === 0) return Promise.resolve();
      return new Promise((resolve) => drainWaiters.push(resolve));
    },
  };
}
