import { describe, expect, it } from "vitest";
import { checkScript } from "../../src/door.js";

const good = {
  scriptVersion: 1,
  name: "search",
  target: "http://127.0.0.1:4000/",
  steps: [{ do: "click", on: { role: "button", name: "Place order" } }],
};

describe("checkScript", () => {
  it("passes a valid script through, parsed", () => {
    const checked = checkScript(good, []);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.script.steps).toHaveLength(1);
  });

  it("checkScript says the version was raised", () => {
    const checked = checkScript({ ...good, device: "phone" }, []);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.script.scriptVersion).toBe(4);
      expect(checked.versionRaisedFrom).toBe(1);
    }
    const kept = checkScript(good, []);
    if (kept.ok) expect(kept.versionRaisedFrom).toBeUndefined();
  });

  it("refuses an array as notAnObject, naming the array", () => {
    const checked = checkScript([good], []);
    expect(checked).toEqual({
      ok: false,
      refusal: {
        outcome: "refusedBeforeRun",
        reason: "notAnObject",
        detail: "the script must be a JSON object, not an array",
        field: null,
      },
    });
  });

  it("refuses a bad field as invalidScript and names the field", () => {
    const checked = checkScript({ ...good, scriptVersion: 99 }, []);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.refusal.reason).toBe("invalidScript");
      expect(checked.refusal.field).toContain("scriptVersion");
      expect(checked.refusal.detail).toMatch(
        /^the script is not a valid DemoScript — scriptVersion: /,
      );
    }
  });

  it("calls a refused field that the last derive named a hole unfilledHoles", () => {
    const { target: _drop, ...noTarget } = good;
    const checked = checkScript(noTarget, ["target"]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.refusal.reason).toBe("unfilledHoles");
      expect(checked.refusal.detail).toContain("(target)");
    }
  });

  it("refuses a non-http target as nonHttpTarget", () => {
    const checked = checkScript({ ...good, target: "file:///etc/passwd" }, []);
    expect(checked).toEqual({
      ok: false,
      refusal: {
        outcome: "refusedBeforeRun",
        reason: "nonHttpTarget",
        detail:
          'the target must be an http(s) URL — "file:///etc/passwd" is not one',
        field: "target",
      },
    });
  });
});
