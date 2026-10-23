import { describe, expect, it } from "vitest";
import { matchRoute, pathFor, ROUTES, type RouteId } from "../../src/index.js";

const SAMPLE = { id: "take 1", ref: "kf:1/2" };

describe("pathFor", () => {
  it("encodes each param", () => {
    expect(pathFor("frame", { id: "a", ref: "kf:1/2" })).toBe(
      "/api/takes/a/frames/kf%3A1%2F2",
    );
  });
  it("throws naming the route and the param when one is missing", () => {
    expect(() => pathFor("frame", { id: "a" })).toThrow(/frame.*ref/);
    expect(() => pathFor("sceneGet")).toThrow(/sceneGet.*id/);
  });
  it("returns a paramless path as is", () => {
    expect(pathFor("ping")).toBe("/api/ping");
  });
});

describe("matchRoute", () => {
  const ids = Object.keys(ROUTES) as RouteId[];
  it("covers the whole table (premise of the round trip)", () => {
    // 22 since 2026-10-19: themeGet and themePut left with the light theme.
    expect(ids.length).toBe(22);
    expect(ids.filter((i) => ROUTES[i].path.includes(":")).length).toBe(8);
  });
  it.each(ids)("round-trips %s", (id) => {
    const wanted = (ROUTES[id].path.match(/:\w+/g) ?? []).map((p) =>
      p.slice(1),
    );
    const params = Object.fromEntries(
      wanted.map((n) => [n, SAMPLE[n as keyof typeof SAMPLE]]),
    );
    expect(Object.keys(params).length).toBe(wanted.length);
    expect(matchRoute(ROUTES[id].method, pathFor(id, params))).toEqual({
      id,
      params,
    });
  });
  it("matches the method too", () => {
    expect(matchRoute("DELETE", "/api/ping")).toBeNull();
    expect(matchRoute("PUT", "/api/takes/a/scene")?.id).toBe("scenePut");
    expect(matchRoute("GET", "/api/takes/a/scene")?.id).toBe("sceneGet");
  });
  it("returns null for unknown paths and a malformed escape", () => {
    expect(matchRoute("GET", "/api/nope")).toBeNull();
    expect(matchRoute("GET", "/api/takes//scene")).toBeNull();
    expect(matchRoute("GET", "/api/takes/%E0%A4%A/scene")).toBeNull();
  });
  it("does not let an encoded slash split a param", () => {
    expect(matchRoute("GET", "/api/takes/..%2Fx/scene")?.params.id).toBe(
      "../x",
    );
  });
});
