import type { FrameImage } from "@demoman/compositor";

/**
 * A stored frame's bytes as the compositor's frame sources want them: a
 * motion span (`span:`) as its raw container bytes, which the compositor
 * demuxes itself; every other ref (a `kf:` keyframe) decoded to an image.
 *
 * One rule for both sides of `#platform`: the extension's
 * `createMessagingBundleSource` reads the bytes from IndexedDB, the studio's
 * `http.ts` from `GET /api/takes/:id/frames/:ref`, and both hand them here.
 * Its own module so the studio's bundle can take it without the IndexedDB
 * frame store `bundle-source.ts` defaults to.
 */
export async function decodeFrame(
  ref: string,
  bytes: Uint8Array,
): Promise<Uint8Array | FrameImage> {
  // Both frame sources discriminate on what comes back rather than on the
  // ref, and both reject the wrong one — `createVideoFrameSource` throws on
  // a keyframe that loads as bytes, `createImageFrameSource` on a span. The
  // store already encodes which is which in the ref prefix.
  if (ref.startsWith("span:")) return bytes;
  // `.slice()`: the stores type bytes as Uint8Array<ArrayBufferLike>,
  // BlobPart demands Uint8Array<ArrayBuffer>, and the Blob copies
  // regardless.
  const blob = new Blob([bytes.slice()], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  // The raw loader the compositor's frame sources wrap; both stamp the real
  // keyframe time over this one before it reaches a renderer, so it never
  // leaks past here.
  return {
    image: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    sourceTimeMs: 0,
  };
}
