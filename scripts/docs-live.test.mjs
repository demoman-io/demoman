import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./docs-live.mjs", import.meta.url));

/** A docs site on 127.0.0.1: `redirects` maps a docs slug to the path its
 *  page redirects to; every other slug is a page linking to `/docs/asset`. */
async function site(redirects) {
  const server = createServer((req, res) => {
    const slug = req.url.replace(/^\/docs\//, "");
    if (redirects[slug] !== undefined) {
      res.writeHead(302, { location: redirects[slug] }).end();
    } else if (req.url.startsWith("/docs/") || req.url.startsWith("/away")) {
      res.writeHead(200, { "content-type": "text/html" });
      // Mintlify's pages carry React's <style data-href="…">: a name, not a link.
      res.end(
        '<style data-href="base-ui-disable-scrollbar"></style><a href="/docs/asset">asset</a>',
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/** A docs folder: three pages, `out` naming `outbound` as its url:. */
function docsFolder(outbound) {
  const dir = mkdtempSync(join(tmpdir(), "docs-live-"));
  const pages = ["index", "out", "stray"];
  writeFileSync(
    join(dir, "docs.json"),
    JSON.stringify({ navigation: { groups: [{ group: "G", pages }] } }),
  );
  writeFileSync(join(dir, "index.mdx"), '---\ntitle: "Home"\n---\n');
  writeFileSync(
    join(dir, "out.mdx"),
    `---\ntitle: "Out"\nurl: "${outbound}"\n---\n`,
  );
  writeFileSync(join(dir, "stray.mdx"), '---\ntitle: "Stray"\n---\n');
  return dir;
}

/** Runs the script; async, so this process's server keeps answering. */
function docsLive(base, dir) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, base],
      { env: { ...process.env, DEMOMAN_DOCS_DIR: dir } },
      (error, stdout) => resolve({ code: error ? error.code : 0, stdout }),
    );
  });
}

test("a page redirected off the docs fails, unless it lands on its own url:", async () => {
  const { server, origin } = await site({
    out: "/away/outbound",
    stray: "/away/elsewhere",
  });
  const dir = docsFolder(`${origin}/away/outbound`);
  try {
    const { code, stdout } = await docsLive(`${origin}/docs`, dir);
    // The premise: the index page was read and its link counted, so the
    // run did reach the site.
    assert.match(stdout, /^ok index$/m, stdout);
    assert.match(stdout, new RegExp(`^ok out -> ${origin}/away/outbound$`, "m"), stdout);
    assert.match(
      stdout,
      new RegExp(`^FAIL stray redirected to ${origin}/away/elsewhere$`, "m"),
      stdout,
    );
    assert.doesNotMatch(stdout, /^FAIL out/m, stdout);
    assert.match(stdout, /3 pages, 1 links, 1 failures$/m, stdout);
    assert.equal(code, 1, stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an outbound page that lands anywhere but its url: fails", async () => {
  const { server, origin } = await site({
    out: "/away/somewhere-else",
    stray: "/docs/index",
  });
  const dir = docsFolder(`${origin}/away/outbound`);
  try {
    const { code, stdout } = await docsLive(`${origin}/docs`, dir);
    assert.match(stdout, /^ok stray$/m, stdout);
    assert.match(
      stdout,
      new RegExp(`^FAIL out redirected to ${origin}/away/somewhere-else$`, "m"),
      stdout,
    );
    assert.equal(code, 1, stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an attribute that only ends in href, like data-href, is not a link", async () => {
  const { server, origin } = await site({ out: "/away/outbound" });
  const dir = docsFolder(`${origin}/away/outbound`);
  try {
    const { code, stdout } = await docsLive(`${origin}/docs`, dir);
    // The premise: every page served the body above, data-href and all.
    assert.match(stdout, /^ok index$/m, stdout);
    assert.match(stdout, /^ok stray$/m, stdout);
    assert.doesNotMatch(stdout, /base-ui-disable-scrollbar/, stdout);
    assert.match(stdout, /3 pages, 1 links, 0 failures$/m, stdout);
    assert.equal(code, 0, stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each docs.json redirect must land on its destination under the docs' base path", async () => {
  // /docs/old keeps the base path; /docs/gone drops it, as a proxy can.
  const { server, origin } = await site({ old: "/docs/index", gone: "/index" });
  const dir = docsFolder(`${origin}/away/outbound`);
  const docs = JSON.parse(readFileSync(join(dir, "docs.json"), "utf8"));
  docs.navigation.groups[0].pages = ["index"];
  docs.redirects = [
    { source: "/old", destination: "/index" },
    { source: "/gone", destination: "/index" },
  ];
  writeFileSync(join(dir, "docs.json"), JSON.stringify(docs));
  try {
    const { code, stdout } = await docsLive(`${origin}/docs`, dir);
    // Premise: the page was read, so the site answered.
    assert.match(stdout, /^ok index$/m, stdout);
    assert.match(stdout, /^ok redirect \/old -> \/docs\/index$/m, stdout);
    assert.match(stdout, new RegExp(`^FAIL redirect /gone landed on ${origin}/index \\(404\\), not /docs/index$`, "m"), stdout);
    assert.equal(code, 1, stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pages in a nested group are crawled like any other", async () => {
  const { server, origin } = await site({});
  const dir = docsFolder(`${origin}/away/outbound`);
  const docs = JSON.parse(readFileSync(join(dir, "docs.json"), "utf8"));
  docs.navigation.groups[0].pages = ["index", { group: "Inner", pages: ["stray"] }];
  writeFileSync(join(dir, "docs.json"), JSON.stringify(docs));
  try {
    const { code, stdout } = await docsLive(`${origin}/docs`, dir);
    assert.match(stdout, /^ok stray$/m, stdout);
    assert.doesNotMatch(stdout, /object Object/, stdout);
    assert.match(stdout, /2 pages, /, stdout);
    assert.equal(code, 0, stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
