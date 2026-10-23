import { describe, expect, it } from "vitest";
import { createSections, section } from "../../../pages/src/editor/sections";

describe("sections", () => {
  it("opens by its default until the author toggles it", () => {
    const sections = createSections();
    expect(sections.isOpen("exported", true)).toBe(true);
    expect(sections.isOpen("share", false)).toBe(false);
  });

  it("remembers a toggle across renders", () => {
    const sections = createSections();
    const first = section("exported", "Exported", sections, true);
    expect(first.details.open).toBe(true);
    expect(first.details.getAttribute("data-section")).toBe("exported");
    expect(first.details.querySelector("summary")?.textContent).toBe(
      "Exported",
    );
    // The UA toggles `open` and fires `toggle`; the section reports it.
    first.details.open = false;
    first.details.dispatchEvent(new Event("toggle"));
    const second = section("exported", "Exported", sections, true);
    expect(second.details.open).toBe(false);
  });

  it("keeps the body as its own element so a caller can fill it", () => {
    const { details, body } = section(
      "source",
      "Source",
      createSections(),
      true,
    );
    expect(body.parentElement).toBe(details);
    expect(details.children).toHaveLength(2);
  });
});
