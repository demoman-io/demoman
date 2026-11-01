// `demoman join-flow`, the terminal's: kept out of src/executor, whose
// sources are the agent's (apps/mcp/test/recipe.test.ts reads them for every
// reason an agent can meet, and sameFlow is answered here only).
import { isFlowId } from "@demoman/run-core";
import { findKept } from "./executor/kept-flows.js";
import type { VideoRepo, VideoStore } from "./executor/videos.js";

export type JoinAnswer =
  | { ok: true; moved: number; adopted: string | null }
  | { ok: false; said: string };

/**
 * `demoman join-flow`: `from`'s videos into `into`, then `from` removed. An
 * `into` this library lacks is the flow the checkout keeps under that id
 * (repoFlowNameTaken's way out, where `from` holds the kept name): its record is
 * written with `from` left out of the name check, `from`'s videos moved and
 * `from` removed, all under one lock.
 */
export async function joinFlow(
  videos: VideoStore,
  from: string,
  into: string,
  checkout: { root: string; repo: VideoRepo } | { none: string },
): Promise<JoinAnswer> {
  const merged = (
    out: Awaited<ReturnType<VideoStore["merge"]>>,
    adopted: string | null,
  ): JoinAnswer =>
    out.ok
      ? { ok: true, moved: out.moved, adopted }
      : {
          ok: false,
          said:
            out.reason === "sameFlow"
              ? `${from} and ${into} are the same flow — name two different flows`
              : `no flow in this library has the id ${out.id}`,
        };
  if (from === into || !isFlowId(into) || (await videos.get(into)) !== null) {
    return merged(await videos.merge(from, into), null);
  }
  if ("none" in checkout) {
    return {
      ok: false,
      said: `no flow in this library has the id ${into}, and no checkout was found to read a recipe from (${checkout.none})`,
    };
  }
  const found = await findKept(checkout.root, into);
  if (found === null) {
    return {
      ok: false,
      said: `no flow in this library or this checkout has the id ${into}`,
    };
  }
  if ("duplicate" in found) {
    return {
      ok: false,
      said: `${found.duplicate.join(" and ")} both name the flow ${into} — delete one of them, then join again`,
    };
  }
  if ("unreadable" in found) {
    return {
      ok: false,
      said: `no flow in this library has the id ${into}, and a recipe that would not read might name it — ${found.unreadable.join("; ")}`,
    };
  }
  const done = await videos.exclusive(async (s): Promise<JoinAnswer> => {
    if ((await s.get(from)) === null) {
      return { ok: false, said: `no flow in this library has the id ${from}` };
    }
    const adopted = await s.adopt({
      id: into,
      name: found.kept.name,
      repo: checkout.repo,
      startPage: found.kept.script.target,
      kept: { root: checkout.root, file: found.file },
      except: from,
    });
    if (!adopted.ok) {
      return {
        ok: false,
        said: `flow "${found.kept.name}" is kept in ${found.file} as ${into}, but this library's flow ${adopted.holder.id} has that name too — join that one into ${into} as well`,
      };
    }
    return merged(await s.merge(from, into), found.file);
  });
  return done.ok
    ? done.value
    : { ok: false, said: `${done.held}, so nothing was moved — try again` };
}
