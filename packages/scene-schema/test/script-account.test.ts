import { describe, expect, it } from "vitest";
import { DemoScriptSchema, SCRIPT_VERSION_ACCOUNT } from "../src/index.js";

const base = {
  name: "behind the login",
  target: "http://localhost:4000/admin/orders",
  steps: [{ do: "waitForLoad" }],
};

describe("a script's account", () => {
  it("is version 5", () => {
    expect(SCRIPT_VERSION_ACCOUNT).toBe(5);
  });

  it("is read at version 5", () => {
    const parsed = DemoScriptSchema.safeParse({
      ...base,
      scriptVersion: 5,
      account: "seller",
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.account).toBe("seller");
  });

  it("is refused below version 5, naming scriptVersion", () => {
    const parsed = DemoScriptSchema.safeParse({
      ...base,
      scriptVersion: 4,
      account: "seller",
    });
    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues.find(
      (i) => i.path.join(".") === "scriptVersion",
    );
    expect(issue?.message).toContain("scriptVersion 5");
    expect(issue?.message).toContain("account");
  });

  it("refuses a name that cannot be a file name", () => {
    const parsed = DemoScriptSchema.safeParse({
      ...base,
      scriptVersion: 5,
      account: "../seller",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a name with a capital: macOS file names ignore case (final review I4)", () => {
    const lower = DemoScriptSchema.safeParse({
      ...base,
      scriptVersion: 5,
      account: "seller",
    });
    // Positive control: the same script with a lower-case name parses.
    expect(lower.success).toBe(true);
    const upper = DemoScriptSchema.safeParse({
      ...base,
      scriptVersion: 5,
      account: "Seller",
    });
    expect(upper.success).toBe(false);
    // The refusal states the rule (C2 residual r2).
    expect(upper.error?.issues[0]?.message).toContain("lower-case letters");
  });
});

describe("secrets in a demo script", () => {
  it("are refused, naming the step's text", () => {
    const parsed = DemoScriptSchema.safeParse({
      ...base,
      scriptVersion: 1,
      steps: [
        {
          do: "type",
          into: { role: "textbox", name: "Password" },
          text: "{secret:KL_PASSWORD}",
        },
      ],
    });
    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues.find(
      (i) => i.path.join(".") === "steps.0.text",
    );
    expect(issue?.message).toContain(".demoman/accounts.json");
  });

  it("leave ordinary braces alone (positive control)", () => {
    const parsed = DemoScriptSchema.safeParse({
      ...base,
      scriptVersion: 1,
      steps: [
        {
          do: "type",
          into: { role: "textbox", name: "Note" },
          text: "{not a secret}",
        },
      ],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
