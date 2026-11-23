// The frame rate a repo's held recordings capture the page at: the user's
// `settings.json` and a repo's `.demoman/config.json` hold one, `status`
// reports it. One list, so every reader checks the same choices.

export const RECORDING_FRAME_RATE_VALUES = [30, 60] as const;
export type RecordingFrameRate = (typeof RECORDING_FRAME_RATE_VALUES)[number];

/** With nothing set in the repo or the user's settings. */
export const RECORDING_FRAME_RATE_DEFAULT: RecordingFrameRate = 30;

export const isRecordingFrameRate = (v: unknown): v is RecordingFrameRate =>
  (RECORDING_FRAME_RATE_VALUES as readonly unknown[]).includes(v);

/** One frame's length in milliseconds. */
export const frameMsOf = (rate: RecordingFrameRate): number => 1000 / rate;
