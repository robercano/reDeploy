import { render, screen } from "@testing-library/react";
import Packages from "../src/components/Packages.js";
import { PACKAGES, PACKAGES_HEADING } from "../src/content.js";

describe("Packages", () => {
  it("labels the section with the micro-heading", () => {
    render(<Packages />);

    expect(screen.getByText(PACKAGES_HEADING.label)).toBeInTheDocument();
    const section = screen.getByText(PACKAGES_HEADING.label).closest("section");
    expect(section).toHaveAttribute("id", "packages");
  });

  it("renders all five package cards, none dropped or duplicated", () => {
    render(<Packages />);

    expect(PACKAGES).toHaveLength(5);
    for (const pkg of PACKAGES) {
      expect(screen.getByText(pkg.name)).toBeInTheDocument();
      expect(screen.getByText(pkg.description)).toBeInTheDocument();
    }
  });

  it("wraps every card in a .pkg element inside a single .pkgs grid", () => {
    render(<Packages />);

    const grid = document.querySelector(".pkgs");
    expect(grid).not.toBeNull();
    const cards = grid?.querySelectorAll(":scope > .pkg");
    expect(cards).toHaveLength(PACKAGES.length);
  });
});
