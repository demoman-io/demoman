import { describe, expect, it } from "vitest";
import sceneFixture from "../../../scene-schema/fixtures/readonly-scene.json";
import {
  buildTreePath,
  followTreePath,
  parseTreePath,
  serializeTreePath,
} from "../../src/treepath";
import { mount } from "../helpers/fixtures";

describe("tree-path grammar", () => {
  it("serializes element steps as tag:nth, one-based within the tag", () => {
    expect(
      serializeTreePath([
        { kind: "element", tag: "body", nth: 1 },
        { kind: "element", tag: "div", nth: 2 },
      ]),
    ).toBe("body:1/div:2");
  });

  it("round-trips a shadow boundary", () => {
    const path = "body:1/#shadow/button:1";
    expect(serializeTreePath(parseTreePath(path))).toBe(path);
  });

  it("round-trips a frame boundary carrying the frame's own fingerprint", () => {
    const path =
      "body:1/#frame(origin=https://js.stripe.com,name=pay,ordinal=1)/input:1";
    const parsed = parseTreePath(path);
    expect(parsed[1]).toEqual({
      kind: "frame",
      hop: { origin: "https://js.stripe.com", name: "pay", ordinal: 1 },
    });
    expect(serializeTreePath(parsed)).toBe(path);
  });

  // A custom element name may carry "_", "." or non-ASCII letters. The step
  // grammar refused them, every consumer swallowed the parse error, and the
  // anchor lost its tree-path tier — and `frameHopOf` its frame — for good.
  it("round-trips a custom element name the way the platform spells it", () => {
    const doc = mount(
      `<main><my-widget_v2><x-über.name><button>Go</button></x-über.name></my-widget_v2></main>`,
    );
    const button = doc.querySelector("button");
    if (button === null) throw new Error("fixture produced no button");
    const segs = buildTreePath(button, doc);
    const path = serializeTreePath(segs);
    expect(path).toBe("body:1/main:1/my-widget_v2:1/x-über.name:1/button:1");
    expect(parseTreePath(path)).toEqual(segs);
    expect(followTreePath(parseTreePath(path), doc)).toBe(button);
  });

  it("throws on a malformed step rather than guessing", () => {
    expect(() => parseTreePath("body:1/??/button")).toThrow();
  });

  it("round-trips a frame hop whose name contains a comma", () => {
    const hop = {
      origin: "https://js.stripe.com",
      name: "pay,checkout",
      ordinal: 1,
    };
    const segs: Parameters<typeof serializeTreePath>[0] = [
      { kind: "frame", hop },
    ];
    const roundTripped = parseTreePath(serializeTreePath(segs));
    expect(roundTripped[0]).toEqual({ kind: "frame", hop });
  });

  it("round-trips a frame hop whose name contains a close-paren", () => {
    const hop = {
      origin: "https://js.stripe.com",
      name: "pay)hack",
      ordinal: 1,
    };
    const segs: Parameters<typeof serializeTreePath>[0] = [
      { kind: "frame", hop },
    ];
    const roundTripped = parseTreePath(serializeTreePath(segs));
    expect(roundTripped[0]).toEqual({ kind: "frame", hop });
  });

  it("round-trips a frame hop whose name contains a literal percent, proving the escape is reversible", () => {
    const hop = {
      origin: "https://js.stripe.com",
      name: "pay%2Cnot",
      ordinal: 1,
    };
    const segs: Parameters<typeof serializeTreePath>[0] = [
      { kind: "frame", hop },
    ];
    const roundTripped = parseTreePath(serializeTreePath(segs));
    expect(roundTripped[0]).toEqual({ kind: "frame", hop });
  });

  it("keeps a normal frame hop's origin unescaped and readable", () => {
    const hop = { origin: "https://js.stripe.com", name: "pay", ordinal: 1 };
    const serialized = serializeTreePath([{ kind: "frame", hop }]);
    expect(serialized).toContain("origin=https://js.stripe.com");
  });
});

describe("buildTreePath / followTreePath", () => {
  it("builds a path that finds the same element again", () => {
    const doc = mount(
      `<main><section><p>a</p></section><section><button>Go</button></section></main>`,
    );
    const button = doc.querySelector("button") as Element;
    const path = buildTreePath(button, doc);
    expect(serializeTreePath(path)).toBe("body:1/main:1/section:2/button:1");
    expect(followTreePath(path, doc)).toBe(button);
  });

  it("counts nth among same-tag siblings only", () => {
    const doc = mount(`<main><p>a</p><span>b</span><p>c</p></main>`);
    const second = doc.querySelectorAll("p")[1] as Element;
    expect(serializeTreePath(buildTreePath(second, doc))).toBe(
      "body:1/main:1/p:2",
    );
  });

  it("returns null when the path no longer leads anywhere", () => {
    const doc = mount(`<main><section></section></main>`);
    expect(
      followTreePath(parseTreePath("body:1/main:1/section:1/button:1"), doc),
    ).toBeNull();
  });

  // Recorded limitation (fix wave I6, 2026-08-25) -- not a target for this
  // fix wave. followTreePath returns null at the first non-element segment,
  // and the ladder always calls it against the top-level scoping root, so
  // tier 4 only works for anchors with no boundary hop of any kind. Paths
  // are document-rooted: rebasing a path relative to its own boundary is
  // deferred to a later sub-project. See the design doc's "Resolution
  // ladder" note.
  it.skip("tier 4 cannot resolve an anchor behind a shadow boundary — paths are document-rooted; see design doc", () => {
    const doc = mount(`<main><sf-card></sf-card></main>`);
    const host = doc.querySelector("sf-card") as Element;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button>Pay</button>`;
    const button = shadow.querySelector("button") as Element;

    const path = buildTreePath(button, doc);
    expect(serializeTreePath(path)).toContain("#shadow");
    // The element is present and reachable, but followTreePath stops at the
    // #shadow segment and never resumes -- this currently returns null, not
    // `button`.
    expect(followTreePath(parseTreePath(serializeTreePath(path)), doc)).toBe(
      button,
    );
  });

  it("parses every tree path in the checked-in scene fixtures", () => {
    for (const anchor of sceneFixture.anchors) {
      const path = anchor.fingerprint.treePath;
      if (path !== null) expect(() => parseTreePath(path)).not.toThrow();
    }
  });
});
