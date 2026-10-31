// apps/runner/src/compare/study-tally.ts
export interface Tally {
  probes: number;
  runs: number;
  runOutcomes: { outcome: string; verdict: string | null }[];
  exportPath: string | null;
  finalReport: string;
}

const PROBE = "mcp__demoman__probe";
const RUN = "mcp__demoman__run";

type Block = {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
};

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c as { text?: string }).text ?? "").join("")
      : "";

/** Reads `claude -p --output-format stream-json` lines. A run still going
 *  answers `stillRunning`; the `report` result for its id replaces that. */
export function tallyStream(lines: string[]): Tally {
  const t: Tally = {
    probes: 0,
    runs: 0,
    runOutcomes: [],
    exportPath: null,
    finalReport: "",
  };
  const runSlot = new Map<string, number>(); // tool_use id -> runOutcomes index
  const runById = new Map<string, number>(); // demoman run id -> index
  const setRun = (i: number, a: Record<string, unknown>) => {
    const v = a.verdict as { kind?: string } | string | undefined;
    t.runOutcomes[i] = {
      outcome: String(a.outcome ?? a.reason ?? "unanswered"),
      verdict: typeof v === "string" ? v : (v?.kind ?? null),
    };
  };
  for (const line of lines) {
    let ev: {
      type?: string;
      result?: string;
      message?: { content?: Block[] };
    };
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // a non-JSON line is claude's noise, not a tool event
    }
    if (ev.type === "result" && typeof ev.result === "string")
      t.finalReport = ev.result;
    for (const b of ev.message?.content ?? []) {
      if (b.type === "tool_use" && b.id) {
        if (b.name === PROBE) t.probes++;
        if (b.name === RUN) {
          runSlot.set(b.id, t.runOutcomes.length);
          t.runOutcomes.push({ outcome: "unanswered", verdict: null });
          t.runs++;
        }
      }
      if (b.type !== "tool_result") continue;
      let a: Record<string, unknown>;
      try {
        a = JSON.parse(textOf(b.content));
      } catch {
        continue; // not a demoman JSON answer
      }
      const slot = b.tool_use_id ? runSlot.get(b.tool_use_id) : undefined;
      if (slot !== undefined) {
        setRun(slot, a);
        if (typeof a.id === "string") runById.set(a.id, slot);
      } else if (typeof a.id === "string" && runById.has(a.id)) {
        setRun(runById.get(a.id) as number, a);
      }
      const file = a.file as { path?: string } | undefined;
      if (a.outcome === "saved" && typeof file?.path === "string")
        t.exportPath = file.path;
    }
  }
  return t;
}
