import { describe, expect, it } from "vitest";
import { readonlyScene } from "../../../replay-engine/test/helpers/scenes";
import { sceneDigest } from "../../src/scene-digest.js";

describe("sceneDigest", () => {
  it("is the same for the same content in any key order", () => {
    const scene = readonlyScene();
    const reordered = Object.fromEntries(
      Object.entries(scene).reverse(),
    ) as typeof scene;
    // Premise: the reorder really moved keys.
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(scene)[0]);
    expect(sceneDigest(reordered)).toBe(sceneDigest(scene));
  });

  it("changes when an edit changes the document", () => {
    const scene = readonlyScene();
    const edited = {
      ...scene,
      cursor: { ...scene.cursor, style: "dark" as const },
    };
    // Premise: the edit really moved a field.
    expect(edited.cursor.style).not.toBe(scene.cursor.style);
    expect(sceneDigest(edited)).not.toBe(sceneDigest(scene));
  });

  it("ignores the toolchain stamp the offscreen renderer adds", () => {
    const scene = readonlyScene();
    const stamped = {
      ...scene,
      meta: {
        ...scene.meta,
        toolchain: { ...scene.meta.toolchain, compositorVersion: "9.9.9" },
      },
    };
    expect(sceneDigest(stamped)).toBe(sceneDigest(scene));
  });

  // Review finding 3. Exporting both shapes is one workflow: the 16:9 file
  // is not "made before your last edit" because the author then toggled
  // 9:16 to export the vertical one. The aspect and the take's name change
  // only the file's name, which already carries them.
  it("ignores the aspect and the take's name", () => {
    const scene = readonlyScene();
    const vertical = { ...scene, canvas: { aspect: "9:16" as const } };
    const renamed = { ...scene, meta: { ...scene.meta, name: "Renamed take" } };
    // Premise: both really differ from the fixture.
    expect(scene.canvas.aspect).toBe("16:9");
    expect(scene.meta.name).not.toBe("Renamed take");
    expect(sceneDigest(vertical)).toBe(sceneDigest(scene));
    expect(sceneDigest(renamed)).toBe(sceneDigest(scene));
  });

  it("changes when only the padding changes", () => {
    const scene = readonlyScene();
    const edited = { ...scene, branding: { ...scene.branding, padding: 0.12 } };
    // Premise: the edit really moved the field.
    expect(edited.branding.padding).not.toBe(scene.branding.padding);
    expect(sceneDigest(edited)).not.toBe(sceneDigest(scene));
  });

  // Review Focus 5 (Auto frame plan): exporting several shapes is one
  // workflow, so switching to Auto leaves earlier exports current. Red if
  // sceneDigest starts reading `canvas`.
  it("does not mark exports stale when the demo is switched to Auto", () => {
    const scene = readonlyScene();
    // Premise: the fixture is not already Auto.
    expect(scene.canvas.aspect).toBe("16:9");
    expect(sceneDigest({ ...scene, canvas: { aspect: "auto" } })).toBe(
      sceneDigest(scene),
    );
  });
});
