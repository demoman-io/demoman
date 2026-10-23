// Reads the DEPLOYED docs site and prints one line per finding.
//   node scripts/docs-live.mjs [base]      (base defaults to https://demoman.io/docs)
// Last line: `docs:live: N pages, M links, K failures`; exit 1 on any failure.
// A fetch that throws (DNS, TLS, timeout) is a FAIL line naming the error.
// A page whose final URL leaves the docs is a FAIL, unless its .mdx sets
// frontmatter `url:` and the final URL is exactly that.
// DEMOMAN_DOCS_DIR reads another docs folder than apps/docs (the tests).
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const base = (process.argv[2] ?? "https://demoman.io/docs").replace(/\/+$/, "");
const origin = new URL(base).origin;
const TIMEOUT_MS = 20_000;
const docsPath = new URL(base).pathname.replace(/\/+$/, "");
const INTERNAL = [docsPath, "/_mintlify", "/mintlify-assets"];
const STARTER = ["Welcome to your project", "support@mintlify.com"];

const docsDir = process.env.DEMOMAN_DOCS_DIR
  ? pathToFileURL(`${process.env.DEMOMAN_DOCS_DIR.replace(/\/+$/, "")}/`)
  : new URL("../apps/docs/", import.meta.url);
const docs = JSON.parse(readFileSync(new URL("docs.json", docsDir), "utf8"));
/** The frontmatter `url:` of a slug's page: where an outbound page may land.
 *  null when the page has none; a page that is not on disk is said. */
function outboundUrl(slug) {
  const file = new URL(`${slug}.mdx`, docsDir);
  if (!existsSync(file)) return { missing: file.pathname };
  const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  const m = /^url:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(front);
  return m ? m[1] : null;
}
const slugs = (docs.navigation?.groups ?? []).flatMap((g) => g.pages ?? []);
if (slugs.length === 0) {
  console.log("FAIL docs.json lists no pages (navigation.groups[].pages)");
  console.log("docs:live: 0 pages, 0 links, 1 failures");
  process.exit(1);
}

let failures = 0;
const fail = (line) => {
  failures += 1;
  console.log(`FAIL ${line}`);
};

async function get(url, wantText) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    // Assets are drained as bytes, never decoded as text.
    const body = wantText
      ? await res.text()
      : (await res.arrayBuffer(), "");
    return { status: res.status, body, finalUrl: res.url || url };
  } catch (e) {
    return { error: `${e?.name ?? "Error"}: ${e?.message ?? e}` };
  }
}

function internalLinks(html, pageUrl) {
  const found = new Set();
  // An attribute named href or src, not one that ends in it: Mintlify's
  // <style data-href="base-ui-…"> names a stylesheet and is no link.
  const attr = /(?<![\w-])(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  const absolute = /https:\/\/demoman\.io\/[^\s"'<>)\\]+/g;
  const candidates = [
    ...[...html.matchAll(attr)].map((m) => m[1]),
    ...(html.match(absolute) ?? []),
  ];
  for (const raw of candidates) {
    let u;
    try {
      u = new URL(raw.replace(/&amp;/g, "&"), pageUrl);
    } catch {
      continue; // not a URL (e.g. a template fragment); nothing to fetch
    }
    if (u.origin !== origin) continue; // external: not fetched
    if (!INTERNAL.some((p) => u.pathname === p || u.pathname.startsWith(`${p}/`)))
      continue;
    u.hash = "";
    found.add(u.href);
  }
  return found;
}

const seen = new Set();
let links = 0;

const onDocs = (u) => {
  const x = new URL(u);
  return x.origin === origin && (x.pathname === docsPath || x.pathname.startsWith(`${docsPath}/`));
};

for (const slug of slugs) {
  const url = `${base}/${slug}`;
  seen.add(url);
  const problems = [];
  const page = await get(url, true);
  if (page.error) {
    problems.push(`${slug} ${page.error}`);
  } else if (page.status !== 200) {
    problems.push(`${slug} ${page.status}`);
  } else if (!onDocs(page.finalUrl)) {
    // Only an outbound page (frontmatter url:) may leave the docs, and only
    // for the address it names: anything else is a redirect the Worker
    // passed through, and a 200 from wherever it went proves nothing.
    const allowed = outboundUrl(slug);
    if (allowed !== null && typeof allowed === "object") {
      problems.push(`${slug} redirected to ${page.finalUrl}, and ${allowed.missing} is not there to say whether it may`);
    } else if (allowed !== null && page.finalUrl === allowed) {
      console.log(`ok ${slug} -> ${page.finalUrl}`);
      continue;
    } else {
      problems.push(`${slug} redirected to ${page.finalUrl}`);
    }
  } else {
    if (STARTER.some((t) => page.body.includes(t))) problems.push(`${slug} starter text`);
    const found = internalLinks(page.body, page.finalUrl);
    if (found.size === 0) problems.push(`${slug} no internal links found`);
    for (const link of found) {
      if (seen.has(link)) continue;
      seen.add(link);
      links += 1;
      const r = await get(link, false);
      if (r.error) problems.push(`${slug} ${link} ${r.error}`);
      else if (r.status !== 200) problems.push(`${slug} ${link} ${r.status}`);
    }
  }
  if (problems.length === 0) console.log(`ok ${slug}`);
  for (const p of problems) fail(p);
}

console.log(`docs:live: ${slugs.length} pages, ${links} links, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
