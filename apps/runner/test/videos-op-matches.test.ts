import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibrary } from "../src/executor/library.js";
import { createVideoStore } from "../src/executor/videos.js";
import { matchesFor } from "../src/executor/videos-op.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-matches-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe("matchesFor", () => {
  // Red when a flow of unknown repo, recorded on another app, makes a new
  // flow in a known repo a possible duplicate (DEM-51).
  it("in a known repo, a flow of unknown repo is no match", async () => {
    const library = createLibrary(home);
    const store = createVideoStore(home, library);
    const other = await store.create({
      name: "Create a new invoice",
      repo: { unknown: true },
      startPage: "http://localhost:4000/",
    });
    if (!other.ok) throw new Error(JSON.stringify(other));
    const mine = { key: "github.com/acme/nylon" };
    expect(await matchesFor(store, library, "Create an invoice", mine)).toEqual(
      [],
    );
  });

  // Premise: within the repo, a similar name still matches.
  it("in a known repo, its own flow under a similar name matches", async () => {
    const library = createLibrary(home);
    const store = createVideoStore(home, library);
    const mine = { key: "github.com/acme/nylon" };
    const same = await store.create({
      name: "Create a new invoice",
      repo: mine,
      startPage: "http://localhost:4401/",
    });
    if (!same.ok) throw new Error(JSON.stringify(same));
    const got = await matchesFor(store, library, "Create an invoice", mine);
    expect(got.map((m) => m.id)).toEqual([same.video.id]);
  });
});
