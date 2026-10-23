import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  nameFromPageTitle,
  untitleTimestampName,
} from "../../src/scene-name.js";

const meta = (
  name: string,
  originUrl: string,
  createdAt = "2026-09-22T18:03:11Z",
) => ({ name, createdAt, capture: { originUrl } }) as SceneDocument["meta"];
const scene = (name: string, createdAt = "2026-09-22T18:03:11Z") =>
  ({ meta: meta(name, "https://app.test/x", createdAt) }) as SceneDocument;

describe("nameFromPageTitle", () => {
  it("takes the title, with its whitespace collapsed", () => {
    expect(
      nameFromPageTitle("  Checkout\n –  Northwind ", "https://a.test/"),
    ).toBe("Checkout – Northwind");
  });

  it("is untitled for no title, or a blank one", () => {
    expect(nameFromPageTitle(null, "https://a.test/")).toBe("");
    expect(nameFromPageTitle(undefined, "https://a.test/")).toBe("");
    expect(nameFromPageTitle("   ", "https://a.test/")).toBe("");
  });

  // Chrome shows a page with no <title> as its address, with or without
  // the scheme. Reddens if the comparison is dropped.
  it("is untitled when the title is only the address Chrome filled in", () => {
    const url = "http://localhost:4000/checkout";
    expect(nameFromPageTitle(url, url)).toBe("");
    expect(nameFromPageTitle("localhost:4000/checkout", url)).toBe("");
    expect(nameFromPageTitle("localhost:4000", "http://localhost:4000/")).toBe(
      "",
    );
    // A title that merely mentions the host is a real title.
    expect(nameFromPageTitle("localhost:4000 admin", url)).toBe(
      "localhost:4000 admin",
    );
  });
});

describe("untitleTimestampName", () => {
  // Every take before 2026-09-22 was named this way at finalize.
  it("reads a take named by its own start time as untitled", () => {
    const createdAt = "2026-09-01T10:30:00Z";
    const stamped = scene(new Date(createdAt).toLocaleString(), createdAt);
    expect(untitleTimestampName(stamped).meta.name).toBe("");
  });

  it("leaves any other name alone, including another take's timestamp", () => {
    const named = scene("Checkout");
    expect(untitleTimestampName(named)).toBe(named);
    const elsewhen = scene(new Date("2026-01-01T00:00:00Z").toLocaleString());
    expect(untitleTimestampName(elsewhen).meta.name).toBe(elsewhen.meta.name);
  });
});
