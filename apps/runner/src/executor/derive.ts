import type { Outcome } from "@demoman/agent-bridge";
import { mergeSkeleton } from "@demoman/run-core";
import { scriptFromTake } from "@demoman/scene-schema";
import { messageOf } from "../report.js";
import type { Library } from "./library.js";

/**
 * The `derive` op, in the run page's shape (`run/view.ts` `deriveFromTake`,
 * `from-take.ts`): `{ report, script }`, the script only when derived. The
 * hole paths are handed back so the executor can answer a later run's
 * refused field as `unfilledHoles`, as the page does.
 */
export async function deriveOp(
  library: Library,
  args: Record<string, unknown>,
): Promise<{ outcome: Outcome; holePaths: string[] | null }> {
  const takeId = typeof args.takeId === "string" ? args.takeId.trim() : "";
  let doc: Awaited<ReturnType<Library["getScene"]>>;
  try {
    // An id that cannot name a folder under takes/ names no take, as
    // `exportTake` answers it: not a library that could not be read
    // (review 2026-10-13, #6).
    doc =
      takeId === "" || !library.isTakeId(takeId)
        ? null
        : await library.getScene(takeId);
  } catch (error) {
    return {
      outcome: {
        ok: true,
        value: {
          report: { outcome: "unreadable", reason: messageOf(error) },
          script: null,
        },
      },
      holePaths: null,
    };
  }
  if (doc === null) {
    return {
      outcome: {
        ok: true,
        value: { report: { outcome: "takeNotFound", takeId }, script: null },
      },
      holePaths: null,
    };
  }
  let derivation: ReturnType<typeof scriptFromTake>;
  try {
    derivation = scriptFromTake(doc);
  } catch (error) {
    return {
      outcome: {
        ok: true,
        value: {
          report: { outcome: "threw", takeId, error: messageOf(error) },
          script: null,
        },
      },
      holePaths: null,
    };
  }
  if (derivation.outcome === "nothingToDerive") {
    return {
      outcome: { ok: true, value: { report: derivation, script: null } },
      holePaths: null,
    };
  }
  // A step whose verb was changed by hand takes the scene's verb, noted in
  // `skeleton` (`verbChanged`): a draft exists to be checked and run, and is
  // the route a re-film's refusal of that edit points to.
  const merged = mergeSkeleton(derivation, await library.getSkeleton(takeId), {
    onVerbChange: "useScene",
    sceneName: doc.meta.name,
  });
  if (!merged.ok) {
    return {
      outcome: {
        ok: true,
        value: {
          report: { outcome: "threw", takeId, error: merged.detail },
          script: null,
        },
      },
      holePaths: null,
    };
  }
  const { draft, holes } = merged;
  const { notes } = derivation;
  const { target, ...rest } = draft;
  return {
    outcome: {
      ok: true,
      value: {
        // `skeleton`: what the merge with script.json said — absent pauses
        // and steps are named here, never only missing from the draft.
        report: {
          outcome: "derived",
          takeId,
          holes,
          notes,
          skeleton: merged.notes,
        },
        // `""` when capture scrubbed the origin, as the page leaves its
        // target field empty: the run then refuses at `target`, the hole's
        // own field, instead of driving an unrelated page.
        script: { target: target ?? "", ...rest },
      },
    },
    holePaths: holes.map((h) =>
      h.step === null ? h.field : `steps.${h.step}.${h.field}`,
    ),
  };
}
