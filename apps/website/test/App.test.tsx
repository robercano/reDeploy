import { render, screen, within } from "@testing-library/react";
import App from "../src/App.js";
import { GRAPH_PANE, NAV_LINKS, PACKAGES, PIPELINE_STAGES, REPO_URL, STUDIO_SECTION, STUDIO_URL } from "../src/content.js";

describe("App", () => {
  it("renders a sticky topbar with the four nav anchors", () => {
    render(<App />);

    for (const link of NAV_LINKS) {
      const anchor = screen.getByRole("link", { name: link.label });
      expect(anchor).toHaveAttribute("href", link.href);
    }
  });

  it("renders the hero headline and subhead", () => {
    render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: /One spec\. One graph\. One truth\./ })).toBeInTheDocument();
    expect(screen.getByText(/Built on Hardhat Ignition\./)).toBeInTheDocument();
  });

  it("renders the spec pane with the example contracts and the dependency graph", () => {
    render(<App />);

    expect(screen.getByText("cat protocol.spec.json")).toBeInTheDocument();
    for (const value of ["Token", "Registry", "Vault", "feeBps", "KEEPER"]) {
      expect(screen.getAllByText(new RegExp(value)).length).toBeGreaterThan(0);
    }

    expect(screen.getByRole("img", { name: GRAPH_PANE.svgLabel })).toBeInTheDocument();
  });

  it("renders all four pipeline stages, in order, with inline code terms", () => {
    render(<App />);

    const pipeline = document.getElementById("pipeline");
    expect(pipeline).not.toBeNull();
    const stages = within(pipeline as HTMLElement).getAllByRole("heading", { level: 3 });
    expect(stages.map((h) => h.textContent?.trim())).toEqual(["Deploy ^^", "Configure", "Verify", "Read"]);
    expect(PIPELINE_STAGES).toHaveLength(4);

    expect(within(pipeline as HTMLElement).getByText("ref")).toBeInTheDocument();
    expect(within(pipeline as HTMLElement).getByText("grantRole")).toBeInTheDocument();
  });

  it("renders the Studio band with a real screenshot and the two real CTAs", () => {
    render(<App />);

    const img = screen.getByAltText(STUDIO_SECTION.screenshotAlt) as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("studio-canvas");

    const launch = screen.getByRole("link", { name: STUDIO_SECTION.ctaPrimary.label });
    expect(launch).toHaveAttribute("href", STUDIO_URL);

    const github = screen.getByRole("link", { name: STUDIO_SECTION.ctaSecondary.label });
    expect(github).toHaveAttribute("href", REPO_URL);
  });

  it("lists all five reDeploy packages, none dropped or duplicated", () => {
    render(<App />);

    for (const pkg of PACKAGES) {
      expect(screen.getByText(pkg.name)).toBeInTheDocument();
    }
    expect(PACKAGES).toHaveLength(5);
  });

  it("renders the footer prompt line and family strip with reDeploy as current", () => {
    render(<App />);

    expect(screen.getByText("roberto@thesolidchain:~$")).toBeInTheDocument();
    expect(screen.getByText("reDeploy ^^")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "reCode </>" })).toHaveAttribute("href", "#");
    expect(screen.getByRole("link", { name: "reDeFi <=>" })).toHaveAttribute("href", "#");
  });

  it("links to the real GitHub repo from the topbar", () => {
    render(<App />);

    const githubLink = screen.getByRole("link", { name: "github" });
    expect(githubLink).toHaveAttribute("href", REPO_URL);
  });
});
