// packages/run-core/test/node/refilm-fixture.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SceneDocument, SceneDocumentSchema } from "@demoman/scene-schema";

/** The checked-in fixture take, parsed the way the library reads scene.json. */
export const scene = (): SceneDocument =>
  SceneDocumentSchema.parse(
    JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "scene-schema",
          "fixtures",
          "readonly-scene.json",
        ),
        "utf8",
      ),
    ),
  );
