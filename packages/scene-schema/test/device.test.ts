import { describe, expect, it } from "vitest";
import {
  CaptureDeviceSchema,
  DEVICE_IDS,
  DEVICES,
  DeviceIdSchema,
  deviceFor,
} from "../src/device";

describe("device presets", () => {
  // Desktop / Phone / Tablet (author's decision, 2026-10-11): the size class
  // is what changes a page, and both carry iOS's identity.
  it("has a phone and a tablet, at the iPhone's and the iPad's sizes", () => {
    expect([...DEVICE_IDS]).toEqual(["phone", "tablet"]);
    expect(deviceFor("phone")).toMatchObject({
      width: 393,
      height: 852,
      label: "Phone",
    });
    expect(deviceFor("tablet")).toMatchObject({
      width: 820,
      height: 1180,
      label: "Tablet",
    });
  });

  it("makes every preset mobile and touch, with an iOS user agent", () => {
    for (const id of DEVICE_IDS) {
      const d = DEVICES[id];
      expect(d.preset).toBe(id);
      expect(d.mobile).toBe(true);
      expect(d.touch).toBe(true);
    }
    expect(deviceFor("phone").userAgent).toMatch(/iPhone/);
    expect(deviceFor("tablet").userAgent).toMatch(/iPad/);
  });

  // Every preset carries client hints that say mobile. Measured 2026-10-10
  // in the integration lane: with a UA override and no metadata, Chrome keeps
  // its own `navigator.userAgentData`, whose `mobile` is false — so a page
  // reading client hints saw a desktop under an iPhone UA. Real Safari has no
  // `userAgentData` at all; "mobile" is the nearer truth for a phone.
  it("gives every preset client hints that say mobile, on its own platform", () => {
    for (const id of DEVICE_IDS) {
      expect(DEVICES[id].userAgentMetadata?.mobile, id).toBe(true);
    }
    expect(deviceFor("phone").userAgentMetadata?.platform).toBe("iOS");
    expect(deviceFor("tablet").userAgentMetadata?.platform).toBe("iOS");
  });
});

// Takes recorded before the rename hold "iphone", "ipad" or "android". They
// were never shipped, but the author's own library has them, and a take
// that no longer parses is a take lost. Scripts get no such reading: an
// agent naming "iphone" is told which devices there are.
describe("a stored take's device, from before Desktop / Phone / Tablet", () => {
  const recorded = (preset: string) => ({
    preset,
    width: 393,
    height: 852,
    mobile: true,
    touch: true,
    userAgent: "iPhone",
  });

  it("reads iphone and android as phone, and ipad as tablet", () => {
    expect(CaptureDeviceSchema.parse(recorded("iphone")).preset).toBe("phone");
    expect(CaptureDeviceSchema.parse(recorded("android")).preset).toBe("phone");
    expect(CaptureDeviceSchema.parse(recorded("ipad")).preset).toBe("tablet");
    expect(CaptureDeviceSchema.parse(recorded("phone")).preset).toBe("phone");
  });

  it("refuses the old names in a script", () => {
    expect(DeviceIdSchema.safeParse("iphone").success).toBe(false);
    expect(DeviceIdSchema.safeParse("phone").success).toBe(true);
  });
});
