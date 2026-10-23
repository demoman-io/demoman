import type { SceneDocument } from "@demoman/scene-schema";
// `readonlyScene` moved to `src/fixtures/scenes.ts` so the
// editor's `?fixture=` door and these lanes share one definition. Re-exported
// rather than re-declared: the door exists so a person can hold what the
// editor draws against what a test asserts, and that only works while both
// read the same object. See that file's docblock.
import { readonlyScene } from "../fixtures/scenes";

export { readonlyScene };

/**
 * The same scene, made by a script rather than recorded — the one field the
 * editor's "re-shoot it" / "run its script again" wordings read
 * (`isAuthoredScene`). Asserts the flag it sets, so a fixture that stopped
 * being authored would fail here, not pass a wording test for the wrong take.
 */
export function authoredScene(scene: SceneDocument): SceneDocument {
  const doc: SceneDocument = {
    ...scene,
    meta: {
      ...scene.meta,
      capture: { ...scene.meta.capture, mode: "authored" },
    },
  };
  if (doc.meta.capture.mode !== "authored")
    throw new Error("authoredScene did not produce an authored scene");
  return doc;
}

/**
 * A navigation `waitFor` carries `anchorId: null` — it names no element, so
 * there is nothing on screen for a camera to aim at. The editor has to say
 * that rather than quietly omitting the control.
 */
export function sceneWithNavigationWait(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    actions: [
      ...scene.actions,
      {
        id: "act-nav",
        anchorId: null,
        timestamp: 9400,
        marker: "waitFor:navigation",
        kind: "waitFor",
        condition: "loaded",
      },
    ],
  };
}

export function mutatingScene(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    meta: { ...scene.meta, id: "scene-mutating-001" },
    flags: { mutating: true, hoverSensitive: true },
  };
}

/** A take whose first action is a redacted credential — SP5 refuses to replay it. */
export function redactedScene(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    meta: { ...scene.meta, id: "scene-redacted-001" },
    actions: scene.actions.map((a) =>
      a.id === "act-1" && a.kind === "type"
        ? { ...a, text: null, redacted: true }
        : a,
    ),
  };
}

/**
 * Two typed fields, the redacted one SECOND. The order matters: a fixture
 * whose redacted action is already first passes against any comparator,
 * including a reversed one, which is exactly how the original test came to
 * prove nothing.
 */
export function twoTypedScene(): SceneDocument {
  const scene = readonlyScene();
  const search = scene.actions.find((a) => a.id === "act-1");
  if (search?.kind !== "type")
    throw new Error("fixture drift: act-1 is not a type action");
  return {
    ...scene,
    meta: { ...scene.meta, id: "scene-two-typed-001" },
    actions: [
      search,
      {
        id: "act-pw",
        anchorId: "a-checkout",
        timestamp: 5000,
        marker: "type:a-checkout",
        kind: "type",
        text: null,
        redacted: true,
      },
      ...scene.actions.filter((a) => a.id !== "act-1"),
    ],
  };
}

/**
 * `readonlyScene` with a hover between the scroll and the click. The hover
 * sits BETWEEN two other actions on purpose: a reorder index computed within
 * the cursor lane and one computed across the merged take differ only when a
 * hover has actions on both sides of it, so this is the fixture that makes
 * that distinction assertable.
 */
export function hoverScene(): SceneDocument {
  const scene = readonlyScene();
  const [first, second, third] = scene.actions;
  if (!first || !second || !third) throw new Error("readonlyScene changed");
  return {
    ...scene,
    actions: [
      first,
      second,
      {
        id: "act-h",
        anchorId: "a-checkout",
        timestamp: 6000,
        marker: "moveTo:a-checkout",
        kind: "moveTo",
        signal: "style",
      },
      third,
    ],
  };
}

/**
 * Every verb a take can hold, once each: `hoverScene`'s type, scroll, hover
 * and click, plus a wait between the hover and the click. The timeline draws
 * each verb as its own shape, and a fixture missing one would let that
 * verb's rule go unexercised with nothing saying so.
 *
 * Against `proceduralBundle()` the hover and the wait carry no marker, so
 * they draw `estimated` while the other three draw `rendered` — both states
 * in one take.
 */
export function everyVerbScene(): SceneDocument {
  const scene = hoverScene();
  const click = scene.actions[scene.actions.length - 1];
  if (!click) throw new Error("hoverScene changed");
  return {
    ...scene,
    actions: [
      ...scene.actions.slice(0, -1),
      {
        id: "act-w",
        anchorId: "a-checkout",
        timestamp: 7500,
        marker: "waitFor:a-checkout",
        kind: "waitFor",
        condition: "visible",
      },
      {
        id: "act-d",
        anchorId: "a-checkout",
        timestamp: 8000,
        marker: "drag:a-checkout",
        kind: "drag",
        toAnchorId: null,
        to: { by: { x: 120, y: 0 } },
      },
      click,
    ],
  };
}
