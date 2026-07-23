import { render, screen } from "@testing-library/react";
import Topbar from "../src/components/Topbar.js";
import { NAV_LINKS, TOPBAR } from "../src/content.js";

describe("Topbar", () => {
  it("renders the shared header's product row: glyph, bold name, then a short context", () => {
    const { container } = render(<Topbar />);

    expect(screen.getByText(TOPBAR.glyph)).toBeInTheDocument();
    expect(container.querySelector("b")?.textContent).toBe("reDeploy");
    expect(container.textContent).toContain(TOPBAR.tagline);

    // Brand book §08 order: glyph, then name, then context — ahead of the nav.
    const text = container.textContent ?? "";
    expect(text.indexOf(TOPBAR.glyph)).toBeLessThan(text.indexOf("reDeploy"));
    expect(text.indexOf("reDeploy")).toBeLessThan(text.indexOf(TOPBAR.tagline));
  });

  it("still exposes the site's own nav anchors alongside the product row", () => {
    render(<Topbar />);

    for (const link of NAV_LINKS) {
      const anchor = screen.getByRole("link", { name: link.label });
      expect(anchor).toHaveAttribute("href", link.href);
    }
  });
});
