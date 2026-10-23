// The devices a take can be filmed as besides the desktop: a phone and a
// tablet (author's decision, 2026-10-11 — the size class is what changes a
// page; iPhone and Android were 19 px apart and differed only to a site that
// sniffs the platform). Both wear iOS's identity, with Chrome DevTools'
// emulated-device user agents, the convention authors already know. It is
// Chrome's engine wearing them: Safari's rendering differences are not
// reproduced, and nothing here claims they are.
//
// `deviceScaleFactor` is not a field: every preset is filmed at the replay
// engine's `REPLAY_DPR` (3), not the hardware's own ratio, so frozen frames
// stay as sharp as desktop ones and the page loads its densest images. An
// accepted deviation from the iPad's hardware (spec 2026-10-10 §1).
import { z } from "zod";

export const DEVICE_IDS = ["phone", "tablet"] as const;
export const DeviceIdSchema = z.enum(DEVICE_IDS);
export type DeviceId = z.infer<typeof DeviceIdSchema>;

/**
 * The names before Desktop / Phone / Tablet (2026-10-10 to 2026-10-11).
 * Never shipped, but the author's own takes and popup setting hold them, and
 * a take that stops parsing is a take lost. Read-side only: a script naming
 * one is refused with the devices there are.
 */
const EARLIER_DEVICE_IDS: Readonly<Record<string, DeviceId>> = {
  iphone: "phone",
  android: "phone",
  ipad: "tablet",
};

/** A device id as stored: a take's record or the popup's saved choice. */
export const StoredDeviceIdSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value in EARLIER_DEVICE_IDS
      ? EARLIER_DEVICE_IDS[value]
      : value,
  DeviceIdSchema,
);

/** CDP `Emulation.UserAgentMetadata`, the subset a preset sets. */
export const UserAgentMetadataSchema = z.object({
  brands: z
    .array(z.object({ brand: z.string(), version: z.string() }))
    .optional(),
  platform: z.string(),
  platformVersion: z.string(),
  architecture: z.string(),
  model: z.string(),
  mobile: z.boolean(),
});
export type UserAgentMetadata = z.infer<typeof UserAgentMetadataSchema>;

export interface DeviceEmulation {
  preset: DeviceId;
  label: string;
  width: number;
  height: number;
  mobile: boolean;
  touch: boolean;
  userAgent: string;
  /**
   * Client hints. Every preset carries them, saying mobile: with a UA
   * override and no metadata, Chrome keeps its own `navigator.userAgentData`
   * (`mobile: false`), so a page reading client hints saw a desktop under an
   * iPhone UA (measured 2026-10-10). Real Safari has none at all; "mobile" is
   * the nearer truth. Optional so a take's record of an older preset parses.
   */
  userAgentMetadata?: UserAgentMetadata;
}

export const DEVICES: Record<DeviceId, DeviceEmulation> = {
  phone: {
    preset: "phone",
    label: "Phone",
    width: 393,
    height: 852,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    userAgentMetadata: {
      platform: "iOS",
      platformVersion: "17.0",
      architecture: "",
      model: "iPhone",
      mobile: true,
    },
  },
  tablet: {
    preset: "tablet",
    label: "Tablet",
    width: 820,
    height: 1180,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    userAgentMetadata: {
      platform: "iOS",
      platformVersion: "17.0",
      architecture: "",
      model: "iPad",
      mobile: true,
    },
  },
};

export function deviceFor(id: DeviceId): DeviceEmulation {
  return DEVICES[id];
}

/**
 * What a take records about the device it was filmed as: the preset and the
 * exact values applied, so a later change to `DEVICES` never changes what an
 * existing take means (spec §4).
 */
export const CaptureDeviceSchema = z.object({
  preset: StoredDeviceIdSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mobile: z.boolean(),
  touch: z.boolean(),
  userAgent: z.string().min(1),
  userAgentMetadata: UserAgentMetadataSchema.optional(),
});
export type CaptureDevice = z.infer<typeof CaptureDeviceSchema>;

/** The take's record of a preset, at the moment it is applied. */
export function captureDeviceOf(device: DeviceEmulation): CaptureDevice {
  const { label: _label, ...captured } = device;
  return captured;
}
