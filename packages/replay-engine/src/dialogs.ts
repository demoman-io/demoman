import type {
  DialogIntent,
  DialogKind,
  DialogRecord,
} from "@demoman/scene-schema";
import type { CdpSession } from "./types.js";

/**
 * JavaScript dialogs (DEM-161). Every dialog that opens while the walk runs
 * is answered here, as the armed step asks or OK by default, and recorded.
 *
 * The answer is sent from inside the event, never after the step: while a
 * dialog is open the page's script is blocked, so Chrome does not answer the
 * `Input.dispatchMouseEvent` (or key) that opened it, and the click probe's
 * read waits too. Answering after the verb would wait on itself.
 */

/** A dialog the run answered, with the action it opened during, or null for
 *  one that opened with no step armed (a page load, between steps). */
export type AnsweredDialog = DialogRecord & { actionId: string | null };

export interface DialogAnswerer {
  /** Before a click, type or press: what it opens is its own. */
  arm(actionId: string, intent: DialogIntent | undefined): void;
  /**
   * After the verb: the step's dialogs, the script's answer that did not fit
   * the dialog that opened (answered OK instead), and an answer the browser
   * has refused by now. Does not wait: a step that opened no dialog must not
   * move the walk's clock (`walk-plan.test.ts`), and a refusal that arrives
   * later is said by `stop`.
   */
  disarm(): {
    records: DialogRecord[];
    unfit?: { kind: DialogKind; intent: DialogIntent };
    failed?: string;
  };
  /** Every dialog answered, in order. */
  answered(): AnsweredDialog[];
  /** Stops listening, waits for the answers sent, and answers a refusal no
   *  `disarm` has said yet. */
  stop(): Promise<string | null>;
}

/** Whether `intent` is an answer a dialog of `kind` can take: an alert has
 *  only OK, and only a prompt takes text. */
const fits = (kind: DialogKind, intent: DialogIntent): boolean =>
  intent === "accept" ||
  (intent === "dismiss" ? kind !== "alert" : kind === "prompt");

const hostOf = (url: unknown): string => {
  try {
    return new URL(String(url)).host;
  } catch {
    // The host is what the record names the dialog by; a page whose address
    // does not parse is named by none, and the message still says what it was.
    return "";
  }
};

export function createDialogAnswerer(
  cdp: CdpSession,
  beatMs: number,
): DialogAnswerer {
  const answered: AnsweredDialog[] = [];
  const sending: Promise<void>[] = [];
  let failed: string | null = null;
  let armed: {
    actionId: string;
    intent: DialogIntent | undefined;
    from: number;
    unfit?: { kind: DialogKind; intent: DialogIntent };
  } | null = null;

  const off = cdp.on("Page.javascriptDialogOpening", (params) => {
    const kind = params.type as DialogKind;
    const message = String(params.message ?? "");
    // The script's answer is for the first dialog its step opens.
    const asked =
      armed !== null && answered.length === armed.from
        ? armed.intent
        : undefined;
    const unfit = asked !== undefined && !fits(kind, asked);
    if (unfit && armed !== null) armed.unfit ??= { kind, intent: asked };
    const intent = asked === undefined || unfit ? "accept" : asked;
    const text =
      typeof intent === "object"
        ? intent.text
        : kind === "prompt" && intent === "accept"
          ? String(params.defaultPrompt ?? "")
          : undefined;
    answered.push({
      kind,
      host: hostOf(params.url),
      message,
      answer: intent === "dismiss" ? "dismiss" : "accept",
      // What the prompt was answered with, the script's text or its default.
      ...(text === undefined ? {} : { text }),
      by: asked === undefined || unfit ? "default" : "script",
      beatMs,
      actionId: armed?.actionId ?? null,
    });
    sending.push(
      cdp
        .send("Page.handleJavaScriptDialog", {
          accept: intent !== "dismiss",
          ...(text === undefined ? {} : { promptText: text }),
        })
        .then(
          () => undefined,
          (error: unknown) => {
            failed ??= `the ${kind} "${message}" could not be answered: ${error instanceof Error ? error.message : String(error)}`;
          },
        ),
    );
  });

  /** The refusal not said yet, once said. */
  const said = (): string | null => {
    const note = failed;
    failed = null;
    return note;
  };

  return {
    arm(actionId, intent) {
      armed = { actionId, intent, from: answered.length };
    },
    disarm() {
      const step = armed;
      armed = null;
      const note = said();
      const records = answered
        .slice(step?.from ?? answered.length)
        .map(({ actionId: _, ...record }) => record);
      return {
        records,
        ...(step?.unfit === undefined ? {} : { unfit: step.unfit }),
        ...(note === null ? {} : { failed: note }),
      };
    },
    answered: () => [...answered],
    async stop() {
      off();
      armed = null;
      await Promise.all(sending);
      return said();
    },
  };
}
