import { describe, expect, it } from "vitest";
import { paintKitPreview } from "../../../pages/src/settings/kit-preview";

/**
 * The Settings page's Brand kit preview, as painted. It uses the
 * compositor's own painters, so a kit previewed here is the kit an export
 * draws — but only if the preview actually paints, which a rect cannot say.
 */
function canvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 480;
  c.height = 270;
  return c;
}
const at = (c: HTMLCanvasElement, x: number, y: number) =>
  Array.from(
    (c.getContext("2d") as CanvasRenderingContext2D).getImageData(x, y, 1, 1)
      .data,
  );

describe("paintKitPreview", () => {
  it("paints the kit's background in the margin and a card for the recording", () => {
    const c = canvas();
    const drew = paintKitPreview(
      c,
      {
        background: { kind: "solid", color: "#1b2a4a" },
        logo: null,
        padding: 0.08,
      },
      null,
      "#ffffff",
    );
    expect(drew).toBe(true);
    expect(at(c, 4, 4)).toEqual([0x1b, 0x2a, 0x4a, 255]);
    // The stand-in card at the centre, not background.
    expect(at(c, c.width / 2, c.height / 2)).toEqual([255, 255, 255, 255]);
  });

  // Final review, Important (2026-10-06): every new take is Auto, and the
  // kit previewed 16:9 — side bars at padding 0 around the 1280x800 card,
  // the very misconception Auto removes, and a logo cap note for a frame no
  // new take uses. Red if the preview keeps a fixed 16:9 frame.
  it("previews the kit in the Auto frame a new take starts on", () => {
    const c = canvas();
    const kit = {
      background: { kind: "solid" as const, color: "#1b2a4a" },
      logo: null,
      padding: 0,
    };
    expect(paintKitPreview(c, kit, null, "#ffffff")).toBe(true);
    // The FRAME takes the recording's own shape, 1280x800 = 1.6, so at 480
    // wide it is 300 tall, painted at the top of the canvas.
    const frame = { width: 480, height: 300 };
    expect(c.width).toBe(frame.width);
    for (const [x, y] of [
      [0, 0],
      [frame.width - 1, 0],
      [0, frame.height - 1],
      [frame.width - 1, frame.height - 1],
      [frame.width / 2, 0],
      [0, frame.height / 2],
    ] as const) {
      expect(at(c, x, y), `${x},${y} of ${c.width}x${c.height}`).toEqual([
        255, 255, 255, 255,
      ]);
    }
    // Below the frame the box is left clear — so the frame is 300 tall,
    // not the box's height.
    expect(c.height).toBeGreaterThan(frame.height);
    expect(at(c, 0, frame.height)[3]).toBe(0);
    // Premise: with a margin, the same probe is background — so the probes
    // above tell card from background.
    paintKitPreview(c, { ...kit, padding: 0.08 }, null, "#ffffff");
    expect(at(c, 0, 0)).toEqual([0x1b, 0x2a, 0x4a, 255]);
  });

  // Review 2026-10-06: the canvas was resized to each padding's frame, and
  // a Padding drag grew it under the pointer. Red if its size follows the
  // padding again; the frame inside it is what moves.
  it("keeps one canvas size for every padding, the tallest frame's", () => {
    const c = canvas();
    const kit = {
      background: { kind: "solid" as const, color: "#1b2a4a" },
      logo: null,
      padding: 0,
    };
    const sizes = [0, 0.08, 0.2].map((padding) => {
      paintKitPreview(c, { ...kit, padding }, null, "#ffffff");
      return [c.width, c.height];
    });
    expect(sizes).toEqual([sizes[2], sizes[2], sizes[2]]);
    // At the ceiling the frame fills the box: its last row is background.
    expect(at(c, 0, c.height - 1)).toEqual([0x1b, 0x2a, 0x4a, 255]);
    // And at 0 it does not, so the box really is taller than that frame.
    paintKitPreview(c, kit, null, "#ffffff");
    expect(at(c, 0, c.height - 1)[3]).toBe(0);
  });

  it("says it drew nothing when there is no 2D context", () => {
    const stub = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(
      paintKitPreview(
        stub,
        {
          background: { kind: "solid", color: "#000000" },
          logo: null,
          padding: 0.08,
        },
        null,
        "#ffffff",
      ),
    ).toBe(false);
  });
});
