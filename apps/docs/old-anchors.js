// Old guide pages redirect to one page each (docs.json), and the browser keeps
// the #section through the redirect, but Mintlify cannot redirect by anchor.
// So an old section's anchor is sent on here, to the section that holds its
// content now (DEM-96). Mintlify runs every .js file in the docs on every page;
// apps/cli/test/docs.test.ts runs this one against each old anchor.
const OLD_ANCHORS = {
  // Was /guides/repo-flows ("Flows in the repo").
  "/get-started/add-to-repo": {
    "add-a-flow": "/get-started/add-to-repo#add-it",
    refresh: "/concepts/refresh",
    "commit-no-video": "/concepts/refresh#keeping-videos-out-of-git",
    "run-it-in-ci": "/get-started/ci",
    demomanappjson: "/reference/app-json",
    "pinned-dates": "/reference/app-json#pinned-dates",
    "the-self-check": "/concepts/refresh#the-self-check",
    stops: "/reference/refusals#setting-up-ci",
    "the-pull-request-route": "/concepts/refresh#where-changed-videos-go",
    "the-main-route": "/concepts/refresh#where-changed-videos-go",
    "no-loop": "/concepts/refresh#where-changed-videos-go",
  },
  // Was /guides/keep-videos-current.
  "/get-started/ci": {
    "keep-a-flow": "/get-started/add-to-repo#add-it",
    refresh: "/concepts/refresh",
    "commit-no-video": "/concepts/refresh#keeping-videos-out-of-git",
    "run-it-on-every-merge": "/get-started/ci#set-it-up",
    "the-pull-request-route": "/concepts/refresh#where-changed-videos-go",
    "the-main-route": "/concepts/refresh#where-changed-videos-go",
    "no-loop": "/concepts/refresh#where-changed-videos-go",
  },
};

for (const [page, anchors] of Object.entries(OLD_ANCHORS)) {
  const to = location.pathname.endsWith(page) && anchors[location.hash.slice(1)];
  // The docs' base path (/docs on the site, none in `mint dev`) is kept.
  if (to) location.replace(location.pathname.slice(0, -page.length) + to);
}
