import { describe, expect, it } from "vitest";
import { VERBS } from "../../src/plan/verbs";

describe("VERBS", () => {
  // The table's two decisions, pinned. A kind added to the schema without an
  // entry fails `pnpm typecheck` (the Record's key type), not this test.
  it("sends the cursor to what is acted on, and not to a scroll or a wait", () => {
    expect(VERBS.click.cursorTravels).toBe(true);
    expect(VERBS.type.cursorTravels).toBe(true);
    expect(VERBS.moveTo.cursorTravels).toBe(true);
    expect(VERBS.scrollTo.cursorTravels).toBe(false);
    expect(VERBS.waitFor.cursorTravels).toBe(false);
  });

  it("lands a scroll where it was recorded and corrects everything else", () => {
    expect(VERBS.scrollTo.approach).toBe("landing");
    expect(VERBS.click.approach).toBe("nearest");
    expect(VERBS.type.approach).toBe("nearest");
    expect(VERBS.moveTo.approach).toBe("nearest");
    expect(VERBS.waitFor.approach).toBe("none");
  });
});
