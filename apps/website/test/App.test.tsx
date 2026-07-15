import { render, screen } from "@testing-library/react";
import App from "../src/App.js";
import { HERO, BENEFITS, FEATURES, REPO_URL } from "../src/content.js";

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

  it("renders a real Studio screenshot for every feature, with a matching caption", () => {
    render(<App />);

    const images = screen.getAllByRole("img");
    expect(images.length).toBe(FEATURES.length);

    const srcStemById: Record<string, string> = {
      canvas: "studio-canvas",
      inspector: "studio-inspector",
      templates: "studio-templates",
      "deploy-flow": "studio-deploy-flow",
    };

    for (const feature of FEATURES) {
      const img = screen.getByAltText(feature.screenshotCaption) as HTMLImageElement;
      expect(screen.getByText(feature.screenshotCaption)).toBeInTheDocument();

      const src = img.getAttribute("src");
      expect(src).toBeTruthy();
      expect(src).toContain(srcStemById[feature.id]);
    }

    const srcs = images.map((img) => img.getAttribute("src"));
    expect(new Set(srcs).size).toBe(FEATURES.length);
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
