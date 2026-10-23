import type { GifSink, ImageSink, VideoSink } from "./types.js";

// Test doubles only. The production surface lives in `./surface` — it was
// here beside these three until 2026-09-06, under a filename that said the
// opposite of what it was.

function guardFinished(finished: boolean): void {
  if (finished)
    throw new Error("sink already finish()ed; cannot accept more frames");
}

export function createRecordingVideoSink(): VideoSink & {
  calls: { timestampSec: number; durationSec: number }[];
} {
  const calls: { timestampSec: number; durationSec: number }[] = [];
  let finished = false;
  return {
    calls,
    addFrame: async (_canvas, timestampSec, durationSec) => {
      guardFinished(finished);
      calls.push({ timestampSec, durationSec });
    },
    finish: async () => {
      finished = true;
      return new Uint8Array();
    },
  };
}

export function createRecordingGifSink(): GifSink & {
  calls: { delayMs: number }[];
} {
  const calls: { delayMs: number }[] = [];
  let finished = false;
  return {
    calls,
    addFrame: async (_canvas, delayMs) => {
      guardFinished(finished);
      calls.push({ delayMs });
    },
    finish: async () => {
      finished = true;
      return new Uint8Array();
    },
  };
}

export function createCollectingImageSink(): ImageSink & {
  files: { name: string; bytes: Uint8Array }[];
} {
  const files: { name: string; bytes: Uint8Array }[] = [];
  let finished = false;
  return {
    files,
    add: async (_canvas, name) => {
      guardFinished(finished);
      files.push({ name, bytes: new Uint8Array() });
    },
    finish: async () => {
      finished = true;
      return files;
    },
  };
}
