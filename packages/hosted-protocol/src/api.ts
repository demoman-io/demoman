/**
 * The hosted service's API, as the CLI and the service both read it
 * (docs/superpowers/specs/2026-11-07-hosted-links-design.md).
 */

export const HOSTED_ROUTES = {
  cliLoginStart: "POST /api/hosted/cli/login/start",
  cliLoginPoll: "POST /api/hosted/cli/login/poll",
  cliLogout: "POST /api/hosted/cli/logout",
  me: "GET /api/hosted/me",
  uploadCreate: "POST /api/hosted/uploads",
  uploadPart: "PUT /api/hosted/uploads/:id/parts/:n",
  uploadPoster: "PUT /api/hosted/uploads/:id/poster",
  uploadComplete: "POST /api/hosted/uploads/:id/complete",
  linkCreate: "POST /api/hosted/links",
  linkList: "GET /api/hosted/links",
  linkChange: "PATCH /api/hosted/links/:id",
  linkDelete: "DELETE /api/hosted/links/:id",
} as const;

export type HostedReason =
  | "signedOut"
  | "invalidRequest"
  | "notFound"
  | "rateLimited"
  | "tooLarge"
  | "notUploaded"
  | "notMp4"
  | "notDemoman"
  | "tooLong"
  | "posterInvalid"
  | "freeLimit"
  | "invalidExpiry"
  | "loginExpired"
  | "notInvited"
  | "unavailable";

export type Refused = { ok: false; reason: HostedReason; detail: string };

export type LoginStart = {
  code: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
  intervalMs: number;
};

export type LoginPoll =
  | { pending: true }
  | { token: string; login: string; workspace: { id: string; name: string } };

export type Me = {
  login: string;
  workspace: { id: string; name: string; plan: "free" | "team" };
  links: { active: number; limit: number | null };
};

export type UploadCreated = { id: string; partSize: number; parts: number };

export type UploadCompleted = {
  id: string;
  durationS: number;
  tag: {
    flow: string;
    video: string;
    commit: string | null;
    dirty: boolean | null;
  };
};

export type LinkCreateRequest = {
  upload: string;
  title: string;
  expiresAt: string | null;
};

export type Link = {
  id: string;
  title: string;
  pageUrl: string;
  fileUrl: string;
  posterUrl: string;
  createdAt: string;
  expiresAt: string | null;
};
