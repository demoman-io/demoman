import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sceneJsonSchema } from "../src/index";

const out = join(import.meta.dirname, "..", "schema.gen.json");
writeFileSync(out, `${JSON.stringify(sceneJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
