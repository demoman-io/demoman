import {
  type RefilmInfo,
  type RefusedBeforeRun,
  refilmScript,
} from "@demoman/run-core";
import { messageOf } from "../report.js";
import { type Library, LibraryError } from "./library.js";

/** `run({ takeId })`'s first half (spec 2026-10-14 re-film §2): the take
 *  and its skeleton, merged into a script — or the reason there is none,
 *  in the door's own shape. */
export async function refilmFromLibrary(
  library: Library,
  takeId: unknown,
): Promise<
  | { ok: true; script: Record<string, unknown>; refilm: RefilmInfo }
  | { ok: false; refusal: RefusedBeforeRun }
> {
  const refuse = (
    reason: string,
    detail: string,
    field: string | null = null,
  ) => ({
    ok: false as const,
    refusal: { outcome: "refusedBeforeRun" as const, reason, detail, field },
  });
  const id = typeof takeId === "string" ? takeId.trim() : "";
  if (id === "" || !library.isTakeId(id)) {
    return refuse(
      "takeNotFound",
      `no take has the id ${JSON.stringify(takeId)} — call takes for the ids there are`,
      "takeId",
    );
  }
  let read: Awaited<ReturnType<Library["getSceneRead"]>>;
  try {
    read = await library.getSceneRead(id);
  } catch (error) {
    return refuse(
      "takeUnreadable",
      error instanceof LibraryError ? error.message : messageOf(error),
      "takeId",
    );
  }
  if (read === null) {
    return refuse(
      "takeNotFound",
      `no take has the id ${id} — call takes for the ids there are`,
      "takeId",
    );
  }
  const { scene, notes } = read;
  const skeleton = await library.getSkeleton(id);
  let built: ReturnType<typeof refilmScript>;
  try {
    built = refilmScript(scene, skeleton);
  } catch (error) {
    // A scene.json the schema read but the merge could not build from is a
    // take that cannot be read for a re-film: said, never a crashed run.
    return refuse(
      "takeUnreadable",
      `take ${id} could not be built into a script (${messageOf(error)})`,
      "takeId",
    );
  }
  if (!built.ok) return refuse(built.reason, built.detail, built.field);
  built.refilm.notes.push(
    ...notes.map((sentence) => ({ kind: "migrated" as const, sentence })),
  );
  return built;
}
