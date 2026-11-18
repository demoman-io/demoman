// .github/actions/changes.sh, the gate's "does this PR touch product code"
// step, run with stub `gh` and `yq` on the PATH (the real jq does the work).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../.github/actions/changes.sh",
);

/**
 * @param {{ event?: string, pages?: object[][], total?: number, failGh?: boolean }} o
 */
function changes({ event = "pull_request", pages = [], total, failGh = false }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-changes-"));
  writeFileSync(join(dir, "pages.json"), JSON.stringify(pages));
  const count = total ?? pages.flat().length;
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub(
    "gh",
    failGh
      ? "exit 1"
      : `case "$*" in *changed_files*) echo ${count};; *) cat "${dir}/pages.json";; esac`,
  );
  stub("yq", `printf '%s\\n' 'packages/**' 'apps/cli/**'`);
  const out = join(dir, "output");
  writeFileSync(out, "");
  const run = spawnSync("bash", [script, "workflow.yml"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      EVENT: event,
      PR: "7",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_OUTPUT: out,
    },
  });
  return { ...run, output: readFileSync(out, "utf8") };
}

const file = (filename, previous_filename) => ({ filename, previous_filename });

test("a PR that touches no product path is not product", () => {
  const r = changes({ pages: [[file("README.md"), file("docs/x.md")]] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.output, "product=false\n", r.stdout);
  assert.match(r.stdout, /2 of the PR's 2 files listed/);
});

test("a product path on any page, or as a rename's old name, is product", () => {
  const paged = changes({
    pages: [[file("README.md")], [file("packages/run-core/src/a.ts")]],
  });
  assert.equal(paged.output, "product=true\n", paged.stdout);
  const renamed = changes({
    pages: [[file("docs/a.ts", "apps/cli/src/a.ts")]],
  });
  assert.equal(renamed.output, "product=true\n", renamed.stdout);
});

test("a file list shorter than the PR's changed_files runs everything, and says why", () => {
  const r = changes({ pages: [[file("README.md")]], total: 3500 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.output, "product=true\n", r.stdout);
  assert.match(r.stdout, /::warning::the files API listed 1 of the PR's 3500/);
});

test("a push is product without asking the API", () => {
  const r = changes({ event: "push", failGh: true });
  assert.equal(r.output, "product=true\n", r.stdout);
});

test("a failed gh fails the step rather than reading as no product change", () => {
  const r = changes({ failGh: true });
  assert.notEqual(r.status, 0);
  assert.equal(r.output, "");
});
