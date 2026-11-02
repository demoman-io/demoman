import { describe, expect, it } from "vitest";
import { entryUrlFor, pagePathFor } from "../../src/paths.js";

const KEY = "local:/Users/x/My Repo/.git";

describe("pagePathFor / entryUrlFor with a project", () => {
  // Red: ignore `project` in pagePathFor.
  it("a project and no take is the library on that project", () => {
    expect(pagePathFor(undefined, KEY)).toBe(
      "/?project=local%3A%2FUsers%2Fx%2FMy%20Repo%2F.git",
    );
  });

  it("a take wins over a project", () => {
    expect(pagePathFor("t1", KEY)).toBe("/editor.html?scene=t1");
  });

  // Red: leave `project` out of the entry query.
  it("the entry link carries the project", () => {
    const url = new URL(entryUrlFor("http://x", "tk", undefined, KEY));
    expect(url.searchParams.get("project")).toBe(KEY);
    expect(url.searchParams.get("t")).toBe("tk");
  });
});
