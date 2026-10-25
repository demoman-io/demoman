/**
 * Wall-clock time per stage of one run or export, said as one log line
 * (`timing run …: walk 12.31s, mux 4.02s, …`). A measurement aid: it changes
 * nothing a run does, and the line is the only place it shows. Each `mark`
 * closes the stage that began at the previous mark (or at creation).
 */
export interface StageTimes {
  mark(stage: string): void;
  /** Free text appended after the stages, e.g. what the render page saw. */
  note(text: string): void;
  line(what: string): string;
}

export function stageTimes(
  now: () => number = () => performance.now(),
): StageTimes {
  const start = now();
  let last = start;
  const stages: string[] = [];
  const notes: string[] = [];
  const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  return {
    mark(stage) {
      const t = now();
      stages.push(`${stage} ${secs(t - last)}`);
      last = t;
    },
    note(text) {
      notes.push(text);
    },
    line(what) {
      const tail = notes.length > 0 ? `; ${notes.join("; ")}` : "";
      return `timing ${what}: ${stages.join(", ")}; total ${secs(last - start)}${tail}`;
    },
  };
}
