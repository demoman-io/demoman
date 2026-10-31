// apps/runner/src/compare/study-briefs.ts
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface Brief {
  name: string;
  url: string;
  reach: string;
  video: string;
  endState: string[];
  /** The brief as a user would say it. */
  body: string;
}

/** `---` front matter of `key: value` lines (and `endState:` with `- ` lines),
 *  then the body. `places.sample` fills `{sample}` everywhere. */
export function loadBriefs(dir: string, places?: { sample: string }): Brief[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      let text = readFileSync(join(dir, file), "utf8");
      if (places) text = text.replaceAll("{sample}", places.sample);
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      if (!m) throw new Error(`${file} has no --- front matter ---`);
      const f: Record<string, string> = {};
      const endState: string[] = [];
      for (const line of (m[1] ?? "").split("\n")) {
        if (line.startsWith("- ")) endState.push(line.slice(2).trim());
        else {
          const i = line.indexOf(":");
          f[line.slice(0, i)] = line.slice(i + 1).trim();
        }
      }
      const brief: Brief = {
        name: basename(file, ".md"),
        url: f.url ?? "",
        reach: f.reach ?? "",
        video: f.video ?? "",
        endState,
        body: (m[2] ?? "").trim(),
      };
      for (const k of ["url", "reach", "video", "body"] as const)
        if (brief[k] === "") throw new Error(`${file} has no ${k}`);
      if (endState.length === 0) throw new Error(`${file} has no endState`);
      return brief;
    });
}

/** The brief, then the rules every study run shares (the Haiku study's, verbatim). */
export function studyPrompt(brief: Brief): string {
  return `${brief.body}

How:
- Use the demoman MCP tools (load them with ToolSearch, e.g. "select:mcp__demoman__recipe,mcp__demoman__status,mcp__demoman__snapshot,mcp__demoman__probe,mcp__demoman__run,mcp__demoman__report,mcp__demoman__export,mcp__demoman__videos"). Call \`recipe\` first and follow it.
- Write the script yourself, from scratch. Do NOT call \`derive\`, and do not read or reuse any existing take, video or script (including anything under apps/runner/compare/). Start a new video named exactly "${brief.video}" — if \`run\` answers possibleDuplicate, pass confirmedNew: true.
- At most three \`run\` calls. Probes are allowed.
- Export the take you accept as an MP4 with default settings. Do not open the Studio.
- Do not edit, create or commit any file in the repository.

Report back, in this order:
1. The final script you ran, verbatim JSON.
2. How many probes and how many runs you used, and what each run's outcome/verdict was.
3. The export's file.path and the accepted take's takeId.
4. Anything that did not go as planned, and anything in the final video you believe is wrong or missing. Say how you know — what you checked — rather than assuming.
`;
}

/** The skip line when the brief's app does not answer; null when it does. */
export async function skipLine(brief: Brief): Promise<string | null> {
  try {
    const res = await fetch(brief.reach, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return null;
  } catch {
    // unreachable: the line below says so
  }
  return `skipped ${brief.name}: ${brief.reach} did not answer (start it with scripts/samples.sh start ${brief.name})`;
}
