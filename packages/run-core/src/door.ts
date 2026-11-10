// packages/run-core/src/door.ts

import { type DemoScript, DemoScriptSchema } from "@demoman/scene-schema";

/**
 * The door's own envelope for a refusal that happened BEFORE `deps.run` was
 * ever called — a script `DemoScriptSchema` refuses, a non-http target, or a
 * second run while one is already running. The executor answers the call
 * with it, so an agent gets SOMETHING parseable for every one of these
 * rather than an answer that reads as if nothing happened.
 *
 * Deliberately NOT `RunReport["refused"]`: that field means the POLICY
 * refused a run that was actually attempted (a stage opened, or at least
 * consulted), and it carries `NoticeRoute[]` — routes out of a setting an
 * agent is meant to act on. A door refusal is a different fact entirely: no
 * run was attempted, no window opened, no policy ever consulted. Reusing
 * `refused` would have an agent hunting for routes that do not exist, or
 * believing the mutating-replay gate refused it when its JSON was simply
 * malformed. `outcome` is the discriminator every reader of a run's answer
 * switches on — `"complete"` | `"stopped"` | `"refused"` are `RunReport`'s
 * own three; `"refusedBeforeRun"` cannot collide with any of them, and
 * means exactly and only this.
 */
export interface RefusedBeforeRun {
  outcome: "refusedBeforeRun";
  /** A stable identifier an agent can branch on without string-matching
   *  prose. `checkScript` below gives `"notAnObject"`, `"invalidScript"`,
   *  `"unfilledHoles"` and `"nonHttpTarget"`; the executor adds its own,
   *  among them `"alreadyRunning"`, `"unknownKit"` (`look.kit` names no
   *  kit, or one that cannot be read; `field` is `"look.kit"`),
   *  `"kitsUnreadable"` (the kit list itself could not be read — a fault,
   *  not a wrong name) and `"wallpaperUnreadable"` (`look.branding` names an
   *  image path that could not be read or opened as an image; `field` is
   *  `"look.branding.background"`). `"unfilledHoles"` is an invalid script
   *  whose refused fields include holes the last derivation named (the
   *  derive report) — a draft not yet finished, not a broken one. Never
   *  reused for two different reasons and never derived from `detail`. */
  reason: string;
  /** One human sentence saying why, for the agent to tell the user. */
  detail: string;
  /** The zod issue path(s) for `"invalidScript"` (joined, `"target"` for
   *  `"nonHttpTarget"`), or `null` when the refusal names no single field
   *  (`"alreadyRunning"`, `"notAnObject"`). */
  field: string | null;
}
/**
 * http(s) only, decided with the same parser the browser itself uses. Review
 * Focus 4: `DemoScriptSchema`'s `target: z.url()` accepts any syntactically
 * valid URL — `chrome-extension://…`, `file:///etc/passwd` and
 * `javascript:1` all pass it (verified against zod 4's own `z.url()`) — so
 * this is a SEPARATE gate, checked after the schema and before `deps.run` is
 * ever called. `apps/runner` does the same filtering, and for the same
 * reason: a `chrome-extension:` target would point a run at a browser
 * extension's own pages, which this file must refuse before any window opens.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export type FailedScriptParse = ReturnType<
  (typeof DemoScriptSchema)["safeParse"]
> & {
  success: false;
};

/** Every zod issue's own field path — `["scriptVersion"]`, `["steps", 0]`,
 *  etc., joined per-issue so `field` in `RefusedBeforeRun` below can name
 *  more than one without losing which is which. `"(script)"` stands in for
 *  the top-level issue a `superRefine` (like `DemoScriptSchema`'s own "every
 *  step is a pause") reports with an empty path. */
export function scriptIssueFields(result: FailedScriptParse): string[] {
  return result.error.issues.flatMap(issueFields);
}

export type ScriptIssue = FailedScriptParse["error"]["issues"][number];

/**
 * The field path(s) one zod issue names. A key the strict step schema refuses
 * (`button`, `host` — both holes a derived draft can carry) arrives as
 * `unrecognized_keys` with the STEP's path and the key in `keys`, so joining
 * the path alone named `steps.1` — which step, not which field. The key is
 * appended, once per key, so the refusal names the same path the hole does.
 */
export function issueFields(issue: ScriptIssue): string[] {
  const at = issue.path.join(".");
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => (at === "" ? key : `${at}.${key}`));
  }
  return [at || "(script)"];
}

/** One line per zod issue, its field path first — the only shape that lets
 *  an agent (or this file's own `/scriptVersion/`-shaped test) see which
 *  field refused, rather than a bare "invalid script". */
export function formatScriptError(result: FailedScriptParse): string {
  return result.error.issues
    .map((issue) => `${issueFields(issue).join(", ")}: ${issue.message}`)
    .join("; ");
}

const plural = (n: number, one: string): string =>
  `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The run door's script checks, for the CLI executor and its probe. No
 * `invalidJson` (an MCP call already carries an object) and no
 * `alreadyRunning` (the executor's slot answers it). The settings, kit and
 * browser checks come after this, in the executor.
 */
export function checkScript(
  raw: unknown,
  holePaths: readonly string[],
):
  | {
      ok: true;
      script: DemoScript;
      /** The version the script stated, when Demoman raised it to what the script uses. */
      versionRaisedFrom?: number;
    }
  | { ok: false; refusal: RefusedBeforeRun } {
  const refuse = (
    reason: string,
    detail: string,
    field: string | null = null,
  ) => ({
    ok: false as const,
    refusal: { outcome: "refusedBeforeRun" as const, reason, detail, field },
  });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse(
      "notAnObject",
      `the script must be a JSON object, not ${Array.isArray(raw) ? "an array" : typeof raw}`,
    );
  }
  const parsed = DemoScriptSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = scriptIssueFields(parsed);
    const open = holePaths.filter((p) => fields.includes(p));
    if (open.length > 0) {
      const others = parsed.error.issues.filter(
        (issue) => !issueFields(issue).some((f) => open.includes(f)),
      );
      const rest =
        others.length === 0
          ? ""
          : `; and besides the holes — ${others.map((i) => `${issueFields(i).join(", ")}: ${i.message}`).join("; ")}`;
      return refuse(
        "unfilledHoles",
        `the script derived from a video still has ${plural(open.length, "hole")} to fill (${open.join(", ")}) — the derive report says what each one needs${rest}`,
        fields.join(", "),
      );
    }
    return refuse(
      "invalidScript",
      `the script is not a valid DemoScript — ${formatScriptError(parsed)}`,
      fields.join(", "),
    );
  }
  if (!isHttpUrl(parsed.data.target)) {
    return refuse(
      "nonHttpTarget",
      `the target must be an http(s) URL — "${parsed.data.target}" is not one`,
      "target",
    );
  }
  const stated = (raw as { scriptVersion?: unknown }).scriptVersion;
  return {
    ok: true,
    script: parsed.data,
    ...(typeof stated === "number" && stated < parsed.data.scriptVersion
      ? { versionRaisedFrom: stated }
      : {}),
  };
}
