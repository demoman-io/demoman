// apps/runner/src/executor/running.ts
//
// A run in flight, in the words a person reads: the step it is on and what
// that step does. The agent's terminal shows this line while the run plays
// ("Calling demoman…" in Claude Code), and `summary` repeats it for a
// polling `report`.

import { authoredTotal } from "@demoman/replay-engine";
import type {
  DemoScript,
  ScriptStep,
  ScriptTarget,
} from "@demoman/scene-schema";

/** Long enough for a button's name or a field's label, short enough for one
 *  terminal line. */
const NAME_MAX = 40;

function nameOf(target: ScriptTarget): string {
  const raw =
    "role" in target
      ? target.name
      : "text" in target
        ? target.text
        : "stableId" in target
          ? target.stableId
          : null;
  // A tree path is the resolver's grammar, not a name anyone would know.
  if (raw === null) return "an element";
  // A page's own name for it: no control or format character reaches the
  // agent's terminal line (audit run 1), as export/report.ts's `quoted`.
  const flat = raw.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return `"${flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX - 1)}…` : flat}"`;
}

/** What one step does. A `type` step never shows its text: it may be a
 *  secret's value. */
export function stepWords(step: ScriptStep): string {
  switch (step.do) {
    case "click":
      return `click ${nameOf(step.on)}`;
    case "type":
      return `type into ${nameOf(step.into)}`;
    case "hover":
      return `hover ${nameOf(step.on)}`;
    case "scrollTo":
      return `scroll to ${nameOf(step.on)}`;
    case "waitFor":
      return step.until === "visible"
        ? `wait for ${nameOf(step.on)}`
        : `wait for ${nameOf(step.on)} to go`;
    case "drag":
      return `drag ${nameOf(step.from.on)} to ${"on" in step.to ? nameOf(step.to.on) : "a point"}`;
    case "press":
      return `press ${step.key}`;
    case "waitForLoad":
      return "wait for the page to load";
    case "pause":
      return "pause";
  }
}

/**
 * Where the run is: `completed` steps done of `total`, so the step in flight
 * is the next one. The engine counts the script's steps but its pauses, and
 * the step is named only when its count agrees with the script's — a count
 * that disagrees would name the wrong step, so the line says only the number.
 */
export function runningWords(
  script: DemoScript,
  completed: number,
  total: number,
): string {
  if (completed >= total) return "finishing the video";
  const where = `step ${completed + 1} of ${total}`;
  if (total !== authoredTotal(script)) return where;
  const step = script.steps.filter((s) => s.do !== "pause")[completed];
  return step === undefined ? where : `${where} · ${stepWords(step)}`;
}
