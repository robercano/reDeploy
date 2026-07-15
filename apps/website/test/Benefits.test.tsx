import { render, screen } from "@testing-library/react";
import Benefits from "../src/components/Benefits.js";
import { BENEFITS } from "../src/content.js";

describe("Benefits", () => {
  it("labels the section with the heading via aria-labelledby", () => {
    render(<Benefits />);

    const heading = screen.getByRole("heading", { level: 2, name: "Why teams use reDeploy" });
    expect(heading).toHaveAttribute("id", "benefits-heading");

    const section = heading.closest("section");
    expect(section).toHaveAttribute("aria-labelledby", "benefits-heading");
  });

  it("wraps the heading, lede, and card list in a single alignment container", () => {
    render(<Benefits />);

    const heading = screen.getByRole("heading", { level: 2, name: "Why teams use reDeploy" });
    const list = screen.getByRole("list");

    // Regression guard for #132: heading and list must share one common
    // parent (the `.benefits__inner` wrapper) so they get identical
    // horizontal alignment instead of each being centered independently.
    const headingWrapper = heading.parentElement;
    expect(headingWrapper).toHaveClass("benefits__inner");
    expect(headingWrapper).toContainElement(list);
  });

  it("renders all five benefit cards, none dropped or duplicated", () => {
    render(<Benefits />);

    const list = screen.getByRole("list");
    const items = list.querySelectorAll(":scope > .benefits__item");
    expect(items).toHaveLength(5);
    expect(items).toHaveLength(BENEFITS.length);

    for (const benefit of BENEFITS) {
      expect(screen.getByRole("heading", { level: 3, name: benefit.title })).toBeInTheDocument();
      expect(screen.getByText(benefit.packageName)).toBeInTheDocument();
    }
  });

  it("uses a wrapping flex layout for the card list so an uneven last row centers instead of stretching", () => {
    // jsdom doesn't compute real layout, but we can assert the structural
    // choice that guards against the 4-on-top + 1-orphan grid regression:
    // every card is a direct <li class="benefits__item"> of the same
    // <ul class="benefits__list">, with no per-item inline width hacks that
    // would fight the CSS wrap/centering behavior.
    render(<Benefits />);

    const list = screen.getByRole("list");
    expect(list).toHaveClass("benefits__list");

    const items = list.querySelectorAll(":scope > li");
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item).toHaveClass("benefits__item");
      expect(item.getAttribute("style")).toBeNull();
    }
  });
});
