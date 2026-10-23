/**
 * gifenc ships no type declarations (no "types" field, no bundled .d.ts —
 * verified against node_modules/gifenc@1.0.3). This covers only the surface
 * this package actually calls: quantizing one RGBA frame to an indexed
 * palette and streaming indexed frames into a GIF89a encoder.
 */
declare module "gifenc" {
  export type RGB = [number, number, number];
  export type RGBA = [number, number, number, number];
  export type Palette = RGB[] | RGBA[];

  export interface QuantizeOptions {
    format?: "rgb565" | "rgb444" | "rgba4444";
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  }

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): Palette;

  export interface ApplyPaletteOptions {
    format?: "rgb565" | "rgb444" | "rgba4444";
  }

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    options?: ApplyPaletteOptions,
  ): Uint8Array;

  export interface GIFEncoderOptions {
    initialCapacity?: number;
    auto?: boolean;
  }

  export interface WriteFrameOptions {
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    palette?: Palette | null;
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface GIFEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: WriteFrameOptions,
    ): void;
  }

  export function GIFEncoder(options?: GIFEncoderOptions): GIFEncoderInstance;
}
