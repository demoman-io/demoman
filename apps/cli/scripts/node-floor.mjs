// The oldest Node the package runs on, per release line: node:util's parseEnv
// and styleText (which @clack/prompts imports) arrived in 20.12 and 21.7, and
// an older Node fails while the bundle links (DEM-121, measured on real
// 20.0.0 and 21.6.2). build.mjs writes this into engines and the bin's check.
export const NODE_FLOORS = [
  [20, 12],
  [21, 7],
];

/** pkg/package.json's engines.node: each line from its floor, the last onward. */
export const NODE_ENGINES = NODE_FLOORS.map(([major, minor], i) =>
  i === NODE_FLOORS.length - 1
    ? `>=${major}.${minor}.0`
    : `^${major}.${minor}.0`,
).join(" || ");

/** The words the bin refuses an older Node with. */
export const NODE_NEEDED = `Demoman needs Node ${NODE_FLOORS[0].join(".")} or later${NODE_FLOORS.slice(
  1,
)
  .map(([major, minor]) => ` (${major}.${minor} or later on Node ${major})`)
  .join("")}`;

/**
 * The bin, dist/demoman.mjs: checks Node, then loads the bundle. An import a
 * Node lacks fails while the bundle links, before any line of it runs, so the
 * check has to sit outside it. Plain old syntax, so an old Node can parse it.
 */
export const binSource = (bundle) => `#!/usr/bin/env node
var floors = ${JSON.stringify(Object.fromEntries(NODE_FLOORS))};
var v = process.versions.node.split(".").map(Number);
if (v[0] < ${NODE_FLOORS[0][0]} || v[1] < (floors[v[0]] || 0)) {
  console.error(${JSON.stringify(NODE_NEEDED)} + ", and this is Node " + process.versions.node + ".");
  process.exitCode = 1;
} else {
  import(${JSON.stringify(bundle)});
}
`;
