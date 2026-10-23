import type { ImageSink } from "./types.js";

export function createPngSink(): ImageSink {
  const files: { name: string; bytes: Uint8Array }[] = [];
  let finished = false;

  return {
    async add(canvas, name) {
      if (finished)
        throw new Error("sink already finish()ed; cannot accept more frames");
      const blob = await canvas.convertToBlob({ type: "image/png" });
      files.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) });
    },
    async finish() {
      finished = true;
      return files;
    },
  };
}
