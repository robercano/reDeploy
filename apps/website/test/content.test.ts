import { BENEFITS, FEATURES, FOOTER_LINKS, REPO_URL } from "../src/content.js";

describe("content", () => {
  it("has non-empty copy for every benefit", () => {
    expect(BENEFITS.length).toBe(5);
    for (const benefit of BENEFITS) {
      expect(benefit.title.length).toBeGreaterThan(0);
      expect(benefit.description.length).toBeGreaterThan(0);
      expect(benefit.packageName.startsWith("@redeploy/")).toBe(true);
    }
  });

  it("has non-empty copy and a screenshot caption for every feature", () => {
    expect(FEATURES.length).toBeGreaterThan(0);
    for (const feature of FEATURES) {
      expect(feature.title.length).toBeGreaterThan(0);
      expect(feature.description.length).toBeGreaterThan(0);
      expect(feature.screenshotCaption.length).toBeGreaterThan(0);
    }
  });

  it("points footer links at the real GitHub repo", () => {
    const github = FOOTER_LINKS.find((link) => link.label === "GitHub");
    expect(github?.href).toBe(REPO_URL);
    expect(REPO_URL).toBe("https://github.com/robercano/reDeploy");
  });
});
