// apps/studio/pages/src/settings/state.ts
import type { LogoPlacement } from "@demoman/compositor";
import type {
  ExportQualityChoice,
  PullRequestsChoice,
} from "@demoman/studio-protocol";
import type { LogoThumb } from "../branding/controls";
import type { BrandKitsRead } from "../core/brand-kit";

/**
 * Everything the Settings page shows. A section whose read failed carries
 * `null` here and a sentence in the page's notices — the two are set
 * together by the page, never one without the other, so a section can
 * never render as "off" or "empty" when the truth is "unreadable".
 */
export interface SettingsModel {
  /** The brand kits as read — an unreadable list is `invalid` with why,
   *  never presented as empty, and each kit is judged on its own
   *  (`coerceBrandKits`). */
  brandKits: BrandKitsRead;
  /** The kit the card edits: a ready list's selected kit, or null with no
   *  kits. Chosen by the page (the default on load), not stored. */
  selectedKitId: string | null;
  /** Whether the SELECTED kit's logo loaded, and why not if it did not — missing
   *  from storage, refused by it, or stored but undecodable are different
   *  faults (`loadLogo`'s reason says which). Null with no logo. */
  brandKitLogo: { ok: true } | { ok: false; error: string } | null;
  /** The thumbnail beside the kit logo's buttons. Null with no logo. */
  brandKitLogoThumb: LogoThumb | null;
  /** Where the kit's logo lands on the preview, for the cap note. */
  brandKitPlacement: LogoPlacement | null;
  /** Muted notes under the kit's logo row: the JPEG note, a load failure. */
  brandKitNotes: string[];
  /** The user's Pull requests default, or null when it could not be read:
   *  the section then says why and checks nothing, never "Off". Not set
   *  reads `PULL_REQUESTS_DEFAULT` ("ask"). */
  pullRequests: PullRequestsChoice | null;
  /** The studio's Export quality, or null when it could not be read: the
   *  section then says why and checks nothing. Not set reads "share". */
  exportQuality: ExportQualityChoice | null;
  /** Why the kits' change feed will not fire (`platform.kits.unwatched`),
   *  or null while it does: said in the Brand kit section. */
  kitsUnwatched: string | null;
}

export const SECTIONS = ["brandKit", "export", "pullRequests"] as const;
export type Section = (typeof SECTIONS)[number];
