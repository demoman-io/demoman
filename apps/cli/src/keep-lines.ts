import type { KeepAnswer, RemoveAnswer } from "@demoman/runner/package";

/** What `demoman add` prints once it has added the flow to the repo. */
export function keepLines(answer: Extract<KeepAnswer, { ok: true }>): string[] {
  return [
    `Added "${answer.kept.name}" to the repo: ${answer.file}`,
    ...(answer.moved === null || answer.moved === undefined
      ? []
      : [`  moved it from ${answer.moved}`]),
    ...answer.written
      .filter((p) => p !== answer.file)
      .map((p) => `  wrote ${p}`),
    ...(answer.scaleGuess === undefined ? [] : [`  ${answer.scaleGuess}`]),
    ...(answer.screensNote === undefined ? [] : [`  ${answer.screensNote}`]),
    ...(answer.markNote === undefined ? [] : [`  ${answer.markNote}`]),
    ...(answer.platformNote === undefined ? [] : [`  ${answer.platformNote}`]),
  ];
}

/** What `demoman remove` prints: what went, what stayed, or why not. */
export function removeLines(answer: RemoveAnswer): string[] {
  if (!answer.ok) return [answer.detail];
  return [
    `Removed "${answer.name}" from the repo: ${answer.removed.join(", ")}.`,
    ...(answer.exportsLeft.length > 0
      ? [`Its exports stay: ${answer.exportsLeft.join(", ")}.`]
      : []),
    "Commit the change.",
  ];
}
