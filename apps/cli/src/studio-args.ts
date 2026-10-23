// apps/cli/src/studio-args.ts
//
// `demoman studio [takeId] | --stop | --serve`: which of the three, or why
// the arguments are none of them. Pure, so the bin's dispatch is testable
// without a process.
export type StudioCommand =
  | { kind: "open"; takeId?: string }
  | { kind: "stop" }
  | { kind: "serve" }
  | { kind: "error"; message: string };

export function parseStudioArgs(args: string[]): StudioCommand {
  const flags = args.filter((a) => a.startsWith("-"));
  const positionals = args.filter((a) => !a.startsWith("-"));
  const unknown = flags.filter((f) => f !== "--stop" && f !== "--serve");
  if (unknown.length > 0) {
    return {
      kind: "error",
      message: `studio does not take ${unknown.join(" ")}`,
    };
  }
  if (flags.length > 1) {
    return {
      kind: "error",
      message: "studio takes one of --stop or --serve, not both",
    };
  }
  if (flags.length === 1 && positionals.length > 0) {
    return {
      kind: "error",
      message: `studio ${flags[0]} takes no take id`,
    };
  }
  if (positionals.length > 1) {
    return { kind: "error", message: "studio takes one take id" };
  }
  if (flags[0] === "--stop") return { kind: "stop" };
  if (flags[0] === "--serve") return { kind: "serve" };
  const [takeId] = positionals;
  return takeId === undefined ? { kind: "open" } : { kind: "open", takeId };
}
