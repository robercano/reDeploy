import { render, screen } from "@testing-library/react";
import App from "../src/App.js";
import { HERO, BENEFITS, REPO_URL } from "../src/content.js";

describe("App", () => {
  it("renders the hero pitch and primary CTA", () => {
    render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: HERO.headline })).toBeInTheDocument();

    const cta = screen.getByRole("link", { name: HERO.ctaLabel });
    expect(cta).toHaveAttribute("href", REPO_URL);
  });

  it("lists all five reDeploy packages as benefits", () => {
    render(<App />);

    for (const benefit of BENEFITS) {
      expect(screen.getByText(benefit.packageName)).toBeInTheDocument();
    }

    expect(BENEFITS.map((b) => b.packageName)).toEqual([
      "@redeploy/core",
      "@redeploy/config",
      "@redeploy/verify",
      "@redeploy/reader",
      "@redeploy/studio",
    ]);
  });

  it("renders a clearly-labeled placeholder for every feature screenshot", () => {
    render(<App />);

    const placeholders = screen.getAllByText("Placeholder — Studio screenshot");
    expect(placeholders.length).toBeGreaterThan(0);
  });

  it("links to the GitHub repo in the footer", () => {
    render(<App />);

    const githubLinks = screen.getAllByRole("link", { name: "GitHub" });
    expect(githubLinks.length).toBeGreaterThan(0);
    for (const link of githubLinks) {
      expect(link).toHaveAttribute("href", REPO_URL);
    }
  });
});
