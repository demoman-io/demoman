import type { KeepAnswer } from "@demoman/runner/package";

/** What `demoman keep` prints once it has kept the video. */
export function keepLines(answer: Extract<KeepAnswer, { ok: true }>): string[] {
  return [
    `Kept "${answer.kept.name}" in ${answer.file}`,
    ...answer.written
      .filter((p) => p !== answer.file)
      .map((p) => `  wrote ${p}`),
    ...(answer.scaleGuess === undefined ? [] : [`  ${answer.scaleGuess}`]),
    `  ${answer.screensNote}`,
    ...(answer.platformNote === undefined ? [] : [`  ${answer.platformNote}`]),
  ];
}
