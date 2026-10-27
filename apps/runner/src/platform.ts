// apps/runner/src/platform.ts
//
// Which machines Demoman records on: one answer that setup and the browser
// session both read (docs/superpowers/specs/2026-10-26-linux-and-ci-refresh-design.md).

export type PlatformAnswer =
  | { ok: true }
  | { ok: false; reason: "unsupportedPlatform"; detail: string };

/** macOS of either arch, and x86_64 Linux. Chromium on arm64 Linux encodes
 *  VP9 and AV1 but not H.264 (measured, run 40271793769). */
export function recorderPlatform(
  platform: string,
  arch: string,
): PlatformAnswer {
  if (platform === "darwin" || (platform === "linux" && arch === "x64")) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "unsupportedPlatform",
    detail:
      platform === "linux" && arch === "arm64"
        ? "Demoman records on macOS and on x86_64 Linux; Chromium on arm64 Linux has no H.264 encoder, so it could not make a video here"
        : `Demoman records on macOS and on x86_64 Linux, and this machine is ${platform} (${arch})`,
  };
}

/** Linux with neither an X11 nor a Wayland display: a headless server, CI,
 *  or an SSH session. Read by the screen read and by every visible window. */
export const noDisplay = (env: NodeJS.ProcessEnv): boolean =>
  !env.DISPLAY && !env.WAYLAND_DISPLAY;

/** Why a visible window (signin, the Studio, `--headed`) cannot open here,
 *  or null: said at once rather than waiting on a window that never comes. */
export function visibleWindowRefusal(
  platform: string,
  env: NodeJS.ProcessEnv,
): string | null {
  return platform === "linux" && noDisplay(env)
    ? "there is no display here (DISPLAY and WAYLAND_DISPLAY are unset), so no window can open"
    : null;
}
