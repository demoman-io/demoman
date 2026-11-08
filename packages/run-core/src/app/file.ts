// `.demoman/app.json`: the one committed record of how the app starts.
// Neither the workflow nor any door re-derives it. Secret VALUES never live
// here: `secrets` names them, `env` is committed and must not look like one.
import { z } from "zod";
import { looksLikeSecret } from "../secrets.js";

export const APP_FILE = ".demoman/app.json";
const APP_VERSION = 1;
const SECRET_NAME_RULE =
  "a secret name is A-Z, 0-9 and _, not starting with a digit or GITHUB_";
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 instant with a zone, that names a real moment
 *  (`2026-11-06T09:00:00Z`; not a bare date, nor a time without a zone). */
export const isInstant = (s: string): boolean => {
  if (!INSTANT.test(s)) return false;
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  const day = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  // Date.parse rolls 2026-02-30 over to March: the calendar date must survive.
  return (
    !Number.isNaN(Date.parse(s)) &&
    day.getUTCMonth() === (m as number) - 1 &&
    day.getUTCDate() === d
  );
};

export interface AppService {
  image: string;
  ports: string[];
  env: Record<string, string>;
  options: string | null;
}
export interface AppSpec {
  appVersion: 1;
  install: string[];
  start: string;
  /** Run before each flow, so one flow's changes never show in the next
   *  (DEM-57). Named by the person or agent; never guessed. */
  reset?: string;
  /** The instant the app is recorded at when Demoman starts it, handed to
   *  it as DEMOMAN_NOW (DEM-79). Set by the person; never written by Demoman. */
  now?: string;
  url: string;
  timeoutSeconds: number;
  env: Record<string, string>;
  secrets: string[];
  services: Record<string, AppService>;
}
export type AppDraft = Omit<AppSpec, "start" | "url"> & {
  start: string | null;
  url: string | null;
};

const Env = z.record(z.string(), z.string()).superRefine((env, ctx) => {
  for (const [name, value] of Object.entries(env)) {
    if (looksLikeSecret(value)) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `${name} looks like a secret; list ${name} under "secrets" and keep its value out of this committed file`,
      });
    }
  }
});
const Service = z
  .object({
    image: z.string().min(1),
    ports: z.array(z.string()),
    env: Env,
    options: z.string().nullable(),
  })
  .strict();
const AppSchema = z
  .object({
    appVersion: z.literal(APP_VERSION),
    install: z.array(z.string().min(1)),
    start: z.string().min(1),
    reset: z.string().min(1).optional(),
    now: z
      .string()
      .refine(
        isInstant,
        "must be an ISO 8601 instant with a zone, e.g. 2026-11-06T09:00:00Z",
      )
      .optional(),
    url: z
      .string()
      .min(1)
      .refine((u) => /^https?:\/\/\S+$/.test(u), "must be an http(s) URL"),
    timeoutSeconds: z.number().int().positive().default(120),
    // Defaulted like timeoutSeconds: a hand-written file may leave them out (DEM-48).
    env: Env.default({}),
    secrets: z
      .array(
        z
          .string()
          .refine(
            (n) => SECRET_NAME.test(n) && !n.startsWith("GITHUB_"),
            SECRET_NAME_RULE,
          ),
      )
      .default([]),
    services: z.record(z.string(), Service).default({}),
  })
  .strict();

export function parseApp(
  text: string,
  file: string,
):
  | { ok: true; app: AppSpec }
  | { ok: false; reason: "appInvalid"; field: string; detail: string } {
  const bad = (field: string, detail: string) =>
    ({
      ok: false,
      reason: "appInvalid",
      field,
      detail: `${file}: ${detail}`,
    }) as const;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return bad(
      "",
      `not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const version = (raw as { appVersion?: unknown } | null)?.appVersion;
  if (typeof version === "number" && version > APP_VERSION) {
    return bad(
      "appVersion",
      `appVersion ${version} was written by a newer Demoman than this one; update Demoman`,
    );
  }
  const parsed = AppSchema.safeParse(raw);
  if (parsed.success) return { ok: true, app: parsed.data as AppSpec };
  const issue = parsed.error.issues[0];
  if (!issue) return bad("", "does not match the app file shape");
  const path = issue.code === "unrecognized_keys" ? issue.keys : issue.path;
  const field = path.join(".");
  return bad(
    field,
    field === "" ? issue.message : `${field}: ${issue.message}`,
  );
}

export function serializeApp(app: AppSpec): string {
  const {
    appVersion,
    install,
    start,
    reset,
    now,
    url,
    timeoutSeconds,
    env,
    secrets,
    services,
  } = app;
  // reset and now only when set: a file written before them serializes as before.
  return `${JSON.stringify({ appVersion, install, start, ...(reset === undefined ? {} : { reset }), ...(now === undefined ? {} : { now }), url, timeoutSeconds, env, secrets, services }, null, 2)}\n`;
}

export function draftHoles(d: AppDraft): string[] {
  return (["start", "url"] as const).filter((k) => d[k] === null);
}
