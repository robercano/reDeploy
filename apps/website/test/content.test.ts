import {
  FOOTER,
  GRAPH_PANE,
  HERO,
  NAV_LINKS,
  PACKAGES,
  PIPELINE_HEADING,
  PIPELINE_NOTE,
  PIPELINE_STAGES,
  REPO_URL,
  SPEC_JSON,
  SPEC_PANE,
  SPLIT_CAPTION,
  STUDIO_SECTION,
  STUDIO_URL,
  TOPBAR,
  type RichSegment,
} from "../src/content.js";

function flatten(segments: RichSegment[]): string {
  return segments.map((s) => s.text).join("");
}

describe("content", () => {
  it("points every real link at the actual repo / studio source", () => {
    expect(REPO_URL).toBe("https://github.com/robercano/reDeploy");
    expect(STUDIO_URL).toBe("https://github.com/robercano/reDeploy/tree/main/apps/studio");

    const github = NAV_LINKS.find((l) => l.label === "github");
    expect(github?.href).toBe(REPO_URL);

    expect(STUDIO_SECTION.ctaPrimary.href).toBe(STUDIO_URL);
    expect(STUDIO_SECTION.ctaSecondary.href).toBe(REPO_URL);
  });

  it("has the four topbar nav anchors, in order", () => {
    expect(NAV_LINKS.map((l) => l.label)).toEqual(["pipeline", "studio", "packages", "github"]);
    expect(NAV_LINKS.find((l) => l.label === "pipeline")?.href).toBe("#pipeline");
    expect(NAV_LINKS.find((l) => l.label === "studio")?.href).toBe("#studio");
    expect(NAV_LINKS.find((l) => l.label === "packages")?.href).toBe("#packages");
  });

  it("has a non-empty hero headline and subhead", () => {
    expect(flatten(HERO.headline)).toContain("One truth.");
    expect(flatten(HERO.subhead).length).toBeGreaterThan(0);
    expect(HERO.subhead.some((s) => s.as === "b")).toBe(true);
  });

  it("has a well-formed example spec that parses as JSON", () => {
    expect(() => JSON.parse(SPEC_JSON)).not.toThrow();
    const parsed = JSON.parse(SPEC_JSON);
    expect(parsed.contracts.map((c: { id: string }) => c.id)).toEqual(["Token", "Registry", "Vault"]);
    expect(parsed.config).toHaveLength(2);
  });

  it("labels the spec/graph panes", () => {
    expect(SPEC_PANE.command).toBe("cat protocol.spec.json");
    expect(GRAPH_PANE.command).toBe("redeploy simulate");
    expect(GRAPH_PANE.svgLabel.length).toBeGreaterThan(0);
  });

  it("has a non-empty split caption", () => {
    expect(flatten(SPLIT_CAPTION).length).toBeGreaterThan(0);
  });

  it("has all four pipeline stages, in order, each with a title and description", () => {
    expect(PIPELINE_STAGES.map((s) => s.id)).toEqual(["deploy", "configure", "verify", "read"]);
    for (const stage of PIPELINE_STAGES) {
      expect(flatten(stage.title).length).toBeGreaterThan(0);
      expect(flatten(stage.description).length).toBeGreaterThan(0);
    }
    expect(PIPELINE_HEADING.label).toBe("THE PIPELINE");
    expect(flatten(PIPELINE_NOTE).length).toBeGreaterThan(0);
  });

  it("lists all five reDeploy packages, none dropped or duplicated", () => {
    expect(PACKAGES.map((p) => p.name)).toEqual([
      "@redeploy/core",
      "@redeploy/config",
      "@redeploy/verify",
      "@redeploy/reader",
      "@redeploy/studio",
    ]);
    for (const pkg of PACKAGES) {
      expect(pkg.description.length).toBeGreaterThan(0);
    }
  });

  it("has a short, non-empty topbar glyph and tagline for the shared header's product row", () => {
    expect(TOPBAR.glyph).toBe("^^");
    expect(TOPBAR.tagline.length).toBeGreaterThan(0);
    expect(TOPBAR.tagline.length).toBeLessThan(80);
  });

  it("has a footer prompt line and a three-entry family strip with exactly one current item", () => {
    expect(FOOTER.promptUser).toBe("roberto@thesolidchain:~$");
    expect(FOOTER.family).toHaveLength(3);
    expect(FOOTER.family.filter((f) => f.current)).toHaveLength(1);
    expect(FOOTER.family.find((f) => f.current)?.label).toBe("reDeploy ^^");
  });
});
