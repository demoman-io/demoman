// apps/runner/src/compare/scripts.ts
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { type DemoScript, DemoScriptSchema } from "@demoman/scene-schema";

export interface Places {
  sample: string;
}
export type Loaded =
  | { ok: true; name: string; script: DemoScript }
  | { ok: false; name: string; cause: string };

/** A checked-in script with its places filled, judged by the schema the run
 *  will judge it by — so a refusal is said before any browser opens. */
export function loadScript(path: string, places: Places): Loaded {
  const name = basename(path, ".json");
  const text = readFileSync(path, "utf8");
  const filled = text.replaceAll("{sample}", places.sample);
  let raw: unknown;
  try {
    raw = JSON.parse(filled);
  } catch (error) {
    return { ok: false, name, cause: `${path} is not JSON (${String(error)})` };
  }
  const parsed = DemoScriptSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      name,
      cause: `${path} is not a DemoScript: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  return { ok: true, name, script: parsed.data };
}
