// node --test scripts/docs-demoscript.test.mjs (after pnpm -r build)
// The DemoScript Reference page is generated from DemoScriptSchema; these
// fail when the page and the schema drift apart.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const schema = await import("../packages/scene-schema/dist/index.js");
const pagePath = new URL("../apps/docs/reference/demoscript.mdx", import.meta.url);
const page = () => readFileSync(pagePath, "utf8");
const unwrap = (s) => {
  let t = s;
  while (["optional", "default", "pipe"].includes(t._zod.def.type))
    t = t._zod.def.type === "pipe" ? t._zod.def.in : t._zod.def.innerType;
  return t;
};

test("the page matches the schema (--check)", () => {
  const r = spawnSync(process.execPath, [new URL("./docs-demoscript.mjs", import.meta.url).pathname, "--check"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /docs:demoscript: up to date/);
});

test("every step type has a section", () => {
  const kinds = schema.ScriptStepSchema.options.map((o) => o.shape.do.value);
  assert.ok(kinds.length >= 9, `premise: read ${kinds}`);
  for (const k of kinds) assert.match(page(), new RegExp(`^### \`${k}\`$`, "m"), k);
});

test("every step type, step field and script field carries a description", () => {
  const missing = [];
  for (const step of schema.ScriptStepSchema.options) {
    const kind = step.shape.do.value;
    if (!step.description) missing.push(kind);
    for (const [field, s] of Object.entries(step.shape))
      if (field !== "do" && !s.description && !unwrap(s).description) missing.push(`${kind}.${field}`);
  }
  const script = unwrap(schema.DemoScriptSchema);
  for (const [field, s] of Object.entries(script.shape))
    if (!s.description && !unwrap(s).description) missing.push(`script.${field}`);
  // Premise: the walk reached the script's own fields.
  assert.ok(Object.keys(script.shape).includes("steps"));
  assert.deepEqual(missing, []);
});

test("the file's own fields are documented", () => {
  for (const f of ["keptVersion", "flow", "name", "script", "scale", "logo", "wallpaper", "deliver", "outputs", "report"])
    assert.match(page(), new RegExp(`^\\| \`${f}\` \\|`, "m"), f);
});
