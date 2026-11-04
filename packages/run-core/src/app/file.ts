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
    url: z
      .string()
      .min(1)
      .refine((u) => /^https?:\/\/\S+$/.test(u), "must be an http(s) URL"),
    timeoutSeconds: z.number().int().positive().default(120),
    env: Env,
    secrets: z.array(
      z
        .string()
        .refine(
          (n) => SECRET_NAME.test(n) && !n.startsWith("GITHUB_"),
          SECRET_NAME_RULE,
        ),
    ),
    services: z.record(z.string(), Service),
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
  return bad(path.join("."), issue.message);
}

export function serializeApp(app: AppSpec): string {
  const {
    appVersion,
    install,
    start,
    url,
    timeoutSeconds,
    env,
    secrets,
    services,
  } = app;
  return `${JSON.stringify({ appVersion, install, start, url, timeoutSeconds, env, secrets, services }, null, 2)}\n`;
}

export function draftHoles(d: AppDraft): string[] {
  return (["start", "url"] as const).filter((k) => d[k] === null);
}
