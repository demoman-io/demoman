// apps/runner/src/executor/dates-on-screen.ts
//
// Whether a page showed dates that may follow today (DEM-79): the evidence
// refresh needs before it says a replaced video's dates may be why. Small on
// purpose: a miss costs only the note, and a false hit would put the note on
// a video whose dates are not the cause.

// Whole names or their abbreviations only: "Market 4" is not a date.
const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const UNIT =
  "(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|[smhdwy])";
const DATE = new RegExp(
  [
    `\\b${MONTH} \\d{1,2}(?:, \\d{4})?\\b`, // Dec 4, 2026 · Oct 31
    `\\b\\d{1,2} ${MONTH} \\d{4}\\b`, // 4 December 2026
    "\\b\\d{4}-\\d{2}-\\d{2}\\b", // 2026-12-04
    "\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b", // 12/4/2026
    `\\b\\d+ ?${UNIT} ago\\b`, // 3 days ago · 45m ago
    `\\bin \\d+ ?${UNIT}\\b`, // in 5 minutes
    "\\b(?:yesterday|tomorrow|just now)\\b",
  ].join("|"),
  "gi",
);

/** Up to 3 distinct date-looking strings in the text, in order of appearance. */
export function datesIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(DATE)) {
    if (!found.includes(m[0])) found.push(m[0]);
    if (found.length === 3) break;
  }
  return found;
}
