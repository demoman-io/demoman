// apps/studio/pages/src/shell/topbar.ts
import type { Platform } from "../platform/types";

/** Points the tabbed pages' Settings tab at the platform's Settings page. */
export function mountTopbar(platform: Pick<Platform, "nav">): void {
  document
    .querySelector<HTMLAnchorElement>('a[data-tab="settings"]')
    ?.setAttribute("href", platform.nav.kits());
}
