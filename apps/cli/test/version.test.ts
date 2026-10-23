import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { VERSION } from "../src/version.js";

it("VERSION equals the workspace's and the built package's version", () => {
  const ws = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const built = JSON.parse(
    readFileSync(new URL("../pkg/package.json", import.meta.url), "utf8"),
  );
  expect(VERSION).toBe(ws.version);
  expect(built.version).toBe(ws.version);
});
