import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { pageCapture } from "../src/executor/page-ops.js";

/**
 * Final review 2026-10-30, Important 2: a step waits up to 10 s for its
 * target, and a page that navigates inside that wait destroys the context
 * the capture was evaluating in. That is "not there yet" on the new
 * document, so the wait keeps polling — not `pageFaulted`, whose sentence
 * sends the agent to an app console with nothing wrong in it.
 */
const DESTROYED =
  "page.evaluate: Execution context was destroyed, most likely because of a navigation";

function throwingPage(message: string, closed = false): Page {
  return {
    evaluate: async () => {
      throw new Error(message);
    },
    url: () => "https://app.example.com/next",
    isClosed: () => closed,
  } as unknown as Page;
}

describe("pageCapture", () => {
  it("answers a context destroyed by navigation as not there yet, saying so", async () => {
    const said: string[] = [];
    const answer = await pageCapture(throwingPage(DESTROYED), (line) => {
      said.push(line);
    })({} as never);
    expect(answer.failureReason).toBe("notInTree");
    expect(answer.anchor).toBeNull();
    // The page it landed on, so `pageWentElsewhere` still reaches it.
    expect(answer.pageUrl).toBe("https://app.example.com/next");
    expect(answer.credentialField).toBeNull();
    expect(said.join("\n")).toContain("Execution context was destroyed");
  });

  it("keeps any other throw pageFaulted", async () => {
    const answer = await pageCapture(
      throwingPage("TypeError: boom"),
      () => undefined,
    )({} as never);
    expect(answer.failureReason).toBe("pageFaulted");
  });

  it("keeps a closed page pageFaulted: waiting cannot bring it back", async () => {
    const answer = await pageCapture(
      throwingPage(
        "page.evaluate: Target page, context or browser has been closed",
        true,
      ),
      () => undefined,
    )({} as never);
    expect(answer.failureReason).toBe("pageFaulted");
  });
});
