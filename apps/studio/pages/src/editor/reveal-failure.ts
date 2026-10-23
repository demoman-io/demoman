/**
 * A Show in Finder (or Show in folder) press that did not show anything:
 * the line the Export panel says, and whether it was an expected outcome.
 *
 * On the studio a file moved or deleted since its export answers 404
 * `revealRefused` — the author's own doing, logged at `info`. Anything
 * else — `open -R` failing (500), a path no take lists (403), no answer at
 * all, the browser's download shelf refusing — is a fault, and goes to
 * `console.error` (CLAUDE.md, console levels).
 */
export interface RevealFailure {
  text: string;
  expected: boolean;
}

export function revealFailure(error: unknown): RevealFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const message = /[.!?]$/.test(raw) ? raw : `${raw}.`;
  const shape =
    typeof error === "object" && error !== null
      ? (error as { reason?: unknown; status?: unknown })
      : {};
  return {
    text: `Not shown: ${message}`,
    expected: shape.reason === "revealRefused" && shape.status === 404,
  };
}
