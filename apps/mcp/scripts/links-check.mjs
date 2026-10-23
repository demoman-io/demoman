// apps/mcp/scripts/links-check.mjs
//
// The links a saved export ends on, served for any file so a person can
// click them in their own terminal: `pnpm --filter @demoman/mcp build`, then
// `node apps/mcp/scripts/links-check.mjs <file>` and paste the line it
// prints into the agent's reply, or click it here. Serves until Ctrl-C.
// No studio link: that needs the CLI's studio (the copy page closes the
// same way).

import { resolve } from "node:path";
import { createSessionLinks } from "../dist/session-links.js";

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: node apps/mcp/scripts/links-check.mjs <file>");
  process.exit(2);
}
const links = createSessionLinks({ log: (line) => console.error(line) });
const got = await links.linksFor({
  takeId: "check",
  path: resolve(path),
  isFile: true,
});
if ("error" in got) {
  console.error(got.error);
  process.exit(1);
}
const name = resolve(path).split("/").pop();
console.log(
  `[${name}](${got.file})${got.copy === undefined ? "" : ` · [Copy video](${got.copy})`}`,
);
// The server is unref'd so it never holds demoman-mcp open; hold it here.
setInterval(() => {}, 1 << 30);
