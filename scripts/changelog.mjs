// The docs changelog's entries, read one way by scripts/release.mjs (which
// pins each shipped entry) and apps/cli/test/docs.test.ts (which checks them).

/** Entries in page order. `label` may sit anywhere in the tag, and a quoted attribute may hold a `>`. */
export const changelogEntries = (text) =>
  [...text.matchAll(/<Update\b((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]*?)<\/Update>/g)].map((m) => ({
    label: /\blabel="([^"]+)"/.exec(m[1])?.[1],
    body: m[2].trim(),
  }));
