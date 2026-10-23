// The one place a device is put on a page (spec 2026-10-10 §1). Every stage
// that films a phone — the authored walk, rebuild, snapshot, the manual phone
// window — calls this before navigating, so the server sees the mobile UA and
// the page reads its meta viewport on first load.
import type { DeviceEmulation, DeviceId } from "@demoman/scene-schema";
import { REPLAY_DPR } from "./constants.js";
import type { CdpSession } from "./types.js";

/** A preset (`DeviceEmulation`) or a take's record of one (`CaptureDevice`),
 *  which carries no label. */
export type DeviceLike = Pick<
  DeviceEmulation,
  "width" | "height" | "mobile" | "touch" | "userAgent" | "userAgentMetadata"
> & { preset: DeviceId; label?: string };

/** Thrown, never defaulted: a phone take that films the desktop is a failure
 *  reporting success. The walk turns this into `deviceFailed`. */
export class DeviceEmulationError extends Error {}

/** The metrics override for a desktop page at `viewport` — the walk's when it
 *  films no device, and the snapshot's, which must lay the page out exactly
 *  as the run it is taken for. One function so the two cannot drift. */
export function desktopMetrics(viewport: {
  width: number;
  height: number;
}): Record<string, unknown> {
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: REPLAY_DPR,
    mobile: false,
  };
}

/** The metrics override for a device. `scale` below 1 only for a manual
 *  phone window that does not fit the screen (`phone-window.ts`). */
export function deviceMetrics(
  device: DeviceLike,
  scale = 1,
): Record<string, unknown> {
  return {
    width: device.width,
    height: device.height,
    deviceScaleFactor: REPLAY_DPR,
    mobile: device.mobile,
    ...(scale === 1 ? {} : { scale }),
  };
}

export async function applyDevice(
  cdp: CdpSession,
  device: DeviceLike,
  scale = 1,
): Promise<void> {
  const step = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await cdp.send(method, params);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new DeviceEmulationError(
        `could not emulate ${device.label ?? device.preset}: ${method} — ${why}`,
      );
    }
  };
  await step(
    "Emulation.setDeviceMetricsOverride",
    deviceMetrics(device, scale),
  );
  if (device.touch) {
    await step("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    // So a person's mouse arrives as touch in a manual phone take, the way
    // DevTools device mode behaves.
    await step("Emulation.setEmitTouchEventsForMouse", {
      enabled: true,
      configuration: "mobile",
    });
  }
  await step("Emulation.setUserAgentOverride", {
    userAgent: device.userAgent,
    ...(device.userAgentMetadata === undefined
      ? {}
      : { userAgentMetadata: device.userAgentMetadata }),
  });
}
