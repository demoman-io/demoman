// Writes the generated part of apps/docs/reference/demoscript.mdx from
// DemoScriptSchema (packages/scene-schema, built), between the markers.
//   node scripts/docs-demoscript.mjs           rewrite the page
//   node scripts/docs-demoscript.mjs --check   write nothing; exit 1 if the page is stale
// Reads the zod schema directly rather than z.toJSONSchema: the walk keeps
// "target" and the descriptions without registering schema ids. Refinements
// (superRefine) have no shape to read, so RULES lists them by hand.
import { readFileSync, writeFileSync } from "node:fs";

const { DemoScriptSchema, ScriptStepSchema } = await import("../packages/scene-schema/dist/index.js");
const pagePath = new URL("../apps/docs/reference/demoscript.mdx", import.meta.url);
const START = "{/* generated:start */}";
const END = "{/* generated:end */}";

// The superRefine rules in script.ts, in words. Keep in step with it.
const RULES = [
  "At least one step acts on the page: a script of pauses alone is refused.",
  "Name a `device` or a `viewport`, not both.",
  "On a `device`, no `hover` step: a phone has no hover.",
  "A `drag` must end somewhere other than where it starts.",
  "`{secret:NAME}` is refused in a script's `type` text: it works only in `.demoman/accounts.json`.",
  "A `trim` step names a step that exists and is not a `pause`, and the start is not after the end.",
  "`look` names a `kit` or gives a `branding`, not both.",
];

const def = (s) => s._zod.def;
function unwrap(s) {
  let t = s;
  let optional = false;
  for (;;) {
    const d = def(t);
    if (d.type === "optional") optional = true;
    else if (d.type === "default") optional = true;
    else if (d.type !== "pipe") return { schema: t, optional };
    t = d.type === "pipe" ? d.in : d.innerType;
  }
}
const TARGET_KEYS = new Set(["stableId", "role", "name", "text", "treePath"]);
const isTarget = (s) =>
  def(s).type === "union" &&
  def(s).options.every((o) => def(o).type === "object" && Object.keys(o.shape).every((k) => TARGET_KEYS.has(k)));

function typeOf(s) {
  const { schema } = unwrap(s);
  const d = def(schema);
  if (isTarget(schema)) return "[target](#targets)";
  switch (d.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "literal":
      return d.values.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
    case "enum":
      return Object.values(d.entries).map((v) => `\`"${v}"\``).join(" \\| ");
    case "array":
      return `${typeOf(d.element)} list`;
    case "union":
      if (d.options.every((o) => def(o).type === "object" && "do" in o.shape)) return "[step](#steps)";
      return [...new Set(d.options.map(typeOf))].join(" or ");
    case "object":
      return `object`;
    default:
      return d.type;
  }
}

const cell = (t) => (t ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
function table(shape, skip = []) {
  const rows = Object.entries(shape)
    .filter(([k]) => !skip.includes(k))
    .map(([k, s]) => {
      const { schema, optional } = unwrap(s);
      return `| \`${k}\` | ${typeOf(s)} | ${optional ? "no" : "yes"} | ${cell(s.description ?? schema.description)} |`;
    });
  return ["| Field | Type | Required | Description |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

export function generate() {
  const script = unwrap(DemoScriptSchema).schema;
  const out = [START, "", "## Script fields", "", table(script.shape), "", "## Steps", ""];
  out.push(
    "Each step is an object whose `do` names what it does.",
    "",
  );
  for (const step of ScriptStepSchema.options) {
    const kind = step.shape.do.value;
    out.push(`### \`${kind}\``, "", `${step.description}.`, "");
    if (Object.keys(step.shape).length > 1) out.push(table(step.shape, ["do"]), "");
  }
  out.push("## Rules", "", "Beyond each field's own type, a script is refused when it breaks one of these:", "");
  for (const r of RULES) out.push(`- ${r}`);
  out.push("", END);
  return out.join("\n");
}

function render(page) {
  const a = page.indexOf(START);
  const b = page.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${pagePath.pathname} has no ${START} … ${END} region`);
  return page.slice(0, a) + generate() + page.slice(b + END.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const page = readFileSync(pagePath, "utf8");
  const next = render(page);
  if (process.argv.includes("--check")) {
    if (next === page) {
      console.log("docs:demoscript: up to date");
    } else {
      const [x, y] = [page.split("\n"), next.split("\n")];
      const i = x.findIndex((l, n) => l !== y[n]);
      console.log(`docs:demoscript: stale at line ${i + 1}\n  page:   ${x[i]}\n  schema: ${y[i]}`);
      console.log("run node scripts/docs-demoscript.mjs to rewrite it");
      process.exit(1);
    }
  } else {
    writeFileSync(pagePath, next);
    console.log("docs:demoscript: written");
  }
}
