import { NAV_LINKS, TOPBAR } from "../content.js";

// Product row of the shared sticky header (brand book §08): glyph, then the bold product
// name and a short context line, ahead of the site's own nav anchors. The reDeploy-specific
// chevron mark previously rendered here was dropped — the family brand mark already anchors
// the statusbar row above it, and duplicating a logo across both rows of the same sticky
// header read as redundant. See the PR description for the full rationale.
export default function Topbar() {
  return (
    <div className="topbar">
      <span className="chev hl" aria-hidden="true">
        {TOPBAR.glyph}
      </span>
      <b>
        <span className="re">re</span>Deploy
      </b>
      <span className="tagline"> — {TOPBAR.tagline}</span>
      <nav>
        {NAV_LINKS.map((link) => (
          <a key={link.label} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
