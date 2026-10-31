// packages/run-core/src/door.ts

import { type DemoScript, DemoScriptSchema } from "@demoman/scene-schema";

/**
 * The door's own envelope for a refusal that happened BEFORE `deps.run` was
 * ever called — bad JSON, a script `DemoScriptSchema` refuses, a non-http
 * target, or a second press while one is already running. `#run-report`
 * must carry SOMETHING parseable for every one of these, because an agent's
 * protocol is "poll `#run-report`, parse JSON" — it does not read
 * `#run-verdict` at all, so a refusal that only painted the verdict line
 * left `#run-report` exactly as empty as before anything happened.
 *
 * Deliberately NOT `RunReport["refused"]`: that field means the POLICY
 * refused a run that was actually attempted (a stage opened, or at least
 * consulted), and it carries `NoticeRoute[]` — routes out of a setting an
 * agent is meant to act on. A door refusal is a different fact entirely: no
 * run was attempted, no window opened, no policy ever consulted. Reusing
 * `refused` would have an agent hunting for routes that do not exist, or
 * believing the mutating-replay gate refused it when its JSON was simply
 * malformed. `outcome` is the discriminator every reader of `#run-report`
 * switches on — `"complete"` | `"stopped"` | `"refused"` are `RunReport`'s
 * own three; `"refusedBeforeRun"` cannot collide with any of them, and
 * means exactly and only this.
 */
export interface RefusedBeforeRun {
  outcome: "refusedBeforeRun";
  /** A stable identifier an agent can branch on without string-matching
   *  prose — `"alreadyRunning"`, `"invalidJson"`, `"notAnObject"`,
   *  `"invalidScript"`, `"unfilledHoles"`, `"nonHttpTarget"`,
   *  `"unknownKit"` (`look.kit` names no kit, or one that cannot be read;
   *  `field` is `"look.kit"`), `"kitsUnreadable"` (the kit list itself could
   *  not be read — a fault, not a wrong name), `"wallpaperUnreadable"`
   *  (`look.branding` names an image path that could not be read or
   *  opened as an image; `field` is `"look.branding.background"`),
   *  `"agentRunsOff"`, `"agentRunsUnreadable"`, and, from Re-shoot,
   *  `"noTakeChosen"` (nothing is chosen in `#from-take`) and
   *  `"authoredTake"` (a script-made take has no recording to replay).
   *  `"unfilledHoles"` is an
   *  invalid script whose refused fields include holes the last derivation
   *  named (`#derive-report`) — a draft not yet finished, not a broken one.
   *  Never reused for two different reasons and
   *  never derived from `detail`. The last two are the door's own gate and
   *  are deliberately distinct: "the author has turned this off" and "the
   *  setting could not be read" call for different moves, and answering the
   *  second with the first would send an agent to flip a switch that is
   *  already where it wants it. */
  reason: string;
  /** The same sentence `#run-verdict` shows, minus its own "Refused: … —
   *  Nothing was run" framing — one human sentence, not painted twice with
   *  two different wordings that could drift apart. */
  detail: string;
  /** The zod issue path(s) for `"invalidScript"` (joined, `"target"` for
   *  `"nonHttpTarget"`), or `null` when the refusal names no single field
   *  (`"alreadyRunning"`, `"invalidJson"`, `"notAnObject"`). For the gate's
   *  two reasons it names the SETTING, `"allowAgentRuns"` — not a script
   *  field, but the one identifier an agent would otherwise have to read out
   *  of the prose. */
  field: string | null;
}
/**
 * http(s) only, decided with the same parser the browser itself uses. Review
 * Focus 4: `DemoScriptSchema`'s `target: z.url()` accepts any syntactically
 * valid URL — `chrome-extension://…`, `file:///etc/passwd` and
 * `javascript:1` all pass it (verified against zod 4's own `z.url()`) — so
 * this is a SEPARATE gate, checked after the schema and before `deps.run` is
 * ever called. `apps/runner` does the same filtering, and for the same
 * reason: a `chrome-extension:` target would point a run at the extension's
 * own pages, which this file must refuse before any window opens.
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
 * The run door's script checks, for a caller with no page: the CLI executor.
 * The same refusals in the same order as the run page's `pressRun`, minus the
 * two that only a page has (`invalidJson`: an MCP call already carries an
 * object; `alreadyRunning`: the executor's slot answers it). The settings,
 * kit and browser checks come after this, in the executor.
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
        `the script derived from a take still has ${plural(open.length, "hole")} to fill (${open.join(", ")}) — the derive report says what each one needs${rest}`,
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
